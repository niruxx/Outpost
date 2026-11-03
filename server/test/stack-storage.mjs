import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Every block device and privileged command is simulated. This test never opens a disk.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'outpost-stack-storage-'));
process.env.OUTPOST_DATA_DIR = root;
const h = await import('../dist/services/storageHelper.js');
const { db } = await import('../dist/db/db.js');
const M = 1048576, EXTENT = 4 * M, PV_EXTENTS = 255;
const disk = (name, id, more = {}) => ({ name, path: name, kname: path.posix.basename(name), 'maj:min': id, type: 'disk', size: 1024 * M, ro: false, rota: true, serial: `SERIAL-${id}`, mountpoints: [], ...more });

// partition -> single-PV VG "games" -> ext4 LVs a (low extents) and b (high extents)
let aExtents = 64, bStart = 600, segmentsBroken = false;
const lvA = disk('/dev/games/a', '253:1', { type: 'lvm', size: 256 * M, fstype: 'ext4' });
const lvB = disk('/dev/games/b', '253:2', { type: 'lvm', size: 128 * M, fstype: 'ext4' });
const part = disk('/dev/sdb1', '8:17', { type: 'part', size: 1024 * M, fstype: 'LVM2_member', children: [lvA, lvB] });
// RAID5: four in-sync members + one spare, 256 MiB components, ext4 directly on the array
const md = disk('/dev/md0', '9:0', { type: 'raid5', size: 768 * M, fstype: 'ext4' });
// NVMe subsystem with two namespaces
const ns1 = disk('/dev/nvme0n1', '259:0', { tran: 'nvme', rota: false, serial: 'NVME-SHARED' });
const ns2 = disk('/dev/nvme0n2', '259:1', { tran: 'nvme', rota: false, serial: 'NVME-SHARED' });
const blocks = [disk('/dev/sda', '8:0', { fstype: 'ext4', mountpoints: ['/'] }), disk('/dev/sdb', '8:16', { children: [part] }), md, ...['c', 'd', 'e', 'f', 'g'].map((n, i) => disk(`/dev/sd${n}`, `8:${32 + i * 16}`, { fstype: 'linux_raid_member' })), ns1, ns2];
let controllers = ['nvme0'], subsystemControllers = [1], cmic = 0, allocated = [1, 2], firmwareState = 0, pending = false;
const calls = [];

function segments() {
  const used = [{ start: 0, size: aExtents, lv: 'a' }, { start: bStart, size: 32, lv: 'b' }].sort((x, y) => x.start - y.start);
  const rows = []; let next = 0;
  for (const seg of used) { if (seg.start > next) rows.push({ start: next, size: seg.start - next, lv: '' }); rows.push(seg); next = seg.start + seg.size; }
  if (next < PV_EXTENTS) rows.push({ start: next, size: PV_EXTENTS - next, lv: '' });
  if (segmentsBroken) rows.splice(1, 1);
  return rows.map(r => ({ pv_name: part.path, pe_start: String(M), pvseg_start: String(r.start), pvseg_size: String(r.size), lv_name: r.lv }));
}
const host = {
  protectedPaths: [],
  async read(file) {
    if (file === '/etc/fstab' || file === '/etc/crypttab' || file.includes('mdadm.conf')) return '';
    if (file === '/proc/swaps') return 'Filename Type Size Used Priority\n';
    if (file.endsWith('/diskseq')) return '5';
    if (file.endsWith('/md/degraded')) return '0';
    if (file.endsWith('/md/sync_action')) return 'idle';
    if (file.endsWith('/md/array_state')) return 'clean';
    if (file.endsWith('/md/component_size')) return String(256 * 1024);
    if (file.endsWith('/md/layout')) return '2';
    if (file.endsWith('/md/sync_completed')) return '1024 / 4096';
    if (file.endsWith('/md/sync_speed')) return '2048';
    if (file.includes('/md/dev-')) return file.includes('sdg') ? 'spare' : 'in_sync';
    if (file.endsWith('/nsid')) return file.includes('nvme0n2') ? '2' : '1';
    if (file.endsWith('/subsysnqn')) return 'nqn.shared';
    if (file.endsWith('/transport')) return 'pcie';
    if (file.endsWith('/cntlid')) return String(controllers.indexOf(file.split('/')[4]) + 1);
    throw Object.assign(new Error(`No fixture for ${file}`), { code: 'ENOENT' });
  },
  async list(dir) { if (dir === '/sys/class/nvme') return controllers; throw new Error(`Unexpected list ${dir}`); },
  async run(command, args, input) {
    calls.push({ command, args, input });
    if (command === 'lsblk') return JSON.stringify({ blockdevices: blocks });
    if (command === 'findmnt') return JSON.stringify({ filesystems: [{ source: '/dev/sda', target: '/', 'maj:min': '8:0' }] });
    if (command === 'pvs' && args[0] === '--segments') return JSON.stringify({ report: [{ pvseg: segments() }] });
    if (command === 'pvs' && args.includes('pv_name,pe_start,pv_pe_count')) return JSON.stringify({ report: [{ pv: [{ pv_name: part.path, pe_start: String(M), pv_pe_count: '127' }] }] });
    if (command === 'pvs') return JSON.stringify({ report: [{ pv: [{ pv_name: part.path, pv_uuid: 'PV', vg_name: 'games', pv_size: String(1020 * M), pv_free: String(636 * M), pv_used: String(384 * M) }] }] });
    if (command === 'vgs') return JSON.stringify({ report: [{ vg: [{ vg_name: 'games', vg_uuid: 'VG', vg_size: String(1020 * M), vg_free: String(636 * M), vg_extent_size: String(EXTENT) }] }] });
    if (command === 'lvs') return JSON.stringify({ report: [{ lv: [lvA, lvB].map(d => ({ lv_name: path.posix.basename(d.path), lv_uuid: d['maj:min'], vg_name: 'games', lv_path: d.path, lv_size: String(d.size), lv_attr: '-wi-a-----', segtype: 'linear', pool_lv: '', origin: '' })) }] });
    if (command === 'lvreduce') { aExtents = 32; return ''; }
    if (command === 'pvmove') { bStart = Number(args.at(-1).split(':')[1].split('-')[0]); return ''; }
    if (command === 'dumpe2fs') { const target = calls.filter(c => c.command === 'resize2fs').at(-1); return `Block count: ${parseInt(target.args[1]) / 4}\nBlock size: 4096\n`; }
    if (command === 'blockdev') return String(args[1] === lvA.path ? 128 * M : args[1] === md.path ? 512 * M : 512 * M);
    if (command === 'sfdisk' && args[0] === '--json') return JSON.stringify({ partitiontable: { sectorsize: 512, partitions: [{ node: part.path, start: 2048, size: 2097152 }] } });
    if (command === 'mdadm' && args.includes('--export')) return 'MD_UUID=aaaa:bbbb:cccc:dddd\nMD_METADATA=1.2\nMD_LEVEL=raid5\nMD_DEVICES=4\n' + ['c', 'd', 'e', 'f', 'g'].map(n => `MD_DEVICE_dev_sd${n}_DEV=/dev/sd${n}`).join('\n') + '\n';
    if (command === 'nvme') {
      if (args[0] === 'id-ctrl') return JSON.stringify({ sn: 'NVME-SHARED', nn: 4, cmic, sanicap: 3 });
      if (args[0] === 'list-ns') return JSON.stringify({ nsid_list: allocated });
      if (args[0] === 'list-ctrl') return JSON.stringify({ num_ctrl: subsystemControllers.length, ctrl_list: subsystemControllers.map(id => ({ ctrl_id: id })) });
      if (args[0] === 'sanitize-log') return JSON.stringify({ sstat: firmwareState });
      if (args[0] === 'sanitize') firmwareState = 2;
    }
    return '';
  },
  async reshapeBackup() { return '/independent/reshape.backup'; },
  async firmwarePending(_device, value) { pending = value; },
  async pause() { firmwareState = 1; },
};
async function run(input) { const op = h.validateStorageOperation(input); return h.executeStorage(host, op, h.storageFingerprint(await h.inventory(host), op)); }
const since = start => calls.slice(start);
const mutating = list => list.filter(c => ['resize2fs', 'lvreduce', 'pvmove', 'pvresize', 'vgchange', 'sfdisk', 'mdadm', 'nvme'].includes(c.command) && !(c.command === 'sfdisk' && c.args[0] === '--json') && !(c.command === 'mdadm' && c.args.includes('--export')) && !(c.command === 'nvme' && c.args[0] !== 'sanitize'));
try {
  const raidState = (await h.inventory(host)).raid.find(r => r.device === md.path);
  assert.deepEqual(raidState.progress, { done: 1024, total: 4096, speedKiB: 2048 });
  // Compaction planning splits moves across free gaps and never targets extents at/after the boundary.
  assert.deepEqual(h.planCompaction([{ start: 0, size: 10, lv: 'a' }, { start: 10, size: 3, lv: '' }, { start: 13, size: 2, lv: 'b' }, { start: 15, size: 5, lv: '' }, { start: 20, size: 4, lv: 'c' }], 18), [{ lv: 'c', from: 20, to: 10, size: 3 }, { lv: 'c', from: 23, to: 15, size: 1 }]);
  assert.throws(() => h.planCompaction([{ start: 0, size: 9, lv: 'a' }, { start: 9, size: 1, lv: '' }, { start: 10, size: 4, lv: 'b' }], 10), /Not enough free extents/);

  // Without compaction the high extents of b block the boundary before anything is changed.
  let start = calls.length;
  await assert.rejects(run({ action: 'pvStackShrink', device: part.path, vg: 'games', sizeMb: 512, lvSizes: { a: 128 } }), /compaction/);
  assert.deepEqual(mutating(since(start)), []);
  // LVs that cannot fit are refused at planning.
  await assert.rejects(run({ action: 'pvStackShrink', device: part.path, vg: 'games', sizeMb: 256, compact: true }), /will not fit/);
  await assert.rejects(run({ action: 'pvStackShrink', device: part.path, vg: 'games', sizeMb: 512, lvSizes: { a: 130 }, compact: true }), /multiple of/);
  segmentsBroken = true; start = calls.length;
  await assert.rejects(run({ action: 'pvStackShrink', device: part.path, vg: 'games', sizeMb: 512, lvSizes: { a: 128 }, compact: true }), /segment map/);
  assert.deepEqual(mutating(since(start)), []); segmentsBroken = false;
  lvB.mountpoints = ['/srv/b']; await assert.rejects(run({ action: 'pvStackShrink', device: part.path, vg: 'games', sizeMb: 512, compact: true }), /Unmount/); lvB.mountpoints = [];

  start = calls.length;
  const result = await run({ action: 'pvStackShrink', device: part.path, vg: 'games', sizeMb: 512, lvSizes: { a: 128 }, compact: true });
  assert.match(result.message, /partition shrink completed/);
  const done = since(start), at = (command, pred = () => true) => done.findIndex(c => c.command === command && pred(c));
  assert.deepEqual(done[at('resize2fs')].args, [lvA.path, `${128 * 1024}K`]);
  assert.deepEqual(done[at('lvreduce')].args, ['--yes', '--size', '128M', 'games/a']);
  assert.deepEqual(done[at('pvmove')].args, ['--alloc', 'anywhere', '--name', 'b', '/dev/sdb1:600-631', '/dev/sdb1:32-63']);
  assert.deepEqual(done[at('pvresize')].args, ['--setphysicalvolumesize', `${512 * M}B`, '--yes', part.path]);
  assert.deepEqual(done[at('sfdisk', c => c.args[0] === '--lock')].input, `,${512 * M / 512}\n`);
  const order = [at('resize2fs'), at('lvreduce'), at('pvmove'), at('pvresize'), at('vgchange'), at('sfdisk', c => c.args[0] === '--lock'), at('lvchange')];
  assert(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])), `unexpected order ${order}`);
  assert.deepEqual(done.filter(c => c.command === 'lvchange').map(c => c.args), [['--activate', 'y', 'games/a'], ['--activate', 'y', 'games/b']]);

  // RAID level/layout conversion and member-count shrinking.
  const mdadm = () => calls.filter(c => c.command === 'mdadm' && !c.args.includes('--export')).at(-1).args;
  await run({ action: 'raidReshape', device: md.path, raidLevel: '6' });
  assert.deepEqual(mdadm(), ['--grow', md.path, '--level=6', '--raid-devices=5', '--backup-file=/independent/reshape.backup']);
  await run({ action: 'raidReshape', device: md.path, raidLayout: 'left-asymmetric' });
  assert.deepEqual(mdadm(), ['--grow', md.path, '--layout=left-asymmetric', '--backup-file=/independent/reshape.backup']);
  await assert.rejects(run({ action: 'raidReshape', device: md.path, raidLevel: '1' }), /two-member/);
  await assert.rejects(run({ action: 'raidReshape', device: md.path, raidLevel: '0' }), /Supported conversions/);
  await assert.rejects(run({ action: 'raidReshape', device: md.path }), /different RAID level/);
  start = calls.length;
  await run({ action: 'raidShrink', device: md.path, raidDevices: 3 });
  const shrink = since(start).filter(c => ['resize2fs', 'mdadm', 'blockdev'].includes(c.command) && !c.args.includes('--export'));
  assert.deepEqual(shrink.map(c => [c.command, ...c.args]), [['resize2fs', md.path, `${512 * 1024}K`], ['mdadm', '--grow', md.path, `--array-size=${512 * 1024}`], ['blockdev', '--getsize64', md.path], ['mdadm', '--grow', md.path, '--raid-devices=3', '--backup-file=/independent/reshape.backup']]);
  await assert.rejects(run({ action: 'raidShrink', device: md.path, raidDevices: 4 }), /smaller member count/);
  md.fstype = 'xfs'; start = calls.length;
  await assert.rejects(run({ action: 'raidShrink', device: md.path, raidDevices: 3 }), /ext4/); assert.deepEqual(mutating(since(start)), []); md.fstype = 'ext4';
  md.size = 700 * M; await assert.rejects(run({ action: 'raidShrink', device: md.path, raidDevices: 3 }), /component size/); md.size = 768 * M;
  md.mountpoints = ['/srv/raid']; await assert.rejects(run({ action: 'raidReshape', device: md.path, raidLevel: '6' }), /Unmount/); md.mountpoints = [];

  // NVMe sanitize: every namespace in the subsystem is checked and listed.
  const sanitize = () => calls.filter(c => c.command === 'nvme' && c.args[0] === 'sanitize');
  await run({ action: 'firmwareSanitize', device: ns1.path, sanitizeMethod: 'nvme-block' });
  assert.equal(sanitize().length, 1); assert.deepEqual(sanitize()[0].args, ['sanitize', '/dev/nvme0', '--sanact=2']); assert.equal(pending, false);
  const refuse = async (setup, reset, pattern) => {
    setup(); const before = sanitize().length;
    await assert.rejects(run({ action: 'firmwareSanitize', device: ns1.path, sanitizeMethod: 'nvme-block' }), pattern);
    assert.equal(sanitize().length, before); reset(); firmwareState = 0;
  };
  await refuse(() => { ns2.mountpoints = ['/srv/ns2']; }, () => { ns2.mountpoints = []; }, /Unmount/);
  await refuse(() => { allocated = [1, 2, 3]; }, () => { allocated = [1, 2]; }, /allocated namespace/);
  await refuse(() => { cmic = 4; }, () => { cmic = 0; }, /SR-IOV/);
  await refuse(() => { cmic = 2; subsystemControllers = [1, 7]; }, () => { cmic = 0; subsystemControllers = [1]; }, /not attached to this host/);
  // Two local controllers whose IDs match the subsystem's own controller list are accepted.
  controllers = ['nvme0', 'nvme1']; subsystemControllers = [1, 2]; cmic = 2; firmwareState = 0;
  await run({ action: 'firmwareSanitize', device: ns2.path, sanitizeMethod: 'nvme-crypto' });
  assert.deepEqual(sanitize().at(-1).args, ['sanitize', '/dev/nvme0', '--sanact=4']);
  assert(calls.some(c => c.command === 'nvme' && c.args[0] === 'list-ctrl'));
  assert(!calls.some(c => c.args.includes('--force')));
  console.log('Partition/LVM stack shrink, multi-LV shrink, extent compaction, RAID level/layout/shrink and multi-namespace/shared NVMe sanitize guards passed; every disk/command was simulated');
} finally { db.close(); await fs.rm(root, { recursive: true, force: true }); }
