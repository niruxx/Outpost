import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Run after npm run build --workspace=server. Never open the real panel database.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-config-access-'));
process.env.OUTPOST_DATA_DIR = dir;
const { db } = await import('../dist/db/db.js');
try {
  const { runMigrations } = await import('../dist/db/migrations.js');
  runMigrations(db); // upgrading twice must be safe
  const users = await import('../dist/services/userService.js');
  const { requireConfigItems, requirePermission } = await import('../dist/auth/middleware.js');
  const viewer = users.createUser('restricted', 'test-password-123', 'viewer');
  db.prepare("INSERT INTO servers (id, name, platform, loader, version) VALUES ('test', 'Test', 'java', 'vanilla', '1.21')").run();
  const req = { auth: { sub: viewer.id, role: 'viewer', username: viewer.username }, params: { serverId: 'test' }, method: 'PATCH', originalUrl: '/api/servers/test' };
  const denied = (fn) => assert.throws(fn, (error) => error.status === 403 || error.statusCode === 403);
  users.setUserServerAccess(viewer.id, [{ serverId: 'test', permissions: null, configAccess: { 'property.motd': true, 'setting.serverPort': false } }]);
  requireConfigItems(req, 'property', { motd: 'Allowed' });
  denied(() => requireConfigItems(req, 'property', { motd: 'Allowed', difficulty: 'hard' }));
  denied(() => requireConfigItems(req, 'setting', { serverPort: 25566 }));
  denied(() => requireConfigItems(req, 'property', { 'server-port': '25566' }));
  assert.equal(users.getUserServerAccessDetailed(viewer.id)[0].configAccess['property.motd'], true);
  users.updateUserRole(viewer.id, 'moderator');
  req.auth.role = 'moderator';
  requireConfigItems(req, 'setting', { name: 'Inherited' });
  denied(() => requirePermission(req, 'settings'));
  for (const capability of ['files.write', 'console', 'backups.restore', 'launch', 'plugins', 'update', 'players']) {
    assert.equal(users.getServerPermissions(viewer.id, 'moderator', 'test').includes(capability), false);
  }
  req.auth.role = 'admin';
  requireConfigItems(req, 'setting', { serverPort: 25566 });
  requirePermission(req, 'files.write');
  req.auth.role = 'viewer';
  users.setUserServerAccess(viewer.id, []);
  denied(() => requireConfigItems(req, 'property', { motd: 'No assignment' }));
  assert.deepEqual(users.sanitizeConfigAccess({ 'setting.unknown': true, 'property.motd': 'yes', 'property.a\nb': false }), {});
  users.setUserServerAccess(viewer.id, ['test']);
  assert.deepEqual(users.getConfigAccess(viewer.id, 'viewer', 'test'), {});
  assert.deepEqual(users.getServerPermissions(viewer.id, 'viewer', 'test'), ['files.read']);
  console.log('Configuration access checks passed');
} finally {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
