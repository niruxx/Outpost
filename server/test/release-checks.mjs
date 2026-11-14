// Mandatory browser/API release gate. All data, faults and sockets are local/disposable.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import express from 'express';
import { WebSocketServer } from 'ws';
import { runBrowser } from './browserHarness.mjs';

const MiB = 1024 * 1024;
const uploadMiB = Number(process.env.OUTPOST_RELEASE_UPLOAD_MIB ?? 64);
assert.ok(Number.isInteger(uploadMiB) && uploadMiB >= 8 && uploadMiB <= 256, 'Release upload size must be 8–256 MiB');
const artifacts = path.resolve(process.env.OUTPOST_RELEASE_ARTIFACTS ?? 'artifacts/release-checks');
fs.mkdirSync(artifacts, { recursive: true });
for (const name of ['report.json', 'browser-failure.json', 'browser-failure.png', 'host-tabs-mobile.png', 'job-recovery.png']) fs.rmSync(path.join(artifacts, name), { force: true });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-release-'));
process.env.OUTPOST_DATA_DIR = temp;
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), node: process.version, os: process.platform, osRelease: os.release(), arch: process.arch, browser: null, uploadBytes: uploadMiB * MiB + 17, checks: [], status: 'running' };
try { report.revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(); report.dirty = !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', windowsHide: true }).trim(); } catch { report.revision = 'unavailable'; }
const saveReport = () => fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
saveReport();
async function check(name, work) {
  const started = performance.now();
  try { const details = await work(); report.checks.push({ name, status: 'passed', durationMs: Math.round(performance.now() - started), ...(details ? { details } : {}) }); console.log(`PASS ${name}`); }
  catch (error) { report.checks.push({ name, status: 'failed', durationMs: Math.round(performance.now() - started), error: error.stack ?? String(error) }); throw error; }
  finally { saveReport(); }
}

let http, wss, db;
const timers = new Set();
try {
  assert.ok(fs.existsSync('web/dist/index.html'), 'Build the web app first (npm run test:release)');
  ({ db } = await import('../dist/db/db.js'));
  const { filesRouter } = await import('../dist/routes/files.routes.js');
  const { backupsRouter } = await import('../dist/routes/backups.routes.js');
  const { workspaceRouter } = await import('../dist/routes/workspace.routes.js');
  const { authRouter } = await import('../dist/routes/auth.routes.js');
  const users = await import('../dist/services/userService.js');
  const { createToken } = await import('../dist/auth/tokens.js');
  const { getServer, listServers } = await import('../dist/services/serverService.js');
  const { instanceDir } = await import('../dist/utils/paths.js');
  const transfers = await import('../dist/services/fileWorkspaceService.js');
  const jobs = await import('../dist/services/jobService.js');
  const admin = users.createUser('release-admin', 'fixture-password-123', 'admin');
  const token = createToken(admin.id, admin.username, admin.role);
  for (const id of ['release-a', 'release-b']) {
    db.prepare('INSERT INTO servers(id,name,platform,loader,version,status,created_by) VALUES (?,?,?,?,?,?,?)').run(id, `Release ${id.at(-1).toUpperCase()}`, 'java', 'vanilla', '1.21.1', 'stopped', admin.id);
    fs.mkdirSync(instanceDir(id), { recursive: true });
    fs.writeFileSync(path.join(instanceDir(id), `${id}.txt`), `Only ${id} owns this file`);
  }
  const failure = jobs.beginJob('backup', 'release-a', 'Release backup stage');
  jobs.progressJob(failure, 'Release backup token=fixture-secret');
  jobs.finishJob(failure, new Error('Release fixture: backup storage unavailable password=fixture-password'));
  const interrupted = jobs.beginJob('import', 'release-a', 'Release interrupted import');
  jobs.recoverJobs();
  assert.equal(jobs.jobRows().find(j => j.id === interrupted).status, 'interrupted');

  const faults = { fileDelay: 0, fileFailures: 0, backupFailures: 0, chunkDropResponses: 0, rejectChunksAfterDrop: false, dropAtOffset: 5 * MiB };
  const counts = { chunks: [], droppedResponses: 0, rejectedChunks: 0, backupAttempts: 0, socketConnections: 0, activeSockets: 0, unexpectedMutations: [] };
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use((req, _res, next) => { if (req.headers.authorization === 'Bearer browser-fixture') req.headers.authorization = `Bearer ${token}`; next(); });
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET' && /\/files\/list$/.test(req.path)) {
      if (faults.fileFailures > 0) { faults.fileFailures--; return res.status(503).json({ error: 'Release fixture: file listing temporarily unavailable' }); }
      if (faults.fileDelay) { const timer = setTimeout(() => { timers.delete(timer); if (!res.destroyed) next(); }, faults.fileDelay); timers.add(timer); return; }
    }
    if (req.method === 'PUT' && /\/transfers\/[^/]+\/chunk$/.test(req.path)) {
      const offset = Number(req.headers['upload-offset']); counts.chunks.push(offset);
      // A valid 503 after the lost acknowledgement makes failure deterministic even
      // when Chromium transparently retries an idempotent PUT on a broken connection.
      if (faults.rejectChunksAfterDrop && counts.droppedResponses > 0) { counts.rejectedChunks++; return res.status(503).json({ error: 'Release fixture: upload link unavailable' }); }
      if (faults.chunkDropResponses > 0 && offset >= faults.dropAtOffset) {
        const original = res.json;
        res.json = function (body) { if (faults.chunkDropResponses > 0) { faults.chunkDropResponses--; counts.droppedResponses++; req.socket.destroy(); return this; } return original.call(this, body); };
      }
    }
    if (req.method === 'POST' && req.path === '/servers/release-a/backups') {
      counts.backupAttempts++;
      if (faults.backupFailures > 0) { faults.backupFailures--; const id = jobs.beginJob('backup', 'release-a', 'Release retry failure'); jobs.finishJob(id, new Error('Release fixture: retry storage unavailable')); return res.status(503).json({ error: 'Release fixture: retry storage unavailable' }); }
    }
    next();
  });
  app.use('/api/auth', authRouter);
  app.use('/api/workspace', workspaceRouter);
  app.use('/api/servers/:serverId/files', filesRouter);
  app.use('/api/servers/:serverId/backups', backupsRouter);
  app.post(['/api/activity/presence', '/api/activity/leave'], (_req, res) => res.status(204).end());
  app.get('/api/servers', (_req, res) => res.json({ servers: listServers(), metrics: {} }));
  app.get('/api/servers/:serverId', (req, res) => res.json({ server: getServer(req.params.serverId), permissions: [...users.SERVER_PERMISSIONS], running: false, runtime: null }));
  app.get('/api/servers/:serverId/tasks', (_req, res) => res.json({ tasks: [] }));
  app.get('/api/servers/:serverId/players', (_req, res) => res.json({ players: [] }));
  app.get('/api/nodes', (_req, res) => res.json({ nodes: [] }));
  app.get('/api/host/settings', (_req, res) => res.json({ linux: false, hostname: 'release-host', prettyHostname: null, os: 'Release fixture OS', kernel: 'fixture', arch: 'fixture', hardware: { vendor: null, product: null, cpu: 'Release fixture CPU', cores: 4, memoryMb: 8192, machineId: null }, bootedAt: new Date().toISOString(), time: { now: new Date().toISOString(), timezone: 'UTC', ntpEnabled: false, synchronized: true, canNtp: false, ntp: { client: null, servers: [], managed: false } }, power: { scheduled: null }, tuned: { installed: false, profiles: [], active: null, recommended: null }, remoteAdmin: false }));
  app.get('/api/host/metrics', (_req, res) => res.json({ range: '6h', from: Date.now() - 60000, to: Date.now(), host: [0, 1].map(n => ({ at: Date.now() - (1 - n) * 60000, cpu: 10 + n, mem_mb: 512, load1: 0.2, net_rx: 0, net_tx: 0, disk_read: 0, disk_write: 0 })), anomalies: {}, services: [], perServiceAvailable: false, totalMemoryMb: 8192 }));
  app.get('/api/host/services', (_req, res) => res.json({ available: true, reason: null, type: 'service', ownUnit: null, units: [{ unit: 'release-fixture.service', description: 'Release fixture service', load: 'loaded', active: 'active', sub: 'running', fileState: 'enabled', preset: 'enabled' }] }));
  const errors = { '/packages': 'software', '/accounts': 'accounts', '/network': 'network', '/security': 'security', '/diagnostics': 'diagnostics' };
  for (const [route, label] of Object.entries(errors)) app.get(`/api/host${route}`, (_req, res) => res.status(503).json({ error: `Release fixture: ${label} unavailable` }));
  app.use('/api', (req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) counts.unexpectedMutations.push(`${req.method} ${req.path}`);
    res.status(503).json({ error: 'Outside release fixture scope' });
  });
  app.use((error, _req, res, _next) => res.status(error.status ?? 500).json({ error: error.message }));
  app.use(express.static(path.resolve('web/dist')));
  app.get('*', (_req, res) => res.sendFile(path.resolve('web/dist/index.html')));
  http = app.listen(0, '127.0.0.1'); await once(http, 'listening');
  const origin = `http://127.0.0.1:${http.address().port}`;
  wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, origin);
    if (!url.pathname.startsWith('/ws/console/') || url.searchParams.get('token') !== 'browser-fixture') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, client => wss.emit('connection', client));
  });
  wss.on('connection', client => {
    counts.socketConnections++; counts.activeSockets++;
    client.on('error', () => {}); client.on('close', () => counts.activeSockets--);
    client.send(JSON.stringify({ type: 'hello', status: 'stopped', history: ['Release console ready', `Release connection ${counts.socketConnections}`], runtime: null }));
  });

  await check('Upload size and chunk limits reject oversized payloads without publishing', async () => {
    const base = `${origin}/api/servers/release-a/files/transfers`;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const manifest = { path: 'boundary.bin', size: 1024 ** 3, hashes: Array(1024).fill('0'.repeat(64)), collision: 'skip' };
    const accepted = await fetch(base, { method: 'POST', headers, body: JSON.stringify(manifest) }); assert.equal(accepted.status, 201);
    const maximum = await accepted.json(); await fetch(`${base}/${maximum.id}`, { method: 'DELETE', headers });
    const oversized = await fetch(base, { method: 'POST', headers, body: JSON.stringify({ ...manifest, size: 1024 ** 3 + 1, hashes: Array(1025).fill('0'.repeat(64)) }) }); assert.equal(oversized.status, 400);
    const small = await fetch(base, { method: 'POST', headers, body: JSON.stringify({ path: 'chunk-boundary.bin', size: MiB, hashes: [createHash('sha256').update(Buffer.alloc(MiB)).digest('hex')], collision: 'skip' }) });
    const transfer = await small.json(); assert.equal(small.status, 201);
    const rejected = await fetch(`${base}/${transfer.id}/chunk`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'Upload-Offset': '0' }, body: Buffer.alloc(MiB + 1) }); assert.equal(rejected.status, 413);
    assert.equal(transfers.transfer('release-a', admin.id, transfer.id).offset, 0);
    await fetch(`${base}/${transfer.id}`, { method: 'DELETE', headers });
    assert.equal(fs.existsSync(path.join(instanceDir('release-a'), 'boundary.bin')), false);
    assert.equal(fs.existsSync(path.join(instanceDir('release-a'), 'chunk-boundary.bin')), false);
    return { acceptedManifestBytes: 1024 ** 3, rejectedManifestBytes: 1024 ** 3 + 1, rejectedChunkBytes: MiB + 1, oversizedBytesPublished: 0 };
  });

  await runBrowser(origin, async browser => {
    const { evaluate, navigate, text, click, until, network, viewport, captureScreenshot } = browser;
    async function visible(label, selector = 'main *') {
      await until(() => evaluate(`(() => {
        const elements=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(e=>e.textContent.trim()===${JSON.stringify(label)});
        return elements.some(el=>{const r=el.getBoundingClientRect();if(r.width<1||r.height<1)return false;for(let e=el;e;e=e.parentElement){const s=getComputedStyle(e);if(s.display==='none'||s.visibility!=='visible'||Number(s.opacity)<0.95||s.contentVisibility==='hidden')return false;}return true;});
      })()`), `visible and opaque: ${label}`);
    }
    async function link(route) {
      await evaluate(`(() => {const a=[...document.querySelectorAll('a[href]')].find(e=>new URL(e.href).pathname===${JSON.stringify(route)});if(!a)throw new Error('Navigation link missing: '+${JSON.stringify(route)});a.click();})()`);
      await until(() => evaluate(`location.pathname===${JSON.stringify(route)}`), `client navigation: ${route}`);
    }
    const hosts = [['/host', 'Overview', 'release-host'], ['/host/metrics', 'Metrics', 'CPU'], ['/host/services', 'Services', 'release-fixture.service'], ['/host/software', 'Software', 'Release fixture: software unavailable'], ['/host/accounts', 'Accounts', 'Release fixture: accounts unavailable'], ['/host/network', 'Networking', 'Release fixture: network unavailable'], ['/host/security', 'Security', 'Release fixture: security unavailable'], ['/host/diagnostics', 'Diagnostics', 'Release fixture: diagnostics unavailable']];
    await check('Repeated host-tab navigation keeps content visible', async () => {
      await viewport(1280, 900);
      await navigate('/host'); await text('release-host');
      for (let cycle = 0; cycle < 4; cycle++) for (const [route, title, body] of cycle % 2 ? [...hosts].reverse() : hosts) { await link(route); await visible(title, 'main h1'); await visible(body); }
      for (let cycle = 0; cycle < 3; cycle++) {
        for (const [route] of hosts) await link(route);
        await visible('Diagnostics', 'main h1'); await visible('Release fixture: diagnostics unavailable');
      }
      await viewport(390, 844);
      for (const [route, title, body] of hosts) { await link(route); await visible(title, 'main h1'); await visible(body); assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'), true, `mobile host overflow: ${route}`); }
      await captureScreenshot(path.join(artifacts, 'host-tabs-mobile.png')); await viewport(1280, 900);
      return { desktopTransitions: 32, rapidTransitions: 24, mobileTransitions: 8, checks: ['nonzero dimensions', 'ancestor visibility/opacity', 'success and error content', 'mobile overflow'] };
    });
    await check('Repeated instance tabs release old console sockets', async () => {
      await navigate('/instances/release-a/files'); await text('release-a.txt');
      for (let cycle = 0; cycle < 6; cycle++) {
        await link('/instances/release-a/console'); await visible('Release console ready');
        await until(() => counts.activeSockets === 1, 'one console subscription');
        await link('/instances/release-a/backups'); await visible('Snapshots');
        await link('/instances/release-a/tasks'); await text('New task');
        await link('/instances/release-a/files'); await visible('release-a.txt');
        await until(() => counts.activeSockets === 0, 'console subscription cleaned up');
      }
      return { cycles: 6, transitions: 24, leakedSockets: counts.activeSockets };
    });
    await check('Console reconnects repeatedly after dropped sockets and offline mode', async () => {
      await link('/instances/release-a/console'); await visible('Release console ready');
      for (let n = 0; n < 3; n++) {
        const before = counts.socketConnections;
        wss.clients.forEach(client => client.terminate()); await text('reconnecting');
        await until(() => counts.socketConnections > before && counts.activeSockets === 1, 'console socket reconnected');
        await visible(`Release connection ${counts.socketConnections}`);
        assert.equal(await evaluate(`[...document.querySelectorAll('main p,main div')].filter(e=>e.childElementCount===0&&e.textContent==='Release console ready').length`), 1, 'history must not duplicate on reconnect');
      }
      await network({ offline: true }); wss.clients.forEach(client => client.terminate()); await text('reconnecting');
      await network(); await until(() => counts.activeSockets === 1, 'console returned online'); await visible('Release console ready');
      return { forcedDisconnects: 3, offlineRecovery: true };
    });
    await check('Slow and failed reads show feedback and recover', async () => {
      faults.fileDelay = 1800;
      await network({ latencyMs: 250, downloadBytesPerSecond: 2 * MiB, uploadBytesPerSecond: 2 * MiB });
      await link('/instances/release-a/files');
      await until(() => evaluate(`!!document.querySelector('[role=progressbar][aria-busy=true]')`), 'slow-request activity indicator');
      await visible('Upload files', 'main button'); await visible('release-a.txt');
      faults.fileDelay = 0; await network();
      await until(() => evaluate(`!document.querySelector('[role=progressbar][aria-busy=true]')`), 'activity indicator settles');
      faults.fileFailures = 1;
      await link('/instances/release-a/console'); await link('/instances/release-a/files');
      await visible('Release fixture: file listing temporarily unavailable');
      await link('/instances/release-a/console'); await link('/instances/release-a/files'); await visible('release-a.txt');
      return { latencyMs: 250, bandwidthBytesPerSecond: 2 * MiB, additionalReadDelayMs: 1800, forcedHttpFailures: 1 };
    });
    await check('Large browser upload survives lost acknowledgements and reload', async () => {
      faults.chunkDropResponses = 1; faults.rejectChunksAfterDrop = true;
      await network({ latencyMs: 20, downloadBytesPerSecond: 16 * MiB, uploadBytesPerSecond: 16 * MiB });
      const selectFile = () => evaluate(`(() => {const block=new Uint8Array(1048576).fill(90);const parts=Array.from({length:${uploadMiB}},()=>block);parts.push(new Uint8Array(17).fill(90));const file=new File(parts,'release-large.bin',{type:'application/octet-stream'});const dt=new DataTransfer();dt.items.add(file);const input=document.querySelector('[data-upload-instance]');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await selectFile(); await text('Failed');
      const pending = transfers.transfers('release-a', admin.id).find(t => t.path === 'release-large.bin');
      assert.ok(pending && pending.offset >= 6 * MiB && pending.offset < report.uploadBytes, 'verified progress survives missing responses');
      assert.equal(fs.existsSync(path.join(instanceDir('release-a'), 'release-large.bin')), false, 'partial bytes must not be published');
      assert.equal(counts.droppedResponses, 1); assert.ok(counts.rejectedChunks >= 3, 'automatic retries exhausted while upload link is unavailable');
      await until(() => evaluate(`(()=>{const p=document.querySelector('progress[aria-label="Upload release-large.bin"]');return p&&p.value>0&&p.value<100;})()`), 'partial upload percentage');
      faults.rejectChunksAfterDrop = false;
      await navigate('/instances/release-a/files'); await text('Reselect file to resume');
      const start = counts.chunks.length; await selectFile();
      await until(() => evaluate(`document.querySelector('[aria-label="Upload queue"]')?.innerText.includes('Complete')`), 'large upload complete', 120000);
      assert.ok(counts.chunks.slice(start).every(offset => offset >= pending.offset), 'reselection resumes durable bytes without starting over');
      const hash = createHash('sha256'); for (let i = 0; i < uploadMiB; i++) hash.update(Buffer.alloc(MiB, 90)); hash.update(Buffer.alloc(17, 90));
      const actual = createHash('sha256'); for await (const chunk of fs.createReadStream(path.join(instanceDir('release-a'), 'release-large.bin'))) actual.update(chunk);
      assert.equal(actual.digest('hex'), hash.digest('hex'), 'published file checksum');
      assert.equal(fs.statSync(path.join(instanceDir('release-a'), 'release-large.bin')).size, report.uploadBytes);
      assert.equal(await evaluate('document.querySelector(\'progress[aria-label="Upload release-large.bin"]\').value'), 100);
      const session = transfers.transfers('release-a', admin.id).find(t => t.path === 'release-large.bin');
      assert.equal(session.state, 'done');
      const retry = await fetch(`${origin}/api/servers/release-a/files/transfers/${session.id}/complete`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }); assert.equal(retry.status, 200, 'completion retry is idempotent');
      await network();
      return { bytes: report.uploadBytes, resumedAtByte: pending.offset, droppedAcknowledgements: counts.droppedResponses, rejectedChunkRequests: counts.rejectedChunks, checksumVerified: true };
    });
    await check('Failed jobs remain reviewable, retry failures stay visible, and successful retries are recorded', async () => {
      await navigate('/jobs'); await text('Job center'); await text('Release fixture: backup storage unavailable');
      assert.equal(await evaluate(`document.body.innerText.includes('fixture-secret')||document.body.innerText.includes('fixture-password')`), false, 'job output redacts credentials');
      await evaluate(`(()=>{const e=document.querySelector('[aria-label="Job status"]');e.value='interrupted';e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await text('Panel restarted before completion was confirmed');
      await evaluate(`(()=>{const e=document.querySelector('[aria-label="Job status"]');e.value='failed';e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      faults.backupFailures = 1; await click('Retry backup'); await text('Retry backup?');
      await evaluate(`[...document.querySelectorAll('[aria-modal=true] button')].find(e=>e.textContent.trim()==='Retry backup').click()`);
      await visible('Release fixture: retry storage unavailable'); assert.equal(counts.backupAttempts, 1);
      await click('Retry backup'); await text('Retry backup?');
      await evaluate(`[...document.querySelectorAll('[aria-modal=true] button')].find(e=>e.textContent.trim()==='Retry backup').click()`);
      await until(() => jobs.jobRows().some(j => j.kind === 'backup' && j.status === 'completed'), 'retry created completed job');
      assert.equal(counts.backupAttempts, 2, 'each explicit retry starts exactly one request');
      await evaluate(`(()=>{const e=document.querySelector('[aria-label="Job status"]');e.value='completed';e.dispatchEvent(new Event('change',{bubbles:true}));})()`); await click('Refresh'); await text('completed');
      await navigate('/jobs'); await text('Release fixture: backup storage unavailable');
      assert.equal(jobs.jobRows().find(j => j.id === failure).status, 'failed', 'original failed history remains intact');
      return { failedJobsRetained: true, interruptedJobsRecovered: true, failedRetries: 1, successfulRetries: 1 };
    });
    assert.deepEqual(counts.unexpectedMutations, [], 'tests must not execute unrelated host/instance mutations');
    await captureScreenshot(path.join(artifacts, 'job-recovery.png'));
  }, { artifactDirectory: artifacts, onBrowserVersion: version => { report.browser = version; saveReport(); } });
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack ?? String(error); console.error(error); process.exitCode = 1; }
finally {
  timers.forEach(clearTimeout);
  wss?.clients.forEach(client => client.terminate());
  if (wss) await new Promise(resolve => wss.close(resolve));
  if (http) { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); }
  db?.close();
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  report.finishedAt = new Date().toISOString(); saveReport();
  console.log(`Release checks ${report.status}. Report: ${path.join(artifacts, 'report.json')}`);
}
