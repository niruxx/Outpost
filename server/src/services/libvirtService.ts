import { execFile } from 'node:child_process';
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
      const volumes = active ? (await this.run(this.uri, ['vol-list', '--pool', name, '--name'])).split(/\r?\n/).filter(Boolean) : [];
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
    if ((await this.run(this.uri, ['vol-list', '--pool', pool, '--name'])).split(/\r?\n/).includes(name)) throw new HttpError(409, 'Volume already exists');
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
  async attachNetwork(uuid: string, network: unknown) {
    validateVmUuid(uuid); const name = resourceName(network);
    const vm = await this.info(uuid);
    if (vm.state !== 'shut off' || !vm.persistent) throw new HttpError(409, 'Shut down a persistent VM before attaching a network');
    await this.run(this.uri, ['net-info', name]);
    await this.run(this.uri, ['attach-interface', uuid, '--type', 'network', '--source', name, '--model', 'virtio', '--config']);
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
