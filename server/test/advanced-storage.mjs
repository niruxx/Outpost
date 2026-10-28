import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

// All device data and privileged commands are simulated. Never operates on a real block device.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'outpost-advanced-storage-'));
process.env.OUTPOST_DATA_DIR = root;
const { db } = await import('../dist/db/db.js');
const helper = await import('../dist/services/storageHelper.js');
const { StorageManager } = await import('../dist/services/storageService.js');
const { createStorageRouter } = await import('../dist/routes/storage.routes.js');
const users = await import('../dist/services/userService.js');
const { createToken } = await import('../dist/auth/tokens.js');
const M = 1048576;
const node = (name, id, extra = {}) => ({ name, path: name, kname: name.split('/').at(-1), 'maj:min': id, type: 'part', size: 1024 * M, ro: false, mountpoints: [], ...extra });
const lv = node('/dev/games/data', '253:1', { type: 'lvm', fstype: 'ext4', uuid: 'DATA-FS', size: 512 * M });
const blocks = [
  node('/dev/sda', '8:0', { type: 'disk', children: [node('/dev/sda1', '8:1', { fstype: 'ext4', mountpoints: ['/'] })] }),
  node('/dev/sdb', '8:16', { type: 'disk', children: [node('/dev/sdb1', '8:17', { fstype: 'LVM2_member', children: [lv] })] }),
  node('/dev/sdc', '8:32', { type: 'disk', children: [node('/dev/sdc1', '8:33', { fstype: 'LVM2_member' })] }),
  node('/dev/sdd', '8:48', { type: 'disk', children: [node('/dev/sdd3', '8:51')] }),
  node('/dev/sde', '8:64', { type: 'disk', children: [node('/dev/sde1', '8:65', { fstype: 'crypto_LUKS', uuid: 'LOCKED-UUID' })] }),
  node('/dev/sdf', '8:80', { type: 'disk', children: [node('/dev/sdf1', '8:81', { fstype: 'crypto_LUKS', children: [node('/dev/dm-9', '253:9', { type: 'crypt', size: 256 * M, fstype: 'ext4', kname: 'dm-9' })] })] }),
];
const pvs = [{ pv_name: '/dev/sdb1', pv_uuid: 'PV-ONE', vg_name: 'games', pv_size: String(1024 * M), pv_free: String(512 * M), pv_used: String(512 * M) }, { pv_name: '/dev/sdc1', pv_uuid: 'PV-TWO', vg_name: '', pv_size: String(1024 * M), pv_free: String(1024 * M), pv_used: '0' }];
const vgs = [{ vg_name: 'games', vg_uuid: 'VG-STABLE-ID', vg_size: String(1024 * M), vg_free: String(512 * M) }];
const lvs = [{ lv_name: 'data', lv_uuid: 'LV-STABLE-ID', vg_name: 'games', lv_path: '/dev/games/data', lv_size: String(512 * M), lv_attr: '-wi-a-----', segtype: 'linear', pool_lv: '', origin: '' }, { lv_name: 'pool', lv_uuid: 'POOL-ID', vg_name: 'games', lv_path: '', lv_size: String(128 * M), lv_attr: 'twi-a-tz--', segtype: 'thin-pool', pool_lv: '', origin: '' }];
const calls = [], suppliedSecrets = [];
let fstab = '', crypttab = '', server;
const host = {
  protectedPaths: ['/panel'],
  async read(file) {
    if (file === '/etc/fstab') return fstab;
    if (file === '/etc/crypttab') return crypttab;
    if (file === '/proc/swaps') return 'Filename Type Size Used Priority\n';
    if (file.endsWith('/diskseq')) return '123';
    if (file.endsWith('/dm/name')) return 'vault';
    throw new Error('Unexpected read ' + file);
  },
  async run(command, args, input) {
    calls.push({ command, args, input });
    if (command === 'lsblk') return JSON.stringify({ blockdevices: blocks });
    if (command === 'findmnt') return JSON.stringify({ filesystems: [{ source: '/dev/sda1', target: '/', 'maj:min': '8:1' }] });
    if (command === 'pvs') return JSON.stringify({ report: [{ pv: pvs }] });
    if (command === 'vgs') return JSON.stringify({ report: [{ vg: vgs }] });
    if (command === 'lvs') return JSON.stringify({ report: [{ lv: lvs }] });
    if (command === 'sfdisk' && args[0] === '--json') return JSON.stringify({ partitiontable: { sectorsize: 512, partitions: [{ node: '/dev/sdd1', start: 2048, size: 2048 }, { node: '/dev/sdd3', start: 8192, size: 2097152 }] } });
    if (command === 'dumpe2fs') return 'Block count: 65536\nBlock size: 4096\n';
    if (command === 'cryptsetup' && args[0] === 'status') return 'device: /dev/sdf1\noffset: 32768 sectors\n';
    return '';
  },
  async withKeyFiles(secrets, use) { suppliedSecrets.push({ ...secrets }); await use({ current: '/private/current', next: '/private/next' }); },
  async prepareMount() {}, async writeFstab() {},
};
const run = async (op, secrets) => {
  op = helper.validateStorageOperation(op);
  const state = await helper.inventory(host);
  return helper.executeStorage(host, op, helper.storageFingerprint(state, op), secrets);
};
const last = (command) => calls.filter((c) => c.command === command).at(-1).args;
try {
  const state = await helper.inventory(host);
  assert.equal(state.lvm.available, true); assert.equal(state.lvm.vgs[0].name, 'games');
  assert.equal(state.lvm.lvs[0].kind, 'linear');
  const secrets = { passphrase: 'old-password-private', newPassphrase: 'new-password-private' };
  await run({ action: 'luksFormat', device: '/dev/sdd3' }, secrets);
  assert.deepEqual(last('cryptsetup'), ['luksFormat', '--type', 'luks2', '--batch-mode', '--key-file', '/private/next', '/dev/sdd3']);
  await run({ action: 'luksOpen', device: '/dev/sde1', name: 'archive' }, secrets);
  assert.deepEqual(last('cryptsetup'), ['open', '--type', 'luks', '--key-file', '/private/current', '/dev/sde1', 'archive']);
  await run({ action: 'luksPassphrase', device: '/dev/sde1' }, secrets);
  assert.deepEqual(last('cryptsetup'), ['luksChangeKey', '--key-file', '/private/current', '/dev/sde1', '/private/next']);
  assert(!JSON.stringify(calls).includes(secrets.passphrase)); assert(!JSON.stringify(calls).includes(secrets.newPassphrase));
  await run({ action: 'luksGrow', device: '/dev/dm-9' }, secrets);
  assert.deepEqual(last('cryptsetup'), ['resize', '--key-file', '/private/current', 'vault']);
  await run({ action: 'luksClose', device: '/dev/dm-9' });
  assert.deepEqual(last('cryptsetup'), ['close', 'vault']);
  const locked = blocks[5].children[0]; const originalSize = locked.size;
  locked.size = 260 * M;
  await assert.rejects(run({ action: 'luksGrow', device: '/dev/dm-9' }, secrets), /Refusing to shrink/); locked.size = originalSize;
  await assert.rejects(run({ action: 'luksFormat', device: '/dev/sde1' }, secrets), /blank leaf/);
  await assert.rejects(run({ action: 'luksFormat', device: '/dev/sda1' }, secrets), /outside system/);
  assert.throws(() => helper.validateStorageSecrets({ action: 'luksPassphrase' }, {}), /existing passphrase/);
  assert.throws(() => helper.validateStorageSecrets({ action: 'luksFormat' }, { newPassphrase: 'short' }), /new passphrase/);
  await run({ action: 'pvCreate', device: '/dev/sdd3' }); assert.deepEqual(last('pvcreate'), ['--yes', '/dev/sdd3']);
  await run({ action: 'pvRemove', device: '/dev/sdc1' }); assert.deepEqual(last('pvremove'), ['--yes', '/dev/sdc1']);
  await assert.rejects(run({ action: 'pvRemove', device: '/dev/sdb1' }), /unassigned/);
  await run({ action: 'vgCreate', device: '/dev/sdc1', name: 'archive' }); assert.deepEqual(last('vgcreate'), ['archive', '/dev/sdc1']);
  await run({ action: 'vgRename', device: '/dev/sdb1', vg: 'games', name: 'renamed' }); assert.deepEqual(last('vgrename'), ['VG-STABLE-ID', 'renamed']);
  await run({ action: 'vgExtend', device: '/dev/sdb1', vg: 'games', devices: ['/dev/sdc1'] }); assert.deepEqual(last('vgextend'), ['games', '/dev/sdc1']);
  await assert.rejects(run({ action: 'vgCreate', device: '/dev/sdc1', name: 'games' }), /unique/);
  await assert.rejects(run({ action: 'vgRemove', device: '/dev/sdb1', vg: 'games' }), /logical volumes first/);
  await run({ action: 'lvCreate', device: '/dev/sdb1', vg: 'games', name: 'newdata', sizeMb: 128, layout: 'linear' });
  assert.deepEqual(last('lvcreate'), ['--name', 'newdata', '--type', 'linear', '--size', '128M', 'games']);
  await run({ action: 'lvCreate', device: '/dev/sdb1', vg: 'games', name: 'newpool', sizeMb: 128, layout: 'thin-pool' });
  assert.deepEqual(last('lvcreate'), ['--name', 'newpool', '--type', 'thin-pool', '--size', '128M', 'games']);
  await run({ action: 'lvCreate', device: '/dev/sdb1', vg: 'games', name: 'thin', sizeMb: 2048, layout: 'thin', pool: 'pool' });
  assert.deepEqual(last('lvcreate'), ['--name', 'thin', '--thinpool', 'games/pool', '--virtualsize', '2048M']);
  await run({ action: 'lvRename', device: '/dev/sdb1', vg: 'games', lv: 'data', name: 'newname' }); assert.deepEqual(last('lvrename'), ['games', 'data', 'newname']);
  await run({ action: 'lvSnapshot', device: '/dev/sdb1', vg: 'games', lv: 'data', name: 'before', sizeMb: 64 });
  assert.deepEqual(last('lvcreate'), ['--snapshot', '--name', 'before', '--size', '64M', 'games/data']);
  lvs[0].segtype = 'thin';
  await run({ action: 'lvSnapshot', device: '/dev/sdb1', vg: 'games', lv: 'data', name: 'thin-snapshot', sizeMb: 2048 });
  assert.deepEqual(last('lvcreate'), ['--snapshot', '--name', 'thin-snapshot', 'games/data']); lvs[0].segtype = 'linear';
  await run({ action: 'lvResize', device: '/dev/sdb1', vg: 'games', lv: 'data', sizeMb: 256 });
  assert.deepEqual(last('lvresize'), ['--yes', '--resizefs', '--size', '256M', 'games/data']);
  lv.fstype = 'xfs'; await assert.rejects(run({ action: 'lvResize', device: '/dev/sdb1', vg: 'games', lv: 'data', sizeMb: 256 }), /Shrinking requires/);
  await run({ action: 'lvResize', device: '/dev/sdb1', vg: 'games', lv: 'data', sizeMb: 768 }); assert.deepEqual(last('lvextend'), ['--size', '768M', 'games/data']); lv.fstype = 'ext4';
  lv.mountpoints = ['/mnt/live']; await assert.rejects(run({ action: 'vgRename', device: '/dev/sdb1', vg: 'games', name: 'newvg' }), /Unmount/); lv.mountpoints = [];
  fstab = '/dev/games/data /mnt/data ext4 defaults 0 2\n'; await assert.rejects(run({ action: 'lvRename', device: '/dev/sdb1', vg: 'games', lv: 'data', name: 'newlv' }), /UUID/); fstab = '';
  crypttab = 'encrypted /dev/games/data none luks\n'; await assert.rejects(run({ action: 'lvRemove', device: '/dev/sdb1', vg: 'games', lv: 'data' }), /crypttab/); crypttab = '';
  await run({ action: 'partitionGrow', device: '/dev/sdd3' }); assert.deepEqual(last('growpart'), ['/dev/sdd', '3']);
  blocks[3].children[0].fstype = 'ext4';
  const shrinkStart = calls.length;
  await run({ action: 'partitionShrink', device: '/dev/sdd3', sizeMb: 256 });
  const shrinkCommands = calls.slice(shrinkStart).filter((c) => ['e2fsck', 'resize2fs', 'dumpe2fs', 'sfdisk'].includes(c.command));
  assert.deepEqual(shrinkCommands.slice(-4).map((c) => c.command), ['e2fsck', 'resize2fs', 'dumpe2fs', 'sfdisk']);
  assert.deepEqual(shrinkCommands.at(-1).args, ['--lock', '--wipe', 'never', '--wipe-partitions', 'never', '-N', '3', '/dev/sdd']);
  assert.equal(shrinkCommands.at(-1).input, ',524288\n');
  const beforeBadShrink = calls.filter((c) => c.command === 'sfdisk' && c.args.includes('-N')).length;
  await assert.rejects(run({ action: 'partitionShrink', device: '/dev/sdd3', sizeMb: 32 }), /Filesystem size could not be verified/);
  assert.equal(calls.filter((c) => c.command === 'sfdisk' && c.args.includes('-N')).length, beforeBadShrink);
  await run({ action: 'lvResize', device: '/dev/sdb1', vg: 'games', lv: 'pool', sizeMb: 256 });
  assert.deepEqual(last('lvextend'), ['--size', '256M', 'games/pool']);
  await assert.rejects(run({ action: 'lvResize', device: '/dev/sdb1', vg: 'games', lv: 'pool', sizeMb: 32 }), /growth only/);
  await run({ action: 'lvActivate', device: '/dev/sdb1', vg: 'games', lv: 'data' }); assert.deepEqual(last('lvchange'), ['--activate', 'y', 'games/data']);
  await run({ action: 'lvDeactivate', device: '/dev/sdb1', vg: 'games', lv: 'data' }); assert.deepEqual(last('lvchange'), ['--activate', 'n', 'games/data']);
  await run({ action: 'lvRename', device: '/dev/sdb1', vg: 'games', lv: 'pool', name: 'renamedpool' }); assert.deepEqual(last('lvrename'), ['games', 'pool', 'renamedpool']);
  await run({ action: 'pvGrow', device: '/dev/sdb1', vg: 'games' }); assert.deepEqual(last('pvresize'), ['/dev/sdb1']);
  pvs[1].vg_name = 'games';
  await run({ action: 'vgReduce', device: '/dev/sdc1', vg: 'games' }); assert.deepEqual(last('vgreduce'), ['games', '/dev/sdc1']); pvs[1].vg_name = '';
  await run({ action: 'lvRemove', device: '/dev/sdb1', vg: 'games', lv: 'data' }); assert.deepEqual(last('lvremove'), ['--yes', 'games/data']);
  await run({ action: 'filesystemGrow', device: '/dev/games/data' }); assert.deepEqual(last('resize2fs'), ['/dev/games/data']);
  await assert.rejects(run({ action: 'lvCreate', device: '/dev/sdb1', vg: 'games', name: 'too-large', sizeMb: 900 }), /free group space/);
  assert.throws(() => helper.validateStorageOperation({ action: 'vgRename', device: '/dev/sdb1', name: '--config' }), /simple LVM/);

  const manager = new StorageManager(async (request) => request.action === 'inventory' ? helper.inventory(host) : helper.executeStorage(host, request.operation, request.fingerprint, request.secrets));
  const actor = users.createUser('crypto-operator', 'test-password-123', 'viewer'); users.setStoragePermissions(actor.id, ['encrypt', 'lvm']);
  const token = createToken(actor.id, actor.username, actor.role);
  const app = express(); app.use(express.json()); app.use('/api/storage', createStorageRouter(manager)); app.use((error, _req, res, _next) => res.status(error.status ?? 500).json({ error: error.message }));
  server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/storage`;
  const req = (route, body) => fetch(base + route, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await req('/preview', { action: 'lvResize', device: '/dev/sdb1', vg: 'games', lv: 'data', sizeMb: 256 })).status, 403);
  const preview = await (await req('/preview', { action: 'luksPassphrase', device: '/dev/sde1', passphrase: secrets.passphrase, secrets })).json();
  assert(!JSON.stringify(preview).includes(secrets.passphrase)); assert(!JSON.stringify(preview).includes(secrets.newPassphrase));
  assert.equal((await req('/execute', { ticket: preview.ticket, confirmation: preview.confirmation })).status, 400);
  assert.equal((await req('/execute', { ticket: preview.ticket, confirmation: preview.confirmation, secrets })).status, 202);
  await manager.overview();
  assert(!JSON.stringify(await manager.overview()).includes(secrets.passphrase));
  assert(!JSON.stringify(db.prepare('SELECT detail FROM audit_log').all()).includes(secrets.passphrase));
  assert(!JSON.stringify(db.prepare('SELECT detail FROM audit_log').all()).includes(secrets.newPassphrase));
  users.setStoragePermissions(actor.id, ['encrypt', 'lvm', 'resize']);
  const sizePreview = await (await req('/preview', { action: 'lvResize', device: '/dev/sdb1', vg: 'games', lv: 'data', sizeMb: 256 })).json();
  assert(sizePreview.ticket); users.setStoragePermissions(actor.id, ['encrypt', 'lvm']);
  assert.equal((await req('/execute', { ticket: sizePreview.ticket, confirmation: sizePreview.confirmation })).status, 403);
  users.setStoragePermissions(actor.id, []); assert.equal((await req('/preview', { action: 'luksOpen', device: '/dev/sde1', name: 'test' })).status, 403);
  console.log('LUKS key handling, growth guards, LVM creation/renames/snapshots/resizing, partition growth and live permission checks passed; no real disks modified');
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  db.close(); await fs.rm(root, { recursive: true, force: true });
}
