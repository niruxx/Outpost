/** Standalone privileged helper. Only Node builtins may be imported here. */
import fs from 'node:fs/promises';
import { existsSync, constants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const EXPERT_ACTIONS = ['raidInfo', 'raidCreate', 'raidAdd', 'raidFail', 'raidRemove', 'raidStop', 'raidBootAdd', 'raidBootRemove', 'pvMove', 'pvMoveAbort', 'pvShrink', 'luksInfo', 'luksAddKey', 'luksRemoveSlot', 'luksChangeSlot', 'luksHeaderBackup', 'crypttabSet', 'crypttabRemove', 'layerShrink', 'smartInfo', 'smartShort', 'smartLong', 'smartConveyance', 'smartAbort', 'secureErase'] as const;
export type StorageAction = 'mount' | 'unmount' | 'automount' | 'format' | 'wipe' | 'partition' | 'luksFormat' | 'luksOpen' | 'luksClose' | 'luksPassphrase' | 'luksGrow' | 'pvCreate' | 'pvRemove' | 'pvGrow' | 'vgCreate' | 'vgRename' | 'vgExtend' | 'vgReduce' | 'vgRemove' | 'lvCreate' | 'lvRename' | 'lvResize' | 'lvRemove' | 'lvSnapshot' | 'lvActivate' | 'lvDeactivate' | 'partitionGrow' | 'partitionShrink' | 'filesystemGrow' | typeof EXPERT_ACTIONS[number];
export const ADVANCED_ACTIONS = ['luksFormat', 'luksOpen', 'luksClose', 'luksPassphrase', 'luksGrow', 'pvCreate', 'pvRemove', 'pvGrow', 'vgCreate', 'vgRename', 'vgExtend', 'vgReduce', 'vgRemove', 'lvCreate', 'lvRename', 'lvResize', 'lvRemove', 'lvSnapshot', 'lvActivate', 'lvDeactivate', 'partitionGrow', 'partitionShrink', 'filesystemGrow', ...EXPERT_ACTIONS];
export function storagePermission(action: StorageAction): 'mount' | 'automount' | 'format' | 'wipe' | 'partition' | 'encrypt' | 'lvm' | 'resize' | 'raid' | 'migrate' | 'crypttab' | 'health' | 'erase' {
  if (action.startsWith('raid')) return 'raid';
  if (action.startsWith('smart')) return 'health';
  if (action === 'secureErase') return 'erase';
  if (action.startsWith('crypttab')) return 'crypttab';
  if (['pvMove', 'pvMoveAbort'].includes(action)) return 'migrate';
  if (['layerShrink', 'pvShrink'].includes(action)) return 'resize';
  if (action.startsWith('luks')) return 'encrypt';
  if (/^(pv|vg|lv)/.test(action)) return 'lvm';
  if (['partitionGrow', 'partitionShrink', 'filesystemGrow'].includes(action)) return 'resize';
  return action === 'unmount' ? 'mount' : action as 'mount' | 'automount' | 'format' | 'wipe' | 'partition';
}
export interface StorageSecrets { passphrase?: string; newPassphrase?: string }
export interface StorageOperation {
  action: StorageAction; device: string; mountpoint?: string; persistent?: boolean;
  enabled?: boolean; readOnly?: boolean; filesystem?: string; label?: string;
  name?: string; vg?: string; lv?: string; sizeMb?: number; devices?: string[]; layout?: 'linear' | 'thin-pool' | 'thin'; pool?: string;
  slot?: number; survivorSlot?: number; raidLevel?: '0' | '1' | '5' | '6' | '10'; keyMode?: 'prompt' | 'managed'; options?: string[]; eraseMethod?: 'secure-discard' | 'overwrite-verify';
}
export interface StorageDevice {
  path: string; kernel: string; id: string; type: string; size: number;
  model: string; serial: string; wwn: string; diskSeq: string; transport: string;
  filesystem: string; label: string; uuid: string; readOnly: boolean;
  partitionUuid: string; partitionLabel: string;
  rotational?: boolean; critical?: boolean; parentPath?: string; partitionNumber?: number;
  mountpoints: string[]; children: StorageDevice[]; protected: boolean; reason: string | null;
}
export interface MountEntry { source: string; target: string; filesystem: string; options: string; managed: boolean; resolvedSource?: string }
export interface PhysicalVolume { path: string; uuid: string; vg: string; size: number; free: number; used: number }
export interface VolumeGroup { name: string; uuid: string; size: number; free: number; extentSize?: number }
export interface LogicalVolume { name: string; uuid: string; vg: string; path: string; size: number; attributes: string; kind: string; pool: string; origin: string }
export interface LvmInventory { available: boolean; error: string | null; pvs: PhysicalVolume[]; vgs: VolumeGroup[]; lvs: LogicalVolume[]; moving?: boolean }
export interface RaidArray { device: string; uuid: string; name: string; level: string; degraded: number; sync: string; state: string; members: { path: string; state: string }[] }
export interface EncryptionInfo { device: string; slots: number[]; digest: string; error?: string }
export interface CrypttabEntry { name: string; source: string; keyMode: 'prompt' | 'managed' | 'external'; options: string[]; managed: boolean }
export interface StorageInventory { raid?: RaidArray[]; encryption?: EncryptionInfo[]; boot?: CrypttabEntry[]; configDigest?: string;  devices: StorageDevice[]; fstab: MountEntry[]; crypttab?: string[]; operationRunning?: boolean; lvm?: LvmInventory }
export interface StorageHost {
  run(command: string, args: string[], input?: string): Promise<string>;
  read(file: string): Promise<string>;
  writeFstab(expected: string, next: string): Promise<void>;
  prepareMount(target: string): Promise<void>;
  protectedPaths: string[];
  operationRunning?(): Promise<boolean>;
  canonicalDevice?(file: string): Promise<string>;
  writeConfig?(file: string, expected: string, next: string): Promise<void>;
  createBootKey?(uuid: string, slot: number): Promise<string>;
  backupHeader?(device: string, name: string): Promise<string>;
  overwriteDisk?(device: StorageDevice): Promise<void>;
  withKeyFiles?(secrets: StorageSecrets, use: (files: { current?: string; next?: string }) => Promise<void>): Promise<void>;
}
function fail(message: string): never { throw new Error(message); }
const FILESYSTEMS = ['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'vfat', 'exfat', 'ntfs'];
const FORMAT_TYPES = ['ext4', 'xfs', 'btrfs', 'vfat', 'exfat'];
const decode = (value: string) => value.replace(/\\040/g, ' ').replace(/\\011/g, '\t').replace(/\\134/g, '\\');
const encode = (value: string) => value.replace(/\\/g, '\\134').replace(/ /g, '\\040').replace(/\t/g, '\\011');
const all = (nodes: StorageDevice[]): StorageDevice[] => nodes.flatMap((node) => [node, ...all(node.children)]);
function bool(value: unknown) { return value === true || value === 1 || value === '1'; }
function referencesDevice(entry: MountEntry, device: StorageDevice) {
  return entry.resolvedSource === device.path || [device.path, ...(device.uuid ? [`UUID=${device.uuid}`] : []), ...(device.label ? [`LABEL=${device.label}`] : []), ...(device.partitionUuid ? [`PARTUUID=${device.partitionUuid}`] : []), ...(device.partitionLabel ? [`PARTLABEL=${device.partitionLabel}`] : [])].includes(entry.source);
}
function devicePath(value: unknown) {
  if (typeof value !== 'string' || !/^\/dev\/[a-zA-Z0-9_./-]+$/.test(value) || path.posix.normalize(value) !== value || value.includes('/../')) fail('Invalid block device path');
  return value as string;
}
export function validateMountpoint(value: unknown) {
  if (typeof value !== 'string' || value.length > 512 || /[\x00-\x1f\x7f#]/.test(value) || path.posix.normalize(value) !== value || !/^\/(mnt|media|srv)\/[^/]/.test(value)) fail('Choose a dedicated absolute mount folder beneath /mnt, /media or /srv');
  return value as string;
}
export function validateStorageOperation(input: unknown): StorageOperation {
  const raw = input as StorageOperation | null;
  if (!raw || !['mount', 'unmount', 'automount', 'format', 'wipe', 'partition', ...ADVANCED_ACTIONS].includes(raw.action)) fail('Unknown storage action');
  const device = devicePath(raw.device);
  const op: StorageOperation = { action: raw.action, device };
  if (ADVANCED_ACTIONS.includes(raw.action)) {
    for (const key of ['name', 'vg', 'lv', 'pool'] as const) {
      if (raw[key] !== undefined) {
        if (typeof raw[key] !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_+.-]{0,126}$/.test(raw[key]!) || ['.', '..'].includes(raw[key]!)) fail('Use a simple LVM/mapping name without slashes or a leading dash');
        op[key] = raw[key];
      }
    }
    if (raw.sizeMb !== undefined) { if (!Number.isSafeInteger(raw.sizeMb) || raw.sizeMb! < 16 || raw.sizeMb! > 16_777_216) fail('Size must be 16–16777216 MiB'); op.sizeMb = raw.sizeMb; }
    if (raw.devices !== undefined) { if (!Array.isArray(raw.devices) || raw.devices.length > 16) fail('Select at most 16 PV devices'); op.devices = [...new Set(raw.devices.map(devicePath))]; }
    for (const key of ['slot', 'survivorSlot'] as const) if (raw[key] !== undefined) { if (!Number.isInteger(raw[key]) || raw[key]! < 0 || raw[key]! > 31) fail('Keyslot must be between 0 and 31'); op[key] = raw[key]; }
    if (raw.raidLevel !== undefined) { if (!['0', '1', '5', '6', '10'].includes(raw.raidLevel)) fail('Supported RAID levels: 0, 1, 5, 6, 10'); op.raidLevel = raw.raidLevel; }
    if (raw.keyMode !== undefined) { if (!['prompt', 'managed'].includes(raw.keyMode)) fail('Choose prompt or managed boot key'); op.keyMode = raw.keyMode; }
    if (raw.options !== undefined) { if (!Array.isArray(raw.options) || !raw.options.every(o => ['nofail', 'noauto', 'discard', 'x-systemd.device-timeout=10s'].includes(o))) fail('Unsupported crypttab options'); op.options = [...new Set(raw.options)]; }
    if (raw.eraseMethod !== undefined) { if (!['secure-discard', 'overwrite-verify'].includes(raw.eraseMethod)) fail('Choose secure-discard or overwrite-verify'); op.eraseMethod = raw.eraseMethod; }
    if (raw.layout !== undefined) { if (!['linear', 'thin-pool', 'thin'].includes(raw.layout)) fail('Unsupported LV layout'); op.layout = raw.layout; }
  }
  if (['mount', 'automount'].includes(raw.action)) {
    op.mountpoint = validateMountpoint(raw.mountpoint);
    if (raw.readOnly !== undefined && typeof raw.readOnly !== 'boolean') fail('readOnly must be boolean');
    op.readOnly = raw.readOnly === true;
    if (raw.action === 'mount') { if (raw.persistent !== undefined && typeof raw.persistent !== 'boolean') fail('persistent must be boolean'); op.persistent = raw.persistent === true; }
    else { if (typeof raw.enabled !== 'boolean') fail('enabled must be boolean'); op.enabled = raw.enabled; }
  }
  if (raw.action === 'format') {
    if (!FORMAT_TYPES.includes(raw.filesystem ?? '')) fail('Choose ext4, XFS, Btrfs, FAT32 or exFAT');
    op.filesystem = raw.filesystem;
    const maxLabel = raw.filesystem === 'vfat' ? 11 : raw.filesystem === 'xfs' ? 12 : raw.filesystem === 'exfat' ? 15 : 16;
    if (raw.label !== undefined && (typeof raw.label !== 'string' || !/^[a-zA-Z0-9 _.-]*$/.test(raw.label) || raw.label.length > maxLabel)) fail(`Use a label up to ${maxLabel} simple characters`);
    op.label = raw.label ?? '';
  }
  return op;
}
export function parseFstab(text: string): MountEntry[] {
  return text.split('\n').filter((line) => line.trim() && !line.trim().startsWith('#')).flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) return [];
    return [{ source: decode(fields[0]), target: decode(fields[1]), filesystem: fields[2], options: fields[3].replace(/(password|credentials|secret)=[^,]+/gi, '$1=hidden'), managed: /# outpost-storage:[a-zA-Z0-9-]+\s*$/.test(line) }];
  });
}
export function rewriteFstab(text: string, device: StorageDevice, op: StorageOperation): string {
  if (!/^[a-zA-Z0-9-]{4,64}$/.test(device.uuid)) fail('A filesystem UUID is required for a persistent mount');
  const source = `UUID=${device.uuid}`;
  const marker = `# outpost-storage:${device.uuid}`;
  const lines = text.split('\n');
  const entries = parseFstab(text);
  for (const entry of entries) {
    if ((entry.source === source || entry.source === device.path || entry.target === op.mountpoint) && !entry.managed) fail('This device or mountpoint has an existing unmanaged fstab entry. Manage that entry outside Outpost first.');
    if (entry.target === op.mountpoint && entry.source !== source) fail('That mountpoint belongs to a different fstab entry');
  }
  const next = lines.filter((line) => !line.trimEnd().endsWith(marker));
  if (op.enabled !== false) {
    if (!FILESYSTEMS.includes(device.filesystem)) fail('Unsupported filesystem for a persistent mount');
    const options = `${op.readOnly ? 'ro' : 'defaults'},nofail,nodev,nosuid`;
    next.push(`${source}\t${encode(op.mountpoint!)}\t${device.filesystem}\t${options}\t0\t${device.filesystem.startsWith('ext') ? 2 : 0}\t${marker}`);
  }
  return next.join('\n').replace(/\n+$/, '') + '\n';
}
export async function inventory(host: StorageHost): Promise<StorageInventory> {
  const [blockText, mountText, fstabText, swaps] = await Promise.all([
    host.run('lsblk', ['--json', '--bytes', '--paths', '--tree', '--output', 'NAME,KNAME,PATH,MAJ:MIN,TYPE,SIZE,MODEL,SERIAL,WWN,TRAN,RO,ROTA,RM,FSTYPE,LABEL,UUID,MOUNTPOINTS,PKNAME,PTTYPE,PARTUUID,PARTLABEL']),
    host.run('findmnt', ['--json', '--list', '--output', 'SOURCE,TARGET,FSTYPE,MAJ:MIN']),
    host.read('/etc/fstab'), host.read('/proc/swaps'),
  ]);
  const mounts = (JSON.parse(mountText).filesystems ?? []) as Record<string, unknown>[];
  const swapDevices = swaps.split('\n').slice(1).map((line) => line.trim().split(/\s+/)[0]);
  const criticalTargets = new Set(['/', '/boot', '/boot/efi', '/usr', '/var', '/var/lib', '/home', '/opt']);
  const protectedTargets = new Set<string>(criticalTargets);
  const protectedIds = new Set(mounts.filter((m) => criticalTargets.has(String(m.target))).map((m) => String(m['maj:min'])));
  for (const target of host.protectedPaths) {
    try {
      const result = JSON.parse(await host.run('findmnt', ['--json', '--target', target, '--output', 'MAJ:MIN,TARGET']));
      for (const mount of result.filesystems ?? []) {
        protectedIds.add(String(mount['maj:min']));
        if (typeof mount.target === 'string') protectedTargets.add(mount.target);
      }
    } catch { /* an unmounted/missing backup drive has no live filesystem to protect */ }
  }
  const build = (raw: Record<string, unknown>): StorageDevice => {
    const device = devicePath(raw.path ?? raw.name);
    const mountpoints = (Array.isArray(raw.mountpoints) ? raw.mountpoints : []).filter((s): s is string => typeof s === 'string' && !!s);
    for (const mount of mounts) if ((String(mount['maj:min']) === String(raw['maj:min']) || String(mount.source).split('[')[0] === device) && typeof mount.target === 'string' && !mountpoints.includes(mount.target)) mountpoints.push(mount.target);
    if (swapDevices.includes(device) && !mountpoints.includes('[SWAP]')) mountpoints.push('[SWAP]');
    const node: StorageDevice = { path: device, kernel: path.posix.basename(String(raw.kname ?? device)), id: String(raw['maj:min']), type: String(raw.type), size: Number(raw.size), model: String(raw.model ?? '').trim(), serial: String(raw.serial ?? '').trim(), wwn: String(raw.wwn ?? ''), diskSeq: '', transport: String(raw.tran ?? ''), filesystem: String(raw.fstype ?? ''), label: String(raw.label ?? ''), uuid: String(raw.uuid ?? ''), partitionUuid: String(raw.partuuid ?? ''), partitionLabel: String(raw.partlabel ?? ''), parentPath: raw.pkname ? String(raw.pkname).startsWith('/dev/') ? String(raw.pkname) : `/dev/${raw.pkname}` : undefined, readOnly: bool(raw.ro), ...(raw.rota !== undefined ? { rotational: bool(raw.rota) } : {}), mountpoints, children: ((raw.children ?? []) as Record<string, unknown>[]).map(build), protected: false, reason: null };
    for (const child of node.children) child.parentPath ??= device;
    return node;
  };
  const devices = (JSON.parse(blockText).blockdevices ?? []).map(build) as StorageDevice[];
  if (host.canonicalDevice) for (const node of all(devices)) {
    try { node.path = await host.canonicalDevice(node.path); } catch { /* device disappeared */ }
    if (node.parentPath) { try { node.parentPath = await host.canonicalDevice(node.parentPath); } catch { /* disappeared */ } }
  }
  for (const root of devices) {
    try { root.diskSeq = (await host.read(`/sys/class/block/${root.kernel}/diskseq`)).trim(); } catch { /* older kernels */ }
    const family = all([root]);
    const critical = family.some((d) => protectedIds.has(d.id) || d.mountpoints.some((target) => protectedTargets.has(target)));
    const complex = family.some((d) => !['disk', 'part', 'rom', 'loop'].includes(d.type));
    for (const device of family) {
      device.diskSeq = root.diskSeq;
      device.critical = critical;
      const mapped = ['crypt', 'lvm', 'raid0', 'raid1', 'raid5', 'raid6', 'raid10'].includes(device.type);
      device.protected = critical || (complex && !mapped) || device.readOnly || !['disk', 'part', 'crypt', 'lvm', 'raid0', 'raid1', 'raid5', 'raid6', 'raid10'].includes(device.type);
      device.reason = critical ? 'Contains system or Outpost storage' : complex && !mapped ? 'Has active device-mapper, RAID or LVM holders' : device.readOnly ? 'Read-only device' : !['disk', 'part', 'crypt', 'lvm', 'raid0', 'raid1', 'raid5', 'raid6', 'raid10'].includes(device.type) ? 'Unsupported block device type' : null;
    }
  }
  const protectedUuids = new Set(all(devices).filter((d) => d.critical && d.uuid).map((d) => d.uuid));
  for (const root of devices) {
    if (all([root]).some((d) => d.uuid && protectedUuids.has(d.uuid))) {
      for (const device of all([root])) { device.protected = true; device.critical = true; device.reason ??= 'Shares a protected system or Outpost filesystem'; }
    }
  }
  const fstab = parseFstab(fstabText);
  if (host.canonicalDevice) for (const entry of fstab) {
    if (entry.source.startsWith('/dev/')) { try { entry.resolvedSource = await host.canonicalDevice(entry.source); } catch { /* missing device alias */ } }
  }
  let crypttab: string[] = [];
  try { crypttab = (await host.read('/etc/crypttab')).split('\n').filter((line) => line.trim() && !line.trim().startsWith('#')).map((line) => line.trim().split(/\s+/)[1]).filter(Boolean); } catch { /* optional */ }
  if (host.canonicalDevice) crypttab = await Promise.all(crypttab.map(async (source) => { try { return source.startsWith('/dev/') ? await host.canonicalDevice!(source) : source; } catch { return source; } }));
  return { devices, fstab, crypttab, lvm: await lvmInventory(host), ...await expertInventory(host, devices), operationRunning: host.operationRunning ? await host.operationRunning() : false };
}
export function deviceFingerprint(device: StorageDevice): string {
  return crypto.createHash('sha256').update(JSON.stringify(device)).digest('hex');
}
export function storageFingerprint(state: StorageInventory, op: StorageOperation) {
  const device = all(state.devices).find((d) => d.path === op.device);
  return ADVANCED_ACTIONS.includes(op.action) ? crypto.createHash('sha256').update(JSON.stringify({ devices: state.devices, lvm: state.lvm, fstab: state.fstab, crypttab: state.crypttab, raid: state.raid, encryption: state.encryption, config: state.configDigest })).digest('hex') : deviceFingerprint(device!);
}
export function validateStorageSecrets(op: StorageOperation, raw: unknown): StorageSecrets {
  const input = (raw ?? {}) as StorageSecrets;
  const result: StorageSecrets = {};
  const current = ['luksOpen', 'luksPassphrase', 'luksGrow', 'luksAddKey', 'luksRemoveSlot', 'luksChangeSlot', 'layerShrink'].includes(op.action) || (op.action === 'crypttabSet' && op.keyMode === 'managed');
  const next = ['luksFormat', 'luksPassphrase', 'luksAddKey', 'luksChangeSlot'].includes(op.action);
  for (const [key, needed] of [['passphrase', current], ['newPassphrase', next]] as const) {
    if (!needed) continue;
    const value = input[key];
    if (typeof value !== 'string' || !value.length || value.includes('\0') || Buffer.byteLength(value) > 4096 || (key === 'newPassphrase' && value.length < 8)) fail(key === 'newPassphrase' ? 'Enter a new passphrase of 8–4096 bytes' : 'Enter the existing passphrase');
    result[key] = value;
  }
  return result;
}
async function lvmInventory(host: StorageHost): Promise<LvmInventory> {
  try {
    const [pv, vg, lv] = await Promise.all([
      host.run('pvs', ['--reportformat', 'json', '--units', 'b', '--nosuffix', '-o', 'pv_name,pv_uuid,vg_name,pv_size,pv_free,pv_used']),
      host.run('vgs', ['--reportformat', 'json', '--units', 'b', '--nosuffix', '-o', 'vg_name,vg_uuid,vg_size,vg_free,vg_extent_size']),
      host.run('lvs', ['--all', '--reportformat', 'json', '--units', 'b', '--nosuffix', '-o', 'lv_name,lv_uuid,vg_name,lv_path,lv_size,lv_attr,segtype,pool_lv,origin']),
    ]);
    const rows = (text: string, key: string): Record<string, string>[] => JSON.parse(text).report.flatMap((r: Record<string, unknown>) => r[key] ?? []);
    const num = (value: string) => Number(String(value).trim());
    const pvs = rows(pv, 'pv').map((p) => ({ path: p.pv_name.trim(), uuid: p.pv_uuid.trim(), vg: p.vg_name.trim(), size: num(p.pv_size), free: num(p.pv_free), used: num(p.pv_used) }));
    if (host.canonicalDevice) for (const p of pvs) { try { p.path = await host.canonicalDevice(p.path); } catch { /* inactive/missing */ } }
    const lvs = rows(lv, 'lv').filter((l) => !l.lv_name.startsWith('[')).map((l) => ({ name: l.lv_name.trim(), uuid: l.lv_uuid.trim(), vg: l.vg_name.trim(), path: l.lv_path.trim(), size: num(l.lv_size), attributes: l.lv_attr.trim(), kind: l.segtype.trim(), pool: l.pool_lv.trim(), origin: l.origin.trim() }));
    if (host.canonicalDevice) for (const l of lvs) { try { l.path = await host.canonicalDevice(l.path); } catch { /* inactive */ } }
    const vgs = rows(vg, 'vg').map((v) => ({ name: v.vg_name.trim(), uuid: v.vg_uuid.trim(), size: num(v.vg_size), free: num(v.vg_free), extentSize: num(v.vg_extent_size ?? '0') }));
    if (pvs.some((p) => ![p.size, p.free, p.used].every((n) => Number.isFinite(n) && n >= 0)) || vgs.some((v) => ![v.size, v.free].every((n) => Number.isFinite(n) && n >= 0)) || lvs.some((l) => !Number.isFinite(l.size) || l.size < 0)) fail('Invalid LVM capacity report');
    return { available: true, error: null, pvs, vgs, lvs, moving: rows(lv, 'lv').some(l => /pvmove/.test(l.lv_name)) };
  } catch { return { available: false, error: 'LVM inventory unavailable. Install lvm2 and update the storage helper.', pvs: [], vgs: [], lvs: [] }; }
}
async function optionalRead(host: StorageHost, file: string) { try { return await host.read(file); } catch (error) { const code = (error as NodeJS.ErrnoException).code; if (code && code !== 'ENOENT' && code !== 'ENOTDIR') throw error; return ''; } }
export function parseCrypttab(text: string): CrypttabEntry[] {
  return text.split('\n').filter(line => line.trim() && !line.trim().startsWith('#')).map(line => {
    const [name, source, key = 'none', options = 'luks'] = line.trim().split(/\s+/);
    return { name, source, keyMode: ['none', '-'].includes(key) ? 'prompt' : key.startsWith('/etc/cryptsetup-keys.d/outpost-') ? 'managed' : 'external', options: options.split(','), managed: line.includes('# outpost-storage') };
  });
}
async function expertInventory(host: StorageHost, devices: StorageDevice[]) {
  const nodes = [...new Map(all(devices).map(node => [node.path, node])).values()];
  const encryption: EncryptionInfo[] = [];
  for (const device of nodes.filter(d => d.filesystem === 'crypto_LUKS')) {
    try {
      const text = await host.run('cryptsetup', ['luksDump', '--dump-json-metadata', device.path]);
      const json = JSON.parse(text);
      encryption.push({ device: device.path, slots: Object.keys(json.keyslots ?? {}).map(Number).sort((a, b) => a - b), digest: crypto.createHash('sha256').update(text).digest('hex') });
    } catch { encryption.push({ device: device.path, slots: [], digest: '', error: 'LUKS2 metadata is unavailable; LUKS1 keyslot operations need native tools' }); }
  }
  const raid: RaidArray[] = [];
  for (const device of nodes.filter(d => /^raid/.test(d.type) || /^md\d+$/.test(d.kernel))) {
    try {
      const text = await host.run('mdadm', ['--detail', '--export', device.path]);
      const fields = Object.fromEntries(text.split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
      const members = [];
      for (const [key, value] of Object.entries(fields)) if (/^MD_DEVICE_.*_DEV$/.test(key)) {
        const member = host.canonicalDevice ? await host.canonicalDevice(value) : value;
        const kernel = nodes.find(d => d.path === member)?.kernel ?? path.posix.basename(member);
        members.push({ path: member, state: (await optionalRead(host, `/sys/class/block/${device.kernel}/md/dev-${kernel}/state`)).trim() || 'unknown' });
      }
      const md = `/sys/class/block/${device.kernel}/md`;
      const degradedText = (await host.read(`${md}/degraded`)).trim();
      if (!/^\d+$/.test(degradedText)) continue;
      raid.push({ device: device.path, uuid: fields.MD_UUID ?? '', name: fields.MD_NAME ?? device.kernel, level: fields.MD_LEVEL ?? device.type, degraded: Number(degradedText), sync: (await host.read(`${md}/sync_action`)).trim(), state: (await host.read(`${md}/array_state`)).trim(), members });
    } catch { /* Visible lsblk device remains protected; no unsafe array management without metadata. */ }
  }
  const [crypt, mdDebian, mdOther] = await Promise.all(['/etc/crypttab', '/etc/mdadm/mdadm.conf', '/etc/mdadm.conf'].map(file => optionalRead(host, file)));
  return { raid, encryption, boot: parseCrypttab(crypt), configDigest: crypto.createHash('sha256').update(JSON.stringify([crypt, mdDebian, mdOther])).digest('hex') };
}
function expertGroup(state: StorageInventory, device: StorageDevice, name?: string) {
  const lvm = state.lvm;
  if (!lvm?.available) fail('Install lvm2 and refresh inventory');
  const group = lvm.vgs.find(g => g.name === name);
  if (!group || lvm.vgs.filter(g => g.name === group.name).length !== 1) fail('Select an unambiguous volume group');
  const members = lvm.pvs.filter(p => p.vg === group.name), nodes = all(state.devices);
  if (!members.some(p => p.path === device.path) && !lvm.lvs.some(l => l.vg === group.name && l.path === device.path)) fail('Selected device does not belong to this volume group');
  for (const pv of members) { const node = nodes.find(d => d.path === pv.path); if (!node || node.critical !== false || node.readOnly) fail('Every PV must be present, writable and outside system/Outpost storage'); }
  return { lvm, group, members };
}
function offlineTree(device: StorageDevice) { if (all([device]).some(d => d.mountpoints.length)) fail('Unmount all affected filesystems and disable swap first'); }
function unreferenced(state: StorageInventory, device: StorageDevice) {
  if (all([device]).some(d => state.fstab.some(e => referencesDevice(e, d)) || state.crypttab?.some(source => referencesDevice({ source, target: '', filesystem: '', options: '', managed: false }, d)))) fail('Remove fstab/crypttab references before destructive device operations');
}
function blankMember(state: StorageInventory, target: string): StorageDevice {
  const device = all(state.devices).find(d => d.path === target);
  if (!device || device.critical !== false || device.readOnly || !['disk', 'part'].includes(device.type) || device.children.length || device.filesystem) fail(`Select a blank non-system disk/partition without holders: ${target}`);
  offlineTree(device); unreferenced(state, device); return device;
}
export function layerShrinkPlan(state: StorageInventory, op: StorageOperation) {
  const nodes = all(state.devices), outer = nodes.find(d => d.path === op.device);
  if (!outer || outer.critical !== false || outer.readOnly || !['part', 'lvm'].includes(outer.type) || outer.filesystem !== 'crypto_LUKS' || outer.children.length !== 1) fail('Supported layered shrink: non-system partition or linear LV → LUKS2 mapping → offline ext4');
  const mapping = outer.children[0];
  if (mapping.type !== 'crypt' || mapping.children.length || mapping.filesystem !== 'ext4' || mapping.critical || mapping.readOnly || !op.sizeMb || op.sizeMb * 1048576 >= outer.size) fail('Select a single, writable ext4 mapping and a smaller outer size');
  offlineTree(outer);
  if (outer.type === 'part') {
    const parent = nodes.find(d => d.path === outer.parentPath);
    if (!parent || parent.type !== 'disk' || parent.critical !== false || parent.readOnly) fail('Partition parent must be a writable non-system physical disk');
    offlineTree(parent);
  } else {
    const { lvm, group } = expertGroup(state, outer, op.vg);
    const lv = lvm.lvs.find(l => l.path === outer.path && l.vg === group.name && l.name === op.lv);
    if (!lv || lv.kind !== 'linear' || lv.pool || lv.origin || lvm.moving || lvm.lvs.some(l => l.vg === lv.vg && (l.origin === lv.name || l.pool === lv.name))) fail('Layered LV shrinking requires a plain linear LV without snapshots, thin layers or extent moves');
    if (!group.extentSize || !Number.isSafeInteger(group.extentSize) || op.sizeMb * 1048576 % group.extentSize) fail('Choose a target exactly aligned to the VG physical extent size; raw LVM rounding is unsafe');
  }
  const metadata = state.encryption?.find(e => e.device === outer.path);
  if (!metadata?.digest || !metadata.slots.length) fail('Verified LUKS2 metadata is required');
  return { outer, mapping, steps: ['Verify passphrase and LUKS2 layout', 'Check, shrink and verify ext4', 'Shrink and verify dm-crypt mapping', 'Close mapping', `Shorten ${outer.type === 'part' ? 'partition without moving its start' : 'linear LV at an exact extent boundary'}`, 'Reopen the mapping'] };
}
function checkExpertOperation(state: StorageInventory, op: StorageOperation): StorageDevice {
  const nodes = all(state.devices), device = nodes.find(d => d.path === op.device);
  if (!device) fail('Device is no longer available');
  if (op.action.startsWith('smart')) { if (device.type !== 'disk') fail('Select a physical disk for SMART diagnostics'); return device; }
  if (device.critical !== false || device.readOnly) fail('System, Outpost, unknown-protection and read-only devices cannot be changed');
  if (op.action === 'layerShrink') { layerShrinkPlan(state, op); return device; }
  if (op.action === 'secureErase') {
    if (device.type !== 'disk' || !device.size || !Number.isSafeInteger(device.size) || !device.diskSeq || !(device.serial || device.wwn)) fail('Erase requires an identified whole physical disk with serial/WWN, kernel disk sequence and a valid capacity');
    offlineTree(device); unreferenced(state, device);
    if (all([device]).some(d => !['disk', 'part'].includes(d.type)) || state.raid?.some(a => a.members.some(m => all([device]).some(d => d.path === m.path))) || state.lvm?.pvs.some(p => all([device]).some(d => d.path === p.path))) fail('Release RAID, encryption and LVM holders before erasure');
    if (!op.eraseMethod || (op.eraseMethod === 'overwrite-verify' && (device.rotational !== true || device.transport === 'nvme'))) fail('Software overwrite is restricted to positively identified rotational disks; use supported secure discard for flash');
    return device;
  }
  if (op.action.startsWith('luks') || op.action.startsWith('crypttab')) {
    if (device.filesystem !== 'crypto_LUKS' || !/^[a-f0-9-]{16,64}$/i.test(device.uuid)) fail('Select a LUKS device with a valid UUID');
    const meta = state.encryption?.find(e => e.device === device.path);
    if (op.action !== 'luksHeaderBackup' && op.action !== 'crypttabRemove' && !(op.action === 'crypttabSet' && op.keyMode === 'prompt') && (!meta?.digest || !meta.slots.length)) fail('LUKS2 keyslot metadata is required');
    if (['luksAddKey', 'luksChangeSlot', 'luksRemoveSlot'].includes(op.action) || (op.action === 'crypttabSet' && op.keyMode === 'managed')) {
      if (op.slot === undefined) fail('Select an explicit keyslot');
      const occupied = meta!.slots.includes(op.slot);
      if (['luksAddKey', 'crypttabSet'].includes(op.action) ? occupied : !occupied) fail(occupied ? 'Choose an unused keyslot' : 'Keyslot does not exist');
    }
    if (op.action === 'luksRemoveSlot' && (meta!.slots.length < 2 || op.survivorSlot === undefined || op.survivorSlot === op.slot || !meta!.slots.includes(op.survivorSlot))) fail('Keep at least one keyslot and identify a different surviving slot whose passphrase you know');
    if (op.action.startsWith('crypttab')) {
      if (!op.name) fail('Choose the crypttab mapping name');
      const existing = state.boot?.find(e => e.name === op.name);
      if (existing && ![device.path, `UUID=${device.uuid}`, `/dev/disk/by-uuid/${device.uuid}`].includes(existing.source)) fail('That crypttab name belongs to a different device');
      if (op.action === 'crypttabRemove' && !existing) fail('No matching crypttab entry');
      if (op.action === 'crypttabSet' && !op.keyMode) fail('Choose interactive boot unlock or a managed key file');
    }
    return device;
  }
  if (op.action.startsWith('raid')) {
    if (op.action === 'raidCreate') {
      const targets = op.devices ?? [];
      if (!op.name || op.name.length > 24 || !op.raidLevel || !targets.includes(device.path)) fail('Choose an array name up to 24 characters, RAID level and members including the selected device');
      const minimum = ({ '0': 2, '1': 2, '5': 3, '6': 4, '10': 4 })[op.raidLevel];
      if (targets.length < minimum || (op.raidLevel === '10' && targets.length % 2)) fail('Not enough distinct members for this RAID level (RAID10 needs an even count)');
      const roots = targets.map(target => { const member = blankMember(state, target); return member.type === 'part' ? member.parentPath : member.path; });
      if (roots.some(r => !r) || new Set(roots).size !== roots.length) fail('RAID members must be on distinct physical disks');
      if (nodes.some(d => d.path === `/dev/md/outpost-${op.name}`) || state.raid?.some(r => r.name.split(':').at(-1) === `outpost-${op.name}`)) fail('Array name already exists');
      return device;
    }
    const array = state.raid?.find(r => r.device === device.path);
    if (!array?.uuid || !/^[a-f0-9:.-]+$/i.test(array.uuid) || !Number.isInteger(array.degraded)) fail('Reliable mdadm/sysfs array metadata is required');
    for (const member of array.members) { const node = nodes.find(d => d.path === member.path); if (!node || node.critical !== false || node.readOnly) fail('All array members must be present, writable and non-system'); }
    if (['raidInfo', 'raidBootAdd', 'raidBootRemove'].includes(op.action)) return device;
    if (array.sync !== 'idle') fail('Wait for RAID synchronization/recovery/reshape to finish');
    if (op.action === 'raidStop') { offlineTree(device); if (device.children.length) fail('Release inner mappings/LVs before stopping the array'); unreferenced(state, device); return device; }
    if (op.devices?.length !== 1) fail('Choose exactly one member device');
    if (op.action === 'raidAdd') { blankMember(state, op.devices[0]); return device; }
    offlineTree(device);
    const member = array.members.find(m => m.path === op.devices![0]);
    if (!member) fail('Member does not belong to this array');
    if (op.action === 'raidRemove' && !/(faulty|spare)/.test(member.state)) fail('Only faulty or spare members may be detached');
    if (op.action === 'raidFail' && (array.degraded !== 0 || !['raid1', 'raid5', 'raid6', 'raid10'].includes(array.level) || !/in_sync/.test(member.state))) fail('Only one in-sync member of a currently healthy redundant array may be marked faulty');
    return device;
  }
  if (['pvMove', 'pvMoveAbort', 'pvShrink'].includes(op.action)) {
    const { lvm, members } = expertGroup(state, device, op.vg);
    const source = members.find(p => p.path === device.path);
    if (!source) fail('Choose the source physical volume');
    if (op.action === 'pvMoveAbort') { if (!lvm.moving) fail('No extent migration is visible'); return device; }
    if (lvm.moving) fail('An extent move is already active; finish or abort it first');
    if (op.action === 'pvShrink') { if (!op.sizeMb || op.sizeMb * 1048576 > device.size || op.sizeMb * 1048576 >= source.size || op.sizeMb * 1048576 <= source.used) fail('Choose a smaller PV size within its real device, larger than its allocated space; LVM must also verify the highest used extent'); offlineTree(device); return device; }
    if (!source.used || !op.devices?.length || op.devices.includes(source.path)) fail('Choose a used source PV and different destination PVs');
    let available = 0;
    for (const target of op.devices) { const pv = members.find(p => p.path === target); if (!pv) fail('Destinations must already belong to the same VG'); available += pv.free; }
    if (available < source.used) fail('Destination PVs do not have enough free extents');
    return device;
  }
  fail('Unsupported expert storage action');
}
function checkAdvancedOperation(state: StorageInventory, op: StorageOperation): StorageDevice {
  const nodes = all(state.devices), device = nodes.find((d) => d.path === op.device);
  if (!device || device.critical || device.readOnly) fail('Select an available writable device outside system and Outpost storage');
  const offline = (node: StorageDevice) => { if (all([node]).some((d) => d.mountpoints.length)) fail('Unmount the filesystem and release swap/child mounts first'); };
  const cryptReference = (node: StorageDevice, pathsOnly = false) => state.crypttab?.some((source) => (!pathsOnly || source.startsWith('/dev/')) && referencesDevice({ source, target: '', filesystem: '', options: '', managed: false }, node));
  const noReferences = (node: StorageDevice) => { if (state.fstab.some((e) => all([node]).some((d) => referencesDevice(e, d))) || all([node]).some((d) => cryptReference(d))) fail('Remove persistent filesystem/crypttab entries before destroying this volume'); };
  if (op.action.startsWith('luks')) {
    if (op.action === 'luksFormat') {
      if (!['part', 'disk', 'lvm'].includes(device.type) || device.children.length || device.filesystem) fail('LUKS creation requires a blank leaf device. Wipe its signatures separately first.');
      offline(device); noReferences(device);
    } else if (['luksOpen', 'luksPassphrase'].includes(op.action)) {
      if (device.filesystem !== 'crypto_LUKS') fail('Select a LUKS-encrypted device');
      if (op.action === 'luksOpen' && (!op.name || op.name === 'control' || device.children.length || nodes.some((n) => n.path === `/dev/mapper/${op.name}`))) fail('Choose a unique mapping name on a locked LUKS device');
    } else {
      if (device.type !== 'crypt') fail('Select the unlocked dm-crypt mapping');
      if (device.children.length) fail('Release child holders before closing or growing this mapping');
      offline(device);
    }
    return device;
  }
  if (op.action === 'partitionGrow' || op.action === 'partitionShrink') {
    if (device.type !== 'part' || !nodes.some((p) => p.path === device.parentPath && p.type === 'disk' && !p.critical)) fail('Select a partition on a non-system disk');
    offline(device);
    if (op.action === 'partitionShrink') {
      const parent = nodes.find((p) => p.path === device.parentPath)!;
      offline(parent);
      if (device.filesystem !== 'ext4' || device.children.length || !op.sizeMb || op.sizeMb * 1048576 >= device.size) fail('Partition shrinking requires an unmounted, plain ext4 partition and a smaller target size');
    }
    return device;
  }
  if (op.action === 'filesystemGrow') {
    if (device.children.length || !['ext2', 'ext3', 'ext4', 'xfs', 'btrfs'].includes(device.filesystem)) fail('Select a leaf ext2/3/4, XFS or Btrfs filesystem');
    if (device.filesystem.startsWith('ext')) offline(device);
    else if (device.mountpoints.length !== 1) fail('Mount this filesystem at exactly one location before growing it');
    if (nodes.filter((n) => n.uuid && n.uuid === device.uuid).length > 1) fail('Multi-device filesystem growth is not supported');
    return device;
  }
  const lvm = state.lvm;
  if (!lvm?.available) fail('LVM tools/inventory are unavailable');
  if (lvm.moving) fail('Finish or abort the active extent migration before other LVM changes');
  const pv = lvm.pvs.find((p) => p.path === device.path);
  if (op.action === 'pvCreate') {
    if (pv || device.filesystem || device.children.length || !['part', 'disk', 'crypt'].includes(device.type)) fail('Select a blank leaf disk, partition or unlocked mapping');
    offline(device); noReferences(device); return device;
  }
  if (op.action === 'pvRemove') { if (!pv || pv.vg || pv.used) fail('Only unassigned, unused physical volumes can be removed'); offline(device); noReferences(device); return device; }
  if (op.action === 'pvGrow') { if (!pv || device.size < pv.size) fail('Select an existing PV whose underlying device has not shrunk'); if (!pv.vg) return device; }
  const group = op.vg ? lvm.vgs.find((g) => g.name === op.vg) : undefined;
  if (group && lvm.vgs.filter((g) => g.name === group.name).length !== 1) fail('Ambiguous duplicate volume group name; resolve duplicate groups outside Outpost first');
  if (op.action !== 'vgCreate' && !['pvRemove', 'pvCreate'].includes(op.action) && !group) fail('Select an existing volume group');
  const members = group ? lvm.pvs.filter((p) => p.vg === group.name) : [];
  if (group && !members.some((p) => p.path === device.path) && !lvm.lvs.some((l) => l.vg === group.name && l.path === device.path)) fail('The selected device does not belong to this volume group');
  for (const member of members) {
    const node = nodes.find((n) => n.path === member.path);
    if (!node || node.critical || node.readOnly) fail('Volume group includes system, Outpost, missing or read-only storage');
  }
  if (['vgCreate', 'vgExtend'].includes(op.action)) {
    if (op.action === 'vgCreate' && (!op.name || lvm.vgs.some((g) => g.name === op.name))) fail('Choose a unique volume group name');
    const targets = op.devices?.length ? op.devices : [device.path];
    if (op.action === 'vgCreate' && !targets.includes(device.path)) fail('Include the selected physical volume in the new group');
    for (const target of targets) {
      const p = lvm.pvs.find((p) => p.path === target), node = nodes.find((d) => d.path === target);
      if (!p || p.vg || p.used !== 0 || !node || node.critical || node.readOnly || node.children.length) fail('Select only unassigned unused physical volumes outside protected storage');
      offline(node);
    }
  }
  if (op.action === 'vgReduce' && (!pv || pv.vg !== group!.name || pv.used !== 0)) fail('Only an entirely unused PV can be removed from the group; move its extents first');
  if (op.action === 'vgRemove' && lvm.lvs.some((l) => l.vg === group!.name)) fail('Remove the group’s logical volumes first');
  if (op.action === 'vgRename') {
    if (!op.name || lvm.vgs.some((g) => g.name === op.name)) fail('Choose a unique volume group name');
    for (const l of lvm.lvs.filter((l) => l.vg === group!.name)) {
      if (l.kind === 'thin-pool') continue; // Pool control devices do not contain mountable filesystems.
      const node = nodes.find((d) => d.path === l.path); if (!node) fail('Activate the group’s logical volumes before renaming so references can be checked');
      offline(node); if (state.fstab.some((e) => (e.source.startsWith('/dev/') || e.resolvedSource) && referencesDevice(e, node)) || cryptReference(node, true)) fail('Convert device-path fstab/crypttab references to UUIDs before renaming');
    }
  }
  if (['lvCreate', 'lvSnapshot'].includes(op.action)) {
    if (!op.name || lvm.lvs.some((l) => l.vg === group!.name && l.name === op.name)) fail('Choose a unique logical volume name');
    if (!op.sizeMb && op.action === 'lvCreate') fail('Enter a volume size');
    if (op.action === 'lvCreate' && op.layout !== 'thin' && op.sizeMb! * 1048576 > group!.free) fail('Requested size exceeds free group space');
    if (op.layout === 'thin' && !lvm.lvs.some((l) => l.vg === group!.name && l.name === op.pool && l.kind === 'thin-pool')) fail('Select an existing thin pool');
  }
  if (['lvActivate', 'lvDeactivate'].includes(op.action)) {
    const lv = lvm.lvs.find((l) => l.vg === op.vg && l.name === op.lv);
    if (!lv) fail('Select an existing logical volume');
    const node = nodes.find((n) => n.path === lv.path);
    if (op.action === 'lvDeactivate' && node) { offline(node); if (node.children.length) fail('Release child holders before deactivation'); }
  }
  if (['lvRename', 'lvResize', 'lvRemove', 'lvSnapshot'].includes(op.action)) {
    const lv = lvm.lvs.find((l) => l.vg === op.vg && l.name === op.lv);
    if (!lv) fail('Select an existing logical volume');
    const node = nodes.find((n) => n.path === lv.path);
    if (lv.kind === 'thin-pool' && op.action === 'lvResize') {
      if (!op.sizeMb || op.sizeMb * 1048576 <= lv.size || op.sizeMb * 1048576 - lv.size > group!.free) fail('Thin pools support growth only, within free VG capacity');
      return device;
    }
    if (lv.kind === 'thin-pool' && op.action === 'lvRemove') {
      if (lvm.lvs.some((l) => l.vg === lv.vg && (l.pool === lv.name || l.origin === lv.name))) fail('Remove dependent thin volumes first');
      return device;
    }
    if (lv.kind === 'thin-pool' && op.action === 'lvRename') {
      if (!op.name || lvm.lvs.some((l) => l.vg === lv.vg && l.name === op.name)) fail('Choose a unique LV name');
      for (const child of lvm.lvs.filter((l) => l.vg === lv.vg && l.pool === lv.name)) {
        const mapped = nodes.find((n) => n.path === child.path); if (mapped) offline(mapped);
      }
      return device;
    }
    if (!node || node.critical || node.children.length) fail('Activate a non-system leaf LV and release any child mappings first');
    offline(node);
    if (op.action === 'lvRemove') {
      noReferences(node);
      if (lvm.lvs.some((l) => l.vg === lv.vg && (l.pool === lv.name || l.origin === lv.name))) fail('Remove dependent snapshots/thin volumes first');
    }
    if (op.action === 'lvRename') {
      if (!op.name || lvm.lvs.some((l) => l.vg === lv.vg && l.name === op.name)) fail('Choose a unique LV name');
      if (state.fstab.some((e) => e.source.startsWith('/dev/') && referencesDevice(e, node)) || cryptReference(node, true)) fail('Convert device-path fstab/crypttab references to UUIDs before renaming');
    }
    if (op.action === 'lvSnapshot' && lv.kind !== 'thin' && (!op.sizeMb || op.sizeMb * 1048576 > group!.free)) fail('Enter a snapshot COW size within the group’s free space');
    if (op.action === 'lvResize') {
      if (!op.sizeMb || !['linear', 'thin'].includes(lv.kind) || !['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'crypto_LUKS', ''].includes(node.filesystem)) fail('Unsupported filesystem or LV layout for resizing');
      const shrink = op.sizeMb * 1048576 < lv.size;
      if (shrink && (node.filesystem !== 'ext4' || lv.kind !== 'linear')) fail('Shrinking requires an offline linear ext4 LV');
      if (!shrink && lv.kind !== 'thin' && op.sizeMb * 1048576 - lv.size > group!.free) fail('Not enough free VG space');
    }
  }
  return device;
}
export function rewriteCrypttab(text: string, device: StorageDevice, op: StorageOperation, keyFile = 'none') {
  const lines = text.split('\n'), output: string[] = [];
  let found = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.split(/\s+/)[0] !== op.name) { output.push(line); continue; }
    const source = trimmed.split(/\s+/)[1];
    if (found || ![device.path, `UUID=${device.uuid}`, `/dev/disk/by-uuid/${device.uuid}`].includes(source)) fail('Ambiguous or changed crypttab entry; refresh before editing');
    found = true;
  }
  if (op.action === 'crypttabRemove' && !found) fail('crypttab entry disappeared');
  if (op.action === 'crypttabSet') output.push(`${op.name}\tUUID=${device.uuid}\t${keyFile}\t${['luks', ...(op.options ?? ['nofail'])].join(',')}\t# outpost-storage`);
  return output.join('\n').replace(/\n*$/, '\n');
}
async function currentConfigs(host: StorageHost, state: StorageInventory) {
  const files = ['/etc/crypttab', '/etc/mdadm/mdadm.conf', '/etc/mdadm.conf'];
  const texts = await Promise.all(files.map(file => optionalRead(host, file)));
  if (crypto.createHash('sha256').update(JSON.stringify(texts)).digest('hex') !== state.configDigest) fail('Boot configuration changed after the device check; refresh');
  return Object.fromEntries(files.map((file, i) => [file, texts[i]]));
}
async function partitionGeometry(host: StorageHost, device: StorageDevice) {
  const number = device.path.match(/(?:p)?(\d+)$/)?.[1];
  if (!number || !device.parentPath) fail('Cannot determine this partition number/parent');
  const table = JSON.parse(await host.run('sfdisk', ['--json', device.parentPath]));
  const size = Number(table.partitiontable?.sectorsize);
  const partition = table.partitiontable?.partitions?.find((p: { node: string }) => p.node === device.path);
  if (![512, 4096].includes(size) || !partition || !Number.isSafeInteger(partition.start) || partition.start < 1 || Number(partition.size) * size !== device.size) fail('Partition geometry changed or is unsupported');
  return { number, sectorSize: size };
}
async function shrinkAndVerifyExt4(host: StorageHost, device: string, size: number) {
  if (!Number.isSafeInteger(size) || size < 16 * 1048576 || size % 1024) fail('Invalid ext4 payload size');
  await host.run('e2fsck', ['-f', '-p', device]);
  await host.run('resize2fs', [device, `${size / 1024}K`]);
  const info = await host.run('dumpe2fs', ['-h', device]);
  const blocks = Number(info.match(/^Block count:\s*(\d+)/m)?.[1]), blockSize = Number(info.match(/^Block size:\s*(\d+)/m)?.[1]);
  const actual = blocks * blockSize;
  if (!Number.isSafeInteger(actual) || !blocks || !blockSize || actual > size) fail('Filesystem verification failed; no outer layer was shortened');
  return actual;
}
async function executeLayerShrink(host: StorageHost, state: StorageInventory, op: StorageOperation, secrets: StorageSecrets) {
  const { outer, mapping } = layerShrinkPlan(state, op);
  const metadataText = await host.run('cryptsetup', ['luksDump', '--dump-json-metadata', outer.path]);
  if (crypto.createHash('sha256').update(metadataText).digest('hex') !== state.encryption!.find(e => e.device === outer.path)!.digest) fail('LUKS2 metadata changed after validation');
  const metadata = JSON.parse(metadataText);
  const segments = Object.values(metadata.segments ?? {}) as { type: string; offset: string; size: string; sector_size?: number; integrity?: unknown; flags?: string[] }[];
  const segment = segments[0];
  if (segments.length !== 1 || segment?.type !== 'crypt' || segment.size !== 'dynamic' || segment.integrity || segment.flags?.length || (metadata.requirements?.mandatory?.length ?? 0)) fail('Only plain single-segment LUKS2 without integrity/reencryption requirements can be shrunk');
  const offset = Number(segment.offset), sector = Number(segment.sector_size ?? 512), target = op.sizeMb! * 1048576, payload = target - offset;
  if (!Number.isSafeInteger(offset) || offset < 4096 || ![512, 4096].includes(sector) || payload < 16 * 1048576 || payload % sector || payload >= mapping.size || mapping.size + offset > outer.size) fail('Unsafe LUKS payload geometry or target');
  const geometry = outer.type === 'part' ? await partitionGeometry(host, outer) : null;
  const name = (await host.read(`/sys/class/block/${mapping.kernel}/dm/name`)).trim();
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_+.-]*$/.test(name)) fail('Invalid active dm-crypt mapping name');
  const status = await host.run('cryptsetup', ['status', name]);
  if (Number(status.match(/offset:\s*(\d+)\s+sectors/)?.[1]) * 512 !== offset) fail('Active mapping offset does not match LUKS2 metadata');
  const backing = status.match(/device:\s*(\/dev\/\S+)/)?.[1];
  if (!backing || (host.canonicalDevice ? await host.canonicalDevice(backing) : backing) !== outer.path) fail('Active mapping is backed by a different device');
  if (!host.withKeyFiles) fail('Update the storage helper for passphrase handling');
  await host.withKeyFiles(secrets, async files => {
    await host.run('cryptsetup', ['open', '--test-passphrase', '--key-file', files.current!, outer.path]);
    const actual = await shrinkAndVerifyExt4(host, mapping.path, payload);
    await host.run('cryptsetup', ['resize', '--size', String(payload / 512), '--key-file', files.current!, name]);
    const mappedSize = Number(await host.run('blockdev', ['--getsize64', mapping.path]));
    if (mappedSize !== payload || mappedSize < actual) fail('Mapping size verification failed; outer device is unchanged');
    await host.run('cryptsetup', ['close', name]);
    try {
      if (geometry) await host.run('sfdisk', ['--lock', '--wipe', 'never', '--wipe-partitions', 'never', '-N', geometry.number, outer.parentPath!], `,${target / geometry.sectorSize}\n`);
      else await host.run('lvreduce', ['--yes', '--size', `${op.sizeMb}M`, `${op.vg}/${op.lv}`]);
      const outerSize = Number(await host.run('blockdev', ['--getsize64', outer.path]));
      if (outerSize !== target) fail('Outer layer size does not match the verified plan; mapping remains closed for inspection');
    } catch (error) { fail(`The filesystem is smaller and the mapping is closed. Inspect the outer device before reopening: ${error instanceof Error ? error.message : String(error)}`); }
    await host.run('cryptsetup', ['open', '--type', 'luks', '--key-file', files.current!, outer.path, name]);
  });
}
async function executeExpertOperation(host: StorageHost, state: StorageInventory, op: StorageOperation, input?: StorageSecrets): Promise<string> {
  const device = checkExpertOperation(state, op);
  const secrets = validateStorageSecrets(op, input);
  if (op.action.startsWith('smart')) {
    const tests: Record<string, string> = { smartShort: 'short', smartLong: 'long', smartConveyance: 'conveyance' };
    const args = op.action === 'smartInfo' ? ['--json', '--all', device.path] : op.action === 'smartAbort' ? ['--json', '--abort', device.path] : ['--json', '--test', tests[op.action], device.path];
    const result = await host.run('smartctl', args);
    return `${op.action === 'smartInfo' ? 'SMART health, capabilities and self-test history' : 'SMART command accepted; tests run asynchronously in the drive. Refresh health/history for completion.'}\n${result.slice(0, 30000)}`;
  }
  if (op.action === 'secureErase') {
    if (op.eraseMethod === 'secure-discard') { await host.run('blkdiscard', ['--secure', device.path]); return `Secure discard completed on ${device.path}. The device reported support; no ordinary discard/overwrite fallback was used.`; }
    if (!host.overwriteDisk) fail('Update the privileged helper for whole-disk overwrite');
    await host.overwriteDisk(device);
    return `Overwrote, flushed and verified all ${device.size} addressable bytes on ${device.path}. This is an HDD logical clear, not an SSD/remapped-sector physical purge.`;
  }
  if (op.action === 'layerShrink') { await executeLayerShrink(host, state, op, secrets); return `Verified ext4 → dm-crypt → ${device.type} shrink completed; mapping reopened. Refresh inventory.`; }
  if (op.action === 'luksInfo') return `LUKS2 metadata\n${await host.run('cryptsetup', ['luksDump', '--dump-json-metadata', device.path])}`;
  if (op.action === 'luksHeaderBackup') { if (!host.backupHeader) fail('Update the helper for root-only header backups'); return `Encrypted LUKS header backup saved root-only at ${await host.backupHeader(device.path, device.uuid)}. Keep a separate protected copy; old header backups can restore old keyslots.`; }
  if (['luksAddKey', 'luksChangeSlot', 'luksRemoveSlot'].includes(op.action)) {
    if (!host.withKeyFiles) fail('Update the storage helper');
    await host.withKeyFiles(secrets, async files => {
      if (op.action === 'luksAddKey') await host.run('cryptsetup', ['luksAddKey', '--key-slot', String(op.slot), '--key-file', files.current!, device.path, files.next!]);
      else if (op.action === 'luksChangeSlot') await host.run('cryptsetup', ['luksChangeKey', '--key-slot', String(op.slot), '--key-file', files.current!, device.path, files.next!]);
      else {
        await host.run('cryptsetup', ['open', '--test-passphrase', '--key-slot', String(op.survivorSlot), '--key-file', files.current!, device.path]);
        await host.run('cryptsetup', ['luksKillSlot', '--key-file', files.current!, device.path, String(op.slot)]);
      }
    });
    return `${op.action} completed for keyslot ${op.slot}; refresh keyslot inventory. Other keys/tokens are unchanged.`;
  }
  if (op.action.startsWith('crypttab')) {
    if (!host.writeConfig) fail('Update the helper for crypttab management');
    const configs = await currentConfigs(host, state);
    let keyFile = 'none';
    if (op.action === 'crypttabSet' && op.keyMode === 'managed') {
      if (!host.withKeyFiles || !host.createBootKey) fail('Update the helper for private boot keys');
      keyFile = await host.createBootKey(device.uuid, op.slot!);
      try { await host.withKeyFiles(secrets, async files => { await host.run('cryptsetup', ['luksAddKey', '--key-slot', String(op.slot), '--key-file', files.current!, device.path, keyFile]); }); }
      catch (error) { fail(`Boot key file retained at ${keyFile}; keyslot addition may have failed. Inspect before retrying. ${error instanceof Error ? error.message : String(error)}`); }
    }
    try { await host.writeConfig('/etc/crypttab', configs['/etc/crypttab'], rewriteCrypttab(configs['/etc/crypttab'], device, op, keyFile)); }
    catch (error) { fail(`${keyFile === 'none' ? '' : `Boot key retained at ${keyFile} and keyslot may already be active. `}Inspect crypttab before retrying. ${error instanceof Error ? error.message : String(error)}`); }
    return op.action === 'crypttabRemove' ? 'crypttab entry removed. Existing key files/keyslots are intentionally retained; revoke them separately after verifying another unlock method.' : `crypttab entry saved for ${op.name}. ${keyFile === 'none' ? 'Boot asks for a passphrase.' : `Root-only boot key: ${keyFile}.`} Existing unrelated entries are preserved; no initramfs was rebuilt.`;
  }
  if (op.action === 'pvMove') { await host.run('pvmove', ['--atomic', device.path, ...op.devices!]); return `Extents migrated from ${device.path}. Verify PV allocation before detaching it from ${op.vg}.`; }
  if (op.action === 'pvMoveAbort') { await host.run('pvmove', ['--abort', device.path]); return 'Requested abort of this source PV migration; refresh LVM state before further changes.'; }
  if (op.action === 'pvShrink') { await host.run('pvresize', ['--setphysicalvolumesize', `${op.sizeMb}M`, '--yes', device.path]); return 'PV size reduced after LVM extent-boundary checks. Its underlying block device was not reduced.'; }
  if (op.action === 'raidCreate') {
    const target = `/dev/md/outpost-${op.name}`;
    await host.run('mdadm', ['--create', target, '--metadata=1.2', `--name=outpost-${op.name}`, `--level=${op.raidLevel}`, `--raid-devices=${op.devices!.length}`, '--run', ...op.devices!]);
    return `Created ${target}; monitor resync before further array changes. Boot assembly is a separate reviewed action.`;
  }
  if (op.action === 'raidInfo') return `RAID detail\n${await host.run('mdadm', ['--detail', device.path])}`;
  if (op.action === 'raidStop') { await host.run('mdadm', ['--stop', device.path]); return 'Array stopped; component superblocks and data are retained.'; }
  if (['raidAdd', 'raidFail', 'raidRemove'].includes(op.action)) {
    const action = ({ raidAdd: '--add', raidFail: '--fail', raidRemove: '--remove' } as Record<string, string>)[op.action];
    await host.run('mdadm', ['--manage', device.path, action, op.devices![0]]);
    return `${op.action} accepted. Refresh array state; replacement may start a rebuild. No component superblocks were wiped.`;
  }
  if (['raidBootAdd', 'raidBootRemove'].includes(op.action)) {
    if (!host.writeConfig) fail('Update the helper for RAID boot configuration');
    const configs = await currentConfigs(host, state), array = state.raid!.find(a => a.device === device.path)!;
    let file = '/etc/mdadm.conf';
    try { await host.read('/etc/mdadm/mdadm.conf'); file = '/etc/mdadm/mdadm.conf'; } catch { if (await optionalRead(host, '/etc/debian_version')) file = '/etc/mdadm/mdadm.conf'; }
    const text = configs[file];
    const lines = text.split('\n').filter(line => {
      if (!/^\s*ARRAY\s/.test(line)) return true;
      const uuid = line.match(/\bUUID=([^\s]+)/)?.[1];
      if (line.trim().split(/\s+/)[1] === device.path && uuid !== array.uuid) fail('An mdadm boot path already belongs to a different array');
      if (uuid !== array.uuid) return true;
      if (!line.includes('# outpost-storage')) fail('Existing unmanaged array boot entry must be reviewed outside Outpost first');
      return false;
    });
    if (op.action === 'raidBootAdd') lines.push(`ARRAY ${device.path} UUID=${array.uuid} # outpost-storage`);
    await host.writeConfig(file, text, lines.join('\n').replace(/\n*$/, '\n'));
    return `Updated ${file}; data-array boot assembly only. No initramfs or system RAID boot configuration was changed.`;
  }
  fail('Unsupported expert storage operation');
}
async function executeAdvancedOperation(host: StorageHost, state: StorageInventory, op: StorageOperation, input?: StorageSecrets) {
  const device = all(state.devices).find((d) => d.path === op.device)!;
  if (['luksFormat', 'luksOpen', 'luksPassphrase', 'luksGrow'].includes(op.action)) {
    const secrets = validateStorageSecrets(op, input);
    if (!host.withKeyFiles) fail('The storage helper must be updated for encryption operations');
    await host.withKeyFiles(secrets, async (files) => {
      if (op.action === 'luksFormat') await host.run('cryptsetup', ['luksFormat', '--type', 'luks2', '--batch-mode', '--key-file', files.next!, device.path]);
      else if (op.action === 'luksOpen') await host.run('cryptsetup', ['open', '--type', 'luks', '--key-file', files.current!, device.path, op.name!]);
      else if (op.action === 'luksPassphrase') await host.run('cryptsetup', ['luksChangeKey', '--key-file', files.current!, device.path, files.next!]);
      else {
        const name = (await host.read(`/sys/class/block/${device.kernel}/dm/name`)).trim();
        if (!/^[a-zA-Z0-9_][a-zA-Z0-9_+.-]*$/.test(name)) fail('Invalid active mapping name');
        const status = await host.run('cryptsetup', ['status', name]);
        const offset = Number(status.match(/offset:\s*(\d+)\s*sectors/)?.[1]);
        let underlyingPath = status.match(/device:\s*(\S+)/)?.[1];
        if (underlyingPath && host.canonicalDevice) underlyingPath = await host.canonicalDevice(underlyingPath);
        const underlying = all(state.devices).find((d) => d.path === underlyingPath);
        if (!underlying || !Number.isFinite(offset) || underlying.size - offset * 512 < device.size) fail('Refusing to shrink the encrypted mapping; verify its underlying device and payload offset');
        await host.run('cryptsetup', ['resize', '--key-file', files.current!, name]);
      }
    });
  } else if (op.action === 'luksClose') {
    const name = (await host.read(`/sys/class/block/${device.kernel}/dm/name`)).trim();
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9_+.-]*$/.test(name)) fail('Invalid active mapping name');
    await host.run('cryptsetup', ['close', name]);
  }
  else if (op.action === 'partitionGrow' || op.action === 'partitionShrink') {
    const table = JSON.parse(await host.run('sfdisk', ['--json', device.parentPath!]));
    const found = table.partitiontable.partitions.some((p: { node: string }) => p.node === device.path);
    const number = device.path.slice(device.parentPath!.length).match(/^p?([1-9]\d*)$/)?.[1];
    if (!found || !number) fail('Partition is no longer in its parent table');
    if (op.action === 'partitionGrow') await host.run('growpart', [device.parentPath!, number]);
    else {
      const sectorSize = Number(table.partitiontable.sectorsize);
      const current = table.partitiontable.partitions.find((p: { node: string }) => p.node === device.path);
      if (![512, 4096].includes(sectorSize) || !Number.isSafeInteger(Number(current.start)) || Number(current.size) * sectorSize !== device.size) fail('Partition geometry changed or uses an unsupported sector size');
      await host.run('e2fsck', ['-f', '-p', device.path]);
      await host.run('resize2fs', [device.path, `${op.sizeMb}M`]);
      const header = await host.run('dumpe2fs', ['-h', device.path]);
      const blocks = Number(header.match(/Block count:\s*(\d+)/)?.[1]), blockSize = Number(header.match(/Block size:\s*(\d+)/)?.[1]);
      if (!blocks || !blockSize || blocks * blockSize > op.sizeMb! * 1048576) fail('Filesystem size could not be verified; partition was left unchanged');
      await host.run('sfdisk', ['--lock', '--wipe', 'never', '--wipe-partitions', 'never', '-N', number, device.parentPath!], `,${op.sizeMb! * 1048576 / sectorSize}\n`);
    }
  } else if (op.action === 'filesystemGrow') {
    if (device.filesystem.startsWith('ext')) { await host.run('e2fsck', ['-f', '-p', device.path]); await host.run('resize2fs', [device.path]); }
    else if (device.filesystem === 'xfs') await host.run('xfs_growfs', [device.mountpoints[0]]);
    else await host.run('btrfs', ['filesystem', 'resize', 'max', device.mountpoints[0]]);
  } else if (op.action === 'pvCreate') await host.run('pvcreate', ['--yes', device.path]);
  else if (op.action === 'pvRemove') await host.run('pvremove', ['--yes', device.path]);
  else if (op.action === 'pvGrow') await host.run('pvresize', [device.path]);
  else if (op.action === 'vgCreate') await host.run('vgcreate', [op.name!, ...(op.devices?.length ? op.devices : [device.path])]);
  else if (op.action === 'vgRename') await host.run('vgrename', [state.lvm!.vgs.find((v) => v.name === op.vg)!.uuid, op.name!]);
  else if (op.action === 'vgExtend') await host.run('vgextend', [op.vg!, ...op.devices!]);
  else if (op.action === 'vgReduce') await host.run('vgreduce', [op.vg!, device.path]);
  else if (op.action === 'vgRemove') await host.run('vgremove', [op.vg!]); // No implicit yes if an unexpected LV appears.
  else if (op.action === 'lvCreate') {
    const args = op.layout === 'thin' ? ['--thinpool', `${op.vg}/${op.pool}`, '--virtualsize', `${op.sizeMb}M`] : ['--type', op.layout === 'thin-pool' ? 'thin-pool' : 'linear', '--size', `${op.sizeMb}M`, op.vg!];
    await host.run('lvcreate', ['--name', op.name!, ...args]);
  } else if (op.action === 'lvActivate' || op.action === 'lvDeactivate') await host.run('lvchange', ['--activate', op.action === 'lvActivate' ? 'y' : 'n', `${op.vg}/${op.lv}`]);
  else if (op.action === 'lvRename') await host.run('lvrename', [op.vg!, op.lv!, op.name!]);
  else if (op.action === 'lvRemove') await host.run('lvremove', ['--yes', `${op.vg}/${op.lv}`]);
  else if (op.action === 'lvSnapshot') {
    const origin = state.lvm!.lvs.find((l) => l.vg === op.vg && l.name === op.lv)!;
    await host.run('lvcreate', ['--snapshot', '--name', op.name!, ...(origin.kind === 'thin' ? [] : ['--size', `${op.sizeMb}M`]), `${op.vg}/${op.lv}`]);
  } else if (op.action === 'lvResize') {
    const lv = state.lvm!.lvs.find((l) => l.vg === op.vg && l.name === op.lv)!;
    if (lv.kind === 'thin-pool') { await host.run('lvextend', ['--size', `${op.sizeMb}M`, `${op.vg}/${op.lv}`]); return; }
    const node = all(state.devices).find((d) => d.path === lv.path)!;
    // LVM/fsadm shrinks the filesystem before reducing its block device; never force a raw reduction.
    if (['xfs', 'btrfs', 'crypto_LUKS'].includes(node.filesystem)) await host.run('lvextend', ['--size', `${op.sizeMb}M`, `${op.vg}/${op.lv}`]);
    else await host.run('lvresize', ['--yes', ...(node.filesystem ? ['--resizefs'] : []), '--size', `${op.sizeMb}M`, `${op.vg}/${op.lv}`]);
  } else fail('Unsupported advanced storage action');
  try { await host.run('udevadm', ['settle']); } catch { /* optional */ }
}
export function checkOperation(state: StorageInventory, op: StorageOperation): StorageDevice {
  if (EXPERT_ACTIONS.includes(op.action as typeof EXPERT_ACTIONS[number])) return checkExpertOperation(state, op);
  if (ADVANCED_ACTIONS.includes(op.action)) return checkAdvancedOperation(state, op);
  const device = all(state.devices).find((d) => d.path === op.device);
  if (!device) fail('The selected device is no longer present');
  if (device!.protected) fail(device!.reason ?? 'Protected device');
  const family = all([device!]);
  if (['format', 'wipe', 'partition'].includes(op.action)) {
    const mountedUuids = new Set(all(state.devices).filter((d) => d.mountpoints.length && d.uuid).map((d) => d.uuid));
    if (family.some((d) => d.mountpoints.length || (d.uuid && mountedUuids.has(d.uuid)))) fail('Unmount every selected filesystem and disable swap before continuing');
    if (family.some((d) => /LVM|RAID|crypto/i.test(d.filesystem))) fail('Encrypted, RAID and LVM members must be released outside Outpost first');
    if (state.fstab.some((e) => family.some((d) => referencesDevice(e, d)))) fail('Remove persistent fstab entries for this device before erasing it');
    if (op.action === 'format' && device!.children.length) fail('Select a partition to format, or wipe and initialize the disk first');
    if (op.action === 'partition' && (device!.type !== 'disk' || device!.children.length || device!.filesystem)) fail('GPT initialization requires an empty disk without existing partitions or a filesystem');
  }
  if (op.action === 'mount' && device!.mountpoints.length) fail('The filesystem is already mounted');
  if (['mount', 'automount'].includes(op.action) && !FILESYSTEMS.includes(device!.filesystem)) fail('Select a partition with a supported filesystem');
  if ((op.action === 'automount' || op.persistent) && all(state.devices).filter((d) => d.uuid && d.uuid === device!.uuid).length !== 1) fail('Persistent mounts require a unique filesystem UUID');
  if ((op.action === 'automount' || op.persistent) && state.fstab.some((e) => !e.managed && referencesDevice(e, device!))) fail('This device has an existing unmanaged fstab entry. Manage that entry outside Outpost first.');
  if (op.action === 'unmount' && (device!.mountpoints.length !== 1 || device!.mountpoints[0] === '[SWAP]')) fail('Select a filesystem with exactly one ordinary mountpoint');
  return device!;
}
export async function executeStorage(host: StorageHost, input: unknown, expectedFingerprint: string, secrets?: StorageSecrets) {
  const op = validateStorageOperation(input);
  const state = await inventory(host), device = checkOperation(state, op);
  if (storageFingerprint(state, op) !== expectedFingerprint) fail('Device identity or state changed since the preview. Refresh and review the operation again.');
  if (EXPERT_ACTIONS.includes(op.action as typeof EXPERT_ACTIONS[number])) return { message: await executeExpertOperation(host, state, op, secrets) };
  if (ADVANCED_ACTIONS.includes(op.action)) { await executeAdvancedOperation(host, state, op, secrets); return { message: `${op.action} completed for ${device.path}` }; }
  if (op.action === 'mount' || op.action === 'automount') {
    if (device.mountpoints.length && (device.mountpoints.length !== 1 || device.mountpoints[0] !== op.mountpoint)) fail('Use the filesystem’s existing mountpoint');
    if (!device.mountpoints.length && !(op.action === 'automount' && op.enabled === false)) await host.prepareMount(op.mountpoint!);
    const before = await host.read('/etc/fstab');
    const persist = op.action === 'automount' || op.persistent;
    const after = persist ? rewriteFstab(before, device, { ...op, enabled: op.action === 'mount' ? true : op.enabled }) : before;
    if (after !== before) await host.writeFstab(before, after);
    if (op.action === 'mount') {
      try { await host.run('mount', ['--types', device.filesystem, '--options', `${op.readOnly ? 'ro' : 'rw'},nodev,nosuid`, '--', device.path, op.mountpoint!]); }
      catch (error) {
        if (after !== before) {
          try { await host.writeFstab(after, before); } catch { fail('Mount failed and fstab rollback also failed. Inspect /etc/fstab and its Outpost backup before rebooting.'); }
        }
        throw error;
      }
    }
  } else if (op.action === 'unmount') await host.run('umount', ['--', device.mountpoints[0]]);
  else if (op.action === 'format') {
    const label = op.label ? [op.filesystem === 'vfat' ? '-n' : '-L', op.label] : [];
    const flags = op.filesystem === 'ext4' ? ['-F'] : ['xfs', 'btrfs'].includes(op.filesystem!) ? ['-f'] : op.filesystem === 'vfat' ? ['-F', '32'] : [];
    await host.run(`mkfs.${op.filesystem}`, [...flags, ...label, device.path]);
  } else if (op.action === 'wipe') {
    for (const target of all([device]).reverse()) await host.run('wipefs', ['--all', '--', target.path]);
  } else if (op.action === 'partition') await host.run('sfdisk', ['--wipe', 'never', '--label', 'gpt', device.path], 'label: gpt\n, , L\n');
  if (['format', 'wipe', 'partition'].includes(op.action)) {
    try { await host.run('udevadm', ['settle']); } catch { /* optional */ }
  }
  return { message: `${op.action} completed for ${device.path}` };
}

export async function overwriteAndVerify(io: { write(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesWritten: number }>; read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>; sync(): Promise<void> }, size: number) {
  if (!Number.isSafeInteger(size) || size <= 0) fail('Invalid whole-device erasure capacity');
  const zero = Buffer.alloc(8 * 1024 * 1024), read = Buffer.alloc(zero.length);
  for (let offset = 0; offset < size;) { const length = Math.min(zero.length, size - offset); const result = await io.write(zero, 0, length, offset); if (!result.bytesWritten || result.bytesWritten > length) fail('Disk overwrite stopped before the end'); offset += result.bytesWritten; }
  await io.sync();
  for (let offset = 0; offset < size;) { const length = Math.min(read.length, size - offset); const result = await io.read(read, 0, length, offset); if (!result.bytesRead || result.bytesRead > length || !read.subarray(0, result.bytesRead).equals(zero.subarray(0, result.bytesRead))) fail('Full-disk overwrite verification failed'); offset += result.bytesRead; }
}
export function storageExitAccepted(command: string, code: unknown) {
  return code === 0 || (command === 'e2fsck' && code === 1) || (command === 'smartctl' && typeof code === 'number' && Number.isInteger(code) && code > 0 && code <= 255 && (code & 7) === 0);
}
async function rootDirectory(directory: string, privateMode: boolean) {
  let current = '/';
  for (const part of directory.split('/').filter(Boolean)) {
    current = path.posix.join(current, part);
    try { await fs.mkdir(current, { mode: privateMode ? 0o700 : 0o755 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022)) fail('Configuration/key directories must be root-owned, without symlinks or group/world write access');
  }
  if (privateMode) { const stat = await fs.stat(directory); if (stat.mode & 0o077) fail('The private key/header directory must have mode 0700'); }
}
export function createLinuxStorageHost(protectedPaths: string[]): StorageHost {
  const command = async (name: string, args: string[], input?: string) => {
    if (!['mdadm', 'pvmove', 'smartctl', 'blkdiscard', 'blockdev', 'lvreduce', 'lsblk', 'findmnt', 'mount', 'umount', 'wipefs', 'sfdisk', 'udevadm', 'systemctl', 'flock', 'cryptsetup', 'pvs', 'vgs', 'lvs', 'pvcreate', 'pvremove', 'pvresize', 'vgcreate', 'vgrename', 'vgextend', 'vgreduce', 'vgremove', 'lvcreate', 'lvrename', 'lvresize', 'lvextend', 'lvremove', 'lvchange', 'growpart', 'e2fsck', 'resize2fs', 'dumpe2fs', 'xfs_growfs', 'btrfs', ...FORMAT_TYPES.map((f) => `mkfs.${f}`)].includes(name)) fail('Unsupported command');
    const executable = ['/usr/sbin', '/sbin', '/usr/bin', '/bin'].map((base) => path.join(base, name)).find(existsSync);
    if (!executable) fail(`Install the host utility ${name} before using this action`);
    return new Promise<string>((resolve, reject) => {
      const child = execFile(executable!, args, { timeout: ['flock', 'pvmove', 'blkdiscard', 'e2fsck', 'resize2fs'].includes(name) ? 24 * 60 * 60_000 : 600_000, maxBuffer: 4 * 1024 * 1024, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C', LANG: 'C', HOME: '/root' } }, (error, stdout, stderr) => error && !storageExitAccepted(name, error.code) ? reject(new Error(`${name}: ${(stderr || stdout || error.message).trim().slice(0, 1500)}`)) : resolve(stdout));
      child.stdin?.end(input ?? '');
    });
  };
  const host: StorageHost = {
    protectedPaths, run: command, read: (file) => fs.readFile(file, 'utf8'), canonicalDevice: (file) => fs.realpath(file),
    writeConfig: async (file, expected, next) => {
      if (!['/etc/crypttab', '/etc/mdadm.conf', '/etc/mdadm/mdadm.conf'].includes(file)) fail('Unsupported configuration file');
      await rootDirectory(path.dirname(file), false);
      let mode = 0o600;
      try { const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022)) fail('Configuration must be a regular root-owned file without group/world writes'); mode = stat.mode & 0o777; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (await optionalRead(host, file) !== expected) fail('Configuration changed concurrently');
      const token = crypto.randomUUID(), temp = `${file}.outpost-${token}.tmp`;
      try {
        await fs.writeFile(temp, next, { mode, flag: 'wx' });
        const handle = await fs.open(temp, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
        if (await optionalRead(host, file) !== expected) fail('Configuration changed concurrently');
        await fs.writeFile(`${file}.outpost-${Date.now()}-${token}.bak`, expected, { mode: 0o600, flag: 'wx' });
        await fs.rename(temp, file);
        const dir = await fs.open(path.dirname(file), 'r'); try { await dir.sync(); } finally { await dir.close(); }
        if (existsSync('/run/systemd/system')) await command('systemctl', ['daemon-reload']);
      } finally { await fs.rm(temp, { force: true }); }
    },
    createBootKey: async (uuid, slot) => {
      if (!/^[a-f0-9-]{16,64}$/i.test(uuid) || !Number.isInteger(slot) || slot < 0 || slot > 31) fail('Invalid boot key identity');
      const dir = '/etc/cryptsetup-keys.d'; await rootDirectory(dir, true);
      const key = `${dir}/outpost-${uuid}-${slot}.key`;
      await fs.writeFile(key, crypto.randomBytes(64), { mode: 0o600, flag: 'wx' });
      const handle = await fs.open(key, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
      return key;
    },
    backupHeader: async (device, uuid) => {
      if (!/^[a-f0-9-]{16,64}$/i.test(uuid)) fail('Invalid LUKS UUID');
      const dir = '/var/lib/outpost-storage/headers'; await rootDirectory(dir, true);
      const target = `${dir}/${uuid}-${Date.now()}-${crypto.randomUUID()}.luks`;
      await command('cryptsetup', ['luksHeaderBackup', '--header-backup-file', target, device]);
      await fs.chmod(target, 0o600); return target;
    },
    overwriteDisk: async device => {
      if (!device.diskSeq || device.rotational !== true) fail('A stable kernel disk sequence and rotational disk are required');
      const sequence = () => host.read(`/sys/class/block/${device.kernel}/diskseq`).then(s => s.trim());
      if (await sequence() !== device.diskSeq || Number(await command('blockdev', ['--getsize64', device.path])) !== device.size) fail('Disk identity/capacity changed before erasure');
      const handle = await fs.open(device.path, constants.O_RDWR | constants.O_EXCL | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat(), link = await fs.lstat(device.path);
        if (!stat.isBlockDevice() || !link.isBlockDevice() || stat.rdev !== link.rdev || await sequence() !== device.diskSeq) fail('Exclusive block-device identity check failed');
        await overwriteAndVerify(handle, device.size);
      } finally { await handle.close(); }
    },
    withKeyFiles: async (secrets, use) => {
      const dir = await fs.mkdtemp('/run/outpost-storage-keys-');
      try {
        const files: { current?: string; next?: string } = {};
        if (secrets.passphrase !== undefined) { files.current = path.join(dir, 'current'); await fs.writeFile(files.current, secrets.passphrase, { flag: 'wx', mode: 0o600 }); }
        if (secrets.newPassphrase !== undefined) { files.next = path.join(dir, 'next'); await fs.writeFile(files.next, secrets.newPassphrase, { flag: 'wx', mode: 0o600 }); }
        await use(files);
      } finally { await fs.rm(dir, { recursive: true, force: true }); }
    },
    operationRunning: async () => {
      if (!existsSync('/run/outpost-storage')) return false;
      try { await command('flock', ['--nonblock', '/run/outpost-storage/operation.lock', '/usr/bin/true']); return false; }
      catch { return true; }
    },
    prepareMount: async (target) => {
      validateMountpoint(target);
      const mounts = (await fs.readFile('/proc/self/mountinfo', 'utf8')).split('\n').map((line) => decode(line.split(' ')[4] ?? ''));
      if (mounts.includes(target)) fail('That folder is already a mountpoint');
      let probe = target;
      for (;;) {
        try {
          const stat = await fs.lstat(probe);
          if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022)) fail('Mount folders and existing parent folders must be root-owned directories, without symlinks or group/world write access');
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (probe === '/') break; probe = path.dirname(probe);
      }
      await fs.mkdir(target, { recursive: true, mode: 0o755 });
      if ((await fs.readdir(target)).length) fail('The mount folder must be empty');
      const stat = await fs.stat(target);
      if (stat.uid !== 0 || (stat.mode & 0o022)) fail('The mount folder must be root-owned and not writable by other users');
    },
    writeFstab: async (expected, next) => {
      const stat = await fs.lstat('/etc/fstab');
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022)) fail('/etc/fstab must be a regular root-owned file');
      if (await fs.readFile('/etc/fstab', 'utf8') !== expected) fail('fstab changed concurrently. Refresh and retry.');
      const token = crypto.randomUUID();
      const temp = `/etc/.fstab.outpost-${token}`;
      try {
        await fs.writeFile(temp, next, { flag: 'wx', mode: stat.mode & 0o777 });
        await fs.chown(temp, stat.uid, stat.gid);
        const handle = await fs.open(temp, 'r+');
        try { await handle.sync(); } finally { await handle.close(); }
        await command('findmnt', ['--verify', '--tab-file', temp]);
        if (await fs.readFile('/etc/fstab', 'utf8') !== expected) fail('fstab changed concurrently. Refresh and retry.');
        await fs.copyFile('/etc/fstab', `/etc/fstab.outpost-${Date.now()}-${token}.bak`, 1);
        await fs.rename(temp, '/etc/fstab');
        const directory = await fs.open('/etc', 'r');
        try { await directory.sync(); } finally { await directory.close(); }
        if (existsSync('/run/systemd/system')) await command('systemctl', ['daemon-reload']);
      } finally { await fs.rm(temp, { force: true }); }
    },
  };
  return host;
}

// Importing this file in tests never executes commands. The installed helper reads one JSON request.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void (async () => {
    try {
      if (process.platform !== 'linux' || process.getuid?.() !== 0) fail('Storage management requires Linux root privileges');
      let text = '';
      for await (const chunk of process.stdin) { text += chunk; if (text.length > 32 * 1024) fail('Storage request is too large'); }
      const request = JSON.parse(text);
      const protectedPaths = Array.isArray(request.protectedPaths) ? request.protectedPaths.filter((p: unknown): p is string => typeof p === 'string' && p.startsWith('/') && !/[\0\r\n]/.test(p)) : [];
      const host = createLinuxStorageHost(protectedPaths);
      if (request.action !== 'inventory' && !process.argv.includes('--storage-locked')) {
        const lockDir = '/run/outpost-storage';
        try { await fs.mkdir(lockDir, { mode: 0o700 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        const stat = await fs.lstat(lockDir);
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o077)) fail('Invalid storage lock directory');
        const result = await host.run('flock', ['--nonblock', path.join(lockDir, 'operation.lock'), process.execPath, ...process.execArgv, fileURLToPath(import.meta.url), '--storage-locked'], text);
        process.stdout.write(result);
        return;
      }
      const result = request.action === 'inventory' ? await inventory(host) : await executeStorage(host, request.operation, request.fingerprint, request.secrets);
      process.stdout.write(JSON.stringify({ ok: true, result }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'Storage operation failed' })); process.exitCode = 1;
    }
  })();
}
