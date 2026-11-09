// Host File Manager regression test. Uses an isolated database and a temporary directory.
//   npm run build && node server/test/host-files.mjs
// Admin Mode is exercised for real only on a disposable Unix host, when
// OUTPOST_TEST_SUDO_PASSWORD is set (or sudo is passwordless and OUTPOST_TEST_SUDO=1).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import express from 'express';
import http from 'node:http';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'outpost-host-files-'));
process.env.OUTPOST_DATA_DIR = path.join(dir, 'data');
const source = process.env.OUTPOST_TEST_SOURCE === '1';
const ext = source ? 'ts' : 'js';
const load = (file) => import(new URL(`../${source ? 'src' : 'dist'}/${file}.${ext}`, import.meta.url));
const { db } = await load('db/db');
const users = await load('services/userService');
const { createToken } = await load('auth/tokens');
const { createKey } = await load('services/apiKeyService');
const { hostFilesRouter } = await load('routes/hostFiles.routes');
const hostFiles = await load('services/hostFilesService');
const ops = await load('services/hostFileOps');
let server;
try {
  // Path validation: absolute only, no NUL bytes.
  assert.throws(() => ops.normalizeHostPath('relative/path', 'linux'), { status: 400 });
  assert.throws(() => ops.normalizeHostPath('/etc/\0passwd', 'linux'), { status: 400 });
  assert.equal(ops.normalizeHostPath('/etc/../etc//hosts', 'linux'), '/etc/hosts');
  assert.throws(() => ops.normalizeHostPath('\\no-drive', 'win32'), { status: 400 });
  await assert.rejects(ops.removeHostEntry(path.parse(dir).root), { status: 400 });

  const admin = users.createUser('files-admin', 'test-password-123', 'admin');
  const viewer = users.createUser('files-viewer', 'test-password-123', 'viewer');
  const adminToken = createToken(admin.id, admin.username, 'admin');
  const viewerToken = createToken(viewer.id, viewer.username, 'viewer');
  const apiKey = createKey(admin.id, { name: 'Not a file manager login', readOnly: false }).key;

  const app = express();
  app.use(express.json());
  app.use('/api/host-files', hostFilesRouter);
  app.use((error, _req, res, _next) => res.status(error.status ?? 500).json({ error: error.message }));
  server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}/api/host-files`;
  const req = (route, token, init = {}) => fetch(origin + route, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  const q = (p) => `?path=${encodeURIComponent(p)}`;

  // Access: admins with a real sign-in only.
  assert.equal((await fetch(origin)).status, 401);
  assert.equal((await req('', viewerToken)).status, 403);
  assert.equal((await req('', apiKey)).status, 403);
  const status = await (await req('', adminToken)).json();
  assert.equal(status.serviceUser, os.userInfo().username);
  assert.equal(typeof status.admin.available, 'boolean');

  // Limited access CRUD, on absolute paths.
  const work = path.join(dir, 'work');
  assert.equal((await req('/mkdir', adminToken, { method: 'POST', body: JSON.stringify({ path: work }) })).status, 201);
  assert.equal((await req('/mkdir', adminToken, { method: 'POST', body: JSON.stringify({ path: work }) })).status, 409);
  const file = path.join(work, 'hello.txt');
  assert.equal((await req('/content', adminToken, { method: 'PUT', body: JSON.stringify({ path: file, content: 'hello host' }) })).status, 200);
  assert.equal((await (await req('/content' + q(file), adminToken)).json()).content, 'hello host');
  const listing = await (await req('/list' + q(work), adminToken)).json();
  assert.equal(listing.path, work);
  assert.deepEqual(listing.entries.map((e) => e.name), ['hello.txt']);
  assert.equal(listing.entries[0].size, 10);
  assert.equal((await req('/list' + q('not/absolute'), adminToken)).status, 400);
  assert.equal((await req('/list' + q(path.join(work, 'missing')), adminToken)).status, 404);

  const download = await req('/download' + q(file), adminToken);
  assert.equal(download.status, 200);
  assert.equal(await download.text(), 'hello host');

  // Upload larger than one chunk, then download it back intact.
  const big = Buffer.alloc(ops.CHUNK_BYTES * 2 + 123);
  for (let i = 0; i < big.length; i++) big[i] = i % 251;
  const form = new FormData();
  form.append('path', work);
  form.append('files', new Blob([big]), '../../escape.bin');
  const up = await fetch(origin + '/upload', { method: 'POST', body: form, headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(up.status, 201);
  const uploaded = path.join(work, 'escape.bin'); // the "../../" was stripped
  assert.ok(Buffer.from(await (await req('/download' + q(uploaded), adminToken)).arrayBuffer()).equals(big));

  const renamed = path.join(work, 'renamed.txt');
  assert.equal((await req('/rename', adminToken, { method: 'POST', body: JSON.stringify({ from: file, to: renamed }) })).status, 200);
  assert.equal((await req('/rename', adminToken, { method: 'POST', body: JSON.stringify({ from: renamed, to: uploaded }) })).status, 409);
  assert.equal((await req('' + q(renamed), adminToken, { method: 'DELETE' })).status, 204);
  assert.equal((await req('' + q(work), adminToken, { method: 'DELETE' })).status, 204);
  await assert.rejects(fs.stat(work));

  // Audit records the mode.
  const audited = db.prepare("SELECT action, detail FROM audit_log WHERE action LIKE 'host.file.%' ORDER BY id").all();
  assert.ok(audited.some((r) => r.action === 'host.file.upload' && JSON.parse(r.detail).mode === (status.admin.alwaysOn ? 'admin' : 'user')));

  // The privileged helper's protocol, run without sudo so it works anywhere.
  const helperPath = fileURLToPath(new URL(`../${source ? 'src' : 'dist'}/services/hostFilesHelper.${ext}`, import.meta.url));
  const helper = spawn(process.execPath, [...process.execArgv, helperPath], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = readline.createInterface({ input: helper.stdout });
  const replies = [];
  const waiters = [];
  lines.on('line', (line) => (waiters.length ? waiters.shift()(JSON.parse(line)) : replies.push(JSON.parse(line))));
  const next = () => (replies.length ? Promise.resolve(replies.shift()) : new Promise((resolve) => waiters.push(resolve)));
  assert.equal((await next()).ready, true);
  helper.stdin.write('not-json password line\n'); // ignored, as when sudo needs no password
  helper.stdin.write(`${JSON.stringify({ id: 1, op: 'stat', args: { path: dir } })}\n`);
  const stat = await next();
  assert.equal(stat.id, 1);
  assert.equal(stat.ok, true);
  assert.equal(stat.result.isDirectory, true);
  helper.stdin.write(`${JSON.stringify({ id: 2, op: 'constructor', args: {} })}\n`);
  assert.deepEqual(await next(), { id: 2, ok: false, status: 400, error: 'Unknown operation' });
  helper.stdin.write(`${JSON.stringify({ id: 3, op: 'list', args: { path: 'relative' } })}\n`);
  assert.equal((await next()).status, 400);
  helper.stdin.end();
  assert.equal(await new Promise((resolve) => helper.once('exit', resolve)), 0);

  // Admin Mode for real, only when explicitly requested on a disposable Unix host.
  const sudoPassword = process.env.OUTPOST_TEST_SUDO_PASSWORD;
  if (process.platform !== 'win32' && !status.admin.alwaysOn && (sudoPassword || process.env.OUTPOST_TEST_SUDO === '1')) {
    const wrong = await req('/admin', adminToken, { method: 'POST', body: JSON.stringify({ password: 'definitely-not-the-password' }) });
    if (status.admin.needsPassword) assert.equal(wrong.status, 403);
    else await req('/admin', adminToken, { method: 'DELETE' });
    const on = await req('/admin', adminToken, { method: 'POST', body: JSON.stringify({ password: sudoPassword ?? '' }) });
    assert.equal(on.status, 200, await on.clone().text());
    assert.equal((await on.json()).admin.active, true);
    // Root can read what the service account cannot.
    assert.equal((await req('/list' + q('/root'), adminToken)).status, 200);
    const off = await (await req('/admin', adminToken, { method: 'DELETE' })).json();
    assert.equal(off.admin.active, false);
    console.log('Admin Mode via sudo: ok');
  } else {
    console.log('Admin Mode via sudo: skipped (set OUTPOST_TEST_SUDO_PASSWORD on a disposable Unix host)');
  }
  console.log('host-files: ok');
} finally {
  hostFiles.stopHostFileSessions();
  server?.close();
  db.close?.();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}
