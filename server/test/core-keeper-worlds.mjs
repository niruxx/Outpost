import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import express from 'express';
import {
  parseCoreKeeperCharacter, setCharacterItem, setCharacterSkill, characterNumber,
} from '../../web/src/lib/coreKeeperCharacter.ts';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'outpost-core-worlds-'));
process.env.OUTPOST_DATA_DIR = temp;
const { db, closeDatabase } = await import('../dist/db/db.js');
const { gameControlsRouter } = await import('../dist/routes/gameControls.routes.js');
const { createUser, setUserServerAccess } = await import('../dist/services/userService.js');
const { createToken } = await import('../dist/auth/tokens.js');
const { setServerStatus, getServer } = await import('../dist/services/serverService.js');
const { coreKeeperData } = await import('../dist/services/coreKeeper.js');
const { listBackups, listSnapshotEntries } = await import('../dist/services/backupService.js');
const { trash } = await import('../dist/services/fileWorkspaceService.js');
let http;

try {
  const input = {
    characterGuid: 'test-guid', coinAmount: 14, maxHealth: 90, futureField: { key: 'preserve me' },
    inventory: [{ objectID: 5, amount: 3, variation: 2, future: { data: true } }, { objectID: 0, amount: 0 }],
    skills: [{ skillID: 2, value: 2000, future: true }],
    skillTalentTreeDatas: [{ skillTreeID: 2, points: [1, 0, 0] }],
  };
  const character = parseCoreKeeperCharacter(JSON.stringify(input));
  let edited = setCharacterItem(character, 0, 5, 9);
  assert.deepEqual(edited.inventory[0], { ...input.inventory[0], amount: 9 });
  edited = setCharacterItem(edited, 1, 12, 4);
  assert.equal(edited.inventory[1].objectID, 12);
  edited = setCharacterItem(edited, 0, 0, 0);
  assert.equal(edited.inventory[0].amount, 0);
  edited = setCharacterSkill(edited, 2, 5000, [2, 1, 0]);
  assert.equal(edited.skills[0].future, true);
  edited = setCharacterSkill(edited, 0, 3000, [0, 0, 0]);
  assert.deepEqual(parseCoreKeeperCharacter(JSON.stringify(edited)).futureField, input.futureField);
  assert.equal(character.skills.length, 1);
  assert.equal(characterNumber('42'), 42);
  assert.throws(() => characterNumber('-2'));
  assert.throws(() => setCharacterSkill(edited, 2, 0, [1]));
  assert.throws(() => parseCoreKeeperCharacter(JSON.stringify(input).replace('"coinAmount":14', '"coinAmount":76561198000000001')));
  assert.throws(() => parseCoreKeeperCharacter('world save'));

  const id = 'core-world-fixture';
  db.prepare('INSERT INTO servers (id,name,platform,loader,version,steam_app_id,steam_preset,status,server_port) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, 'Core Keeper Worlds', 'steam', 'vanilla', 'latest', '1963720', 'core_keeper', 'stopped', 27015);
  const data = coreKeeperData(getServer(id));
  const config = path.join(data, 'ServerConfig.json');
  await fs.mkdir(path.join(data, 'worlds'), { recursive: true });
  await fs.writeFile(config, JSON.stringify({ world: 0, worldName: 'Home', extension: { keep: true } }));
  await fs.writeFile(path.join(data, 'worlds', '0.world.gzip'), 'Opaque world storage fixture.');
  const admin = createUser('world-admin', 'fixture-password-123', 'admin');
  const viewer = createUser('world-reader', 'fixture-password-123', 'viewer');
  setUserServerAccess(viewer.id, [{ serverId: id, permissions: ['files.read'] }]);

  const app = express();
  app.use(express.json());
  app.use('/api/servers/:serverId/game-controls', gameControlsRouter);
  app.use((err, _req, res, _next) => res.status(err.status ?? 500).json({ error: err.message }));
  http = app.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const base = `http://127.0.0.1:${http.address().port}/api/servers/${id}/game-controls/core-keeper/worlds`;
  const req = (suffix, body, user = admin) => fetch(base + suffix, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${createToken(user.id, user.username, user.role)}`,
      ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const success = async (response) => {
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    return data;
  };
  const form = (revision, includeInfo = false) => {
    const upload = new FormData();
    upload.append('revision', revision);
    upload.append('world', new Blob(['Another opaque world fixture.']), '4.world.gzip');
    if (includeInfo) upload.append('info', new Blob(['{"name":"Imported"}']), '4.worldinfo');
    upload.append('map', new Blob(['Cartography fixture']), '4.mapparts.gzip');
    return upload;
  };
  const initial = await success(await req('', undefined, viewer));
  assert.equal(initial.active, 0);
  assert.equal(initial.slots.length, 30);
  const revision = initial.revision;
  assert.equal((await req('/0/remove', { revision })).status, 409);
  assert.equal((await req('/30/select', { revision })).status, 400);
  assert.equal((await req('/1/select', { revision }, viewer)).status, 403);
  assert.equal((await req('/3/import', form(revision, true))).status, 400);
  setServerStatus(id, 'running');
  assert.equal((await req('/4/import', form(revision, true))).status, 409);
  assert.equal((await req('/0/files/world')).status, 409);
  setServerStatus(id, 'stopped');
  const imported = await success(await req('/4/import', form(revision, true)));
  assert.equal(imported.slots[4].name, 'Imported');
  assert.equal(imported.slots[4].hasWorld, true);
  assert.equal((await req('/4/import', form(imported.revision))).status, 409);
  assert.equal((await req('/4/select', { revision })).status, 409);
  assert.ok(listBackups(id).some((snapshot) => snapshot.fileName === imported.backup));
  const download = await req('/4/files/world', undefined, viewer);
  assert.equal(download.status, 200);
  assert.equal(await download.text(), 'Another opaque world fixture.');
  const switched = await success(await req('/4/select', { revision: imported.revision }));
  assert.equal(switched.active, 4);
  assert.deepEqual(JSON.parse(await fs.readFile(config, 'utf8')), { world: 4, worldName: 'Home', extension: { keep: true } });
  await fs.writeFile(path.join(data, 'worlds', '0.world.gzip.pugbackup'), 'old game copy');
  const refreshed = await success(await req(''));
  const removed = await success(await req('/0/remove', { revision: refreshed.revision }));
  assert.equal(removed.slots[0].occupied, false);
  assert.equal(trash(id).length, 2);
  assert.ok(listSnapshotEntries(id, removed.backup).some((file) => file.path.endsWith('/0.world.gzip.pugbackup')));
  const newWorld = await success(await req('/3/select', { revision: removed.revision }));
  assert.equal(newWorld.active, 3);
  assert.equal(newWorld.slots[3].hasWorld, false);
  console.log('Core Keeper world inventory, imports, downloads, slot selection, recycle recovery, permissions, stopped guards, and character edits passed.');
} finally {
  if (http) {
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  }
  closeDatabase();
  await fs.rm(temp, { recursive: true, force: true });
}
