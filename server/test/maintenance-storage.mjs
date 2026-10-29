import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'outpost-maintenance-'));
process.env.OUTPOST_DATA_DIR = root;
const h = await import('../dist/services/storageHelper.js');
const { StorageManager } = await import('../dist/services/storageService.js');
const { db } = await import('../dist/db/db.js');
const M = 1048576, uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const disk = (name, id, more = {}) => ({ name, path: name, kname: path.posix.basename(name), 'maj:min': id, type: 'disk', size: 1024 * M, ro: false, rota: true, serial: name === '/dev/nvme0n1' ? 'NVME-ONLY' : `SERIAL-${id}`, mountpoints: [], ...more });
const data = disk('/dev/vault/data', '253:1', { type: 'lvm', size: 64 * M, fstype: 'ext4' });
const cache = disk('/dev/vault/fast', '253:2', { type: 'lvm', size: 64 * M });
const mapping = disk('/dev/dm-0', '253:0', { type: 'crypt', size: 496 * M, fstype: 'LVM2_member', children: [data, cache] });
const outer = disk('/dev/sdb1', '8:17', { type: 'part', size: 512 * M, fstype: 'crypto_LUKS', uuid, children: [mapping] });
const blocks = [disk('/dev/sda', '8:0', { fstype: 'ext4', mountpoints: ['/'] }), disk('/dev/sdb', '8:16', { children: [outer] }), disk('/dev/sdc', '8:32', { tran: 'sata' }), disk('/dev/nvme0n1', '259:0', { tran: 'nvme', rota: false }), disk('/dev/md0', '9:0', { type: 'raid5', fstype: 'ext4' }), ...['d', 'e', 'f', 'g'].map((n, i) => disk(`/dev/sd${n}`, `8:${48 + i * 16}`, { fstype: 'linux_raid_member' }))];
let cacheKind = 'linear', pvResized = false, badPv = false, extraNamespace = false, shared = false, cap = 3, firmwareState = 0, pending = false, pendingFile = false, firmwareFail = false, badSerial = false, smartCalls = 0, modernLog = false;
const calls = [];
const metadata = JSON.stringify({ keyslots: { '0': {} }, segments: { '0': { type: 'crypt', offset: String(16 * M), size: 'dynamic', sector_size: 512 } } });
const host = {
  protectedPaths: [],
  async read(file) {
    if (file === '/etc/fstab' || file === '/etc/crypttab' || file.includes('mdadm.conf')) return '';
    if (file === '/proc/swaps') return 'Filename Type Size Used Priority\n';
    if (file.endsWith('/diskseq')) return '17';
    if (file.endsWith('/dm/name')) return 'vault-crypt';
    if (file.endsWith('/md/degraded')) return '0';
    if (file.endsWith('/md/sync_action')) return 'idle';
    if (file.endsWith('/md/array_state')) return 'clean';
    if (file.includes('/md/dev-')) return file.includes('sdg') ? 'spare' : 'in_sync';
    if (file.endsWith('/transport')) return 'pcie';
    if (file.endsWith('/subsysnqn')) return 'nqn.fixture';
    if (file.includes('/sanitize/') && pendingFile) return '{"pending":true}';
    throw Object.assign(new Error('Not present'), { code: 'ENOENT' });
  },
  async list(dir) { return dir === '/sys/class/nvme' ? shared ? ['nvme0', 'nvme1'] : ['nvme0'] : extraNamespace ? ['nvme0n1', 'nvme0n2'] : ['nvme0n1']; },
  async run(command, args, input) {
    calls.push({ command, args, input });
    if (command === 'lsblk') return JSON.stringify({ blockdevices: blocks });
    if (command === 'findmnt') return JSON.stringify({ filesystems: [{ source: '/dev/sda', target: '/', 'maj:min': '8:0' }] });
    if (command === 'pvs') return JSON.stringify({ report: [{ pv: [{ pv_name: mapping.path, pv_uuid: 'PV', vg_name: 'vault', pv_size: String((pvResized ? 236 : 496) * M), pv_free: String(368 * M), pv_used: String(128 * M), pe_start: String(M), pv_pe_count: String(badPv ? 124 : 59) }] }] });
    if (command === 'vgs') return JSON.stringify({ report: [{ vg: [{ vg_name: 'vault', vg_uuid: 'VG', vg_size: String(496 * M), vg_free: String(368 * M), vg_extent_size: String(4 * M) }] }] });
    if (command === 'lvs') return JSON.stringify({ report: [{ lv: [data, cache].map(d => ({ lv_name: path.posix.basename(d.path), lv_uuid: d['maj:min'], vg_name: 'vault', lv_path: d.path, lv_size: String(d.size), lv_attr: '-wi-a-----', segtype: d === data ? cacheKind : 'linear', pool_lv: '', origin: '' })) }] });
    if (command === 'cryptsetup' && args[0] === 'luksDump') return metadata;
    if (command === 'cryptsetup' && args[0] === 'status') return `device: ${outer.path}\noffset: 32768 sectors\n`;
    if (command === 'sfdisk' && args[0] === '--json') return JSON.stringify({ partitiontable: { sectorsize: 512, partitions: [{ node: outer.path, start: 2048, size: 1048576 }] } });
    if (command === 'blockdev') return String((args[1] === mapping.path ? 240 : 256) * M);
    if (command === 'pvresize') pvResized = true;
    if (command === 'mdadm' && args.includes('--export')) return 'MD_UUID=aaaa:bbbb:cccc:dddd\nMD_METADATA=1.2\nMD_LEVEL=raid5\nMD_DEVICES=3\nMD_DEVICE_dev_sdd_DEV=/dev/sdd\nMD_DEVICE_dev_sde_DEV=/dev/sde\nMD_DEVICE_dev_sdf_DEV=/dev/sdf\nMD_DEVICE_dev_sdg_DEV=/dev/sdg\n';
    if (command === 'smartctl') { smartCalls++; if (args.at(-1) === '/dev/sdc') throw new Error('SMART unsupported'); return JSON.stringify({ smartctl: { exit_status: 64 }, smart_status: { passed: true }, temperature: { current: 38 }, power_on_time: { hours: 1234 }, ata_smart_self_test_log: { standard: { table: [{ status: { string: 'Completed: read failure' } }] } } }); }
    if (command === 'nvme') {
      if (args[0] === 'id-ctrl') return JSON.stringify({ sn: badSerial ? 'OTHER' : 'NVME-ONLY', nn: 1, cmic: 0, sanicap: cap });
      if (args[0] === 'list-ns') return JSON.stringify({ nsid_list: extraNamespace ? [1, 2] : [1] });
      if (args[0] === 'sanitize-log') return JSON.stringify(modernLog ? { '/dev/nvme0': { sstat: { status: `(${firmwareState}) fixture` } } } : { sstat: firmwareState });
      if (args[0] === 'sanitize') { if (firmwareFail) throw new Error('Submission interrupted'); firmwareState = 2; }
    }
    if (command === 'hdparm') {
      if (args[0] === '-I') return 'Serial Number: SERIAL-8:32\n * SANITIZE feature set\n * BLOCK_ERASE_EXT command\n * CRYPTO_SCRAMBLE_EXT command\n';
      if (args[0] === '--sanitize-status') return `State: SD${firmwareState === 1 ? 4 : firmwareState} Sanitize fixture`;
      else firmwareState = 2;
    }
    return '';
  },
  async reshapeBackup() { return '/independent/reshape.backup'; },
  async firmwarePending(_device, value) { pending = value; },
  async pause() { firmwareState = 1; },
  async withKeyFiles(_secrets, use) { return use({ current: '/private/key' }); },
};
async function run(input, secrets) { const op = h.validateStorageOperation(input); return h.executeStorage(host, op, h.storageFingerprint(await h.inventory(host), op), secrets); }
const last = command => calls.filter(c => c.command === command).at(-1);
try {
  const health = await h.storageHealth(host, await h.inventory(host));
  assert.equal(health['/dev/sda'].result.status, 'warning'); assert.equal(health['/dev/sda'].result.temperatureC, 38); assert.equal(health['/dev/sda'].result.powerOnHours, 1234); assert.match(health['/dev/sda'].result.selfTest, /failure/); assert.equal(health['/dev/sdc'].result.status, 'unavailable');
  assert(last('smartctl').args.includes('--nocheck=standby,0'));
  assert.equal(h.summarizeSmart('{"smart_status":{"passed":false}}').status, 'failed');
  assert.equal(h.summarizeSmart('{"smart_status":{"passed":true}}').status, 'passed');
  assert.equal(h.summarizeSmart('{}').status, 'unknown');
  const nvmeHealth = h.summarizeSmart(JSON.stringify({ smart_status: { passed: true }, nvme_self_test_log: { current_self_test_operation: { value: 1, string: 'Short self-test in progress' }, current_self_test_completion_percent: 42 } })); assert.equal(nvmeHealth.remainingPercent, 58); assert.match(nvmeHealth.selfTest, /in progress/);
  const runner = async request => ({ ...await h.inventory(host), ...(request.includeHealth ? { health: await h.storageHealth(host, await h.inventory(host)) } : {}) });
  const manager = new StorageManager(runner); smartCalls = 0;
  assert.equal((await manager.overview(false)).health, undefined); assert.equal(smartCalls, 0);
  await manager.overview(true); await new Promise(resolve => setTimeout(resolve, 10));
  const cached = await manager.overview(true), count = smartCalls; assert.equal(cached.health['/dev/sda'].status, 'warning');
  await manager.overview(true); assert.equal(smartCalls, count);
  blocks[0].serial = 'REPLACED'; const replaced = await manager.overview(true); assert.equal(replaced.health['/dev/sda'], undefined); blocks[0].serial = 'SERIAL-8:0';

  let start = calls.length;
  await run({ action: 'layerShrink', device: outer.path, sizeMb: 256 }, { passphrase: 'fixture-key' });
  let commands = calls.slice(start); const at = c => commands.findIndex(x => x.command === c);
  assert(at('pvresize') < at('vgchange')); assert(at('vgchange') < commands.findIndex(x => x.command === 'cryptsetup' && x.args[0] === 'resize')); assert(at('sfdisk') < at('lvchange'));
  assert(!commands.some(c => c.command === 'resize2fs')); assert.deepEqual(last('lvchange').args, ['--activate', 'y', 'vault/fast']);
  badPv = true; start = calls.length; await assert.rejects(run({ action: 'layerShrink', device: outer.path, sizeMb: 256 }, { passphrase: 'fixture-key' }), /extent boundary/); assert(!calls.slice(start).some(c => c.command === 'cryptsetup' && c.args[0] === 'resize')); badPv = false;

  await run({ action: 'lvCacheAttach', device: data.path, vg: 'vault', lv: 'data', pool: 'fast', cacheMode: 'writethrough' }); assert.deepEqual(last('lvconvert').args, ['--yes', '--type', 'cache', '--cachevol', 'vault/fast', '--cachemode', 'writethrough', 'vault/data']);
  cache.fstype = 'ext4'; await assert.rejects(run({ action: 'lvCacheAttach', device: data.path, vg: 'vault', lv: 'data', pool: 'fast', cacheMode: 'writethrough' }), /blank/); delete cache.fstype;
  cacheKind = 'cache'; await run({ action: 'lvCacheDetach', device: data.path, vg: 'vault', lv: 'data' }); assert.deepEqual(last('lvconvert').args, ['--splitcache', 'vault/data']);
  await run({ action: 'lvCacheMode', device: data.path, vg: 'vault', lv: 'data', cacheMode: 'writeback' }); assert.deepEqual(last('lvchange').args, ['--cachemode', 'writeback', 'vault/data']); cacheKind = 'linear';
  await run({ action: 'raidGrow', device: '/dev/md0', raidDevices: 4 }); assert.deepEqual(last('mdadm').args, ['--grow', '/dev/md0', '--raid-devices=4', '--backup-file=/independent/reshape.backup']);
  await assert.rejects(run({ action: 'raidGrow', device: '/dev/md0', raidDevices: 5 }), /spares/);
  await assert.rejects(run({ action: 'raidGrow', device: '/dev/md0', raidDevices: 2 }), /increased/);

  await run({ action: 'firmwareSanitize', device: '/dev/nvme0n1', sanitizeMethod: 'nvme-block' }); assert.equal(pending, false); assert.deepEqual(calls.find(c => c.command === 'nvme' && c.args[0] === 'sanitize').args, ['sanitize', '/dev/nvme0', '--sanact=2']);
  for (const reason of ['namespace', 'shared', 'capability', 'serial']) {
    extraNamespace = reason === 'namespace'; shared = reason === 'shared'; cap = reason === 'capability' ? 0 : 3; badSerial = reason === 'serial'; start = calls.length;
    await assert.rejects(run({ action: 'firmwareSanitize', device: '/dev/nvme0n1', sanitizeMethod: 'nvme-block' })); assert(!calls.slice(start).some(c => c.command === 'nvme' && c.args[0] === 'sanitize'));
  }
  extraNamespace = shared = badSerial = false; cap = 3; modernLog = true;
  await run({ action: 'firmwareSanitize', device: '/dev/nvme0n1', sanitizeMethod: 'nvme-crypto' }); assert.equal(pending, false);
  firmwareFail = true;
  await assert.rejects(run({ action: 'firmwareSanitize', device: '/dev/nvme0n1', sanitizeMethod: 'nvme-block' }), /maintenance record/); assert.equal(pending, true); firmwareFail = false;
  pendingFile = true; const blocked = await h.inventory(host); assert.throws(() => h.checkOperation(blocked, h.validateStorageOperation({ action: 'secureErase', device: '/dev/nvme0n1', eraseMethod: 'secure-discard' })), /maintenance/);
  firmwareState = 1; await run({ action: 'firmwareInfo', device: '/dev/nvme0n1' }); assert.equal(pending, false); pendingFile = false;
  firmwareState = 0; await run({ action: 'firmwareSanitize', device: '/dev/sdc', sanitizeMethod: 'ata-block' }); assert(calls.some(c => c.command === 'hdparm' && c.args.includes('--sanitize-block-erase')));
  assert(!calls.some(c => c.args.includes('--force') || c.args.includes('--security-set-pass')));
  console.log('SMART summaries/cache/identity, LVM-inside-LUKS ordering, cache safety, RAID growth and ATA/NVMe sanitization guards passed; every disk/command was simulated');
} finally { db.close(); await fs.rm(root, { recursive: true, force: true }); }

