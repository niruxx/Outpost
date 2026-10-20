import { spawnSync } from 'node:child_process';
import { prep } from '../db/db.js';
import { HttpError } from '../utils/asyncHandler.js';
import { logger } from '../utils/logger.js';
import { getDiskUsage } from './diskUsageService.js';
import { getServer, listServers } from './serverService.js';
import type { ServerRecord } from '../types/index.js';

/**
 * Resource limits per instance (admins set them):
 *
 *  - CPU (percent of one core: 150 = one and a half cores), memory (hard cap, MB) and process count
 *    are enforced by the kernel on Linux: the instance runs inside a systemd scope
 *    (`systemd-run --scope -p CPUQuota=… -p MemoryMax=… -p TasksMax=…`), outside the sandbox.
 *    Container instances get the same values as docker/podman --cpus/--memory/--pids-limit.
 *  - Disk (MB of the instance folder) is checked every few minutes: going over warns in the
 *    console and by webhook, blocks starts and uploads, and can stop the server.
 */

export interface Limits {
  cpuPercent: number | null;
  memoryMb: number | null;
  tasks: number | null;
  diskMb: number | null;
  diskAction: 'warn' | 'stop';
}

export const NO_LIMITS: Limits = { cpuPercent: null, memoryMb: null, tasks: null, diskMb: null, diskAction: 'warn' };

export function limitsOf(server: Pick<ServerRecord, 'limits'>): Limits {
  if (!server.limits) return { ...NO_LIMITS };
  try {
    const raw = JSON.parse(server.limits) as Partial<Limits>;
    const num = (v: unknown) => (typeof v === 'number' && v > 0 ? v : null);
    return { cpuPercent: num(raw.cpuPercent), memoryMb: num(raw.memoryMb), tasks: num(raw.tasks), diskMb: num(raw.diskMb), diskAction: raw.diskAction === 'stop' ? 'stop' : 'warn' };
  } catch {
    return { ...NO_LIMITS };
  }
}

export function saveLimits(server: ServerRecord, input: Record<string, unknown>): Limits {
  const prev = limitsOf(server);
  const read = (key: keyof Limits, min: number, max: number, label: string): number | null => {
    if (!(key in input)) return prev[key] as number | null;
    const v = input[key];
    if (v === null || v === '' || v === 0) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${label} must be between ${min} and ${max}`);
    return Math.round(n);
  };
  const next: Limits = {
    cpuPercent: read('cpuPercent', 10, 25600, 'CPU limit (%)'),
    memoryMb: read('memoryMb', 128, 1024 * 1024, 'Memory limit (MB)'),
    tasks: read('tasks', 16, 1_000_000, 'Process limit'),
    diskMb: read('diskMb', 100, 100 * 1024 * 1024, 'Disk limit (MB)'),
    diskAction: input.diskAction === undefined ? prev.diskAction : input.diskAction === 'stop' ? 'stop' : 'warn',
  };
  if (next.memoryMb && server.platform === 'java' && next.memoryMb < server.max_memory_mb * 1.1) {
    throw new HttpError(400, `The memory limit must leave room above Java’s ${server.max_memory_mb} MB heap — use at least ${Math.ceil(server.max_memory_mb * 1.25)} MB`);
  }
  const empty = !next.cpuPercent && !next.memoryMb && !next.tasks && !next.diskMb;
  prep('UPDATE servers SET limits = ? WHERE id = ?').run(empty ? null : JSON.stringify(next), server.id);
  overDisk.delete(server.id);
  return next;
}

// ---------------------------------------------------------------------------
// CPU / memory / processes: systemd scopes
// ---------------------------------------------------------------------------

export interface LimitSupport {
  available: boolean;
  method: 'systemd' | 'container' | 'none';
  reason: string | null;
}

let probed: LimitSupport | null = null;
const isRoot = () => process.getuid?.() === 0;

/** Whether this host can enforce CPU/memory/process limits on processes. Probed once. */
export function hostLimitSupport(): LimitSupport {
  if (probed) return probed;
  if (process.platform !== 'linux') {
    probed = { available: false, method: 'none', reason: 'CPU, memory and process limits need Linux (systemd + cgroups v2). Container instances use the container engine’s own limits.' };
    return probed;
  }
  const trial = spawnSync('systemd-run', [...(isRoot() ? [] : ['--user']), '--scope', '--quiet', '--collect', '-p', 'MemoryMax=64M', '-p', 'CPUQuota=50%', 'true'], { encoding: 'utf8', timeout: 10_000 });
  if (trial.error || trial.status !== 0) {
    const why = trial.error ? 'systemd-run isn’t available' : (trial.stderr || '').trim().split('\n')[0];
    probed = {
      available: false,
      method: 'none',
      reason: `Can’t create systemd scopes (${why}). Run Outpost as a systemd service with lingering on (install.sh does this), or as root.`,
    };
  } else {
    probed = { available: true, method: 'systemd', reason: null };
  }
  return probed;
}

export function limitSupportFor(server: ServerRecord): LimitSupport {
  if (server.platform === 'docker') return { available: true, method: 'container', reason: null };
  return hostLimitSupport();
}

/** Wraps a launch in a systemd scope carrying the instance's limits. Returns notes for the console. */
export function wrapWithLimits(server: ServerRecord, target: { cmd: string; args: string[] }): { cmd: string; args: string[]; notes: string[] } {
  if (server.platform === 'docker') return { ...target, notes: [] };
  const l = limitsOf(server);
  if (!l.cpuPercent && !l.memoryMb && !l.tasks) return { ...target, notes: [] };
  const support = hostLimitSupport();
  if (!support.available) return { ...target, notes: [`Resource limits are set but not enforced on this host: ${support.reason}`] };
  const described = [l.cpuPercent && `CPU ${l.cpuPercent}%`, l.memoryMb && `memory ${l.memoryMb} MB`, l.tasks && `${l.tasks} processes`].filter(Boolean).join(', ');
  return {
    cmd: 'systemd-run',
    args: scopeArgs(l, { root: isRoot(), unit: `outpost-${server.id.slice(0, 8)}-${Date.now().toString(36)}` }, target),
    notes: [`Resource limits: ${described} (if it uses more memory than that, the system stops it)`],
  };
}

/** The systemd-run arguments for a set of limits (pure — unit-tested). */
export function scopeArgs(l: Limits, opts: { root: boolean; unit: string }, target: { cmd: string; args: string[] }): string[] {
  const props: string[] = [];
  if (l.cpuPercent) props.push('-p', `CPUQuota=${l.cpuPercent}%`);
  if (l.memoryMb) props.push('-p', `MemoryMax=${l.memoryMb}M`, '-p', 'MemorySwapMax=0');
  if (l.tasks) props.push('-p', `TasksMax=${l.tasks}`);
  return [...(opts.root ? [] : ['--user']), '--scope', '--quiet', '--collect', `--unit=${opts.unit}`, ...props, '--', target.cmd, ...target.args];
}

/** Container instances: the limits as docker/podman flags (replacing the defaults). */
export function containerLimitArgs(server: ServerRecord): { memoryMb: number | null; cpus: number | null; pids: number | null } {
  const l = limitsOf(server);
  return { memoryMb: l.memoryMb, cpus: l.cpuPercent ? l.cpuPercent / 100 : null, pids: l.tasks };
}

// ---------------------------------------------------------------------------
// Disk quota
// ---------------------------------------------------------------------------

/** Instances currently over their disk limit (MB used). */
const overDisk = new Map<string, number>();

export function diskStatus(server: ServerRecord): { usedMb: number; limitMb: number | null; over: boolean } {
  const used = Math.round(getDiskUsage(server.id).serverBytes / 1048576);
  const limit = limitsOf(server).diskMb;
  return { usedMb: used, limitMb: limit, over: !!limit && used > limit };
}

/** Throws when the instance is over its disk limit (before starting it, or accepting uploads). */
export function assertDiskRoom(serverId: string, what: 'start' | 'write') {
  const server = getServer(serverId);
  if (!server) return;
  const limit = limitsOf(server).diskMb;
  if (!limit) return;
  const { usedMb } = diskStatus(server);
  if (usedMb > limit) {
    throw new HttpError(507, `This instance uses ${usedMb} MB, over its ${limit} MB disk limit — delete some files${what === 'start' ? ' before starting it' : ' first'}, or ask an admin to raise the limit`);
  }
}

export function initDiskQuotas(hooks: { log: (serverId: string, line: string) => void; stop: (serverId: string) => void; isRunning: (serverId: string) => boolean; notify: (server: ServerRecord, message: string) => void }) {
  const check = () => {
    for (const server of listServers()) {
      const limit = limitsOf(server).diskMb;
      if (!limit) continue;
      try {
        const { usedMb, over } = diskStatus(server);
        if (over && !overDisk.has(server.id)) {
          overDisk.set(server.id, usedMb);
          const action = limitsOf(server).diskAction;
          hooks.log(server.id, `[Outpost] Disk limit reached: ${usedMb} MB used of ${limit} MB. Uploads are blocked${action === 'stop' ? ' and the server is being stopped' : ''} until space is freed.`);
          hooks.notify(server, `${server.name} is over its disk limit (${usedMb} / ${limit} MB)`);
          if (action === 'stop' && hooks.isRunning(server.id)) hooks.stop(server.id);
        } else if (!over && overDisk.has(server.id)) {
          overDisk.delete(server.id);
          hooks.log(server.id, `[Outpost] Back under the disk limit (${usedMb} / ${limit} MB).`);
        }
      } catch (err) {
        logger.warn(`Disk check for ${server.id} failed`, err);
      }
    }
  };
  setTimeout(check, 20_000).unref();
  setInterval(check, 5 * 60_000).unref();
  return check;
}
