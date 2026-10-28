// Browser smoke test against simulated guests. Requires a production build and Chrome/Edge.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';

const browserPath = process.env.OUTPOST_TEST_BROWSER ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'outpost-vm-browser-'));
const uuid = '01234567-89ab-cdef-0123-456789abcdef';
const user = { id: 'browser-test', username: 'vmdelegate', role: 'viewer', vmAccess: [{ uri: 'qemu:///system', uuid, permissions: ['view', 'console'] }] };
const app = express(); app.use(express.json());
app.get('/api/auth/status', (_req, res) => res.json({ setupRequired: false }));
app.get('/api/auth/me', (_req, res) => res.json({ user }));
app.get('/api/system', (_req, res) => res.status(503).json({ error: 'System inventory is outside this fixture' }));
app.get('/api/libvirt/vms', (_req, res) => res.json({ machines: [{ uuid, name: 'Browser test VM', state: 'running', cpus: 2, memoryMb: 1024, maxMemoryMb: 4096, persistent: true, autostart: false, permissions: ['view', 'console'] }], connection: '' }));
app.get(`/api/libvirt/vms/${uuid}/preview`, (_req, res) => res.status(422).json({ error: 'Preview intentionally unavailable in fixture' }));
app.post(`/api/libvirt/vms/${uuid}/console-ticket`, (req, res) => res.json({ ticket: req.body.protocol, protocol: req.body.protocol }));
app.use('/api', (_req, res) => res.json({ servers: [], notifications: [], count: 0 }));
app.use(express.static(path.resolve('web/dist')));
app.get('*', (_req, res) => res.sendFile(path.resolve('web/dist/index.html')));
const server = http.createServer(app), wss = new WebSocketServer({ server });
let spiceStarted = false, vncStarted = false;
wss.on('connection', (ws, req) => {
  if (new URL(req.url, 'http://localhost').searchParams.get('ticket') === 'spice') {
    ws.on('message', bytes => { if (bytes.subarray(0, 4).toString() === 'REDQ') spiceStarted = true; });
    return;
  }
  ws.send(Buffer.from('RFB 003.008\n')); let stage = 0;
  ws.on('message', () => {
    if (stage === 0) { stage++; ws.send(Buffer.from([1, 1])); }
    else if (stage === 1) { stage++; ws.send(Buffer.alloc(4)); }
    else if (stage === 2) {
      stage++; const name = Buffer.from('Fixture'); const init = Buffer.alloc(24 + name.length);
      init.writeUInt16BE(2, 0); init.writeUInt16BE(2, 2); init[4] = 32; init[5] = 24; init[7] = 1;
      init.writeUInt16BE(255, 8); init.writeUInt16BE(255, 10); init.writeUInt16BE(255, 12); init[14] = 16; init[15] = 8;
      init.writeUInt32BE(name.length, 20); name.copy(init, 24); ws.send(init); vncStarted = true;
    }
  });
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = spawn(browserPath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
let devtools, inspect; let serial = 0; const pending = new Map(); const exceptions = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, description, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(100); }
  throw new Error(`Timed out: ${description}`);
}
try {
  let debugPort;
  await until(async () => { try { debugPort = Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); return !!debugPort; } catch { return false; } }, 'browser startup');
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  devtools = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl); await once(devtools, 'open');
  devtools.on('message', bytes => {
    const data = JSON.parse(bytes);
    if (data.method === 'Runtime.exceptionThrown') exceptions.push(data.params.exceptionDetails.exception?.description ?? data.params.exceptionDetails.text);
    if (data.id) { const request = pending.get(data.id); pending.delete(data.id); data.error ? request.reject(new Error(data.error.message)) : request.resolve(data.result); }
  });
  function cdp(method, params = {}) { return new Promise((resolve, reject) => { const id = ++serial; pending.set(id, { resolve, reject }); devtools.send(JSON.stringify({ id, method, params })); }); }
  async function evaluate(expression) { const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text); return result.result.value; }
  inspect = evaluate;
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('outpost_token', 'browser-fixture')" });
  await cdp('Page.navigate', { url: origin + '/libvirt' });
  await until(() => evaluate("document.body?.innerText.includes('Interactive console')"), 'VM page');
  assert.equal(await evaluate(`!!document.querySelector('a[href="/libvirt/configuration"]')`), false, 'delegate must not see host settings');
  await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent === 'Connect').click()");
  await until(() => vncStarted, 'VNC protocol initialization');
  await until(() => evaluate("[...document.querySelectorAll('[role=status]')].some(e => e.textContent.startsWith('Connected.')) && !!document.querySelector('canvas')"), 'VNC canvas');
  await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent === 'Disconnect').click()");
  await evaluate("const select = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'spice')); select.value = 'spice'; select.dispatchEvent(new Event('change', { bubbles: true }));");
  await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent === 'Connect').click()");
  await until(() => spiceStarted, 'SPICE protocol initialization');
  await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent === 'Disconnect').click()");
  assert.deepEqual(exceptions, []);
  console.log('Browser VM page, delegated navigation, noVNC handshake/canvas, SPICE initialization and disconnect cleanup passed with simulated guests');
} catch (error) {
  console.error({ page: await inspect?.('({ text: document.body?.innerText, url: location.href, html: document.documentElement.outerHTML.slice(-2000) })'), exceptions }); throw error;
} finally {
  devtools?.close(); browser.kill();
  for (const ws of wss.clients) ws.terminate();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  // Browser shutdown can briefly hold profile files open on Windows.
  await delay(500); await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
