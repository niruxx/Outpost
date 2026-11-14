// npm run build --workspace=server && node server/test/antivirus.mjs
// Scanner protocol fixtures are harmless strings; no malware or OS package installation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import express from 'express';
import ssh2 from 'ssh2';
import AdmZip from 'adm-zip';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-antivirus-'));
process.env.OUTPOST_DATA_DIR = temp;
const originalSpawn = childProcess.spawn;
let mode = 'normal', calls = 0, killed = 0;
function containsFixture(target) {
  if (!fs.existsSync(target)) return false;
  const stat = fs.lstatSync(target); if (stat.isSymbolicLink()) return false;
  if (stat.isDirectory()) return fs.readdirSync(target).some(n => containsFixture(path.join(target, n)));
  const bytes = fs.readFileSync(target);
  if (bytes.includes(Buffer.from('OUTPOST_TEST_THREAT'))) return true;
  if (bytes.subarray(0, 2).toString() === 'PK') { try { return new AdmZip(bytes).getEntries().some(e => !e.isDirectory && e.getData().includes(Buffer.from('OUTPOST_TEST_THREAT'))); } catch {} }
  return false;
}
function findingPath(target) { return fs.statSync(target).isDirectory() ? findingPath(path.join(target, fs.readdirSync(target).find(n => containsFixture(path.join(target, n))))) : target; }
childProcess.spawn = (exe, args, options) => {
  assert.equal(options.shell, false); assert.equal(options.windowsHide, true); calls++;
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let closed = false;
  const close = code => { if (!closed) { closed = true; child.emit('close', code); } };
  child.kill = () => { killed++; queueMicrotask(() => close(null)); return true; };
  queueMicrotask(() => {
    if (mode === 'missing') { child.emit('error', new Error('ENOENT')); return; }
    if (args.includes('--version')) { child.stdout.write('ClamAV fixture/12345/current\n'); close(0); return; }
    if (path.basename(exe) === 'freshclam') { child.stdout.write('Signatures updated (fixture)'); close(0); return; }
    assert.ok(args.includes('--alert-exceeds-max=yes')); assert.ok(args.includes('--alert-encrypted=yes')); assert.ok(args.includes('--fail-if-cvd-older-than=7')); assert.ok(args.includes('--follow-file-symlinks=0'));
    if (mode === 'hang') return;
    if (mode === 'error') { child.stderr.write('ERROR: scanner unavailable'); close(2); return; }
    if (mode === 'warning') { child.stderr.write('WARNING: unreadable file'); close(0); return; }
    const target = args.at(-1);
    if (containsFixture(target)) { child.stdout.write(`${findingPath(target)}: Fixture.Signature FOUND\n`); close(1); return; }
    close(0);
  });
  return child;
};
syncBuiltinESMExports();
const { db } = await import('../dist/db/db.js');
const av = await import('../dist/services/antivirusService.js');
const { antivirusRouter, instanceAntivirusRouter } = await import('../dist/routes/antivirus.routes.js');
const { filesRouter } = await import('../dist/routes/files.routes.js');
const { pluginsRouter } = await import('../dist/routes/plugins.routes.js');
const { authRouter } = await import('../dist/routes/auth.routes.js');
const { instanceDir } = await import('../dist/utils/paths.js');
const users = await import('../dist/services/userService.js');
const { createToken } = await import('../dist/auth/tokens.js');
const sftpService = await import('../dist/services/sftpService.js');
let http, client;
const waitFor = async (check, label) => { for (let n = 0; n < 150; n++) { if (await check()) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('Timed out: ' + label); };
try {
  const admin = users.createUser('av-admin', 'test-password-123', 'admin'), viewer = users.createUser('av-viewer', 'test-password-123', 'viewer');
  db.prepare('INSERT INTO servers(id,name,platform,loader,version,status) VALUES (?,?,?,?,?,?)').run('av-instance', 'Antivirus fixture', 'java', 'forge', '1.21.1', 'stopped');
  fs.mkdirSync(instanceDir('av-instance'), { recursive: true }); users.setUserServerAccess(viewer.id, ['av-instance']);
  const token = u => createToken(u.id, u.username, u.role);
  const app = express(); app.use(express.json());
  app.use((q, _r, next) => { if (q.headers.authorization === 'Bearer browser-fixture') q.headers.authorization = `Bearer ${token(admin)}`; next(); });
  app.use('/api/auth', authRouter); app.use('/api/antivirus', antivirusRouter); app.use('/api/servers/:serverId/antivirus', instanceAntivirusRouter); app.use('/api/servers/:serverId/files', filesRouter);
  app.use('/api/servers/:serverId/plugins', pluginsRouter);
  app.use((err, _q, r, _next) => r.status(err.status ?? 500).json({ error: err.message }));
  http = app.listen(0, '127.0.0.1'); await once(http, 'listening'); const origin = `http://127.0.0.1:${http.address().port}`;
  const request = (route, method = 'GET', body, user = admin) => fetch(origin + '/api' + route, { method, headers: { ...(user ? { Authorization: `Bearer ${token(user)}` } : {}), ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}) });
  assert.equal((await request('/antivirus', 'GET', null, viewer)).status, 403);
  assert.equal((await request('/antivirus', 'GET', null, null)).status, 401);
  assert.equal((await request('/servers/av-instance/antivirus', 'GET', null, viewer)).status, 200);
  assert.equal(av.scanVerdict({ code: 2, output: 'payload: Fixture.Signature FOUND\nERROR: another file unreadable' }).status, 'detected', 'partial scans with findings must still trigger a hold');
  assert.throws(() => av.scanVerdict({ code: 1, output: '' }), { status: 503 });
  const config = { enabled: true, executable: 'clamscan', updater: 'freshclam', database: '', stopOnDetection: false };
  mode = 'missing'; assert.equal((await request('/antivirus/config', 'PUT', config)).status, 503); assert.equal(av.protectionEnabled(), false);
  mode = 'normal'; assert.equal((await request('/antivirus/config', 'PUT', config)).status, 200);
  assert.equal((await request('/antivirus/config', 'PUT', { ...config, executable: 'clamscan --remove' })).status, 400);
  // Resumable upload and recycle restoration must use the same fail-closed scanner gate.
  const staged = async (content, name) => {
    const bytes = Buffer.from(content);
    const response = await request('/servers/av-instance/files/transfers', 'POST', { path: name, size: bytes.length, hashes: [createHash('sha256').update(bytes).digest('hex')], collision: 'replace' });
    assert.equal(response.status, 201, await response.clone().text()); const transfer = await response.json();
    assert.equal((await fetch(origin + `/api/servers/av-instance/files/transfers/${transfer.id}/chunk`, { method: 'PUT', headers: {Authorization: `Bearer ${token(admin)}`, 'Content-Type': 'application/octet-stream', 'Upload-Offset': '0'}, body: bytes })).status, 200);
    return transfer;
  };
  const badTransfer = await staged('OUTPOST_TEST_THREAT', 'staged-bad.jar');
  assert.equal((await request(`/servers/av-instance/files/transfers/${badTransfer.id}/complete`, 'POST')).status, 422);
  assert.equal(fs.existsSync(path.join(instanceDir('av-instance'), 'staged-bad.jar')), false);
  const safeTransfer = await staged('safe staged fixture', 'staged-safe.txt');
  mode = 'error'; assert.equal((await request(`/servers/av-instance/files/transfers/${safeTransfer.id}/complete`, 'POST')).status, 503);
  assert.equal(fs.existsSync(path.join(instanceDir('av-instance'), 'staged-safe.txt')), false);
  mode = 'normal'; assert.equal((await request(`/servers/av-instance/files/transfers/${safeTransfer.id}/complete`, 'POST')).status, 200);
  fs.writeFileSync(path.join(instanceDir('av-instance'), 'recycled-bad.txt'), 'OUTPOST_TEST_THREAT');
  assert.equal((await request('/servers/av-instance/files?path=recycled-bad.txt', 'DELETE')).status, 204);
  const recycled = (await (await request('/servers/av-instance/files/recycle')).json()).items.find(i => i.path === 'recycled-bad.txt');
  assert.equal((await request(`/servers/av-instance/files/recycle/${recycled.id}/restore`, 'POST')).status, 422);
  assert.equal(fs.existsSync(path.join(instanceDir('av-instance'), 'recycled-bad.txt')), false);
  const form = (files) => { const data = new FormData(); for (const [name, content] of files) data.append('files', new Blob([content]), name); return data; };
  const upload = files => request('/servers/av-instance/files/upload', 'POST', form(files));
  const old = path.join(instanceDir('av-instance'), 'existing.txt'); fs.writeFileSync(old, 'original');
  assert.equal((await upload([['existing.txt', 'OUTPOST_TEST_THREAT']])).status, 422);
  assert.equal(fs.readFileSync(old, 'utf8'), 'original', 'detected overwrite preserves original');
  assert.equal((await upload([['first.txt', 'clean'], ['bad.zip', 'OUTPOST_TEST_THREAT']])).status, 422);
  assert.equal(fs.existsSync(path.join(instanceDir('av-instance'), 'first.txt')), false, 'batch is checked before any file is published');
  assert.equal((await upload([['safe.txt', 'clean']])).status, 201);
  const modArchive = new AdmZip(); modArchive.addFile('example/Fixture.class', Buffer.from('OUTPOST_TEST_THREAT'));
  const safeModArchive = new AdmZip(); safeModArchive.addFile('example/Safe.class', Buffer.from('safe fixture class bytes'));
  assert.equal((await request('/servers/av-instance/plugins/upload', 'POST', form([['bad-mod.jar', modArchive.toBuffer()]]))).status, 422);
  assert.equal(fs.existsSync(path.join(instanceDir('av-instance'), 'mods', 'bad-mod.jar')), false, 'mod upload is scanned before the installer writes it');
  assert.equal((await request('/servers/av-instance/plugins/upload', 'POST', form([['safe-mod.jar', safeModArchive.toBuffer()]]))).status, 201);
  assert.equal((await upload([['uploaded-mod.jar', modArchive.toBuffer()]])).status, 422, 'archive contents are included in the scanner contract');
  assert.equal(fs.existsSync(path.join(instanceDir('av-instance'), 'uploaded-mod.jar')), false);
  mode = 'error'; assert.equal((await upload([['error.txt', 'clean']])).status, 503); assert.equal(fs.existsSync(path.join(instanceDir('av-instance'), 'error.txt')), false);
  mode = 'warning'; assert.equal((await upload([['warning.txt', 'clean']])).status, 503);
  mode = 'normal'; assert.equal((await request('/servers/av-instance/files/content', 'PUT', { path: 'existing.txt', content: 'OUTPOST_TEST_THREAT' })).status, 422);
  assert.equal(fs.readFileSync(old, 'utf8'), 'original');
  const deniedCalls = calls; assert.equal((await request('/servers/av-instance/files/upload', 'POST', form([['forbidden', 'clean']]), viewer)).status, 403); assert.equal(calls, deniedCalls, 'permission denied before scanning');
  assert.ok(av.quarantineRows().length >= 3); const blocked = av.quarantineRows()[0]; assert.equal(blocked.retained, 1); assert.equal(blocked.sha256.length, 64);
  assert.equal(fs.existsSync(path.join(temp, 'antivirus', `${blocked.id}.bin`)), true);
  assert.equal((await request(`/antivirus/quarantine/${blocked.id}`, 'DELETE', null, viewer)).status, 403);
  assert.equal((await request(`/antivirus/quarantine/${blocked.id}`, 'DELETE')).status, 200);
  assert.equal(fs.existsSync(path.join(temp, 'antivirus', `${blocked.id}.bin`)), false);
  fs.writeFileSync(path.join(instanceDir('av-instance'), 'finding.txt'), 'OUTPOST_TEST_THREAT');
  const scan = av.startInstanceScan('av-instance'); assert.throws(() => av.startInstanceScan('av-instance'), { status: 409 });
  await waitFor(() => av.scanRows('av-instance').find(s => s.id === scan.id)?.status === 'detected', 'scan detection');
  assert.equal(av.securityHold('av-instance'), true); assert.throws(() => av.assertNoSecurityHold('av-instance'), { status: 423 });
  fs.unlinkSync(path.join(instanceDir('av-instance'), 'finding.txt'));
  await waitFor(() => { try { av.startInstanceScan('av-instance'); return true; } catch { return false; } }, 'clean scan enqueue');
  await waitFor(() => !av.securityHold('av-instance'), 'clean scan clears hold');
  mode = 'hang'; await waitFor(() => { try { av.startInstanceScan('av-instance'); return true; } catch { return false; } }, 'cancel scan enqueue');
  await waitFor(() => av.scanRows('av-instance')[0].status === 'running', 'scan running'); av.cancelInstanceScan('av-instance');
  await waitFor(() => av.scanRows('av-instance')[0].status === 'cancelled', 'scan cancelled'); assert.ok(killed);
  mode = 'normal';
  assert.equal((await request('/antivirus/schedule/av-instance', 'PUT', { expression: 'invalid', enabled: true })).status, 400);
  assert.equal((await request('/antivirus/schedule/av-instance', 'PUT', { expression: '0 3 * * *', enabled: true })).status, 200);
  av.stopAntivirus(); av.initAntivirus(); assert.equal(av.antivirusSchedules()[0].enabled, 1, 'schedule persists through initialization');
  assert.equal((await request('/antivirus/signatures', 'POST')).status, 200);
  // Verify staging and rejection through the real SFTP protocol, not only the HTTP gate.
  const reserve = net.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening'); const port = reserve.address().port; await new Promise(r => reserve.close(r));
  sftpService.setSftpPassword(admin.id, 'sftp-test-password-123'); await sftpService.saveSftpSettings({ enabled: true, port });
  client = new ssh2.Client(); client.connect({ host: '127.0.0.1', port, username: 'av-admin.av-insta', password: 'sftp-test-password-123', readyTimeout: 10000 }); await once(client, 'ready');
  const sftp = await new Promise((resolve, reject) => client.sftp((e, s) => e ? reject(e) : resolve(s)));
  const sftpWrite = (name, text) => new Promise((resolve, reject) => sftp.writeFile(name, Buffer.from(text), e => e ? reject(e) : resolve()));
  await assert.rejects(sftpWrite('existing.txt', 'OUTPOST_TEST_THREAT')); assert.equal(fs.readFileSync(old, 'utf8'), 'original');
  await sftpWrite('sftp-safe.txt', 'safe SFTP content'); assert.equal(fs.readFileSync(path.join(instanceDir('av-instance'), 'sftp-safe.txt'), 'utf8'), 'safe SFTP content');
  client.end(); await once(client, 'close'); client = null; await sftpService.stopSftp();
  assert.ok(fs.readdirSync(path.join(temp, 'antivirus')).every(n => !n.startsWith('incoming-')), 'private staging is cleaned');
  // Real native filesystem events plus reconciliation detect out-of-band mod changes.
  const mods = path.join(instanceDir('av-instance'), 'mods'); fs.mkdirSync(mods, { recursive: true }); fs.writeFileSync(path.join(mods, 'existing.jar'), 'safe initial mod');
  const liveWait = async (check, label) => { for (let n = 0; n < 500; n++) { await av.reconcileRealtime(); if (await check()) return; await new Promise(r => setTimeout(r, 25)); } throw new Error('Timed out: ' + label); };
  assert.equal((await request('/antivirus/config', 'PUT', { ...config, realtime: true })).status, 200);
  await liveWait(() => av.scanRows('av-instance').some(s => s.source === 'realtime' && s.status === 'clean'), 'initial mod inventory scan');
  assert.equal(av.realtimeAntivirusStatus().enabled, true);
  fs.writeFileSync(path.join(mods, 'external-mod.jar'), modArchive.toBuffer());
  await liveWait(() => av.scanRows('av-instance').some(s => s.source === 'realtime' && s.status === 'detected'), 'external mod detected');
  assert.equal(av.securityHold('av-instance'), true);
  const liveReport = av.scanRows('av-instance').find(s => s.source === 'realtime' && s.status === 'detected');
  assert.ok(liveReport.report.findings.some(f => f.includes('mods/external-mod.jar')));
  assert.equal(fs.existsSync(path.join(mods, 'external-mod.jar')), true, 'live monitor is non-destructive');
  await liveWait(() => !av.realtimeAntivirusStatus().scanning, 'monitor idle');
  const unchangedCalls = calls; await av.reconcileRealtime(); assert.equal(calls, unchangedCalls, 'unchanged files do not rescan on every tick');
  fs.writeFileSync(path.join(mods, 'external-mod.jar'), 'fixed mod');
  await liveWait(() => av.scanRows('av-instance').some(s => s.source === 'realtime' && s.status === 'clean' && s.started_at > liveReport.started_at), 'changed mod rescanned');
  assert.equal(av.securityHold('av-instance'), true, 'a partial live clean result cannot clear a whole-instance hold');
  av.startInstanceScan('av-instance'); await liveWait(() => !av.securityHold('av-instance'), 'full clean scan clears hold');
  mode = 'error'; fs.writeFileSync(path.join(mods, 'changed-during-outage.jar'), 'safe content but scanner unavailable');
  await liveWait(() => !!av.realtimeAntivirusStatus().error, 'live scanner error is visible');
  assert.ok(av.scanRows('av-instance').some(s => s.source === 'realtime' && s.status === 'error'));
  assert.equal((await request('/antivirus/config', 'PUT', { ...config, realtime: false })).status, 200);
  mode = 'normal';
  assert.equal(av.realtimeAntivirusStatus().enabled, false);
  const disabledCalls = calls; fs.writeFileSync(path.join(mods, 'disabled.jar'), 'OUTPOST_TEST_THREAT'); await av.reconcileRealtime(); assert.equal(calls, disabledCalls, 'disabled monitor does not scan');
  assert.equal((await request('/antivirus/config', 'PUT', { ...config, enabled: false, realtime: true })).status, 400);
  if (process.env.OUTPOST_TEST_BROWSER_UI === '1') {
    childProcess.spawn = originalSpawn; syncBuiltinESMExports();
    const { runBrowser } = await import('./browserHarness.mjs');
    app.get('/api/servers', (_q, r) => r.json({ servers: db.prepare('SELECT * FROM servers').all(), metrics: {} }));
    app.get('/api/servers/:serverId', (q, r) => r.json({ server: db.prepare('SELECT * FROM servers WHERE id=?').get(q.params.serverId), permissions: [...users.SERVER_PERMISSIONS], running: false, runtime: null }));
    app.use('/api', (_q, r) => r.status(503).json({ error: 'Outside fixture scope' }));
    app.use(express.static(path.resolve('web/dist'))); app.get('*', (_q, r) => r.sendFile(path.resolve('web/dist/index.html')));
    await runBrowser(origin, async ({ navigate, text, evaluate, viewport, captureScreenshot }) => {
      await navigate('/configuration/operations?section=antivirus'); await text('Upload scanning enabled'); await text('Fixture.Signature'); await text('Scan instance now');
      await text('Monitor mod and plugin folders continuously');
      assert.equal(await evaluate("[...document.querySelectorAll('label')].find(l=>l.textContent.includes('Monitor mod and plugin folders continuously')).querySelector('input').checked"), false);
      await viewport(390, 844); assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
      if (process.env.OUTPOST_AV_SCREENSHOT) await captureScreenshot(process.env.OUTPOST_AV_SCREENSHOT);
      await navigate('/instances/av-instance/plugins'); await text('Mod uploads, including supported JAR/ZIP contents, are scanned before installation.');
    });
  }
  console.log('Antivirus: mod archive/upload gating, live change detection, unchanged-file caching, scanner errors, holds, editor/SFTP staging, quarantine, cancellation, permissions and schedules passed (fixture engine).');
} finally {
  av.stopAntivirus(); if (client) client.destroy(); await sftpService.stopSftp();
  if (http) { http.closeAllConnections(); await new Promise(r => http.close(r)); }
  childProcess.spawn = originalSpawn; syncBuiltinESMExports(); db.close(); fs.rmSync(temp, { recursive: true, force: true });
}
