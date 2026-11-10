import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { HostTemperatures, TemperatureSensor } from './temperatureService.js';

const exec = promisify(execFile);
type Run = (file: string, args: string[]) => Promise<string>;
const run: Run = async (file, args) => (await exec(file, args, { timeout: 2500, maxBuffer: 8192, env: process.env })).stdout;

export function parseMacTemperature(output: string): number | null {
  // Reject missing sensors (often reported as zero), diagnostics and malformed output.
  if (!/^\s*\d+(?:\.\d+)?\s*$/.test(output)) return null;
  const value = Number(output);
  return Number.isFinite(value) && value > 0 && value < 150 ? Math.round(value * 10) / 10 : null;
}

async function findHelper(): Promise<string | null> {
  const override = process.env.OUTPOST_SMCTEMP_PATH;
  const candidates = override ? [override] : [
    path.join(os.homedir(), '.local/bin/smctemp'), '/usr/local/bin/smctemp', '/opt/homebrew/bin/smctemp',
    ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, 'smctemp')),
  ];
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    try { await fs.access(candidate, constants.X_OK); return candidate; } catch { /* Try next installed location. */ }
  }
  return null;
}

export async function readMacTemperatures(execute: Run = run, locate: () => Promise<string | null> = findHelper): Promise<HostTemperatures> {
  const result: HostTemperatures = { supported: true, sampledAt: new Date().toISOString(), sensors: [], platform: 'macos' };
  const helper = await locate();
  if (!helper) {
    result.hint = 'Install the optional smctemp helper for macOS CPU/GPU temperatures. See README: macOS temperature sensors. Restart Outpost after installing it outside the standard locations.';
    return result;
  }
  const readings = await Promise.all((['cpu', 'gpu'] as const).map(async category => {
    try {
      const celsius = parseMacTemperature(await execute(helper, [category === 'cpu' ? '-c' : '-g', '-i25', '-n3']));
      if (celsius === null) return null;
      return { id: `macos-smc-${category}`, chip: 'Apple SMC', device: category.toUpperCase(), label: `${category.toUpperCase()} temperature`, category, celsius, high: null, critical: null } satisfies TemperatureSensor;
    } catch { return null; } // Unsupported sensors/timeouts must never break host metrics.
  }));
  result.sensors = readings.filter((sensor): sensor is NonNullable<typeof sensor> => sensor !== null);
  if (result.sensors.length < 2) result.hint = 'Some macOS CPU/GPU readings are unavailable. Sensor access varies by Mac and macOS version; test smctemp -c and smctemp -g as the Outpost login user. No elevated privileges or fan controls are used.';
  return result;
}
