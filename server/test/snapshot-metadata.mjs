import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import AdmZip from 'adm-zip';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'outpost-snapshot-metadata-'));
process.env.OUTPOST_DATA_DIR = dir;
const { db, closeDatabase } = await import('../dist/db/db.js');
const zipBackups = await import('../dist/services/backupService.js');
const dedupBackups = await import('../dist/services/verifiedBackupService.js');
const { snapshotMetadata } = await import('../dist/services/snapshotMetadataService.js');
const { exportEnvironment } = await import('../dist/services/environmentBackupService.js');
const { backupsRouter } = await import('../dist/routes/backups.routes.js');
const { reliabilityRouter } = await import('../dist/routes/reliability.routes.js');
const { createUser, setUserServerAccess } = await import('../dist/services/userService.js');
const { createToken } = await import('../dist/auth/tokens.js');
const { instanceDir } = await import('../dist/utils/paths.js');
let http, exportPath;

try {
  const admin = createUser('backup-admin', 'test-password-123', 'admin');
  const viewer = createUser('backup-viewer', 'test-password-123', 'viewer');
  const makeInstance = async (id) => {
    db.prepare('INSERT INTO servers (id, name, platform, loader, version, status) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, id, 'java', 'vanilla', '1.21.1', 'stopped');
    await fs.mkdir(instanceDir(id), { recursive: true });
    await fs.writeFile(path.join(instanceDir(id), 'world.txt'), 'Original world');
  };
  const id = 'first';
  await makeInstance(id);
  await makeInstance('second');
  setUserServerAccess(viewer.id, [{ serverId: id, permissions: ['files.read'] }]);
  const original = await zipBackups.createBackup(id, 'pre-update');
  const scheduled = await zipBackups.createBackup(id, 'auto');
  const firstDedup = await dedupBackups.createDedup(id);
  const pathOfArchive = zipBackups.resolveBackupPath(id, original.fileName);
  const bytes = await fs.readFile(pathOfArchive);
  const archivedAt = (await fs.stat(pathOfArchive)).mtimeMs;
  assert.equal(zipBackups.listBackups(id).find((backup) => backup.fileName === original.fileName).label, 'pre-update');
  assert.equal(scheduled.scheduled, true);

  const app = express();
  app.use(express.json());
  app.use('/api/servers/:serverId/backups', backupsRouter);
  app.use('/api/servers/:serverId/reliability', reliabilityRouter);
  app.use((err, _req, res, _next) => res.status(err.status ?? 500).json({ error: err.message }));
  http = app.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const base = `http://127.0.0.1:${http.address().port}/api/servers`;
  const endpoint = (name, instance = id) => `${base}/${instance}/backups/${encodeURIComponent(name)}/metadata`;
  const patch = (url, details, user = admin) => fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${createToken(user.id, user.username, user.role)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(details),
  });
  const json = async (response) => {
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    return data;
  };
  assert.equal((await patch(endpoint(original.fileName), { name: 'Forbidden' }, viewer)).status, 403);
  assert.equal((await patch(endpoint(original.fileName, 'second'), { name: 'Wrong instance' })).status, 404);
  assert.equal((await patch(endpoint(original.fileName), { label: 'x'.repeat(41) })).status, 400);
  const renamed = (await json(await patch(endpoint(original.fileName), { name: 'Before 1.22', label: 'Maintenance' }))).backup;
  assert.equal(renamed.fileName, original.fileName);
  assert.equal(renamed.name, 'Before 1.22');
  assert.equal(renamed.label, 'Maintenance');
  const cleared = (await json(await patch(endpoint(original.fileName), { label: null }))).backup;
  assert.equal(cleared.name, renamed.name);
  assert.equal(cleared.label, null);
  assert.deepEqual(await fs.readFile(pathOfArchive), bytes);
  assert.equal((await fs.stat(pathOfArchive)).mtimeMs, archivedAt);
  assert.equal((await json(await patch(endpoint(scheduled.fileName), { label: 'Nightly' }))).backup.scheduled, true);
  const dedupUrl = `${base}/${id}/reliability/deduplicated/${firstDedup.id}/metadata`;
  assert.equal((await patch(dedupUrl, { name: 'Forbidden' }, viewer)).status, 403);
  await json(await patch(dedupUrl, { name: 'Baseline', label: 'Stable' }));
  assert.equal(dedupBackups.backupEstimate(id).manifests[0].name, 'Baseline');
  assert.equal(dedupBackups.backupEstimate(id).manifests[0].label, 'Stable');
  assert.equal(dedupBackups.dedupList(id)[0].id, firstDedup.id);

  ({ filePath: exportPath } = await exportEnvironment());
  const restored = path.join(dir, 'environment-contents');
  await fs.mkdir(restored);
  new AdmZip(exportPath).extractAllTo(restored, true);
  const exportedDb = new DatabaseSync(path.join(restored, 'outpost.db'));
  try {
    assert.equal(exportedDb.prepare('SELECT name FROM snapshot_metadata WHERE snapshot_id = ?').get(original.fileName).name, 'Before 1.22');
  } finally { exportedDb.close(); }

  await dedupBackups.createDedup(id);
  assert.equal(snapshotMetadata(id, 'deduplicated').has(firstDedup.id), false);
  zipBackups.enforceRetention(id, 1);
  assert.equal(snapshotMetadata(id, 'zip').has(original.fileName), false);
  zipBackups.deleteBackup(id, scheduled.fileName);
  assert.equal(snapshotMetadata(id, 'zip').size, 0);
  console.log('Snapshot metadata: legacy labels, scheduling, both backup formats, permissions, unchanged archives, environment export, and retention passed.');
} finally {
  if (http) {
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  }
  if (exportPath) await fs.rm(exportPath, { force: true });
  closeDatabase();
  await fs.rm(dir, { recursive: true, force: true });
}
