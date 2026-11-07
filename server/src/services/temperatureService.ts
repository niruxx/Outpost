import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Host temperature sensors, read from Linux sysfs (`/sys/class/hwmon`, with `/sys/class/thermal`
 * zones as a fallback for sensors that have no hwmon twin). Other platforms report
 * `supported: false`.
 *
 * SATA/SAS drive temperatures (kernel `drivetemp`) are only re-read after the disk has done block
 * I/O since the previous reading, so dashboard polling never keeps an idle disk from spinning down.
 */
export type SensorCategory = 'cpu' | 'memory' | 'chipset' | 'drive' | 'gpu' | 'motherboard' | 'other';

export interface TemperatureSensor {
  id: string;
  /** Driver / chip name, e.g. `coretemp`, `nvme`, `jc42`. */
  chip: string;
  /** Which physical part the chip represents: a drive name + model, DIMM slot, CPU socket… */
  device: string;
  label: string;
  category: SensorCategory;
  celsius: number;
  high: number | null;
  critical: number | null;
  /** When the value was last read, if older than this sample (spun-down drives). */
  readAt?: string;
}

export interface HostTemperatures {
  supported: boolean;
  sampledAt: string;
  sensors: TemperatureSensor[];
}

/** Overridable for tests against a fake sysfs tree. */
const SYSFS = process.env.OUTPOST_SYSFS_ROOT ?? '/sys';
const HWMON = path.join(SYSFS, 'class/hwmon');
const THERMAL = path.join(SYSFS, 'class/thermal');
const CACHE_MS = 3000;

async function readText(file: string): Promise<string | null> {
  try {
    return (await fs.readFile(file, 'utf8')).trim();
  } catch {
    return null;
  }
}

/** sysfs millidegrees → °C (one decimal), rejecting the bogus values some chips report. */
async function readMilli(file: string): Promise<number | null> {
  const raw = await readText(file);
  if (raw === null || raw === '') return null;
  const v = Number(raw);
  if (!Number.isFinite(v)) return null;
  const c = Math.round(v / 100) / 10;
  return c > -60 && c < 250 ? c : null;
}

function categorize(chip: string, label: string): SensorCategory {
  const c = chip.toLowerCase();
  const l = label.toLowerCase();
  if (c === 'nvme' || c === 'drivetemp') return 'drive';
  if (c === 'jc42' || c === 'spd5118') return 'memory';
  if (/^pch(_|$)/.test(c) || /pch|chipset|southbridge|\bsb\b|fch/.test(l)) return 'chipset';
  if (/^(coretemp|k8temp|k10temp|zenpower|via_cputemp|x86_pkg_temp|fam15h_power)$/.test(c) || /cpu|soc[_-]?thermal|^tcpu$/.test(c)) return 'cpu';
  if (/^(amdgpu|radeon|nouveau|i915|xe)$/.test(c) || /gpu/.test(c)) return 'gpu';
  if (/^(nct|it8|w83|f71|asus|gigabyte|dell_smm|thinkpad|acpitz|hp_wmi|lenovo)/.test(c)) return 'motherboard';
  return 'other';
}

/** Human name for the part a hwmon chip belongs to. */
async function deviceName(chip: string, hwmonDir: string, instance: number): Promise<string> {
  const dev = path.join(hwmonDir, 'device');
  let real: string | null = null;
  try {
    real = await fs.realpath(dev);
  } catch {
    // virtual chip without a parent device
  }
  if (chip === 'nvme' && real) {
    let ctrl = real;
    let model = await readText(path.join(ctrl, 'model'));
    if (model === null) {
      // Older kernels hang the hwmon off the PCI function rather than the nvme controller.
      const sub = await fs.readdir(path.join(real, 'nvme')).catch(() => [] as string[]);
      if (sub[0]) {
        ctrl = path.join(real, 'nvme', sub[0]);
        model = await readText(path.join(ctrl, 'model'));
      }
    }
    const name = path.basename(ctrl).startsWith('nvme') ? path.basename(ctrl) : `nvme #${instance}`;
    return model ? `${name} · ${model}` : name;
  }
  if (chip === 'drivetemp' && real) {
    const block = (await fs.readdir(path.join(real, 'block')).catch(() => [] as string[]))[0];
    const vendor = (await readText(path.join(real, 'vendor'))) ?? '';
    const model = (await readText(path.join(real, 'model'))) ?? '';
    const ident = [vendor === 'ATA' ? '' : vendor, model].filter(Boolean).join(' ');
    return [block ?? `disk #${instance}`, ident].filter(Boolean).join(' · ');
  }
  if ((chip === 'jc42' || chip === 'spd5118') && real) {
    // i2c client dirs are named `<bus>-<addr>`; SPD hubs sit at 0x18–0x1f (jc42) / 0x50–0x57 (DDR5).
    const m = path.basename(real).match(/^(\d+)-([0-9a-f]{4})$/i);
    if (m) {
      const addr = parseInt(m[2], 16);
      const slot = chip === 'jc42' ? addr - 0x18 : addr - 0x50;
      return slot >= 0 && slot < 8 ? `DIMM ${slot} (bus ${m[1]})` : `DIMM @ 0x${addr.toString(16)} (bus ${m[1]})`;
    }
  }
  if (chip === 'coretemp' && real) {
    const m = path.basename(real).match(/coretemp\.(\d+)/);
    if (m) return `CPU socket ${m[1]}`;
  }
  return instance > 0 ? `${chip} #${instance + 1}` : chip;
}

/** drivetemp: disk block name → last /sys/block/<dev>/stat seen and the reading taken then. */
const driveCache = new Map<string, { stat: string; at: string; values: Map<string, number> }>();

async function readHwmon(): Promise<{ sensors: TemperatureSensor[]; chips: Set<string> } | null> {
  let entries: string[];
  try {
    entries = (await fs.readdir(HWMON)).sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')));
  } catch {
    return null;
  }
  const sensors: TemperatureSensor[] = [];
  const chips = new Set<string>();
  const instances = new Map<string, number>();
  for (const entry of entries) {
    const dir = path.join(HWMON, entry);
    const chip = (await readText(path.join(dir, 'name'))) ?? entry;
    const files = await fs.readdir(dir).catch(() => [] as string[]);
    const inputs = files
      .map((f) => f.match(/^temp(\d+)_input$/)?.[1])
      .filter((n): n is string => !!n)
      .sort((a, b) => Number(a) - Number(b));
    if (!inputs.length) continue;
    chips.add(chip);
    const instance = instances.get(chip) ?? 0;
    instances.set(chip, instance + 1);
    const device = await deviceName(chip, dir, instance);

    // Spin-down guard for SATA/SAS drives.
    let cached: { stat: string; at: string; values: Map<string, number> } | undefined;
    let reuse = false;
    let statNow: string | null = null;
    if (chip === 'drivetemp') {
      const real = await fs.realpath(path.join(dir, 'device')).catch(() => null);
      const block = real ? (await fs.readdir(path.join(real, 'block')).catch(() => [] as string[]))[0] : undefined;
      if (block) {
        statNow = await readText(path.join(SYSFS, 'block', block, 'stat'));
        cached = driveCache.get(dir);
        reuse = !!cached && statNow !== null && cached.stat === statNow;
      }
    }
    const fresh = new Map<string, number>();

    for (const n of inputs) {
      const base = path.join(dir, `temp${n}`);
      const label = (await readText(`${base}_label`)) || (inputs.length === 1 ? 'Temperature' : `temp${n}`);
      let celsius: number | null;
      if (reuse && cached?.values.has(n)) celsius = cached.values.get(n)!;
      else celsius = await readMilli(`${base}_input`);
      if (celsius === null) continue;
      fresh.set(n, celsius);
      const high = (await readMilli(`${base}_max`)) ?? (await readMilli(`${base}_high`));
      const critical = (await readMilli(`${base}_crit`)) ?? (await readMilli(`${base}_emergency`));
      sensors.push({
        id: `${entry}/temp${n}`,
        chip,
        device,
        label,
        category: categorize(chip, label),
        celsius,
        high: high !== null && high > 0 ? high : null,
        critical: critical !== null && critical > 0 ? critical : null,
        ...(reuse && cached ? { readAt: cached.at } : {}),
      });
    }
    if (chip === 'drivetemp' && statNow !== null && !reuse && fresh.size) {
      driveCache.set(dir, { stat: statNow, at: new Date().toISOString(), values: fresh });
    }
  }
  return { sensors, chips };
}

/** Thermal zones whose type has no matching hwmon chip (avoids listing the same sensor twice). */
async function readThermalZones(skip: Set<string>): Promise<TemperatureSensor[]> {
  let zones: string[];
  try {
    zones = (await fs.readdir(THERMAL)).filter((z) => z.startsWith('thermal_zone'));
  } catch {
    return [];
  }
  const out: TemperatureSensor[] = [];
  for (const zone of zones.sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')))) {
    const dir = path.join(THERMAL, zone);
    const type = (await readText(path.join(dir, 'type'))) ?? zone;
    if (skip.has(type) || skip.has(type.replace(/-/g, '_'))) continue;
    if (type === 'x86_pkg_temp' && skip.has('coretemp')) continue; // coretemp already reports the package
    const celsius = await readMilli(path.join(dir, 'temp'));
    if (celsius === null) continue;
    let high: number | null = null;
    let critical: number | null = null;
    const files = await fs.readdir(dir).catch(() => [] as string[]);
    for (const f of files) {
      const m = f.match(/^trip_point_(\d+)_type$/);
      if (!m) continue;
      const kind = await readText(path.join(dir, f));
      const temp = await readMilli(path.join(dir, `trip_point_${m[1]}_temp`));
      if (temp === null || temp <= 0) continue;
      if (kind === 'critical') critical = critical === null ? temp : Math.min(critical, temp);
      else if (kind === 'hot' || kind === 'passive') high = high === null ? temp : Math.min(high, temp);
    }
    out.push({ id: zone, chip: type, device: `Thermal zone ${zone.replace('thermal_zone', '')}`, label: type, category: categorize(type, type), celsius, high, critical });
  }
  return out;
}

let cache: HostTemperatures | null = null;
let cacheAt = 0;
let inflight: Promise<HostTemperatures> | null = null;

async function sample(): Promise<HostTemperatures> {
  const sampledAt = new Date().toISOString();
  if (process.platform !== 'linux' && !process.env.OUTPOST_SYSFS_ROOT) return { supported: false, sampledAt, sensors: [] };
  const hw = await readHwmon();
  const zones = await readThermalZones(hw?.chips ?? new Set());
  const sensors = [...(hw?.sensors ?? []), ...zones];
  return { supported: hw !== null || zones.length > 0, sampledAt, sensors };
}

export async function getTemperatures(): Promise<HostTemperatures> {
  if (cache && Date.now() - cacheAt < CACHE_MS) return cache;
  inflight ??= sample()
    .then((r) => {
      cache = r;
      cacheAt = Date.now();
      return r;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
