import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import express from 'express';
import { WebSocketServer } from 'ws';
import { runBrowser } from './browserHarness.mjs';

const artifacts = path.resolve('artifacts/firewall-instances'); await fs.mkdir(artifacts, { recursive: true });
const base = { platform: 'java', loader: 'paper', version: '1.21.1', server_port: 25565, name: 'Minecraft friends', status: 'stopped', created_at: '2026-11-16T12:00:00Z', min_memory_mb: 256, max_memory_mb: 1024, suspended: 0, launch_config: null };
const servers = {
  minecraft: { ...base, id: 'minecraft' },
  cs2: { ...base, id: 'cs2', name: 'CS2 friends', platform: 'steam', loader: 'steam', steam_preset: 'cs2', steam_app_id: '730', server_port: 27025 },
  beammp: { ...base, id: 'beammp', name: 'BeamMP friends', platform: 'custom', loader: 'custom', server_port: 30814, launch_config: JSON.stringify({ executable: 'BeamMP-Server', env: [{ key: 'BEAMMP_PRIVATE', value: 'true' }] }) },
};
let access = 'manage', unavailable = false, partial = false;
const requests = [], configured = new Set();
function info(id) {
  const port = id === 'minecraft' ? 25580 : servers[id].server_port;
  const protocols = id === 'beammp' ? ['tcp', 'udp'] : id === 'cs2' ? ['udp'] : ['tcp'];
  return {
    access,
    status: { available: !unavailable, backend: id === 'minecraft' ? 'ufw' : 'firewalld', active: true, reason: unavailable ? 'Outpost does not have permission to run the firewall tool.' : null, sudoersHint: null, zone: id === 'minecraft' ? null : 'public', rules: [], protectedPorts: [], canToggle: id === 'minecraft' },
    ports: protocols.map(protocol => ({ serverId: id, name: servers[id].name, port, protocol, source: id === 'minecraft' ? 'server.properties: server-port' : id === 'cs2' ? 'Game launch port override' : 'BeamMP launch environment', configured: configured.has(`${id}/${protocol}`) })),
  };
}
const app = express(); app.use(express.json());
app.get('/api/auth/status', (_q, r) => r.json({ setupRequired: false }));
app.get('/api/auth/me', (_q, r) => r.json({ user: { id: 'user', username: 'Firewall tester', role: access === 'manage' ? 'admin' : 'viewer', firewall: access, theme: null }, creation: { canCreate: false, allowedPlatforms: [], containers: 'none', maxInstances: 0, maxMemoryMb: 0, owned: 0 } }));
app.get('/api/servers', (_q, r) => r.json({ servers: Object.values(servers), metrics: {} }));
app.get('/api/servers/:id', (q, r) => r.json({ server: servers[q.params.id], runtime: null, running: false, permissions: ['files.read'], autoRestart: { attempts: 0, pendingAt: null } }));
app.get('/api/servers/:id/endpoint', (q, r) => r.json({ host: '192.0.2.10', port: servers[q.params.id].server_port, protocol: q.params.id === 'cs2' ? 'udp' : 'tcp', hostname: 'test-host', addresses: [], bindAddress: '0.0.0.0', webUrl: null }));
app.get('/api/servers/:id/resources', (_q, r) => r.json({ runtime: null, running: false, disk: { serverBytes: 10000, backupsBytes: 0 }, host: { totalMemMb: 8192, freeMemMb: 4096, cpuCores: 4, loadAvg: 0 } }));
app.get('/api/firewall/instances/:id', (q, r) => r.json(info(q.params.id)));
app.post('/api/firewall/instances/:id/allow', (q, r) => {
  const id = q.params.id; requests.push({ id, body: q.body ?? null });
  const result = info(id), added = [], existing = [], failed = [];
  for (const port of result.ports) {
    if (partial && port.protocol === 'udp') { failed.push({ ...port, error: 'Fixture UDP rule failed' }); continue; }
    (port.configured ? existing : added).push(port); configured.add(`${id}/${port.protocol}`);
  }
  r.json({ ...info(id), added, existing, failed });
});
app.use('/api', (_q, r) => r.status(503).json({ error: 'Outside firewall fixture scope' }));
app.use(express.static(path.resolve('web/dist'))); app.get('*', (_q, r) => r.sendFile(path.resolve('web/dist/index.html')));
const http = app.listen(0, '127.0.0.1'); await once(http, 'listening');
const sockets = new WebSocketServer({ server: http }); sockets.on('connection', socket => socket.send(JSON.stringify({ type: 'hello', status: 'stopped', runtime: null, history: [] })));
try {
  await runBrowser(`http://127.0.0.1:${http.address().port}`, async ({ navigate, text, click, evaluate, until, viewport, captureScreenshot }) => {
    await viewport(1440, 1100);
    await navigate('/instances/minecraft/status'); await text('server.properties: server-port'); await text('Allow server ports');
    const card = `document.querySelector('[aria-label="Server firewall"]')`;
    assert(await evaluate(`${card}.innerText.includes('25580/tcp')`));
    assert(await evaluate(`${card}.innerText.includes('UFW')`));
    await evaluate(`${card}.scrollIntoView({block:'center'})`); await captureScreenshot(path.join(artifacts, 'minecraft-ufw-desktop.png'));
    await click('Allow server ports'); await text('Allow rule present');
    assert.deepEqual(requests[0], { id: 'minecraft', body: {} }, 'One click sends only the instance id, without a port/command or confirmation step');
    await click('Allow server ports'); await until(() => Promise.resolve(requests.length === 2), 'Idempotent repeated click');
    await navigate('/instances/cs2/status'); await text('Game launch port override');
    assert(await evaluate(`${card}.innerText.includes('27025/udp') && ${card}.innerText.includes('firewalld')`));
    await click('Allow server ports'); await text('Allow rule present'); assert.equal(requests.at(-1).id, 'cs2');
    partial = true; await navigate('/instances/beammp/status'); await text('BeamMP launch environment');
    await click('Allow server ports'); await text('Fixture UDP rule failed');
    assert(await evaluate(`${card}.innerText.includes('30814/tcp') && ${card}.innerText.includes('30814/udp')`));
    partial = false; await click('Allow server ports'); await until(() => evaluate(`![...${card}.querySelectorAll('[role="alert"]')].length`), 'Partial retry clears the failure');
    access = 'view'; await navigate('/instances/minecraft/status'); await text('Your account can view firewall rules.');
    assert(!await evaluate(`${card}.innerText.includes('Allow server ports')`), 'Read-only users do not get the allow action');
    access = 'manage'; unavailable = true; await navigate('/instances/minecraft/status'); await text('Outpost does not have permission');
    assert(await evaluate(`[...${card}.querySelectorAll('button')].find(e=>e.textContent==='Allow server ports').disabled`));
    unavailable = false; await navigate('/instances/cs2/status'); await text('Game launch port override');
    await viewport(390, 844); await evaluate(`${card}.scrollIntoView({block:'center'})`);
    await captureScreenshot(path.join(artifacts, 'cs2-firewalld-mobile.png'));
    assert(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), 'No horizontal overflow on mobile');
  }, { artifactDirectory: artifacts });
  console.log('Firewall browser: Minecraft/UFW, CS2/firewalld, one-click requests, repeats, multi-port partial retry, read-only/permission states and mobile layout passed.');
} finally {
  for (const socket of sockets.clients) socket.terminate();
  await new Promise(resolve => sockets.close(resolve)); http.closeAllConnections(); await new Promise(resolve => http.close(resolve));
}
