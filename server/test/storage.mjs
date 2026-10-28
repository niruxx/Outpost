import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

// No real Linux storage commands or writes to /etc are performed by these tests.
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'outpost-storage-'));
process.env.OUTPOST_DATA_DIR = temp;
const { db } = await import('../dist/db/db.js');
const helper = await import('../dist/services/storageHelper.js');
const { StorageManager } = await import('../dist/services/storageService.js');
const { createStorageRouter } = await import('../dist/routes/storage.routes.js');
const { usersRouter } = await import('../dist/routes/users.routes.js');
const users = await import('../dist/services/userService.js');
const { createToken } = await import('../dist/auth/tokens.js');
const { createKey } = await import('../dist/services/apiKeyService.js');
let server;
const device = (name, id, extra = {}) => ({ name: '/dev/' + name, path: '/dev/' + name, kname: name, 'maj:min': id, type: 'disk', size: 1073741824, serial: 'SERIAL-' + name, model: 'Fake disk', ro: false, mountpoints: [], ...extra });
function simulatedHost() {
  const blockdevices = [
    device('sda', '8:0', { children: [device('sda1', '8:1', { type: 'part', fstype: 'ext4', uuid: 'ROOT-1234', mountpoints: ['/'] })] }),
    device('sdb', '8:16', { children: [device('sdb1', '8:17', { type: 'part', fstype: 'ext4', uuid: 'DATA-1234', partuuid: 'PART-1234', label: 'Data' })] }),
    device('sdc', '8:32'),
    device('sdd', '8:48', { children: [device('dm-0', '253:0', { type: 'lvm', fstype: 'ext4' })] }),
    device('sde', '8:64', { fstype: 'swap', mountpoints: ['[SWAP]'] }),
    device('sdf', '8:80', { ro: true }),
  ];
  const commands = [];
  let fstab = '# Preserve comments\nUUID=ROOT-1234 / ext4 defaults 0 1\n';
  let mountFails = false;
  const host = {
    protectedPaths: ['/panel'], blockdevices, commands,
    get fstab() { return fstab; }, set fstab(value) { fstab = value; },
    set mountFails(value) { mountFails = value; },
    async read(file) {
      if (file === '/etc/fstab') return fstab;
      if (file === '/proc/swaps') return 'Filename Type Size Used Priority\n/dev/sde partition 1024 0 -2\n';
      if (file.endsWith('/diskseq')) return '100';
      throw new Error('Unexpected fixture read ' + file);
    },
    async run(command, args, input) {
      commands.push({ command, args, input });
      if (command === 'lsblk') return JSON.stringify({ blockdevices });
      if (command === 'findmnt') return JSON.stringify({ filesystems: [{ source: '/dev/sda1', target: '/', fstype: 'ext4', 'maj:min': '8:1' }] });
      if (command === 'mount' && mountFails) throw new Error('Simulated mount failure');
      return '';
    },
    async prepareMount(target) { helper.validateMountpoint(target); commands.push({ command: 'prepare-mount', args: [target] }); },
    async writeFstab(expected, next) { assert.equal(fstab, expected); fstab = next; commands.push({ command: 'write-fstab', args: [next] }); },
  };
  return host;
}
const flatten = (nodes) => nodes.flatMap((d) => [d, ...flatten(d.children)]);
const get = (state, name) => flatten(state.devices).find((d) => d.path === '/dev/' + name);
async function perform(host, op, fingerprint) {
  const state = await helper.inventory(host);
  const disk = get(state, op.device.slice(5));
  return helper.executeStorage(host, op, fingerprint ?? helper.deviceFingerprint(disk));
}
try {
  const host = simulatedHost();
  const state = await helper.inventory(host);
  assert.equal(get(state, 'sda').protected, true); assert.equal(get(state, 'sda1').protected, true);
  assert.equal(get(state, 'sdd').protected, true); assert.equal(get(state, 'sdf').protected, true);
  assert.equal(get(state, 'sdb1').protected, false);
  for (const disk of ['sda', 'sda1', 'sdd', 'sde', 'sdf']) await assert.rejects(perform(host, { action: 'wipe', device: '/dev/' + disk }));
  assert.equal(host.commands.some((c) => c.command === 'wipefs'), false);
  for (const mountpoint of ['/', '/etc/test', '/mnt/../etc', '/mnt/test\nline', 'relative', '/mnt']) assert.throws(() => helper.validateMountpoint(mountpoint));
  assert.throws(() => helper.validateStorageOperation({ action: 'format', device: '/dev/sdc;reboot', filesystem: 'ext4' }));
  assert.throws(() => helper.validateStorageOperation({ action: 'format', device: '/dev/sdc', filesystem: 'ext4', label: 'bad;command' }));
  assert.throws(() => helper.checkOperation(state, { action: 'format', device: '/dev/sdb', filesystem: 'ext4' }));
  assert.throws(() => helper.checkOperation(state, { action: 'partition', device: '/dev/sdb' }));
  await perform(host, { action: 'format', device: '/dev/sdb1', filesystem: 'ext4', label: 'Games' });
  assert.deepEqual(host.commands.find((c) => c.command === 'mkfs.ext4').args, ['-F', '-L', 'Games', '/dev/sdb1']);
  await perform(host, { action: 'partition', device: '/dev/sdc' });
  const partition = host.commands.find((c) => c.command === 'sfdisk');
  assert.equal(partition.input, 'label: gpt\n, , L\n');
  await perform(host, { action: 'wipe', device: '/dev/sdb' });
  assert.deepEqual(host.commands.filter((c) => c.command === 'wipefs').map((c) => c.args), [['--all', '--', '/dev/sdb1'], ['--all', '--', '/dev/sdb']]);
  const beforeFingerprint = helper.deviceFingerprint(get(await helper.inventory(host), 'sdc'));
  host.blockdevices[2].serial = 'REPLACEMENT';
  await assert.rejects(perform(host, { action: 'wipe', device: '/dev/sdc' }, beforeFingerprint), /identity or state changed/);
  host.blockdevices[1].children[0].mountpoints = ['/mnt/attached'];
  await assert.rejects(perform(host, { action: 'format', device: '/dev/sdb1', filesystem: 'ext4' }), /Unmount/);
  host.blockdevices[1].children[0].mountpoints = [];

  const mount = { action: 'mount', device: '/dev/sdb1', mountpoint: '/mnt/game backups', persistent: true, readOnly: false };
  await perform(host, mount);
  assert(host.fstab.includes('# Preserve comments'));
  assert(host.fstab.includes('UUID=ROOT-1234 / ext4 defaults 0 1'));
  assert(host.fstab.includes('UUID=DATA-1234\t/mnt/game\\040backups\text4\tdefaults,nofail,nodev,nosuid'));
  assert.equal(helper.parseFstab(host.fstab).find((e) => e.source === 'UUID=DATA-1234').target, '/mnt/game backups');
  await assert.rejects(perform(host, { action: 'wipe', device: '/dev/sdb1' }), /fstab/);
  await perform(host, { ...mount, action: 'automount', enabled: false });
  assert(!host.fstab.includes('UUID=DATA-1234'));
  host.mountFails = true;
  const original = host.fstab;
  await assert.rejects(perform(host, mount), /Simulated mount failure/);
  assert.equal(host.fstab, original, 'A failed persistent mount must roll back its fstab change');
  host.mountFails = false;
  host.fstab += 'PARTUUID=PART-1234 /mnt/old ext4 defaults 0 2\n';
  await assert.rejects(perform(host, { action: 'wipe', device: '/dev/sdb1' }), /fstab/);
  host.fstab = original + 'UUID=DATA-1234 /mnt/unmanaged ext4 defaults 0 2\n';
  await assert.rejects(perform(host, mount), /unmanaged fstab/);
  host.fstab = original;

  // Real HTTP middleware against the simulated Linux runner. No privileged helper is started.
  const run = async (request) => request.action === 'inventory' ? helper.inventory(host) : helper.executeStorage(host, request.operation, request.fingerprint);
  const manager = new StorageManager(run);
  const app = express(); app.use(express.json()); app.use('/api/storage', createStorageRouter(manager)); app.use('/api/users', usersRouter);
  app.use((err, _req, res, _next) => res.status(err.status ?? 500).json({ error: err.message }));
  server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const admin = users.createUser('disk-admin', 'test-password-123', 'admin');
  const operator = users.createUser('disk-operator', 'test-password-123', 'viewer');
  const other = users.createUser('disk-other', 'test-password-123', 'moderator');
  const token = (user) => createToken(user.id, user.username, user.role);
  const adminToken = token(admin), opToken = token(operator), otherToken = token(other);
  const request = (route, auth, method = 'GET', body) => fetch(base + route, { method, headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await request('/api/storage', opToken)).status, 403);
  assert.equal((await request('/api/storage', otherToken)).status, 403);
  const overview = await (await request('/api/storage', adminToken)).json();
  assert.deepEqual(overview.permissions, users.STORAGE_PERMISSIONS);
  const update = await request('/api/users/' + operator.id, adminToken, 'PATCH', { storagePermissions: ['mount', 'automount'] });
  assert.equal(update.status, 200);
  assert(users.getPublicUser(operator.id).storagePermissions.includes('view'));
  assert.equal((await request('/api/storage', opToken)).status, 200);
  assert.equal((await request('/api/storage/preview', opToken, 'POST', { action: 'wipe', device: '/dev/sdc' })).status, 403);
  const preview = await (await request('/api/storage/preview', opToken, 'POST', mount)).json();
  assert(preview.ticket);
  // Revocation after preview must block the combined fstab change too.
  users.setStoragePermissions(operator.id, ['mount']);
  assert.equal((await request('/api/storage/execute', opToken, 'POST', { ticket: preview.ticket, confirmation: preview.confirmation })).status, 403);
  users.setStoragePermissions(operator.id, ['mount', 'automount']);
  assert.equal((await request('/api/storage/execute', otherToken, 'POST', { ticket: preview.ticket, confirmation: preview.confirmation })).status, 403);
  assert.equal((await request('/api/storage/execute', opToken, 'POST', { ticket: preview.ticket, confirmation: 'wrong device' })).status, 400);
  assert.equal((await request('/api/storage/execute', opToken, 'POST', { ticket: preview.ticket, confirmation: preview.confirmation })).status, 202);
  assert.equal((await request('/api/storage/execute', opToken, 'POST', { ticket: preview.ticket, confirmation: preview.confirmation })).status, 403);
  const key = createKey(admin.id, { name: 'No disk mutation', readOnly: false }).key;
  assert.equal((await request('/api/storage/preview', key, 'POST', mount)).status, 403);
  users.updateUserRole(admin.id, 'viewer');
  assert.equal((await request('/api/storage', adminToken)).status, 403);
  assert.equal((await request('/api/users/' + operator.id, adminToken, 'PATCH', { storagePermissions: ['wipe'] })).status, 403);
  users.setStoragePermissions(operator.id, []);
  assert.equal((await request('/api/storage', opToken)).status, 403);
  console.log('Storage protections, identity checks, captured format/wipe/partition commands, fstab preservation/rollback, delegation and live authorization checks passed (no real disks modified)');
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  db.close(); await fs.rm(temp, { recursive: true, force: true });
}
