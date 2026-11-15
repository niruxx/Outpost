// Disposable HTTP/socket fixtures for instance header, console/sidebar and overview UI.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import express from 'express';
import { WebSocketServer } from 'ws';
import { runBrowser } from './browserHarness.mjs';

const artifacts = path.resolve('artifacts/instance-ui');
await fs.mkdir(artifacts, { recursive: true });
const permissions = ['console', 'settings', 'power', 'players', 'files.read', 'files.write', 'backup', 'tasks', 'plugins'];
const base = { name: 'Instance with a long title for layout checks', platform: 'java', loader: 'fabric', version: '1.21.1', build: null, server_port: 25565, status: 'running', created_at: '2026-10-01T12:00:00Z', auto_start: 1, restart_policy: 'on-crash', min_memory_mb: 1024, max_memory_mb: 4096, suspended: 0 };
const servers = {
  java: { ...base, id: 'java' },
  bedrock: { ...base, id: 'bedrock', platform: 'bedrock', loader: 'bedrock' },
  steam: { ...base, id: 'steam', platform: 'steam', loader: 'steam', steam_preset: 'tf2', steam_app_id: '232250' },
  custom: { ...base, id: 'custom', platform: 'custom', loader: 'custom' },
  proxy: { ...base, id: 'proxy', loader: 'velocity' },
  stopped: { ...base, id: 'stopped', status: 'stopped' },
};
const stats = { memoryMb: 512, cpuPercent: 8, diskReadBytes: null, diskWriteBytes: null, diskReadRate: null, diskWriteRate: null, netRxBytes: null, netTxBytes: null, netRxRate: null, netTxRate: null };
const runtime = { pid: 1234, uptimeMs: 3720000, stats };
const faults = { roster: false, empty: false, delay: 0, readOnly: false };
const reads = new Map(), mutations = [];
const app = express();
app.use(express.json());
app.use('/api', (q, _r, next) => { if (!['GET', 'HEAD'].includes(q.method) && !['/activity/presence', '/activity/leave'].includes(q.path)) mutations.push(`${q.method} ${q.path}`); next(); });
app.get('/api/auth/status', (_q, r) => r.json({ setupRequired: false }));
app.get('/api/auth/me', (_q, r) => r.json({ user: { id: 'owner', username: 'UI reviewer', role: 'admin', theme: null }, creation: { canCreate: true, platforms: [], allowedPlatforms: [], maxInstances: 0, maxMemoryMb: 0, owned: 6 } }));
app.get('/api/servers', (_q, r) => r.json({ servers: Object.values(servers), metrics: {} }));
app.get('/api/servers/:id', (q, r) => r.json({ server: servers[q.params.id], runtime, running: servers[q.params.id].status === 'running', permissions: faults.readOnly ? ['files.read'] : permissions, owner: { id: 'owner', username: 'UI reviewer' }, autoRestart: { attempts: 0, pendingAt: null } }));
app.get('/api/servers/:id/endpoint', (_q, r) => r.json({ host: '192.0.2.10', port: 25565, protocol: 'tcp', hostname: 'test-host', addresses: [], bindAddress: '0.0.0.0', webUrl: null }));
app.get('/api/system/public-address', (_q, r) => r.json({ address: '192.0.2.20', behindNat: false, source: 'lookup' }));
app.get('/api/servers/:id/resources', (_q, r) => r.json({ runtime, running: true, disk: { serverBytes: 10000, backupsBytes: 1000 }, host: { totalMemMb: 8192, freeMemMb: 4096, cpuCores: 4, loadAvg: 0.5 } }));
app.get(['/api/servers/:id/players', '/api/servers/:id/query/players'], async (q, r) => {
  const id = q.params.id, fail = faults.roster, empty = faults.empty;
  reads.set(id, (reads.get(id) ?? 0) + 1);
  if (faults.delay) await new Promise(resolve => setTimeout(resolve, faults.delay));
  if (fail) return r.status(503).json({ error: 'Fixture query timed out' });
  if (id === 'steam') return r.json({ players: empty ? [] : [{ name: 'Steam friend', ping: 24, score: 10, durationSec: 125, bot: false }], info: { players: empty ? 0 : 1, maxPlayers: 24 }, at: new Date().toISOString(), error: null, running: true });
  r.json({ players: empty ? [] : [{ name: id === 'bedrock' ? 'Bedrock friend' : 'Alex', online: true, op: true, whitelisted: true }, { name: 'Offline player', online: false }] });
});
app.get('/api/events', (_q, r) => r.json({ events: [] }));
app.use('/api', (_q, r) => r.status(503).json({ error: 'Outside fixture scope' }));
app.use(express.static(path.resolve('web/dist')));
app.get('*', (_q, r) => r.sendFile(path.resolve('web/dist/index.html')));
const http = app.listen(0, '127.0.0.1'); await once(http, 'listening');
const wss = new WebSocketServer({ server: http });
wss.on('connection', socket => socket.send(JSON.stringify({ type: 'hello', status: 'running', runtime, history: Array.from({ length: 70 }, (_, i) => `Console output ${i}`) })));
try {
  await runBrowser(`http://127.0.0.1:${http.address().port}`, async ({ navigate, text, click, evaluate, until, viewport, captureScreenshot }) => {
    await viewport(1440, 1000);
    await navigate('/instances/java/console'); await text('Alex'); await text('Operator'); await text('1h 2m');
    const bannerFits = () => evaluate(`(() => { const a=[...document.querySelectorAll('a')].find(e=>e.textContent==='Customize banner');if(!a)return false;const b=a.getBoundingClientRect(),h=a.closest('header').getBoundingClientRect();return b.left>=h.left+4 && b.right<=h.right-4 && b.top>=h.top+4 && b.bottom<=h.bottom && document.elementFromPoint(b.left+b.width/2,b.top+b.height/2)?.closest('a')===a; })()`);
    await until(bannerFits, 'banner button fully inside header and clickable');
    assert(await evaluate(`(() => {const m=document.querySelector('[data-console-main]').getBoundingClientRect(),s=document.querySelector('aside[aria-label="Console information"]').getBoundingClientRect();return s.left>=m.right && m.width>400;})()`), 'Desktop roster sits to the right of console');
    assert(!await evaluate(`document.querySelector('[aria-label="Player roster"]').innerText.includes('Offline player')`));
    await captureScreenshot(path.join(artifacts, 'console-desktop.png'));
    for (const theme of ['outpost', 'classic', 'minecraft', 'xp', 'vista', 'aero']) {
      await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      for (const width of [320, 390, 768, 1280]) {
        await viewport(width, 900); await until(bannerFits, `banner containment ${theme}/${width}`);
        assert(await evaluate('document.documentElement.scrollWidth<=innerWidth+2'), `No horizontal overflow ${theme}/${width}`);
      }
    }
    await evaluate("document.documentElement.dataset.theme='outpost'"); await viewport(390, 844);
    assert(await evaluate(`(() => {const m=document.querySelector('[data-console-main]').getBoundingClientRect(),s=document.querySelector('aside[aria-label="Console information"]').getBoundingClientRect();return s.top>=m.bottom;})()`), 'Mobile roster moves below console');
    await captureScreenshot(path.join(artifacts, 'console-mobile.png'));
    faults.roster = true; await click('Refresh players'); await text('showing the last successful snapshot'); await text('Fixture query timed out');
    assert(await evaluate(`document.querySelector('[aria-label="Player roster"]').innerText.includes('Alex')`));
    faults.roster = false; faults.empty = true; await click('Refresh players'); await text('Nobody is online.');
    faults.empty = false; await navigate('/instances/bedrock/console'); await text('Bedrock friend');
    await navigate('/instances/steam/console'); await text('Steam friend'); await text('24 ms'); await text('Session 2m');
    await navigate('/instances/custom/console'); await text('A live player list is not available');
    await navigate('/instances/proxy/console'); await text('A live player list is not available');
    await navigate('/instances/stopped/console'); await text('The instance is stopped.');
    assert.equal(reads.get('custom'), undefined); assert.equal(reads.get('proxy'), undefined); assert.equal(reads.get('stopped'), undefined);
    faults.readOnly = true; await navigate('/instances/java/console'); await text('Console is read-only'); await text('Alex');
    assert(!await evaluate(`!!document.querySelector('input[placeholder*="command"]')`));
    assert(!await evaluate(`[...document.querySelectorAll('a')].some(a=>a.textContent==='Customize banner')`));
    faults.readOnly = false; faults.delay = 500;
    await navigate('/instances/java/console'); await text('Connected players');
    await evaluate(`document.querySelector('[data-console-main]') && window.history.pushState({},'', '/instances/bedrock/console');window.dispatchEvent(new PopStateEvent('popstate'));`);
    await text('Bedrock friend');
    assert(!await evaluate(`document.querySelector('[aria-label="Player roster"]').innerText.includes('Alex')`), 'Late response does not leak previous instance players'); faults.delay = 0;
    await viewport(1440, 1000); await navigate('/instances/java/status'); await text('Instance details'); await text('Automatic recovery'); await text('Restart on crash'); await text('Browse files'); await text('Latest console output');
    await captureScreenshot(path.join(artifacts, 'status-desktop.png'));
    await click('Customize banner'); await until(() => evaluate(`location.pathname==='/instances/java/configuration' && location.search==='?section=artwork'`), 'banner settings link destination');
    assert.deepEqual(mutations, [], 'Information panels do not mutate instance or player settings');
  }, { artifactDirectory: artifacts });
  console.log('Instance UI: banner bounds across six themes and four widths, console roster/sidebar, Java/Bedrock/Steam players, stale/error/empty/offline states, instance isolation, read-only access and status details passed.');
} finally {
  for (const socket of wss.clients) socket.terminate();
  await new Promise(resolve => wss.close(resolve)); http.closeAllConnections(); await new Promise(resolve => http.close(resolve));
}
