import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import http from 'node:http';
import { WebSocket } from 'ws';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'outpost-host-terminal-'));
process.env.OUTPOST_DATA_DIR = dir;
const source = process.env.OUTPOST_TEST_SOURCE === '1';
const load = (file) => import(new URL(`../${source ? 'src' : 'dist'}/${file}.${source ? 'ts' : 'js'}`, import.meta.url));
const { db } = await load('db/db');
const terminal = await load('services/hostTerminalService');
const users = await load('services/userService');
const { createToken } = await load('auth/tokens');
const { createKey } = await load('services/apiKeyService');
const { terminalRouter } = await load('routes/terminal.routes');
let server;
let wss;
const sockets = [];
try {
  const options = { mode: 'service', cols: 100, rows: 30 };
  assert.deepEqual(terminal.validateTerminalOptions(options), options);
  assert.throws(() => terminal.validateTerminalOptions({ mode: 'root' }, 'win32'), { status: 400 });
  assert.throws(() => terminal.validateTerminalOptions({ mode: 'user', username: '--help' }, 'linux'), { status: 400 });
  assert.throws(() => terminal.validateTerminalOptions({ mode: 'user', username: 'root\ncommand' }, 'linux'), { status: 400 });
  assert.throws(() => terminal.validateTerminalOptions({ ...options, cols: 100000 }), { status: 400 });
  assert.throws(() => terminal.validateTerminalOptions({ ...options, rows: 1.5 }), { status: 400 });
  assert.deepEqual(terminal.terminalCommand({ ...options, mode: 'root' }, 'linux', 1000).args, ['-i', '-u', 'root']);
  assert.deepEqual(terminal.terminalCommand({ ...options, mode: 'user', username: 'games' }, 'linux', 0).args, ['-', 'games']);
  assert.equal(terminal.terminalOriginAllowed({ headers: { origin: 'https://evil.example', host: 'panel.example' } }), false);
  assert.equal(terminal.terminalOriginAllowed({ headers: { origin: 'https://panel.example', host: 'panel.example' } }), true);
  assert.equal(terminal.terminalOriginAllowed({ headers: { host: 'panel.example' } }), false);

  const admin = users.createUser('terminal-admin', 'test-password-123', 'admin');
  const viewer = users.createUser('terminal-viewer', 'test-password-123', 'viewer');
  const adminToken = createToken(admin.id, admin.username, 'admin');
  const viewerToken = createToken(viewer.id, viewer.username, 'viewer');
  const apiKey = createKey(admin.id, { name: 'Not a terminal login', readOnly: false }).key;
  assert.throws(() => terminal.createTerminalTicket(viewerToken, options), { status: 403 });
  assert.throws(() => terminal.createTerminalTicket(apiKey, options), { status: 403 });
  const once = terminal.createTerminalTicket(adminToken, options);
  assert.equal(terminal.consumeTerminalTicket(once.ticket).userId, admin.id);
  assert.throws(() => terminal.consumeTerminalTicket(once.ticket), { status: 403 });

  const app = express(); app.use(express.json()); app.use('/api/terminal', terminalRouter);
  app.use((error, _req, res, _next) => res.status(error.status ?? 500).json({ error: error.message }));
  server = http.createServer(app); wss = terminal.registerHostTerminal(server);
  server.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const req = (route, token, init = {}) => fetch(origin + '/api/terminal' + route, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
  assert.equal((await fetch(origin + '/api/terminal')).status, 401);
  assert.equal((await req('', viewerToken)).status, 403);
  assert.equal((await req('', apiKey)).status, 403);
  assert.equal((await req('/ticket', apiKey, { method: 'POST', body: JSON.stringify(options) })).status, 403);
  const status = await (await req('', adminToken)).json();
  assert.equal(status.available, true, 'Install/rebuild node-pty to run the real PTY smoke test');

  async function rejectedUpgrade(ticket, requestOrigin, expectedStatus) {
    const ws = new WebSocket(origin.replace('http:', 'ws:') + '/ws/host-terminal?ticket=' + ticket, { origin: requestOrigin });
    sockets.push(ws);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Upgrade rejection timed out')), 5000);
      ws.once('unexpected-response', (_req, res) => { clearTimeout(timer); assert.equal(res.statusCode, expectedStatus); res.resume(); resolve(); });
      ws.once('open', () => { clearTimeout(timer); reject(new Error('Unexpected terminal access')); });
      ws.on('error', () => {});
    });
    ws.terminate();
  }
  const response = await req('/ticket', adminToken, { method: 'POST', body: JSON.stringify(options) });
  assert.equal(response.status, 200);
  const { ticket } = await response.json();
  await rejectedUpgrade(ticket, 'https://evil.example', 403);
  // An origin rejection must not consume the ticket.
  const ws = new WebSocket(origin.replace('http:', 'ws:') + '/ws/host-terminal?ticket=' + ticket, { origin });
  sockets.push(ws);
  let output = '', ready = false, shellPid;
  const smoke = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('PTY output timed out: ' + output.slice(-500))), 15000);
    ws.on('error', reject);
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'ready') {
        ready = true; shellPid = msg.pid;
        ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
        ws.send(JSON.stringify({ type: 'input', data: process.platform === 'win32' ? "Write-Output ('OUTPOST_' + 'PTY_OK')\r" : "printf '%s%s\\n' OUTPOST_ PTY_OK\r" }));
      } else if (msg.type === 'output') {
        output += msg.data;
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ack', length: msg.data.length }));
        if (output.includes('OUTPOST_PTY_OK')) { clearTimeout(timer); resolve(); }
      } else if (msg.type === 'error') { clearTimeout(timer); reject(new Error(msg.message)); }
    });
  });
  await smoke; assert.equal(ready, true);
  await rejectedUpgrade(ticket, origin, 403);
  // Existing sessions reject the next keystroke immediately after demotion.
  const ended = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Demoted terminal stayed open')), 5000);
    ws.once('close', () => { clearTimeout(timer); resolve(); });
  });
  users.updateUserRole(admin.id, 'viewer');
  ws.send(JSON.stringify({ type: 'input', data: '\r' }));
  await ended;
  const shellIsAlive = () => { try { process.kill(shellPid, 0); return true; } catch { return false; } };
  for (let attempt = 0; attempt < 30 && shellIsAlive(); attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(shellIsAlive(), false, 'Closing the terminal must terminate its shell process');
  assert.equal((await req('', adminToken)).status, 403);
  // A fresh session is a new process, and a normal shell exit must also close its socket.
  users.updateUserRole(admin.id, 'admin');
  const next = terminal.createTerminalTicket(adminToken, options);
  const fresh = new WebSocket(origin.replace('http:', 'ws:') + '/ws/host-terminal?ticket=' + next.ticket, { origin });
  sockets.push(fresh);
  await new Promise((resolve, reject) => {
    let sawExit = false;
    const timer = setTimeout(() => reject(new Error('Normal shell exit did not close the terminal')), 10000);
    fresh.on('error', reject);
    fresh.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'ready') {
        assert.notEqual(msg.pid, shellPid);
        fresh.send(JSON.stringify({ type: 'input', data: 'exit\r' }));
      } else if (msg.type === 'output') fresh.send(JSON.stringify({ type: 'ack', length: msg.data.length }));
      else if (msg.type === 'exit') sawExit = true;
      else if (msg.type === 'error') { clearTimeout(timer); reject(new Error(msg.message)); }
    });
    fresh.on('close', () => { clearTimeout(timer); assert.equal(sawExit, true); resolve(); });
  });
  const audit = db.prepare("SELECT action FROM audit_log WHERE action LIKE 'terminal.%'").all();
  assert(audit.some((row) => row.action === 'terminal.open'));
  assert(audit.some((row) => row.action === 'terminal.close'));
  console.log('Host terminal authorization, tickets, origins, real PTY I/O, resize, audit and demotion checks passed');
} finally {
  terminal.stopHostTerminals();
  for (const socket of sockets) socket.terminate();
  if (wss) wss.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  db.close(); await fs.rm(dir, { recursive: true, force: true });
}
