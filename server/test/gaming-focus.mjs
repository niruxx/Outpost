import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'outpost-gaming-focus-'));
process.env.OUTPOST_DATA_DIR = temp;
const { db, closeDatabase } = await import('../dist/db/db.js');
const { createToken } = await import('../dist/auth/tokens.js');
const { backupsRouter } = await import('../dist/routes/backups.routes.js');
const { serversRouter } = await import('../dist/routes/servers.routes.js');
const { createServerRecord, getServer } = await import('../dist/services/serverService.js');
const { getTemplate, listTemplates } = await import('../dist/services/templateService.js');
const { createUser, getEffectiveCreation, setUserServerAccess } = await import('../dist/services/userService.js');
const { instanceDir } = await import('../dist/utils/paths.js');
let http;

try {
  const admin = createUser('admin', 'gaming-focus-fixture-password', 'admin');
  const moderator = createUser('moderator', 'gaming-focus-fixture-password', 'moderator');
  const legacy = 'legacy-container';
  db.exec("ALTER TABLE servers ADD COLUMN docker_config TEXT");
  const legacyConfig = '{"image":"fixture/old-game"}';
  db.prepare('INSERT INTO servers (id, name, platform, loader, version, status, created_by, docker_config) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(legacy, 'Old container', 'docker', 'docker', 'fixture/old-game', 'running', moderator.id, legacyConfig);
  db.prepare('INSERT INTO templates (id, name, platform, data, created_at) VALUES (?, ?, ?, ?, ?)').run(legacy, 'Old template', 'docker', '{}', new Date().toISOString());
  await fs.mkdir(instanceDir(legacy), { recursive: true });
  const legacyFile = path.join(instanceDir(legacy), 'world.dat');
  await fs.writeFile(legacyFile, 'legacy world');
  setUserServerAccess(moderator.id, [legacy]);

  const game = createServerRecord({ name: 'Game server', platform: 'steam', loader: 'vanilla', version: 'latest', minMemoryMb: 512, maxMemoryMb: 1024, serverPort: 27015, createdBy: admin.id });
  assert.equal(getServer(legacy), undefined);
  assert.equal(getEffectiveCreation(moderator.id, 'moderator').owned, 0);
  assert.equal(getEffectiveCreation(admin.id, 'admin').allowedPlatforms.includes('docker'), false);
  assert.equal(getTemplate(legacy), null);
  assert.equal(listTemplates().some(template => template.id === legacy), false);

  const app = express();
  app.use(express.json());
  app.use('/api/servers/:serverId/backups', backupsRouter);
  app.use('/api/servers', serversRouter);
  app.use((error, _req, res, _next) => res.status(error.status ?? 500).json({ error: error.message }));
  http = app.listen(0, '127.0.0.1');
  await once(http, 'listening');

  function request(account, url = '', options = {}) {
    return fetch('http://127.0.0.1:' + http.address().port + '/api/servers' + url, {
      ...options, headers: { Authorization: 'Bearer ' + createToken(account.id, account.username, account.role), 'Content-Type': 'application/json' },
    });
  }

  assert.deepEqual((await (await request(admin)).json()).servers.map(server => server.id), [game.id]);
  assert.equal((await request(admin, '/' + game.id + '/backups')).status, 200);
  for (const account of [admin, moderator]) {
    assert.equal((await request(account, '/' + legacy)).status, 404);
    assert.equal((await request(account, '/' + legacy + '/backups')).status, 404);
  }
  assert.equal((await request(admin, '', { method: 'POST', body: JSON.stringify({ name: 'Container', platform: 'docker' }) })).status, 400);
  const retained = db.prepare('SELECT status, docker_config FROM servers WHERE id = ?').get(legacy);
  assert.equal(retained.status, 'running');
  assert.equal(retained.docker_config, legacyConfig);
  assert.equal(await fs.readFile(legacyFile, 'utf8'), 'legacy world');
  console.log('Legacy container data is retained and dormant. Game inventory and backups remain available.');
} finally {
  http?.closeAllConnections();
  if (http) await new Promise(resolve => http.close(resolve));
  closeDatabase();
  await fs.rm(temp, { recursive: true, force: true });
}
