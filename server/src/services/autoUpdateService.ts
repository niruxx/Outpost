import cron, { type ScheduledTask as CronJob } from 'node-cron';
import { HttpError } from '../utils/asyncHandler.js';
import { logger } from '../utils/logger.js';
import { getServer, listServers, setAutoUpdate } from './serverService.js';
import { checkForUpdate, runUpdate, type UpdateCheckResult } from './updateService.js';
import { isRunning, sendCommand, startServer, stopServer } from './processManager.js';
import { createBackup } from './backupService.js';
import { appendLine } from './consoleLogService.js';
import { notify } from './notificationService.js';
import { findPresetFor } from './steamGames.js';
import type { ServerRecord } from '../types/index.js';

/**
 * Automatic game updates: on a schedule, check for a newer build; if there is one, warn players
 * in-game, stop, (optionally) snapshot, update, and start again if it was running.
 *
 * Which updates are safe to apply unattended:
 *  - Paper / Purpur: new builds of the same Minecraft version.
 *  - Bedrock: new server releases (worlds and settings are preserved).
 *  - Steam: new public builds (installed buildid vs Steam's).
 *  - Vanilla: only when "allow new Minecraft versions" is on — a version jump upgrades the world.
 * Spigot (always rebuilt), custom and Docker instances aren't auto-updated.
 */

export interface AutoUpdateConfig {
  enabled: boolean;
  /** cron expression for checks. */
  schedule: string;
  /** Minutes of in-game warning before stopping a running server (0 = none). */
  warnMinutes: number;
  /** Console command for the warning; {minutes} is replaced. Empty = no message. */
  warnCommand: string;
  /** Take a snapshot before updating. */
  backupFirst: boolean;
  /** Only tell (webhook + console), don't apply. */
  notifyOnly: boolean;
  /** Vanilla: follow new Minecraft releases. */
  allowVersionChange: boolean;
  lastCheckAt: string | null;
  lastResult: string | null;
}

export const SCHEDULES: { value: string; label: string }[] = [
  { value: '0 * * * *', label: 'Every hour' },
  { value: '0 */3 * * *', label: 'Every 3 hours' },
  { value: '0 */6 * * *', label: 'Every 6 hours' },
  { value: '0 */12 * * *', label: 'Every 12 hours' },
  { value: '0 4 * * *', label: 'Daily at 04:00' },
  { value: '0 4 * * 1', label: 'Weekly (Monday 04:00)' },
];

/** The usual broadcast command per game, for the default warning. */
function defaultWarnCommand(server: ServerRecord): string {
  if (server.platform === 'java') return 'say Server restarting for an update in {minutes} minute(s)';
  if (server.platform === 'bedrock') return 'say Server restarting for an update in {minutes} minute(s)';
  const id = findPresetFor(server)?.id ?? '';
  if (id === 'rust') return 'say "Server restarting for an update in {minutes} minute(s)"';
  if (['cs2', 'csgo', 'css', 'tf2', 'gmod', 'l4d2', 'hl2dm', 'dods', 'cs16', 'cscz', 'hldm', 'tfc'].includes(id)) return 'say Server restarting for an update in {minutes} minute(s)';
  if (id === 'ark') return 'broadcast Server restarting for an update in {minutes} minute(s)';
  if (id === 'palworld') return 'Broadcast Server_restarting_for_an_update_in_{minutes}_minute(s)';
  return '';
}

export function autoUpdateSupport(server: ServerRecord): { supported: boolean; reason: string | null } {
  if (server.platform === 'custom') return { supported: false, reason: 'Custom instances run your own files.' };
  if (server.platform === 'docker') return { supported: false, reason: 'Container instances update by pulling their image (Update tab).' };
  if (server.loader === 'spigot') return { supported: false, reason: 'Spigot has no build numbers to compare — rebuild it from the Update tab.' };
  if (server.modpack) return { supported: false, reason: 'Modpack instances stay pinned to their pack version.' };
  if (server.platform === 'steam' && !server.steam_app_id) return { supported: false, reason: 'No Steam App ID recorded.' };
  return { supported: true, reason: null };
}

export function autoUpdateOf(server: ServerRecord): AutoUpdateConfig {
  let raw: Partial<AutoUpdateConfig> = {};
  try {
    raw = server.auto_update ? (JSON.parse(server.auto_update) as Partial<AutoUpdateConfig>) : {};
  } catch {
    // defaults
  }
  return {
    enabled: raw.enabled === true,
    schedule: typeof raw.schedule === 'string' && cron.validate(raw.schedule) ? raw.schedule : '0 */6 * * *',
    warnMinutes: Number.isInteger(raw.warnMinutes) ? Math.min(60, Math.max(0, raw.warnMinutes!)) : 5,
    warnCommand: typeof raw.warnCommand === 'string' ? raw.warnCommand : defaultWarnCommand(server),
    backupFirst: raw.backupFirst !== false,
    notifyOnly: raw.notifyOnly === true,
    allowVersionChange: raw.allowVersionChange === true,
    lastCheckAt: typeof raw.lastCheckAt === 'string' ? raw.lastCheckAt : null,
    lastResult: typeof raw.lastResult === 'string' ? raw.lastResult : null,
  };
}

export function saveAutoUpdate(server: ServerRecord, input: Record<string, unknown>): AutoUpdateConfig {
  const current = autoUpdateOf(server);
  const next: AutoUpdateConfig = { ...current };
  if (input.enabled !== undefined) {
    if (input.enabled === true && !autoUpdateSupport(server).supported) throw new HttpError(400, autoUpdateSupport(server).reason ?? 'Not supported');
    next.enabled = input.enabled === true;
  }
  if (input.schedule !== undefined) {
    if (typeof input.schedule !== 'string' || !cron.validate(input.schedule)) throw new HttpError(400, 'Invalid schedule (cron expression)');
    next.schedule = input.schedule;
  }
  if (input.warnMinutes !== undefined) {
    const m = Number(input.warnMinutes);
    if (!Number.isInteger(m) || m < 0 || m > 60) throw new HttpError(400, 'Warning must be 0–60 minutes');
    next.warnMinutes = m;
  }
  if (input.warnCommand !== undefined) {
    if (typeof input.warnCommand !== 'string' || input.warnCommand.length > 300 || /[\r\n]/.test(input.warnCommand)) throw new HttpError(400, 'Warning command must be one line');
    next.warnCommand = input.warnCommand.trim();
  }
  for (const key of ['backupFirst', 'notifyOnly', 'allowVersionChange'] as const) {
    if (input[key] !== undefined) next[key] = input[key] === true;
  }
  persist(server.id, next);
  register(server.id);
  return next;
}

function persist(serverId: string, cfg: AutoUpdateConfig) {
  setAutoUpdate(serverId, JSON.stringify(cfg));
}

function record(serverId: string, result: string) {
  const server = getServer(serverId);
  if (!server) return;
  persist(serverId, { ...autoUpdateOf(server), lastCheckAt: new Date().toISOString(), lastResult: result });
}

const jobs = new Map<string, CronJob>();
const busy = new Set<string>();
export const autoUpdateBusy = (serverId: string) => busy.has(serverId);

function register(serverId: string) {
  jobs.get(serverId)?.stop();
  jobs.delete(serverId);
  const server = getServer(serverId);
  if (!server) return;
  const cfg = autoUpdateOf(server);
  if (!cfg.enabled || !autoUpdateSupport(server).supported) return;
  jobs.set(
    serverId,
    cron.schedule(cfg.schedule, () => {
      void runAutoUpdate(serverId, 'schedule').catch((err) => logger.error(`Auto-update for ${serverId} failed`, err));
    })
  );
}

export function forgetAutoUpdate(serverId: string) {
  jobs.get(serverId)?.stop();
  jobs.delete(serverId);
}

export function initAutoUpdates() {
  for (const s of listServers()) register(s.id);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Whether a check's result is one this instance should apply. */
function shouldApply(server: ServerRecord, cfg: AutoUpdateConfig, check: UpdateCheckResult): { apply: boolean; why: string } {
  if (!check.updateAvailable) return { apply: false, why: 'Up to date' };
  if (server.platform === 'steam' && !check.latestBuild) return { apply: false, why: 'Couldn’t compare Steam builds — check skipped' };
  if (server.loader === 'vanilla' && check.latestVersion !== server.version && !cfg.allowVersionChange) {
    return { apply: false, why: `Minecraft ${check.latestVersion} is out — not applied (new Minecraft versions are off)` };
  }
  return { apply: true, why: '' };
}

async function waitForStop(serverId: string, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (!isRunning(serverId)) return true;
    await sleep(1000);
  }
  return !isRunning(serverId);
}

/**
 * Checks once and, if there's an applicable update, applies it (warning, stop, snapshot, update, start).
 * `trigger` is for the log. Returns what happened.
 */
export async function runAutoUpdate(serverId: string, trigger: 'schedule' | 'manual', who = 'automatic updates'): Promise<string> {
  if (busy.has(serverId)) return 'Already checking or updating';
  const server = getServer(serverId);
  if (!server) return 'Server not found';
  const cfg = autoUpdateOf(server);
  const support = autoUpdateSupport(server);
  if (!support.supported) return support.reason ?? 'Not supported';
  if (server.status === 'installing' || server.status === 'updating' || server.status === 'transferring') return 'Busy — skipped';
  busy.add(serverId);
  const log = (line: string) => appendLine(serverId, `[Outpost] Auto-update: ${line}`, 'system');
  try {
    let check: UpdateCheckResult;
    try {
      check = await checkForUpdate(server);
    } catch (err) {
      const msg = `Check failed — ${err instanceof Error ? err.message : String(err)}`;
      record(serverId, msg);
      return msg;
    }
    const decision = shouldApply(server, cfg, check);
    const label = check.latestBuild ? `build ${check.latestBuild}` : check.latestVersion ?? 'a newer build';
    if (!decision.apply) {
      record(serverId, decision.why);
      if (trigger === 'manual' || check.updateAvailable) log(decision.why);
      return decision.why;
    }
    if (cfg.notifyOnly) {
      const msg = `Update available (${label}) — not applied (notify only)`;
      // Only ping once per new build.
      if (autoUpdateOf(server).lastResult !== msg) notify('update.available', { id: server.id, name: server.name }, `${label} is available.`);
      record(serverId, msg);
      log(msg);
      return msg;
    }

    const wasRunning = isRunning(serverId);
    log(`${label} is available (${trigger === 'schedule' ? 'scheduled check' : `run by ${who}`}).`);
    if (wasRunning) {
      if (cfg.warnMinutes > 0 && cfg.warnCommand) {
        const marks = [...new Set([cfg.warnMinutes, 5, 1].filter((m) => m <= cfg.warnMinutes))].sort((a, b) => b - a);
        for (let i = 0; i < marks.length; i++) {
          if (!isRunning(serverId)) break;
          try {
            sendCommand(serverId, cfg.warnCommand.replace(/\{minutes\}/g, String(marks[i])));
          } catch {
            // console unavailable — carry on
          }
          const next = marks[i + 1] ?? 0;
          await sleep((marks[i] - next) * 60_000);
        }
      }
      if (isRunning(serverId)) {
        log('stopping the server…');
        try {
          stopServer(serverId);
        } catch {
          // already stopping/stopped
        }
        if (!(await waitForStop(serverId, 5 * 60_000))) {
          const msg = 'The server didn’t stop — update skipped';
          record(serverId, msg);
          notify('update.failed', { id: server.id, name: server.name }, msg);
          log(msg);
          return msg;
        }
      }
    }

    if (cfg.backupFirst) {
      log('taking a snapshot first…');
      try {
        await createBackup(serverId, 'pre-update');
      } catch (err) {
        log(`snapshot failed (${err instanceof Error ? err.message : String(err)}) — updating anyway`);
      }
    }

    const target = server.loader === 'vanilla' && cfg.allowVersionChange ? check.latestVersion ?? undefined : undefined;
    try {
      await runUpdate(getServer(serverId) ?? server, target, who);
    } catch (err) {
      const msg = `Update failed — ${err instanceof Error ? err.message : String(err)}`;
      record(serverId, msg);
      notify('update.failed', { id: server.id, name: server.name }, msg);
      if (wasRunning) await startServer(serverId, { auto: true }).catch(() => {});
      return msg;
    }
    if (wasRunning) {
      log('starting the server again…');
      await startServer(serverId, { auto: true }).catch((err) => log(`couldn’t start: ${err instanceof Error ? err.message : String(err)}`));
    }
    const msg = `Updated to ${label}`;
    record(serverId, msg);
    notify('update.applied', { id: server.id, name: server.name }, msg);
    return msg;
  } finally {
    busy.delete(serverId);
  }
}
