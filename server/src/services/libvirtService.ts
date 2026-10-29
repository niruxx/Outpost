import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import { DATA_DIR } from '../utils/paths.js';
import { HttpError } from '../utils/asyncHandler.js';
import { getSetting, setSetting } from './systemSettingsService.js';

export interface LibvirtSettings { enabled: boolean; uri: string }
export interface VirtualMachine {
  uuid: string; name: string; state: string; cpus: number; memoryMb: number;
  maxMemoryMb: number; autostart: boolean; persistent: boolean;
}
export const VM_ACTIONS = ['start', 'shutdown', 'reboot', 'suspend', 'resume', 'destroy'] as const;
export type VmAction = typeof VM_ACTIONS[number];
export type VirshRunner = (uri: string, args: string[]) => Promise<string>;

export function validateLibvirtSettings(input: unknown): LibvirtSettings {
  const value = input as Partial<LibvirtSettings> | null;
  if (!value || typeof value.enabled !== 'boolean' || typeof value.uri !== 'string') throw new HttpError(400, 'enabled and uri are required');
  const uri = value.uri.trim();
  // No URI query parameters: they can select arbitrary SSH commands or sockets.
  if (!/^qemu:\/\/\/(system|session)$/.test(uri) && !/^qemu\+ssh:\/\/(?:[a-zA-Z0-9_.-]+@)?(?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\])(?::[0-9]{1,5})?\/(system|session)$/.test(uri)) {
    throw new HttpError(400, 'Use qemu:///system, qemu:///session or qemu+ssh://user@host/system (no passwords or query parameters)');
  }
  return { enabled: value.enabled, uri };
}
export function libvirtSettings(): LibvirtSettings {
  return { enabled: getSetting('libvirt_enabled') === 'true', uri: getSetting('libvirt_uri') ?? 'qemu:///system' };
}
export function saveLibvirtSettings(input: unknown) {
  const settings = validateLibvirtSettings(input);
  setSetting('libvirt_uri', settings.uri);
  setSetting('libvirt_enabled', String(settings.enabled));
  return settings;
}

export const runVirsh: VirshRunner = (uri, args) => new Promise((resolve, reject) => {
  execFile('virsh', ['--connect', uri, ...args], {
    timeout: args[0] === 'migrate' ? 0 : 120_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  }, (error, stdout, stderr) => {
    if (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      reject(new HttpError(503, missing ? 'virsh is not installed or is not on the Outpost service PATH. Install the libvirt client tools.' : `libvirt: ${(stderr.trim() || error.message).slice(0, 1000)}`));
    } else resolve(stdout.trim());
  });
});

export function validateVmUuid(uuid: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) throw new HttpError(400, 'A valid VM UUID is required');
  return uuid;
}
export function resourceName(input: unknown): string {
  if (typeof input !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/.test(input)) throw new HttpError(400, 'Use a name of 1-128 letters, digits, dots, underscores or hyphens');
  return input;
}
export function xmlEscape(value: string) { return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!)); }
const unescapeXml = (value: string) => value.replace(/&(?:amp|lt|gt|quot|apos);/g, c => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }[c]!));
const attr = (xml: string, key: string) => unescapeXml(xml.match(new RegExp(`\\b${key}=['"]([^'"]*)['"]`))?.[1] ?? '');
const element = (xml: string, tag: string) => xml.match(new RegExp(`<${tag}\\b[^>]*>`))?.[0] ?? '';
const deviceBlocks = (xml: string, tag: string) => [...(xml.match(/<devices\b[^>]*>([\s\S]*?)<\/devices>/)?.[1] ?? '').matchAll(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'g'))].map(m => m[0]);
export function interfaceXml(input: { network?: unknown; model?: unknown; mac?: unknown; link?: unknown }) {
  const network = resourceName(input.network), model = input.model ?? 'virtio', mac = input.mac ?? '', link = input.link ?? 'up';
  if (!['virtio', 'e1000e', 'rtl8139'].includes(String(model)) || !['up', 'down'].includes(String(link))) throw new HttpError(400, 'Choose a supported NIC model and link state');
  if (typeof mac !== 'string' || (mac && (!/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(mac) || (parseInt(mac.slice(0, 2), 16) & 1) !== 0 || mac === '00:00:00:00:00:00'))) throw new HttpError(400, 'Provide a unicast MAC address or leave it blank for automatic assignment');
  return `<interface type='network'>${mac ? `<mac address='${mac}'/>` : ''}<source network='${xmlEscape(network)}'/><model type='${model}'/><link state='${link}'/></interface>`;
}
export function parseDomainInfo(text: string): VirtualMachine {
  const fields = Object.fromEntries(text.split(/\r?\n/).map((line) => {
    const colon = line.indexOf(':');
    return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
  }));
  return {
    uuid: validateVmUuid(fields.UUID ?? ''), name: fields.Name ?? '', state: fields.State ?? 'unknown',
    cpus: Number(fields['CPU(s)']) || 0, memoryMb: Math.round((parseInt(fields['Used memory']) || 0) / 1024),
    maxMemoryMb: Math.round((parseInt(fields['Max memory']) || 0) / 1024),
    autostart: fields.Autostart === 'enable', persistent: fields.Persistent === 'yes',
  };
}

/** P6 is the QEMU screenshot format on hosts that do not return PNG directly. */
export function screenshotToPng(data: Buffer): Buffer {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return data;
  let offset = 0;
  const token = () => {
    while (offset < data.length) {
      if (data[offset] === 35) { while (offset < data.length && data[offset] !== 10) offset++; }
      else if ([9, 10, 13, 32].includes(data[offset])) offset++;
      else break;
    }
    const start = offset;
    while (offset < data.length && ![9, 10, 13, 32].includes(data[offset])) offset++;
    return data.toString('ascii', start, offset);
  };
  const magic = token(), width = Number(token()), height = Number(token()), max = Number(token());
  if (magic !== 'P6' || max !== 255 || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 16_777_216) {
    throw new HttpError(422, 'The hypervisor returned an unsupported screenshot format (PNG or 8-bit PPM required)');
  }
  // Consume exactly the header separator; pixel bytes may themselves be whitespace or '#'.
  if (data[offset] === 13 && data[offset + 1] === 10) offset += 2;
  else if ([9, 10, 13, 32].includes(data[offset])) offset++;
  else throw new HttpError(422, 'Invalid screenshot header');
  if (data.length - offset !== width * height * 3) throw new HttpError(422, 'Incomplete screenshot');
  const png = new PNG({ width, height });
  for (let pixel = 0; pixel < width * height; pixel++) {
    data.copy(png.data, pixel * 4, offset + pixel * 3, offset + pixel * 3 + 3);
    png.data[pixel * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

export class LibvirtClient {
  constructor(readonly uri: string, private readonly run: VirshRunner = runVirsh) {}
  private async volumeNames(pool: string): Promise<string[]> {
    // vol-list has no --name option: its default output is a Name/Path table.
    const table = await this.run(this.uri, ['vol-list', '--pool', pool]);
    const lines = table.split(/\r?\n/);
    const separator = lines.findIndex(line => /^\s*-+\s*$/.test(line));
    return lines.slice(separator + 1).map(line => line.trim().split(/\s{2,}/)[0]).filter(Boolean);
  }
  private imagesKey() { return `libvirt_images_${createHash('sha256').update(this.uri).digest('hex').slice(0, 16)}`; }
  async images(directory?: unknown) {
    const key = this.imagesKey();
    const pool = `outpost-images-${createHash('sha256').update(`${this.uri}:${directory ?? getSetting(key) ?? ''}`).digest('hex').slice(0, 16)}`;
    if (directory !== undefined) {
      if (typeof directory !== 'string' || !directory.startsWith('/') || directory.length > 4096 || /[\x00-\x1f]/.test(directory) || directory.split('/').includes('..')) throw new HttpError(400, 'Specify an existing absolute images directory on the hypervisor');
      const pools = (await this.run(this.uri, ['pool-list', '--all', '--name'])).split(/\r?\n/);
      if (pools.includes(pool)) {
        const xml = await this.run(this.uri, ['pool-dumpxml', pool]);
        const current = unescapeXml(xml.match(/<path>([^<]*)<\/path>/)?.[1] ?? '');
        if (current !== directory) throw new HttpError(409, 'This connection already has an images pool. Use a different directory by editing the dedicated pool in native libvirt tools first.');
      } else await this.createPool({ name: pool, target: directory });
      const info = await this.run(this.uri, ['pool-info', pool]);
      if (!/^State:\s+running\s*$/m.test(info)) await this.run(this.uri, ['pool-start', pool]);
      await this.run(this.uri, ['pool-autostart', pool]);
      setSetting(key, directory);
    }
    const saved = getSetting(key);
    if (!saved) return { directory: '', pool, images: [] as { name: string; path: string }[] };
    await this.run(this.uri, ['pool-refresh', pool]);
    const names = (await this.volumeNames(pool)).filter(n => /\.iso$/i.test(n));
    const images = [];
    for (const name of names) images.push({ name, path: await this.run(this.uri, ['vol-path', name, '--pool', pool]) });
    return { directory: saved, pool, images };
  }
  async devices(uuid: string) {
    const xml = await this.xml(uuid);
    return {
      disks: deviceBlocks(xml, 'disk').map(d => ({ target: attr(element(d, 'target'), 'dev'), device: attr(element(d, 'disk'), 'device'), source: attr(element(d, 'source'), 'file') || [attr(element(d, 'source'), 'pool'), attr(element(d, 'source'), 'volume')].filter(Boolean).join('/'), boot: Number(attr(element(d, 'boot'), 'order')) || null })),
      interfaces: deviceBlocks(xml, 'interface').map(d => ({ mac: attr(element(d, 'mac'), 'address'), type: attr(element(d, 'interface'), 'type'), network: attr(element(d, 'source'), 'network'), model: attr(element(d, 'model'), 'type'), link: attr(element(d, 'link'), 'state') || 'up', boot: Number(attr(element(d, 'boot'), 'order')) || null })),
    };
  }
  private async stoppedXml(uuid: string) {
    const vm = await this.info(validateVmUuid(uuid));
    if (vm.state !== 'shut off' || !vm.persistent) throw new HttpError(409, 'Shut down a persistent VM before editing devices or boot settings');
    return this.xml(uuid);
  }
  async bootDevice(uuid: string, input: { target?: unknown; mac?: unknown }) {
    let xml = await this.stoppedXml(uuid);
    const tag = input.target ? 'disk' : 'interface';
    const blocks = deviceBlocks(xml, tag);
    const selected = blocks.find(d => input.target ? attr(element(d, 'target'), 'dev') === input.target : attr(element(d, 'mac'), 'address').toLowerCase() === String(input.mac).toLowerCase());
    if (!selected) throw new HttpError(404, 'Boot device not found');
    if (tag === 'disk' && attr(element(selected, 'disk'), 'device') === 'cdrom' && !/<source\b/.test(selected)) throw new HttpError(400, 'Insert media before selecting this CD-ROM as boot device');
    // libvirt disallows mixing OS boot order with per-device boot order.
    xml = xml.replace(/<boot\b[^>]*\/>/g, '');
    const clean = selected.replace(/<boot\b[^>]*\/>/g, '');
    xml = xml.replace(clean, clean.replace(`</${tag}>`, `<boot order='1'/></${tag}>`));
    await this.define(xml, uuid);
  }
  async media(uuid: string, input: { target?: unknown; iso?: unknown; add?: unknown }) {
    const xml = await this.stoppedXml(uuid);
    const target = input.target;
    const disk = deviceBlocks(xml, 'disk').find(d => attr(element(d, 'target'), 'dev') === target && attr(element(d, 'disk'), 'device') === 'cdrom');
    if (input.iso !== '' && (typeof input.iso !== 'string' || !input.iso.startsWith('/') || !/\.iso$/i.test(input.iso) || /[\x00-\x1f]/.test(input.iso) || input.iso.length > 4096 || input.iso.split('/').includes('..'))) throw new HttpError(400, 'Provide an absolute ISO path or an empty string to eject');
    if (input.add === true) {
      if (typeof target !== 'string' || !/^sd[a-z]$/.test(target)) throw new HttpError(400, 'Choose a SATA target such as sdb');
      if (deviceBlocks(xml, 'disk').some(d => attr(element(d, 'target'), 'dev') === target)) throw new HttpError(409, 'That disk target is already in use');
      const controller = /<controller\b[^>]*type=['"]sata['"]/.test(xml) ? '' : "<controller type='sata' index='0'/>";
      const drive = `<disk type='file' device='cdrom'><driver name='qemu' type='raw'/>${input.iso ? `<source file='${xmlEscape(String(input.iso))}'/>` : ''}<target dev='${target}' bus='sata'/><readonly/></disk>`;
      await this.define(xml.replace('</devices>', `${controller}${drive}</devices>`), uuid); return;
    }
    if (!disk) throw new HttpError(404, 'CD-ROM drive not found');
    await this.run(this.uri, ['change-media', uuid, String(target), ...(input.iso ? [input.iso as string, '--update'] : ['--eject']), '--config']);
  }
  async detachDisk(uuid: string, target: unknown) {
    const xml = await this.stoppedXml(uuid);
    const disk = deviceBlocks(xml, 'disk').find(d => attr(element(d, 'target'), 'dev') === target && attr(element(d, 'disk'), 'device') === 'disk');
    if (!disk) throw new HttpError(404, 'Disk not found');
    await this.withXml(disk, file => this.run(this.uri, ['detach-device', uuid, file, '--config']));
  }
  async createAttachedDisk(uuid: string, input: { pool?: unknown; name?: unknown; sizeMb?: unknown; format?: unknown; target?: unknown }) {
    const xml = await this.stoppedXml(uuid), pool = resourceName(input.pool), name = resourceName(input.name);
    if (typeof input.target !== 'string' || !/^vd[a-z]{1,2}$/.test(input.target)) throw new HttpError(400, 'Choose a virtio target such as vdb');
    if (deviceBlocks(xml, 'disk').some(d => attr(element(d, 'target'), 'dev') === input.target)) throw new HttpError(409, 'That disk target is already in use');
    await this.createDisk(pool, input);
    try { await this.attachDisk(uuid, { pool, volume: name, target: input.target }); }
    catch (err) { throw new HttpError(503, `${err instanceof Error ? err.message : 'Attachment failed'}. New disk ${pool}/${name} was retained. Attach the existing disk after reviewing the VM.`); }
  }
  async editInterface(uuid: string, input: { mac?: unknown; originalMac?: unknown; network?: unknown; model?: unknown; link?: unknown; remove?: unknown }) {
    const xml = await this.stoppedXml(uuid);
    const old = deviceBlocks(xml, 'interface').find(d => attr(element(d, 'mac'), 'address').toLowerCase() === String(input.originalMac ?? input.mac).toLowerCase());
    if (!old || attr(element(old, 'interface'), 'type') !== 'network') throw new HttpError(404, 'Managed virtual network interface not found');
    let replacement = '';
    if (input.remove !== true) {
      interfaceXml(input); await this.run(this.uri, ['net-info', resourceName(input.network)]);
      // Preserve addresses, boot priorities, filters and other settings from native tools.
      replacement = old;
      replacement = replacement.replace(/<mac\b[^>]*\/>/, input.mac ? `<mac address='${input.mac}'/>` : '');
      for (const [tag, value] of [['source', `<source network='${xmlEscape(String(input.network))}'/>`], ['model', `<model type='${input.model ?? 'virtio'}'/>`], ['link', `<link state='${input.link ?? 'up'}'/>`]]) {
        const re = new RegExp(`<${tag}\\b[^>]*(?:\\/>|>[\\s\\S]*?<\\/${tag}>)`);
        replacement = re.test(replacement) ? replacement.replace(re, value) : replacement.replace('</interface>', `${value}</interface>`);
      }
    }
    await this.define(xml.replace(old, replacement), uuid);
  }
  async create(input: { name?: unknown; cpus?: unknown; memoryMb?: unknown; diskMb?: unknown; pool?: unknown; network?: unknown; iso?: unknown; start?: unknown; autostart?: unknown; model?: unknown; mac?: unknown; link?: unknown; boot?: unknown; extraVolume?: unknown }) {
    const name = resourceName(input?.name), pool = resourceName(input?.pool), network = resourceName(input?.network);
    if (!Number.isInteger(input.cpus) || Number(input.cpus) < 1 || Number(input.cpus) > 256 || !Number.isInteger(input.memoryMb) || Number(input.memoryMb) < 256 || Number(input.memoryMb) > 1048576 || !Number.isInteger(input.diskMb) || Number(input.diskMb) < 1024 || Number(input.diskMb) > 16777216) throw new HttpError(400, 'Provide 1-256 CPUs, 256-1048576 MiB memory and 1024-16777216 MiB disk capacity');
    if (typeof input.start !== 'boolean' || typeof input.autostart !== 'boolean') throw new HttpError(400, 'start and autostart are required');
    const nic = interfaceXml(input), boot = input.boot ?? 'hd';
    if (input.extraVolume) resourceName(input.extraVolume);
    if (!['hd', 'cdrom', 'network'].includes(String(boot))) throw new HttpError(400, 'Choose disk, CD-ROM or network boot');
    const iso = input.iso;
    if (typeof iso !== 'string' || (iso !== '' && (!iso.startsWith('/') || iso.length > 4096 || /[\x00-\x1f]/.test(iso) || iso.split('/').includes('..') || !/\.iso$/i.test(iso)))) throw new HttpError(400, 'Provide an absolute installer ISO path on the hypervisor without parent traversal, or leave it blank');
    if (boot === 'cdrom' && !iso) throw new HttpError(400, 'Select an ISO to boot from CD-ROM');
    if ((await this.list()).some(vm => vm.name === name)) throw new HttpError(409, 'A VM with that name already exists');
    const poolInfo = await this.run(this.uri, ['pool-info', pool]);
    if (!/^State:\s+running\s*$/m.test(poolInfo)) throw new HttpError(409, 'Start the selected storage pool first');
    const networkInfo = await this.run(this.uri, ['net-info', network]);
    if (!/^Active:\s+yes\s*$/m.test(networkInfo)) throw new HttpError(409, 'Start the selected network first');
    const uuid = randomUUID(), volume = `${name.slice(0, 80)}-${uuid}.qcow2`;
    await this.createDisk(pool, { name: volume, sizeMb: input.diskMb, format: 'qcow2' });
    const xml = `<domain type='kvm'>
      <name>${name}</name><uuid>${uuid}</uuid>
      <memory unit='MiB'>${input.memoryMb}</memory><currentMemory unit='MiB'>${input.memoryMb}</currentMemory><vcpu>${input.cpus}</vcpu>
      <os><type arch='x86_64' machine='q35'>hvm</type>${[boot, ...['hd', 'cdrom', 'network'].filter(d => d !== boot)].map(d => `<boot dev='${d}'/>`).join('')}<bootmenu enable='yes'/></os>
      <features><acpi/><apic/></features><clock offset='utc'/><on_reboot>restart</on_reboot>
      <devices>
        <disk type='volume' device='disk'><driver name='qemu' type='qcow2'/><source pool='${xmlEscape(pool)}' volume='${xmlEscape(volume)}'/><target dev='vda' bus='virtio'/></disk>
        <controller type='sata' index='0'/><disk type='file' device='cdrom'><driver name='qemu' type='raw'/>${iso ? `<source file='${xmlEscape(iso)}'/>` : ''}<target dev='sda' bus='sata'/><readonly/></disk>
        ${nic}
        <graphics type='vnc' port='-1' autoport='yes' listen='127.0.0.1'/><video><model type='vga'/></video>
        <serial type='pty'><target port='0'/></serial><console type='pty'><target type='serial' port='0'/></console>
      </devices></domain>`;
    try { await this.define(xml); }
    catch (error) { throw new HttpError(503, `${error instanceof Error ? error.message : 'VM definition failed'}. Disk ${pool}/${volume} was retained; review storage before retrying.`); }
    // Once defined, return its identity even if a later operation fails, preventing blind duplicate retries.
    let warning: string | undefined;
    try {
      if (input.extraVolume) await this.attachDisk(uuid, { pool, volume: input.extraVolume, target: 'vdb' });
      if (input.autostart) await this.run(this.uri, ['autostart', uuid]);
      if (input.start) await this.action(uuid, 'start');
    } catch (error) { warning = `VM created. ${error instanceof Error ? error.message : 'Startup settings failed'}. Select it to review its state before retrying.`; }
    return { uuid, name, pool, volume, warning };
  }
  async snapshots(uuid: string) {
    return (await this.run(this.uri, ['snapshot-list', validateVmUuid(uuid), '--name'])).split(/\r?\n/).filter(Boolean);
  }
  async snapshot(uuid: string, action: string, name: unknown) {
    validateVmUuid(uuid); const snapshot = resourceName(name);
    if (!['create', 'revert', 'delete'].includes(action)) throw new HttpError(400, 'Unknown snapshot action');
    const vm = await this.info(uuid);
    if (vm.state !== 'shut off' || !vm.persistent) throw new HttpError(409, 'Shut down a persistent VM before snapshot operations');
    if (action === 'create') {
      if ((await this.snapshots(uuid)).includes(snapshot)) throw new HttpError(409, 'Snapshot already exists');
      await this.run(this.uri, ['snapshot-create-as', uuid, '--name', snapshot, '--atomic']);
    } else {
      if (!(await this.snapshots(uuid)).includes(snapshot)) throw new HttpError(404, 'Snapshot not found');
      if (action === 'revert') {
        const metadata = await this.run(this.uri, ['snapshot-dumpxml', uuid, '--snapshotname', snapshot]);
        if (!/<state>shutoff<\/state>/.test(metadata)) throw new HttpError(409, 'Restore only snapshots captured while the VM was shut off; running-state snapshots need native libvirt tools');
      }
      // No --force, --children or metadata-only deletion: libvirt must accept the safe default.
      await this.run(this.uri, [action === 'revert' ? 'snapshot-revert' : 'snapshot-delete', uuid, '--snapshotname', snapshot]);
    }
  }
  async infrastructure() {
    const pools = (await this.run(this.uri, ['pool-list', '--all', '--name'])).split(/\r?\n/).filter(Boolean);
    const networks = (await this.run(this.uri, ['net-list', '--all', '--name'])).split(/\r?\n/).filter(Boolean);
    const poolDetails = [];
    for (const name of pools) {
      const info = await this.run(this.uri, ['pool-info', name]);
      const active = /^State:\s+running\s*$/m.test(info);
      const volumes = active ? await this.volumeNames(name) : [];
      poolDetails.push({ name, active, info, volumes });
    }
    const networkDetails = [];
    for (const name of networks) networkDetails.push({ name, info: await this.run(this.uri, ['net-info', name]), xml: await this.run(this.uri, ['net-dumpxml', name]) });
    return { pools: poolDetails, networks: networkDetails };
  }
  async createPool(input: { name?: unknown; target?: unknown }) {
    const name = resourceName(input?.name), target = input?.target;
    if (typeof target !== 'string' || !target.startsWith('/') || target.length > 4096 || /[\x00-\x1f]/.test(target) || target.split('/').includes('..')) throw new HttpError(400, 'Provide an absolute hypervisor directory without parent traversal');
    const existing = (await this.run(this.uri, ['pool-list', '--all', '--name'])).split(/\r?\n/);
    if (existing.includes(name)) throw new HttpError(409, 'Pool already exists');
    // Define only: starting it is a separate explicit action. Never formats a host disk.
    await this.run(this.uri, ['pool-define-as', name, '--type', 'dir', '--target', target]);
  }
  async poolAction(name: string, action: string, enabled?: boolean) {
    resourceName(name);
    if (!['start', 'stop', 'refresh', 'autostart', 'undefine'].includes(action)) throw new HttpError(400, 'Unknown pool action');
    if (action === 'autostart' && typeof enabled !== 'boolean') throw new HttpError(400, 'enabled is required');
    await this.run(this.uri, [`pool-${action === 'stop' ? 'destroy' : action}`, name, ...(action === 'autostart' && !enabled ? ['--disable'] : [])]);
  }
  async createDisk(pool: string, input: { name?: unknown; sizeMb?: unknown; format?: unknown }) {
    resourceName(pool); const name = resourceName(input?.name);
    if (!Number.isInteger(input?.sizeMb) || Number(input.sizeMb) < 16 || Number(input.sizeMb) > 16_777_216 || !['raw', 'qcow2'].includes(String(input.format))) throw new HttpError(400, 'Provide sizeMb (16-16777216) and raw or qcow2 format');
    const xml = await this.run(this.uri, ['pool-dumpxml', pool]);
    if (!/<pool\s[^>]*type=['"]dir['"]/.test(xml)) throw new HttpError(400, 'Disk creation is limited to directory pools');
    if ((await this.volumeNames(pool)).includes(name)) throw new HttpError(409, 'Volume already exists');
    await this.run(this.uri, ['vol-create-as', pool, name, `${input.sizeMb}MiB`, '--format', String(input.format)]);
  }
  async attachDisk(uuid: string, input: { pool?: unknown; volume?: unknown; target?: unknown }) {
    validateVmUuid(uuid); const pool = resourceName(input?.pool), volume = resourceName(input?.volume);
    if (typeof input.target !== 'string' || !/^vd[a-z]{1,2}$/.test(input.target)) throw new HttpError(400, 'Use a virtio disk target such as vdb');
    const vmInfo = await this.info(uuid);
    if (vmInfo.state !== 'shut off' || !vmInfo.persistent) throw new HttpError(409, 'Shut down a persistent VM before attaching a disk');
    const xml = await this.run(this.uri, ['vol-dumpxml', volume, '--pool', pool]);
    const format = xml.match(/<format\s+type=['"](raw|qcow2)['"]\s*\//)?.[1];
    if (!format || !/<volume\s[^>]*type=['"]file['"]/.test(xml)) throw new HttpError(400, 'Select a raw or qcow2 file volume');
    const diskPath = xml.match(/<path>([^<]+)<\/path>/)?.[1];
    if (!diskPath) throw new HttpError(422, 'Volume path is missing');
    for (const vm of await this.list()) {
      const definitions = [await this.run(this.uri, ['dumpxml', vm.uuid])];
      if (vm.persistent && vm.state !== 'shut off') definitions.push(await this.run(this.uri, ['dumpxml', vm.uuid, '--inactive']));
      for (const definition of definitions) {
        if (vm.uuid === uuid && [...definition.matchAll(/<target\b[^>]*\bdev=['"]([^'"]+)['"]/g)].some(m => m[1] === input.target)) throw new HttpError(409, 'That guest disk target is already in use');
        for (const source of definition.matchAll(/<(?:source|backingStore)\b[^>]*>/g)) {
          const attr = (key: string) => source[0].match(new RegExp(`\\b${key}=['"]([^'"]*)['"]`))?.[1];
          if (attr('file') === diskPath || (attr('pool') === xmlEscape(pool) && attr('volume') === xmlEscape(volume))) throw new HttpError(409, `Disk is already referenced by ${vm.name}; shared writable disk attachment is refused`);
        }
      }
    }
    // Volume references avoid interpreting paths from form input.
    await this.withXml(`<disk type='volume' device='disk'><driver name='qemu' type='${format}'/><source pool='${xmlEscape(pool)}' volume='${xmlEscape(volume)}'/><target dev='${input.target}' bus='virtio'/></disk>`, file => this.run(this.uri, ['attach-device', uuid, file, '--config']));
  }
  async createNetwork(input: { name?: unknown; mode?: unknown; bridge?: unknown; address?: unknown; prefix?: unknown; dhcpStart?: unknown; dhcpEnd?: unknown }) {
    const name = resourceName(input?.name);
    if (!['nat', 'isolated', 'bridge'].includes(String(input.mode))) throw new HttpError(400, 'Use nat, isolated or bridge mode');
    let body: string;
    if (input.mode === 'bridge') {
      const bridge = resourceName(input.bridge);
      if (bridge.length > 15) throw new HttpError(400, 'Bridge interface names are at most 15 characters');
      body = `<forward mode='bridge'/><bridge name='${bridge}'/>`;
    } else {
      const ipv4 = (v: unknown) => typeof v === 'string' && /^(\d{1,3}\.){3}\d{1,3}$/.test(v) && v.split('.').every(n => Number(n) <= 255);
      if (!ipv4(input.address) || !Number.isInteger(input.prefix) || Number(input.prefix) < 8 || Number(input.prefix) > 30 || !ipv4(input.dhcpStart) || !ipv4(input.dhcpEnd)) throw new HttpError(400, 'Provide valid IPv4 gateway, prefix (8-30), and DHCP start/end');
      const number = (v: unknown) => String(v).split('.').reduce((sum, n) => sum * 256 + Number(n), 0);
      const size = 2 ** (32 - Number(input.prefix)), base = Math.floor(number(input.address) / size) * size;
      const start = number(input.dhcpStart), end = number(input.dhcpEnd), gateway = number(input.address);
      if (start <= base || end >= base + size - 1 || start > end || (gateway >= start && gateway <= end) || gateway <= base || gateway >= base + size - 1) throw new HttpError(400, 'DHCP range must be inside the subnet and exclude the gateway/network/broadcast');
      body = `${input.mode === 'nat' ? "<forward mode='nat'/>" : ''}<ip address='${input.address}' prefix='${input.prefix}'><dhcp><range start='${input.dhcpStart}' end='${input.dhcpEnd}'/></dhcp></ip>`;
    }
    if ((await this.run(this.uri, ['net-list', '--all', '--name'])).split(/\r?\n/).includes(name)) throw new HttpError(409, 'Network already exists');
    await this.withXml(`<network><name>${name}</name>${body}</network>`, file => this.run(this.uri, ['net-define', file, '--validate']));
  }
  async attachNetwork(uuid: string, network: unknown, options: { model?: unknown; mac?: unknown; link?: unknown } = {}) {
    validateVmUuid(uuid); const name = resourceName(network);
    const vm = await this.info(uuid);
    if (vm.state !== 'shut off' || !vm.persistent) throw new HttpError(409, 'Shut down a persistent VM before attaching a network');
    await this.run(this.uri, ['net-info', name]);
    const xml = interfaceXml({ ...options, network: name });
    await this.withXml(xml, file => this.run(this.uri, ['attach-device', uuid, file, '--config']));
  }
  async networkAction(name: string, action: string, enabled?: boolean) {
    resourceName(name);
    if (!['start', 'stop', 'autostart', 'undefine'].includes(action)) throw new HttpError(400, 'Unknown network action');
    if (action === 'autostart' && typeof enabled !== 'boolean') throw new HttpError(400, 'enabled is required');
    await this.run(this.uri, [`net-${action === 'stop' ? 'destroy' : action}`, name, ...(action === 'autostart' && !enabled ? ['--disable'] : [])]);
  }
  async migrationArgs(uuid: string, input: { destination?: unknown; live?: unknown; copyStorage?: unknown; undefineSource?: unknown }) {
    validateVmUuid(uuid);
    const destination = validateLibvirtSettings({ enabled: true, uri: input?.destination }).uri;
    if (!destination.startsWith('qemu+ssh://') || destination === this.uri) throw new HttpError(400, 'Use a different qemu+ssh destination');
    if (typeof input.live !== 'boolean' || typeof input.copyStorage !== 'boolean' || typeof input.undefineSource !== 'boolean') throw new HttpError(400, 'Provide live, copyStorage and undefineSource booleans');
    const vm = await this.info(uuid);
    if (!vm.persistent || (input.live ? vm.state !== 'running' : vm.state !== 'shut off')) throw new HttpError(409, 'Live migration needs a running persistent VM; offline migration needs a stopped persistent VM');
    if (!input.live && input.copyStorage) throw new HttpError(400, 'Offline migration transfers definitions only; shared or pre-copied storage is required');
    // Managed migration uses client connections at both ends, retaining SSH host verification.
    return ['migrate', uuid, destination, '--persistent', ...(input.live ? ['--live', '--timeout', '3600', '--timeout-suspend'] : ['--offline']), ...(input.copyStorage ? ['--copy-storage-all'] : []), ...(input.undefineSource ? ['--undefinesource'] : [])];
  }
  async migrate(uuid: string, input: Parameters<LibvirtClient['migrationArgs']>[1]) { await this.run(this.uri, await this.migrationArgs(uuid, input)); }
  async abortMigration(uuid: string) { await this.run(this.uri, ['domjobabort', validateVmUuid(uuid)]); }
  async display(uuid: string, protocol: 'vnc' | 'spice') {
    validateVmUuid(uuid);
    if (protocol === 'vnc') {
      const display = await this.run(this.uri, ['vncdisplay', uuid]);
      const match = display.match(/^(?:127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0|\[::\])?:(\d+)$/);
      if (!match || Number(match[1]) > 59635) throw new HttpError(422, 'VNC console requires a TCP display on the hypervisor loopback/wildcard address');
      return { host: display.startsWith('[::1]') ? '::1' : '127.0.0.1', port: 5900 + Number(match[1]) };
    }
    const display = new URL(await this.run(this.uri, ['domdisplay', uuid, '--type', 'spice']));
    if (display.protocol !== 'spice:' || !['localhost', '127.0.0.1', '[::1]', '0.0.0.0', '[::]'].includes(display.hostname) || !display.port || display.search || display.username || display.password) throw new HttpError(422, 'SPICE console requires a plain TCP display on the hypervisor loopback/wildcard address');
    return { host: display.hostname === '[::1]' ? '::1' : '127.0.0.1', port: Number(display.port) };
  }
  private async withXml<T>(xml: string, use: (file: string) => Promise<T>) {
    return this.withTemp(async dir => { const file = path.join(dir, 'resource.xml'); await fs.writeFile(file, xml, { mode: 0o600 }); return use(file); });
  }
  async list(): Promise<VirtualMachine[]> {
    const ids = (await this.run(this.uri, ['list', '--all', '--uuid'])).split(/\s+/).filter(Boolean);
    const machines: VirtualMachine[] = [];
    // Bound concurrent virsh/SSH processes on larger hosts. A disappearing domain is omitted.
    for (let index = 0; index < ids.length; index += 4) {
      const batch = await Promise.all(ids.slice(index, index + 4).map(async (id) => {
        try { return await this.info(id); } catch (error) {
          if (error instanceof Error && /domain not found|failed to get domain/i.test(error.message)) return null;
          throw error;
        }
      }));
      for (const vm of batch) if (vm) machines.push(vm);
    }
    return machines.sort((a, b) => a.name.localeCompare(b.name));
  }
  async info(uuid: string) { return parseDomainInfo(await this.run(this.uri, ['dominfo', validateVmUuid(uuid)])); }
  async xml(uuid: string) {
    const vm = await this.info(uuid);
    return this.run(this.uri, ['dumpxml', uuid, ...(vm.persistent ? ['--inactive'] : [])]);
  }
  async action(uuid: string, action: VmAction) {
    validateVmUuid(uuid);
    if (!VM_ACTIONS.includes(action)) throw new HttpError(400, 'Unknown VM action');
    await this.run(this.uri, [action, uuid]);
  }
  async removeEntry(uuid: string, input: { confirmName?: unknown; removeSnapshotMetadata?: unknown }) {
    const vm = await this.info(validateVmUuid(uuid));
    if (!vm.persistent || vm.state !== 'shut off') throw new HttpError(409, 'Shut down a persistent VM before deleting its entry');
    if (input?.confirmName !== vm.name || typeof input.removeSnapshotMetadata !== 'boolean') throw new HttpError(400, 'Type the VM name and specify whether to remove snapshot metadata');
    // Definition only. Never pass storage deletion, NVRAM deletion or managed-save removal flags.
    await this.run(this.uri, ['undefine', uuid, '--keep-nvram', '--keep-tpm', ...(input.removeSnapshotMetadata ? ['--snapshots-metadata'] : [])]);
  }
  async makePersistent(uuid: string) {
    const vm = await this.info(uuid);
    if (vm.persistent) return;
    // Defining the running domain's own XML preserves identity and devices without restarting it.
    const xml = await this.run(this.uri, ['dumpxml', validateVmUuid(uuid)]);
    if (xml.match(/<uuid>\s*([^<]+?)\s*<\/uuid>/)?.[1]?.toLowerCase() !== uuid.toLowerCase()) throw new HttpError(409, 'The domain identity changed. Refresh before keeping its definition.');
    await this.withTemp(async (dir) => {
      const file = path.join(dir, 'domain.xml');
      await fs.writeFile(file, xml, { mode: 0o600 });
      await this.run(this.uri, ['define', file, '--validate']);
    });
  }
  async configure(uuid: string, input: unknown) {
    validateVmUuid(uuid);
    const value = input as { memoryMb?: number; cpus?: number; autostart?: boolean } | null;
    if (!value || !Number.isInteger(value.memoryMb) || value.memoryMb! < 128 || value.memoryMb! > 16_777_216 || !Number.isInteger(value.cpus) || value.cpus! < 1 || value.cpus! > 4096 || typeof value.autostart !== 'boolean') {
      throw new HttpError(400, 'Provide memoryMb (128–16777216), cpus (1–4096) and autostart');
    }
    const vm = await this.info(uuid);
    if (!vm.persistent) throw new HttpError(409, 'Make this VM persistent before editing its next-boot configuration');
    if (vm.state !== 'shut off') throw new HttpError(409, 'Shut down the VM before changing its CPU and memory configuration');
    if (value.memoryMb! > vm.maxMemoryMb) throw new HttpError(400, `Memory exceeds the configured maximum (${vm.maxMemoryMb} MB). Increase the maximum in XML first.`);
    // Validate CPU ceiling before changing anything.
    const maxCpus = Number(await this.run(this.uri, ['vcpucount', uuid, '--maximum', '--config']));
    if (value.cpus! > maxCpus) throw new HttpError(400, `CPU count exceeds the configured maximum (${maxCpus}). Increase the maximum in XML first.`);
    try {
      await this.run(this.uri, ['setmem', uuid, `${value.memoryMb}MiB`, '--config']);
      await this.run(this.uri, ['setvcpus', uuid, String(value.cpus), '--config']);
      await this.run(this.uri, ['autostart', uuid, ...(value.autostart ? [] : ['--disable'])]);
    } catch (error) {
      throw new HttpError(503, `${error instanceof Error ? error.message : 'Configuration failed'}. Some settings may already have applied; reload the VM before retrying.`);
    }
  }
  async define(xml: string, expectedUuid?: string) {
    if (typeof xml !== 'string' || Buffer.byteLength(xml) > 1024 * 1024 || !/<domain[\s>]/.test(xml) || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new HttpError(400, 'Provide domain XML up to 1 MB without DTDs or entities');
    if (expectedUuid) {
      validateVmUuid(expectedUuid);
      const uuid = xml.match(/<uuid>\s*([^<]+?)\s*<\/uuid>/)?.[1];
      if (uuid?.toLowerCase() !== expectedUuid.toLowerCase()) throw new HttpError(400, 'Keep the VM UUID unchanged when editing XML');
      const vm = await this.info(expectedUuid);
      if (vm.state !== 'shut off') throw new HttpError(409, 'Shut down the VM before editing its XML');
    } else {
      // Import is deliberately create-only, so it cannot silently redefine another VM.
      const name = xml.match(/<name>\s*([^<]+?)\s*<\/name>/)?.[1];
      const uuid = xml.match(/<uuid>\s*([^<]+?)\s*<\/uuid>/)?.[1];
      if (!name || /[&<>]/.test(name)) throw new HttpError(400, 'Domain XML needs a plain-text name');
      const existing = await this.list();
      if (existing.some((vm) => vm.name === name || (uuid && vm.uuid.toLowerCase() === uuid.toLowerCase()))) throw new HttpError(409, 'This VM already exists. Select it and use the XML editor instead.');
    }
    await this.withTemp(async (dir) => {
      const file = path.join(dir, 'domain.xml');
      await fs.writeFile(file, xml, { mode: 0o600 });
      await this.run(this.uri, ['define', file, '--validate']);
    });
  }
  async screenshot(uuid: string) {
    validateVmUuid(uuid);
    return this.withTemp(async (dir) => {
      const file = path.join(dir, 'screen');
      await this.run(this.uri, ['screenshot', uuid, file, '--screen', '0']);
      const stat = await fs.stat(file);
      if (stat.size > 64 * 1024 * 1024) throw new HttpError(422, 'Screenshot exceeds 64 MB');
      return screenshotToPng(await fs.readFile(file));
    });
  }
  private async withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const base = path.join(DATA_DIR, 'libvirt-tmp');
    await fs.mkdir(base, { recursive: true, mode: 0o700 });
    const dir = await fs.mkdtemp(path.join(base, 'request-'));
    try { return await fn(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
  }
}

export function libvirtClient() {
  const settings = libvirtSettings();
  if (!settings.enabled) throw new HttpError(409, 'Enable libvirt in its Configuration page first');
  return new LibvirtClient(validateLibvirtSettings(settings).uri);
}
