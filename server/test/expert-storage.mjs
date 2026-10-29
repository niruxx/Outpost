import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { once } from 'node:events';

// Every block device and privileged action is simulated. This test never opens a disk.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'outpost-expert-storage-'));
process.env.OUTPOST_DATA_DIR = root;
const { db } = await import('../dist/db/db.js');
const helper = await import('../dist/services/storageHelper.js');
const { StorageManager } = await import('../dist/services/storageService.js');
const { createStorageRouter } = await import('../dist/routes/storage.routes.js');
const users = await import('../dist/services/userService.js');
const { createToken } = await import('../dist/auth/tokens.js');
// Exercise actual overwrite/verification I/O on a disposable regular file only.
const scratch = path.join(root, 'overwrite-fixture');
await fs.writeFile(scratch, Buffer.alloc(1048593, 0x73));
const scratchHandle = await fs.open(scratch, 'r+');
try { await helper.overwriteAndVerify(scratchHandle, 1048593); } finally { await scratchHandle.close(); }
assert((await fs.readFile(scratch)).every(byte => byte === 0));
await assert.rejects(helper.overwriteAndVerify({ write: async () => ({ bytesWritten: 0 }), sync: async () => {}, read: async () => ({ bytesRead: 0 }) }, 512), /write/i);
await assert.rejects(helper.overwriteAndVerify({ write: async (_b, _o, length) => ({ bytesWritten: length }), sync: async () => {}, read: async (buffer, offset, length) => { buffer.fill(1); return { bytesRead: length }; } }, 512), /verif/i);
const M = 1048576, uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const node = (name, id, extra = {}) => ({ name, path: name, kname: path.posix.basename(name), 'maj:min': id, type: 'disk', size: 1024 * M, ro: false, rota: true, serial: `SERIAL-${id.replace(':', '-')}`, mountpoints: [], ...extra });
const mapping = node('/dev/dm-9', '253:9', { type: 'crypt', size: 496 * M, fstype: 'ext4' });
const encrypted = node('/dev/sdg1', '8:97', { type: 'part', size: 512 * M, fstype: 'crypto_LUKS', uuid, children: [mapping] });
const lvMapping = node('/dev/dm-11', '253:11', { type: 'crypt', size: 496 * M, fstype: 'ext4' });
const encryptedLv = node('/dev/games/secure', '253:10', { type: 'lvm', size: 512 * M, fstype: 'crypto_LUKS', uuid: '11111111-2222-3333-4444-555555555555', children: [lvMapping] });
const blocks = [
  node('/dev/sda', '8:0', { children: [node('/dev/sda1', '8:1', { type: 'part', fstype: 'ext4', mountpoints: ['/'] })] }),
  node('/dev/sdb', '8:16'), node('/dev/sdc', '8:32'), node('/dev/sdd', '8:48'),
  node('/dev/sde', '8:64', { fstype: 'linux_raid_member' }), node('/dev/sdf', '8:80', { fstype: 'linux_raid_member' }),
  node('/dev/md0', '9:0', { type: 'raid1', size: 512 * M, fstype: 'ext4', uuid: 'RAID-FS' }),
  node('/dev/sdg', '8:96', { children: [encrypted] }),
  node('/dev/sdh', '8:112', { children: [node('/dev/sdh1', '8:113', { type: 'part', fstype: 'LVM2_member', children: [encryptedLv] })] }),
  node('/dev/sdi', '8:128', { children: [node('/dev/sdi1', '8:129', { type: 'part', fstype: 'LVM2_member' })] }),
  node('/dev/nvme0n1', '259:0', { rota: false, tran: 'nvme' }),
];
let slots = { '0': {}, '1': {} }, degraded = 0, sync = 'idle', memberState = 'in_sync', moving = false, filesystemTooLarge = false, badPassphrase = false, badMappingSize = false, eraseUnsupported = false;
const metadata = () => ({ keyslots: slots, segments: { '0': { type: 'crypt', offset: String(16 * M), size: 'dynamic', sector_size: 512 } } });
const files = { '/etc/fstab': '', '/etc/crypttab': '# keep me\nother UUID=99999999-aaaa-bbbb-cccc-dddddddddddd none luks\n', '/etc/mdadm/mdadm.conf': '# existing md config\n', '/etc/mdadm.conf': '' };
const calls = [], secretsSeen = [], writes = [];
const host = {
  protectedPaths: ['/panel'],
  async read(file) {
    if (file in files) return files[file];
    if (file === '/proc/swaps') return 'Filename Type Size Used Priority\n';
    if (file.endsWith('/diskseq')) return '73';
    if (file.endsWith('/dm/name')) return file.includes('dm-11') ? 'secure-lv' : 'vault';
    if (file.endsWith('/md/degraded')) return String(degraded);
    if (file.endsWith('/md/sync_action')) return sync;
    if (file.endsWith('/md/array_state')) return 'clean';
    if (file.includes('/md/dev-')) return memberState;
    throw Object.assign(new Error(`No fixture for ${file}`), { code: 'ENOENT' });
  },
  async run(command, args, input) {
    calls.push({ command, args, input });
    if (command === 'lsblk') return JSON.stringify({ blockdevices: blocks });
    if (command === 'findmnt') return JSON.stringify({ filesystems: [{ source: '/dev/sda1', target: '/', 'maj:min': '8:1' }] });
    if (command === 'pvs') return JSON.stringify({ report: [{ pv: [{ pv_name: '/dev/sdh1', pv_uuid: 'PV-A', vg_name: 'games', pv_size: String(1024 * M), pv_free: String(512 * M), pv_used: String(512 * M) }, { pv_name: '/dev/sdi1', pv_uuid: 'PV-B', vg_name: 'games', pv_size: String(1024 * M), pv_free: String(1024 * M), pv_used: '0' }] }] });
    if (command === 'vgs') return JSON.stringify({ report: [{ vg: [{ vg_name: 'games', vg_uuid: 'VG-UUID', vg_size: String(2048 * M), vg_free: String(1536 * M), vg_extent_size: String(4 * M) }] }] });
    if (command === 'lvs') return JSON.stringify({ report: [{ lv: [{ lv_name: 'secure', lv_uuid: 'LV-UUID', vg_name: 'games', lv_path: encryptedLv.path, lv_size: String(512 * M), lv_attr: '-wi-a-----', segtype: 'linear', pool_lv: '', origin: '' }, ...(moving ? [{ lv_name: '[pvmove0]', lv_uuid: 'MOVE', vg_name: 'games', lv_path: '', lv_size: '0', lv_attr: '', segtype: 'mirror', pool_lv: '', origin: '' }] : [])] }] });
    if (command === 'cryptsetup' && args[0] === 'luksDump') return JSON.stringify(metadata());
    if (command === 'cryptsetup' && args[0] === 'status') return `device: ${args[1] === 'secure-lv' ? encryptedLv.path : encrypted.path}\noffset: 32768 sectors\n`;
    if (command === 'cryptsetup' && args.includes('--test-passphrase') && badPassphrase) throw new Error('Invalid surviving passphrase');
    if (command === 'mdadm' && args.includes('--export')) return 'MD_UUID=abcd:1234:abcd:1234\nMD_LEVEL=raid1\nMD_NAME=host:outpost-array\nMD_DEVICE_dev_sde_DEV=/dev/sde\nMD_DEVICE_dev_sdf_DEV=/dev/sdf\n';
    if (command === 'mdadm' && args[0] === '--detail') return 'State: clean\nRaid Level: raid1';
    if (command === 'sfdisk' && args[0] === '--json') return JSON.stringify({ partitiontable: { sectorsize: 512, partitions: [{ node: '/dev/sdg1', start: 2048, size: 1048576 }] } });
    if (command === 'dumpe2fs') return `Block count: ${filesystemTooLarge ? 65536 : 61440}\nBlock size: 4096\n`;
    if (command === 'blockdev') return String(args[1].startsWith('/dev/dm-') ? (badMappingSize ? 232 : 240) * M : 256 * M);
    if (command === 'smartctl') return JSON.stringify({ smart_status: { passed: false }, ata_smart_self_test_log: { standard: { table: [{ status: { string: 'Completed: read failure' } }] } } });
    if (command === 'blkdiscard' && eraseUnsupported) throw new Error('Secure discard is not supported');
    return '';
  },
  async withKeyFiles(secrets, use) { secretsSeen.push({ ...secrets }); await use({ current: '/private/current', next: '/private/next' }); },
  async writeConfig(file, expected, next) { assert.equal(files[file], expected); writes.push({ file, next }); files[file] = next; },
  async createBootKey(id, slot) { return `/etc/cryptsetup-keys.d/outpost-${id}-${slot}.key`; },
  async backupHeader(_device, id) { return `/var/lib/outpost-storage/headers/${id}.luks`; },
  async overwriteDisk(device) { calls.push({ command: 'SIMULATED-OVERWRITE', args: [device.path, device.size, device.serial] }); },
  async prepareMount() {}, async writeFstab() {},
};
async function run(input, secrets) { const op = helper.validateStorageOperation(input); const state = await helper.inventory(host); return helper.executeStorage(host, op, helper.storageFingerprint(state, op), secrets); }
const last = command => calls.filter(c => c.command === command).at(-1);
let server;
try {
  const state = await helper.inventory(host); assert.equal(state.raid[0].level, 'raid1'); assert.deepEqual(state.encryption[0].slots, [0, 1]); assert.equal(state.lvm.vgs[0].extentSize, 4 * M);
  assert.equal(helper.storageExitAccepted('smartctl', 8), true); assert.equal(helper.storageExitAccepted('smartctl', 64), true); assert.equal(helper.storageExitAccepted('smartctl', 4), false); assert.equal(helper.storageExitAccepted('smartctl', 9), false); assert.equal(helper.storageExitAccepted('mdadm', 8), false);
  await run({ action: 'raidCreate', device: '/dev/sdb', devices: ['/dev/sdb', '/dev/sdc'], name: 'mirror', raidLevel: '1' }); assert.deepEqual(last('mdadm').args, ['--create', '/dev/md/outpost-mirror', '--metadata=1.2', '--name=outpost-mirror', '--level=1', '--raid-devices=2', '--run', '/dev/sdb', '/dev/sdc']);
  await assert.rejects(run({ action: 'raidCreate', device: '/dev/sdb', devices: ['/dev/sdb', '/dev/sdc'], name: 'too-small', raidLevel: '5' }), /Not enough/);
  await assert.rejects(run({ action: 'raidCreate', device: '/dev/sda', devices: ['/dev/sda', '/dev/sdc'], name: 'system', raidLevel: '1' }), /System|system/);
  await run({ action: 'raidAdd', device: '/dev/md0', devices: ['/dev/sdb'] }); assert.deepEqual(last('mdadm').args, ['--manage', '/dev/md0', '--add', '/dev/sdb']);
  await run({ action: 'raidFail', device: '/dev/md0', devices: ['/dev/sde'] }); assert(last('mdadm').args.includes('--fail'));
  degraded = 1; await assert.rejects(run({ action: 'raidFail', device: '/dev/md0', devices: ['/dev/sdf'] }), /currently healthy/); degraded = 0;
  await assert.rejects(run({ action: 'raidRemove', device: '/dev/md0', devices: ['/dev/sde'] }), /Only faulty/);
  memberState = 'faulty'; await run({ action: 'raidRemove', device: '/dev/md0', devices: ['/dev/sde'] }); memberState = 'in_sync';
  sync = 'resync'; await assert.rejects(run({ action: 'raidStop', device: '/dev/md0' }), /synchronization/); sync = 'idle';
  await run({ action: 'raidBootAdd', device: '/dev/md0' }); assert.match(files['/etc/mdadm/mdadm.conf'], /# existing md config/); assert.match(files['/etc/mdadm/mdadm.conf'], /ARRAY \/dev\/md0 UUID=abcd:1234:abcd:1234/);
  await run({ action: 'raidBootRemove', device: '/dev/md0' }); assert(!files['/etc/mdadm/mdadm.conf'].includes('ARRAY'));
  await run({ action: 'pvMove', device: '/dev/sdh1', vg: 'games', devices: ['/dev/sdi1'] }); assert.deepEqual(last('pvmove').args, ['--atomic', '/dev/sdh1', '/dev/sdi1']);
  await assert.rejects(run({ action: 'pvMove', device: '/dev/sdh1', vg: 'games', devices: ['/dev/sdh1'] }), /different/);
  moving = true; await run({ action: 'pvMoveAbort', device: '/dev/sdh1', vg: 'games' }); assert.deepEqual(last('pvmove').args, ['--abort', '/dev/sdh1']); moving = false;
  await run({ action: 'pvShrink', device: '/dev/sdh1', vg: 'games', sizeMb: 768 }); assert.deepEqual(last('pvresize').args, ['--setphysicalvolumesize', '768M', '--yes', '/dev/sdh1']);
  await run({ action: 'luksAddKey', device: encrypted.path, slot: 2 }, { passphrase: 'current-private', newPassphrase: 'new-private-pass' }); assert.deepEqual(last('cryptsetup').args, ['luksAddKey', '--key-slot', '2', '--key-file', '/private/current', encrypted.path, '/private/next']);
  await assert.rejects(run({ action: 'luksAddKey', device: encrypted.path, slot: 0 }, { passphrase: 'old', newPassphrase: 'new-private-pass' }), /unused/);
  const startKill = calls.length; badPassphrase = true; await assert.rejects(run({ action: 'luksRemoveSlot', device: encrypted.path, slot: 1, survivorSlot: 0 }, { passphrase: 'wrong' }), /Invalid surviving/); assert(!calls.slice(startKill).some(c => c.args[0] === 'luksKillSlot')); badPassphrase = false;
  await run({ action: 'luksRemoveSlot', device: encrypted.path, slot: 1, survivorSlot: 0 }, { passphrase: 'surviving-private' }); assert.deepEqual(last('cryptsetup').args, ['luksKillSlot', '--key-file', '/private/current', encrypted.path, '1']);
  slots = { '0': {} }; await assert.rejects(run({ action: 'luksRemoveSlot', device: encrypted.path, slot: 0, survivorSlot: 1 }, { passphrase: 'x' }), /at least one/); slots = { '0': {}, '1': {} };
  await run({ action: 'luksChangeSlot', device: encrypted.path, slot: 1 }, { passphrase: 'current-private', newPassphrase: 'new-private-pass' }); assert(last('cryptsetup').args.includes('--key-slot'));
  await run({ action: 'luksHeaderBackup', device: encrypted.path });
  await run({ action: 'crypttabSet', device: encrypted.path, name: 'vault-boot', keyMode: 'prompt', options: ['nofail'] }); assert.match(files['/etc/crypttab'], /other UUID=/); assert.match(files['/etc/crypttab'], /vault-boot\s+UUID=aaaaaaaa.*none\s+luks,nofail/);
  await run({ action: 'crypttabSet', device: encrypted.path, name: 'vault-boot', keyMode: 'managed', slot: 2, options: ['nofail', 'noauto'] }, { passphrase: 'current-private' }); assert.match(files['/etc/crypttab'], /cryptsetup-keys.d\/outpost-/);
  await run({ action: 'crypttabRemove', device: encrypted.path, name: 'vault-boot' }); assert(!files['/etc/crypttab'].includes('vault-boot')); assert(files['/etc/crypttab'].includes('other UUID='));
  assert.throws(() => helper.validateStorageOperation({ action: 'crypttabSet', device: encrypted.path, name: 'test', options: ['keyscript=/bin/sh'] }), /Unsupported crypttab/);
  const shrink = { action: 'layerShrink', device: encrypted.path, sizeMb: 256 };
  let start = calls.length; await run(shrink, { passphrase: 'current-private' });
  const sequence = calls.slice(start).filter(c => ['e2fsck', 'resize2fs', 'dumpe2fs', 'blockdev', 'sfdisk'].includes(c.command) || (c.command === 'cryptsetup' && c.args[0] !== 'luksDump')).map(c => `${c.command}:${c.args[0]}`);
  assert(sequence.indexOf('resize2fs:/dev/dm-9') < sequence.indexOf('cryptsetup:resize')); assert(sequence.indexOf('cryptsetup:close') < sequence.indexOf('sfdisk:--lock')); assert(sequence.indexOf('sfdisk:--lock') < sequence.lastIndexOf('cryptsetup:open')); assert.equal(last('sfdisk').input, ',524288\n');
  filesystemTooLarge = true; start = calls.length; await assert.rejects(run(shrink, { passphrase: 'current-private' }), /Filesystem verification/); assert(!calls.slice(start).some(c => c.command === 'sfdisk' && c.args[0] !== '--json')); filesystemTooLarge = false;
  badMappingSize = true; start = calls.length; await assert.rejects(run(shrink, { passphrase: 'current-private' }), /Mapping size verification/); assert(!calls.slice(start).some(c => c.command === 'sfdisk' && c.args[0] === '--lock')); badMappingSize = false;
  await run({ ...shrink, device: encryptedLv.path, vg: 'games', lv: 'secure' }, { passphrase: 'current-private' }); assert.deepEqual(last('lvreduce').args, ['--yes', '--size', '256M', 'games/secure']);
  await assert.rejects(run({ ...shrink, device: encryptedLv.path, vg: 'games', lv: 'secure', sizeMb: 257 }, { passphrase: 'current-private' }), /aligned/);
  mapping.fstype = 'xfs'; await assert.rejects(run(shrink, { passphrase: 'current-private' }), /ext4/); mapping.fstype = 'ext4';
  const health = await run({ action: 'smartInfo', device: '/dev/sda' }); assert.match(health.message, /read failure/);
  await run({ action: 'smartLong', device: '/dev/sdb' }); assert.deepEqual(last('smartctl').args, ['--json', '--test', 'long', '/dev/sdb']);
  await run({ action: 'smartAbort', device: '/dev/sdb' }); assert(last('smartctl').args.includes('--abort'));
  await run({ action: 'secureErase', device: '/dev/sdb', eraseMethod: 'overwrite-verify' }); assert.equal(last('SIMULATED-OVERWRITE').args[0], '/dev/sdb');
  await run({ action: 'secureErase', device: '/dev/nvme0n1', eraseMethod: 'secure-discard' }); assert.deepEqual(last('blkdiscard').args, ['--secure', '/dev/nvme0n1']);
  await assert.rejects(run({ action: 'secureErase', device: '/dev/nvme0n1', eraseMethod: 'overwrite-verify' }), /rotational/);
  await assert.rejects(run({ action: 'secureErase', device: '/dev/sda', eraseMethod: 'secure-discard' }), /System/);
  eraseUnsupported = true; start = calls.length; await assert.rejects(run({ action: 'secureErase', device: '/dev/sdb', eraseMethod: 'secure-discard' }), /not supported/); assert(!calls.slice(start).some(c => c.command === 'SIMULATED-OVERWRITE')); eraseUnsupported = false;
  assert(!JSON.stringify(calls).includes('current-private')); assert(!JSON.stringify(calls).includes('new-private-pass'));

  const runner = async request => request.action === 'inventory' ? helper.inventory(host) : helper.executeStorage(host, request.operation, request.fingerprint, request.secrets);
  const manager = new StorageManager(runner); const router = createStorageRouter(manager);
  const actor = users.createUser('expert-operator', 'test-password', 'viewer'); const token = createToken(actor.id, actor.username, actor.role);
  const app = express(); app.use(express.json()); app.use('/storage', router); app.use((error, _req, res, _next) => res.status(error.status ?? 500).json({ error: error.message }));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); const url = `http://127.0.0.1:${server.address().port}/storage`;
  const post = (route, body) => fetch(url + route, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  users.setStoragePermissions(actor.id, ['wipe']); assert.equal((await post('/preview', { action: 'secureErase', device: '/dev/sdb', eraseMethod: 'overwrite-verify' })).status, 403);
  users.setStoragePermissions(actor.id, ['health']); assert.equal((await post('/preview', { action: 'firmwareSanitize', device: '/dev/nvme0n1', sanitizeMethod: 'nvme-block' })).status, 403);
  users.setStoragePermissions(actor.id, ['migrate']); assert.equal((await post('/preview', { action: 'pvMove', device: '/dev/sdh1', vg: 'games', devices: ['/dev/sdi1'] })).status, 403);
  users.setStoragePermissions(actor.id, ['crypttab']); assert.equal((await post('/preview', { action: 'crypttabSet', device: encrypted.path, name: 'boot', keyMode: 'prompt' })).status, 403);
  users.setStoragePermissions(actor.id, ['raid']); assert.equal((await post('/preview', { action: 'raidBootAdd', device: '/dev/md0' })).status, 403);
  users.setStoragePermissions(actor.id, ['erase']); const response = await post('/preview', { action: 'secureErase', device: '/dev/sdb', eraseMethod: 'overwrite-verify' }); assert.equal(response.status, 200); const plan = await response.json(); assert.equal(plan.confirmation, 'ERASE /dev/sdb SERIAL-8-16');
  users.setStoragePermissions(actor.id, ['view']); assert.equal((await post('/execute', { ticket: plan.ticket, confirmation: plan.confirmation })).status, 403);
  console.log('RAID creation/member safety, PV migration, surviving keyslot verification, crypttab preservation, filesystem-first LUKS stack shrinking, SMART reports, erasure guards and live permissions passed; no real disks touched');
} finally { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } db.close(); await fs.rm(root, { recursive: true, force: true }); }
