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
    timeout: 20_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
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
