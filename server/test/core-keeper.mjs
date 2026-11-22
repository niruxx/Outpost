// npm run build --workspace=server && node server/test/core-keeper.mjs
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-core-keeper-'));
process.env.OUTPOST_DATA_DIR = temp;
const { db, closeDatabase } = await import('../dist/db/db.js');
const { getServer, setServerStatus } = await import('../dist/services/serverService.js');
const { coreKeeperData } = await import('../dist/services/coreKeeper.js');
const { findPresetFor, findPresetById } = await import('../dist/services/steamGames.js');
const { gameControlsView, saveGameControls } = await import('../dist/services/gameControlsService.js');
const backups = await import('../dist/services/backupService.js');
const { backupDir } = await import('../dist/services/backupStorageService.js');
const { exportEnvironment } = await import('../dist/services/environmentBackupService.js');
const { createDedup, dedupList } = await import('../dist/services/verifiedBackupService.js');
const { spawnSupervised, supervisorStates } = await import('../dist/services/instanceSupervisor.js');
const { buildLaunch } = await import('../dist/services/processManager.js');
const { instanceDir } = await import('../dist/utils/paths.js');
const preset = findPresetById('core_keeper');

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
  setServerStatus(id, 'stopped');
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
  const exported = await exportEnvironment();
  try {
    const archive = new AdmZip(exported.filePath);
    assert.ok(archive.getEntries().some((entry) => entry.entryName.endsWith('/core-keeper-data/worlds/0.world.gzip')));
    assert.ok(archive.getEntry('outpost.db'));
  } finally {
    fs.unlinkSync(exported.filePath);
  }

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
  console.log('Core Keeper preset, safe stop timeout, and stopped backup/restore verified.');
} finally {
  closeDatabase();
  fs.rmSync(temp, { recursive: true, force: true });
}
