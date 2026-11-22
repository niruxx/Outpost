import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import express from 'express';
import AdmZip from 'adm-zip';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'outpost-export-fixture-'));
const root = path.join(temp, 'data');
process.env.OUTPOST_DATA_DIR = root;
const { db, closeDatabase } = await import('../dist/db/db.js');
const { environmentRouter } = await import('../dist/routes/environment.routes.js');
const { createUser } = await import('../dist/services/userService.js');
const { createToken } = await import('../dist/auth/tokens.js');
const { assertBackupIdle } = await import('../dist/services/verifiedBackupService.js');
const { setServerStatus } = await import('../dist/services/serverService.js');
let http;

try {
  const makeFile = async (rel, body) => {
    const file = path.join(root, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body);
    return file;
  };
  const insert = db.prepare('INSERT INTO servers (id,name,platform,loader,version,steam_preset,status,auto_start) VALUES (?,?,?,?,?,?,?,?)');
  insert.run('keeper', 'Core Keeper', 'steam', 'vanilla', 'latest', 'core_keeper', 'stopped', 1);
  insert.run('other', 'Other Instance', 'java', 'vanilla', 'latest', null, 'stopped', 1);
  db.prepare('INSERT INTO snapshot_metadata (server_id,kind,snapshot_id,name) VALUES (?,?,?,?)')
    .run('keeper', 'zip', 'existing.zip', 'Named snapshot');
  const admin = createUser('export-admin', 'fixture-password-123', 'admin');
  const guest = createUser('export-guest', 'fixture-password-123', 'viewer');
  await makeFile('servers/keeper/core-keeper-data/worlds/0.world.gzip', 'World 0');
  await makeFile('servers/other/secret-world.txt', 'Excluded world');
  await makeFile('backups/keeper/existing.zip', 'Prior backup');
  await makeFile('rewind/keeper/point/manifest.json', '{}');
  await makeFile('rewind/other/point/manifest.json', '{}');
  await makeFile('console-logs/other/private.log', 'Excluded log');
  await makeFile('runtimes/runtime-tool', 'Tool');
  await makeFile('session.secret', 'Fixture key');
  const outside = path.join(temp, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'private-host-file.txt'), 'Outside the data directory');
  await fs.symlink(outside, path.join(root, 'runtimes', 'outside-link'), 'junction').catch(() => {});

  const app = express();
  app.use(express.json());
  app.use('/api/environment', environmentRouter);
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use((error, _req, res, _next) => res.status(error.status ?? 500).json({ error: error.message }));
  http = app.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const origin = `http://127.0.0.1:${http.address().port}`;
  const token = (user) => createToken(user.id, user.username, user.role);
  const request = (route, options, user = admin) => fetch(origin + '/api/environment/' + route, {
    method: options ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token(user)}`, 'Content-Type': 'application/json' },
    body: options ? JSON.stringify(options) : undefined,
  });
  const zip = async (response) => {
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /attachment;.*\.zip/);
    assert.equal(response.headers.get('content-length'), null);
    return new AdmZip(Buffer.from(await response.arrayBuffer()));
  };
  const names = (archive) => archive.getEntries().map(({ entryName }) => entryName);
  const scoped = { instanceIds: ['keeper'], includeSnapshots: false, includeRestorePoints: true, includeSupportFiles: true };
  assert.equal((await request('export', scoped, guest)).status, 403);
  assert.equal((await request('export', { includeDatabase: 'false' })).status, 400);
  setServerStatus('keeper', 'running');
  const blocked = await request('export/preview', scoped).then((response) => response.json());
  assert.match(blocked.blockers[0], /Stop Core Keeper/);
  assert.equal((await request('export', scoped)).status, 409);
  assert.equal((await request('export/preview', { ...scoped, includeFiles: false }).then((response) => response.json())).blockers.length, 0);
  setServerStatus('keeper', 'stopped');

  const archive = await zip(await request('export', scoped));
  assert.ok(archive.getEntry('servers/keeper/core-keeper-data/worlds/0.world.gzip'));
  assert.ok(archive.getEntry('rewind/keeper/point/manifest.json'));
  assert.ok(archive.getEntry('runtimes/runtime-tool'));
  assert.ok(!names(archive).some((name) => /(?:^backups\/|other|outside-link|outpost\.db-(?:wal|shm))/.test(name)));
  const dbFile = path.join(temp, 'restored.db');
  await fs.writeFile(dbFile, archive.readFile('outpost.db'));
  const restored = new DatabaseSync(dbFile);
  try {
    assert.deepEqual(restored.prepare('SELECT id FROM servers').all().map(({ id }) => id), ['keeper']);
    assert.equal(restored.prepare('SELECT count(*) AS count FROM snapshot_metadata').get().count, 0);
    assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { restored.close(); }
  assert.equal(db.prepare('SELECT count(*) AS count FROM servers').get().count, 2);

  const form = new URLSearchParams({ options: JSON.stringify({ ...scoped, includeDatabase: false, includeSupportFiles: false, includeRestorePoints: false }) });
  const files = await zip(await fetch(`${origin}/api/environment/export?token=${token(admin)}`, { method: 'POST', body: form }));
  assert.ok(files.getEntry('servers/keeper/core-keeper-data/worlds/0.world.gzip'));
  assert.ok(!files.getEntry('outpost.db') && !files.getEntry('session.secret'));
  const legacy = await zip(await request('export?history=exclude'));
  assert.ok(legacy.getEntry('servers/other/secret-world.txt'));
  assert.ok(!names(legacy).some((name) => /^(?:backups|rewind)\//.test(name)));

  const large = await makeFile('servers/keeper/large.zip', '');
  await fs.truncate(large, 48 * 1024 * 1024);
  const abort = new AbortController();
  const response = await fetch(`${origin}/api/environment/export?token=${token(admin)}`, {
    method: 'POST',
    body: new URLSearchParams({ options: JSON.stringify({ ...scoped, includeDatabase: false, includeSupportFiles: false, includeRestorePoints: false }) }),
    signal: abort.signal,
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const chunk = await reader.read();
  assert.equal(Buffer.from(chunk.value).subarray(0, 2).toString(), 'PK');
  assert.throws(() => assertBackupIdle('keeper'), { status: 423 });
  assert.equal((await fetch(origin + '/health', { signal: AbortSignal.timeout(2000) })).status, 200);
  abort.abort();
  await reader.cancel().catch(() => {});
  for (let retry = 0; retry < 100; retry++) {
    try { assertBackupIdle('keeper'); break; }
    catch { await delay(20); }
  }
  assert.doesNotThrow(() => assertBackupIdle('keeper'));
  assert.ok(db.prepare("SELECT 1 FROM panel_jobs WHERE kind = 'environment-export' AND stage LIKE '%cancelled%'").get());
  console.log('Environment export streams before completion, stays responsive, filters selections and SQLite records, skips links, and cleans up on cancellation.');
} finally {
  if (http) {
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  }
  closeDatabase();
  await fs.rm(temp, { recursive: true, force: true });
}
