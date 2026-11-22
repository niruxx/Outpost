// npm run build --workspace=server && node server/test/core-keeper.mjs
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import express from 'express';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-core-keeper-'));
process.env.OUTPOST_DATA_DIR = temp;
const { db, closeDatabase } = await import('../dist/db/db.js');
const { getServer, setServerStatus } = await import('../dist/services/serverService.js');
const { coreKeeperData } = await import('../dist/services/coreKeeper.js');
const { findPresetFor, findPresetById } = await import('../dist/services/steamGames.js');
const { gameControlsView, saveGameControls } = await import('../dist/services/gameControlsService.js');
const backups = await import('../dist/services/backupService.js');
const { backupDir } = await import('../dist/services/backupStorageService.js');
const { exportEnvironment, environmentExportPreview } = await import('../dist/services/environmentBackupService.js');
const { pluginsRouter } = await import('../dist/routes/plugins.routes.js');
const { environmentRouter } = await import('../dist/routes/environment.routes.js');
const { createUser, setUserServerAccess } = await import('../dist/services/userService.js');
const { createToken } = await import('../dist/auth/tokens.js');
const { createDedup, dedupList } = await import('../dist/services/verifiedBackupService.js');
const { spawnSupervised, supervisorStates } = await import('../dist/services/instanceSupervisor.js');
const { buildLaunch } = await import('../dist/services/processManager.js');
const { instanceDir, rewindDir } = await import('../dist/utils/paths.js');
const preset = findPresetById('core_keeper');
let http;

try {
  assert.equal(preset.appId, '1963720');
  assert.deepEqual(preset.hosts, ['win32', 'linux']);
  assert.equal(preset.stopStrategy.kind, 'core-keeper');
  assert.equal(findPresetFor({ steam_app_id: preset.appId, steam_preset: null }), undefined);
  const id = 'core-keeper-fixture';
  db.prepare('INSERT INTO servers (id,name,platform,loader,version,steam_app_id,steam_preset,status,server_port) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, 'Core Keeper fixture', 'steam', 'vanilla', 'latest', preset.appId, preset.id, 'stopped', 27155);
  let server = getServer(id);
  preset.prepareInstance(server);
  const data = coreKeeperData(server), world = path.join(data, 'worlds', '0.world.gzip');
  fs.mkdirSync(path.dirname(world), { recursive: true });
  fs.writeFileSync(world, 'initial world');
  fs.writeFileSync(path.join(data, 'ServerConfig.json'), '{"world":0}');
  fs.writeFileSync(path.join(instanceDir(id), 'GameInfo.txt'), 'example');
  assert.ok(preset.buildLaunchArgs(server).includes(data));
  assert.ok(!preset.buildLaunchArgs(server).includes('-port'));
  assert.throws(() => preset.buildLaunchArgs({ ...server, extra_args: '-datapath "outside data"' }), { status: 400 });

  const view = gameControlsView(server, true);
  saveGameControls(server, { revision: view.revision, values: { directConnections: 'true', directPassword: 'fixture-pass' } });
  server = getServer(id);
  assert.deepEqual(preset.buildLaunchArgs(server).slice(-4), ['-port', '27155', '-password', 'fixture-pass']);
  assert.ok(!server.game_settings.includes('fixture-pass'));
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(instanceDir(id), preset.executable.win32), 'fixture');
    const launch = await buildLaunch(server);
    assert.ok(launch.cmd.endsWith('CoreKeeperServer.exe'));
    assert.ok(launch.display.includes('[redacted]') && !launch.display.includes('fixture-pass'));
  }

  setServerStatus(id, 'running');
  await assert.rejects(backups.createBackup(id), { status: 409 });
  await assert.rejects(exportEnvironment(), { status: 409 });
  assert.ok(environmentExportPreview(false).blockers[0].includes('Core Keeper fixture'));
  setServerStatus(id, 'stopped');
  assert.deepEqual(environmentExportPreview(true).blockers, []);
  const { fileName } = await backups.createBackup(id);
  const entries = backups.listSnapshotEntries(id, fileName).map((item) => item.path);
  assert.ok(entries.includes('core-keeper-data/worlds/0.world.gzip'));
  assert.ok(entries.includes('core-keeper-data/ServerConfig.json'));
  assert.ok(entries.includes('GameInfo.txt'));
  fs.writeFileSync(world, 'changed world');
  setServerStatus(id, 'stopping');
  await assert.rejects(backups.restoreBackup(id, fileName), { status: 409 });
  setServerStatus(id, 'stopped');
  await backups.restoreBackup(id, fileName);
  assert.equal(fs.readFileSync(world, 'utf8'), 'initial world');
  fs.writeFileSync(path.join(backupDir(id), 'damaged.zip'), 'bad archive');
  await assert.rejects(backups.restoreBackup(id, 'damaged.zip'));
  assert.equal(fs.readFileSync(world, 'utf8'), 'initial world');
  const verified = await createDedup(id);
  const manifest = dedupList(id).find((snapshot) => snapshot.id === verified.id);
  assert.ok(manifest?.files.some((file) => file.path === 'core-keeper-data/worlds/0.world.gzip'));
  fs.mkdirSync(rewindDir(id), { recursive: true });
  fs.writeFileSync(path.join(rewindDir(id), 'sample-point'), 'rewind fixture');
  for (const history of [true, false]) {
    const exported = await exportEnvironment(history);
    try {
      const archive = new AdmZip(exported.filePath);
      assert.ok(archive.getEntries().some((entry) => entry.entryName.endsWith('/core-keeper-data/worlds/0.world.gzip')));
      assert.ok(archive.getEntry('outpost.db'));
      assert.equal(archive.getEntries().some((entry) => entry.entryName.startsWith('backups/')), history);
      assert.equal(archive.getEntries().some((entry) => entry.entryName.startsWith('rewind/')), history);
    } finally {
      fs.unlinkSync(exported.filePath);
    }
  }

  const admin = createUser('core-admin', 'fixture-password-123', 'admin');
  const viewer = createUser('core-guest', 'fixture-password-123', 'viewer');
  setUserServerAccess(viewer.id, [{ serverId: id, permissions: ['console'] }]);
  const app = express();
  app.use(express.json());
  app.use('/api/servers/:serverId/plugins', pluginsRouter);
  app.use('/api/environment', environmentRouter);
  app.use((err, _req, res, _next) => res.status(err.status ?? 500).json({ error: err.message }));
  http = app.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const origin = `http://127.0.0.1:${http.address().port}/api`;
  const token = (user) => createToken(user.id, user.username, user.role);
  const request = (route, body, user = admin) => fetch(`${origin}/servers/${id}/plugins${route}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${token(user)}`,
      ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  assert.equal((await fetch(`${origin}/environment/export/preview?token=${token(viewer)}`)).status, 403);
  const archiveResponse = await fetch(`${origin}/environment/export?history=exclude&token=${token(admin)}`);
  assert.equal(archiveResponse.status, 200);
  const downloadedEnvironment = new AdmZip(Buffer.from(await archiveResponse.arrayBuffer()));
  assert.ok(downloadedEnvironment.getEntry('outpost.db'));
  assert.ok(!downloadedEnvironment.getEntries().some((entry) => entry.entryName.startsWith('backups/')));
  const packageZip = (name, guid, version, dependencies = [], nested = false) => {
    const zip = new AdmZip();
    const prefix = nested ? `release/${name}/` : '';
    zip.addFile(prefix + 'ModManifest.json', Buffer.from(JSON.stringify({ name, guid, version, dependencies })));
    zip.addFile(prefix + 'Scripts/mod.cs', Buffer.from('fixture'));
    return zip.toBuffer();
  };
  const upload = (packages, replace = false) => {
    const form = new FormData();
    for (const bytes of packages) form.append('files', new Blob([bytes]), 'package.zip');
    if (replace) form.append('replace', 'true');
    return request('/upload', form);
  };
  const libraryId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const consumerId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const library = packageZip('Test Library', libraryId, '1.0', [], true);
  const consumer = packageZip('Test Content', consumerId, '1.0', [{ modName: 'Test Library', required: true }, { modName: 'Optional Mod', required: false }]);
  const inventory = async () => (await (await request('')).json()).inventory.items;
  setServerStatus(id, 'running');
  assert.equal((await upload([library])).status, 409);
  setServerStatus(id, 'stopped');
  assert.equal((await upload([library, Buffer.from('corrupt')])).status, 400);
  assert.equal((await inventory()).length, 0);
  const installed = await upload([consumer, library]);
  assert.equal(installed.status, 201, await installed.text());
  assert.equal((await upload([library])).status, 409);
  let items = await inventory();
  const content = items.find((mod) => mod.name === 'Test Content');
  assert.equal(content.metadata.version, '1.0');
  assert.ok(content.dependencies.some((dependency) => dependency.name === 'Optional Mod' && !dependency.required));
  assert.equal(items.find((mod) => mod.name === 'Test Library').requiredBy[0].name, 'Test Content');
  const review = (item, action) => request(`/installed/${item.id}/plan`, { action }).then((res) => res.json());
  const apply = (plan) => request(`/installed/actions/${plan.id}/apply`, { acknowledged: true });
  assert.ok((await review(items.find((mod) => mod.name === 'Test Library'), 'disable')).blockers.length);
  assert.equal((await apply(await review(content, 'disable'))).status, 200);
  items = await inventory();
  const disabled = items.find((mod) => mod.name === 'Test Content');
  assert.equal(disabled.enabled, false);
  assert.match(disabled.relativePath, /^core-keeper-disabled-mods\//);
  assert.equal((await request('/core-keeper-pack', undefined, viewer)).status, 403);
  const pack = new AdmZip(Buffer.from(await (await request('/core-keeper-pack')).arrayBuffer()));
  assert.ok(pack.getEntry(`mod-${libraryId}/ModManifest.json`));
  assert.equal(pack.getEntry(`mod-${consumerId}/ModManifest.json`), null);
  assert.equal((await upload([packageZip('Test Content', consumerId, '2.0', [libraryId])], true)).status, 201);
  const updated = (await inventory()).find((mod) => mod.name === 'Test Content');
  assert.equal(updated.enabled, false);
  assert.equal(updated.metadata.version, '2.0');
  assert.ok(backups.listBackups(id).find((item) => item.fileName.includes('before-core-keeper-mod-update')));
  assert.equal((await apply(await review(updated, 'enable'))).status, 200);
  const enabled = (await inventory()).find((mod) => mod.name === 'Test Content');
  const removal = await apply(await review(enabled, 'remove'));
  assert.equal(removal.status, 200, await removal.clone().text());
  assert.ok((await removal.json()).backup);
  assert.equal((await inventory()).length, 1);

  const supervisor = await spawnSupervised('core-keeper-stop-fixture', {
    cmd: process.execPath, args: ['-e', 'setInterval(() => {}, 100)'], cwd: temp, env: process.env,
    shell: false, detached: false, sandboxed: false, ready: null,
    context: { config: { stopTimeoutSec: 1 }, cwd: temp, groupKill: false, sandboxed: false, coreKeeper: true },
  });
  supervisor.resume();
  let exited = false;
  supervisor.once('exit', () => { exited = true; });
  try {
    supervisor.markManualStop();
    await new Promise((resolve) => setTimeout(resolve, 1700));
    assert.ok(supervisorStates().find((state) => state.serverId === 'core-keeper-stop-fixture')?.manualStop);
    assert.equal(exited, false, 'normal Core Keeper stop must not schedule a forced kill');
  } finally {
    if (!exited) {
      const exit = once(supervisor, 'exit');
      supervisor.kill('SIGKILL');
      await exit;
    }
  }
  console.log('Core Keeper preset, ZIP mod install/update/toggle/remove, download, safe stop, and backup/restore verified.');
} finally {
  if (http) {
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  }
  closeDatabase();
  fs.rmSync(temp, { recursive: true, force: true });
}
