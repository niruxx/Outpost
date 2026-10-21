import fs from 'node:fs';
import os from 'node:os';
import { assertDiskRoom, wrapWithLimits } from './limitsService.js';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { getServer, setServerStatus } from './serverService.js';
import { instanceDir } from '../utils/paths.js';
import { pickRuntime } from './javaRuntimeService.js';
import { activeRcon, rconLaunchArgs, rconSend } from './rconService.js';
import { proxyLaunchArgs } from './proxyService.js';
import { readProcessStats, clearStatsSample, emptyStats, type ProcessStats } from './statsService.js';
import { addonLaunchEnv } from './pluginService.js';
import { upnpOnStart, upnpOnStop } from './upnpService.js';
import { minimalEnv, sandboxApplies, wrapInSandbox } from './sandboxService.js';
import { buildContainerLaunch, killContainer, sampleContainer } from './containerService.js';
import { handleLogLine, resetOnlinePlayers } from './playerService.js';
import { publish, consoleTopic } from './wsHub.js';
import * as consoleLog from './consoleLogService.js';
import { logger } from '../utils/logger.js';
import { HttpError } from '../utils/asyncHandler.js';
import { findPresetFor, type StopStrategy } from './steamGames.js';
import { notify } from './notificationService.js';
import { ensurePrefix, findWine, findXvfbRun, INSTALL_HINT, prefixNeedsWork, usesWine, wineBusy, wineEnv, wineSettingsOf, withWineJob } from './wineService.js';
import { isProxyLoader, type ServerRecord } from '../types/index.js';
import {
  ensureExecutable,
  expandVariables,
  launchConfigOf,
  launchEnv,
  launchVariables,
  resolveExecutable,
  splitArgs,
  type LaunchConfig,
} from './launchConfig.js';

const JAVA_READY_RE = /Done \(/i;
// Velocity prints "Done (1.2s)!"; BungeeCord/Waterfall announce their listener instead.
const BUNGEE_READY_RE = /Listening on \/|Done \(/i;
const BEDROCK_READY_RE = /Server started\./i;
const DEFAULT_STOP_TIMEOUT_MS = 60_000;
const STATS_INTERVAL_MS = 4000;

const JAVA_STOP: StopStrategy = { kind: 'stdin', commands: ['stop'], delayMs: 0 };
const PROXY_STOP: StopStrategy = { kind: 'stdin', commands: ['end'], delayMs: 0 };
// Preserves Bedrock's existing exact behavior (stdin "stop") — not a signal change.
const BEDROCK_STOP: StopStrategy = { kind: 'stdin', commands: ['stop'], delayMs: 0 };
const CUSTOM_STEAM_STOP: StopStrategy = { kind: 'signal', signal: 'SIGTERM' };

/** Built-in strategies plus a user-defined stop script (custom launch configs). */
type StopPlan = StopStrategy | { kind: 'script'; command: string };

interface RunningInstance {
  child: ChildProcessWithoutNullStreams;
  startedAt: number;
  manualStop: boolean;
  statsTimer?: NodeJS.Timeout;
  forceKillTimer?: NodeJS.Timeout;
  lastStats: ProcessStats;
  readyRegex: RegExp | null;
  stopStrategy: StopPlan;
  stopTimeoutMs: number;
  /** Signals go to the whole process group (custom instances run detached so scripts' children stop too). */
  groupKill: boolean;
  /** The real game process inside a bubblewrap sandbox (signals must go to it, not to bwrap). */
  innerPid: number | null;
  sandboxed: boolean;
  server: ServerRecord;
  config: LaunchConfig;
  cwd: string;
}

const running = new Map<string, RunningInstance>();


// ---------------------------------------------------------------------------
// Auto-restart (per-instance restart_policy)
// ---------------------------------------------------------------------------

/** A run at least this long counts as healthy and resets the consecutive-restart counter. */
const STABLE_RUN_MS = 10 * 60_000;
const pendingRestarts = new Map<string, { timer: NodeJS.Timeout; at: number; attempt: number }>();
const restartAttempts = new Map<string, number>();
let shuttingDown = false;

export function getAutoRestartState(serverId: string): { pendingAt: string | null; attempts: number } {
  const pending = pendingRestarts.get(serverId);
  return { pendingAt: pending ? new Date(pending.at).toISOString() : null, attempts: restartAttempts.get(serverId) ?? 0 };
}

/** Cancels a scheduled auto-restart and resets the attempt counter. Returns whether one was pending. */
export function cancelAutoRestart(serverId: string, reason?: string): boolean {
  const pending = pendingRestarts.get(serverId);
  restartAttempts.delete(serverId);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingRestarts.delete(serverId);
  if (reason) appendLog(serverId, `[Outpost] Auto-restart cancelled (${reason})`, 'system');
  publish(consoleTopic(serverId), { type: 'auto_restart', pendingAt: null });
  return true;
}

function maybeScheduleAutoRestart(serverId: string, crashed: boolean, ranForMs: number) {
  if (shuttingDown) return;
  const server = getServer(serverId);
  if (!server || server.suspended) return;
  const policy = server.restart_policy ?? 'never';
  if (policy === 'never' || (policy === 'on-crash' && !crashed)) {
    restartAttempts.delete(serverId);
    return;
  }
  if (ranForMs >= STABLE_RUN_MS) restartAttempts.set(serverId, 0);
  const attempt = (restartAttempts.get(serverId) ?? 0) + 1;
  const max = server.restart_max_attempts;
  if (max > 0 && attempt > max) {
    appendLog(serverId, `[Outpost] Auto-restart gave up after ${max} attempt${max === 1 ? '' : 's'} — start it manually once the problem is fixed`, 'system');
    notify('server.restart_gave_up', { id: server.id, name: server.name }, `Gave up after ${max} attempt${max === 1 ? '' : 's'} — it needs a manual start once the problem is fixed.`);
    restartAttempts.delete(serverId);
    return;
  }
  restartAttempts.set(serverId, attempt);
  const delayMs = Math.max(1, server.restart_delay_sec || 10) * 1000;
  const at = Date.now() + delayMs;
  appendLog(
    serverId,
    `[Outpost] ${crashed ? 'Crash detected' : 'Process exited'} — auto-restarting in ${delayMs / 1000}s (attempt ${attempt}${max ? ` of ${max}` : ''})`,
    'system'
  );
  const timer = setTimeout(async () => {
    pendingRestarts.delete(serverId);
    publish(consoleTopic(serverId), { type: 'auto_restart', pendingAt: null });
    const current = getServer(serverId);
    if (!current || current.suspended || running.has(serverId) || !['crashed', 'stopped'].includes(current.status)) return;
    try {
      await startServer(serverId, { auto: true });
    } catch (err) {
      appendLog(serverId, `[Outpost] Auto-restart failed to start: ${err instanceof Error ? err.message : String(err)}`, 'system');
      maybeScheduleAutoRestart(serverId, true, 0);
    }
  }, delayMs);
  pendingRestarts.set(serverId, { timer, at, attempt });
  publish(consoleTopic(serverId), { type: 'auto_restart', pendingAt: new Date(at).toISOString(), attempt });
}

/** starting → running, once the ready line appears (or straight away for games without one). */
function markRunning(serverId: string) {
  const server = getServer(serverId);
  if (!server || server.status !== 'starting') return;
  setServerStatus(serverId, 'running');
  publish(consoleTopic(serverId), { type: 'status', status: 'running' });
  notify('server.started', { id: server.id, name: server.name }, 'The instance is up and running.');
}

function appendLog(serverId: string, line: string, stream: 'stdout' | 'stderr' | 'system') {
  consoleLog.appendLine(serverId, line, stream);

  const event = handleLogLine(serverId, line);
  if (event) publish(consoleTopic(serverId), { type: 'player', action: event.type, name: event.name });

  if (stream !== 'system') {
    const instance = running.get(serverId);
    if (instance?.readyRegex?.test(line)) markRunning(serverId);
  }
}

/** Everything needed to spawn an instance — also used to preview the command in the UI. */
export interface LaunchPlan {
  cmd: string;
  args: string[];
  /** Set when the server runs under Wine — the prefix may need setting up before the first start. */
  wine?: { bin: string };
  useShell: boolean;
  /** Spawn detached so signals can target the whole process group. */
  detached: boolean;
  cwd: string;
  env: Record<string, string>;
  /** Human-readable command line (env values omitted). */
  display: string;
  /** Things worth saying in the console before launching (e.g. a Java fallback). */
  notes?: string[];
}

/** Whether a launch would be sandboxed — for the UI preview. */
export function launchSandboxed(server: ServerRecord): boolean {
  return sandboxApplies(server);
}

const splitPlain = (value: string) => (value ? value.split(' ').filter(Boolean) : []);

function requireFile(filePath: string, what: string) {
  if (!fs.existsSync(filePath)) throw new HttpError(400, `${what} not found at ${filePath}`);
}

/**
 * Wraps a Windows program for Wine (and Xvfb, when the instance asks for a virtual screen).
 * Returns null when the launch doesn't use Wine.
 */
function wineCommand(
  label: string,
  config: LaunchConfig,
  exe: string,
  gameArgs: string[],
  windowsOnly: boolean,
  dir: string
): { cmd: string; args: string[]; env: Record<string, string>; wine: string } | null {
  if (!usesWine(config, exe, windowsOnly)) return null;
  const settings = wineSettingsOf(config);
  const wine = findWine(settings.binary);
  if (!wine) {
    if (settings.binary) throw new HttpError(400, `This instance is set to use Wine from ${settings.binary}, which isn’t there (Wine tab).`);
    throw new HttpError(400, `${label} is a Windows program and Wine isn’t installed. ${INSTALL_HINT}`);
  }
  const env = wineEnv(dir, settings);
  if (settings.virtualDisplay) {
    const xvfb = findXvfbRun();
    if (!xvfb) throw new HttpError(400, 'This instance wants a virtual screen, but xvfb-run isn’t installed (e.g. "sudo apt install xvfb").');
    return { cmd: xvfb, args: ['-a', '-s', `-screen 0 ${settings.resolution}`, wine, exe, ...gameArgs], env, wine };
  }
  return { cmd: wine, args: [exe, ...gameArgs], env, wine };
}

/** Runs a script file through /bin/sh when it has no shebang (an uploaded start.sh often doesn't). */
function scriptCommand(exePath: string, args: string[]): { cmd: string; args: string[] } {
  if (process.platform !== 'win32' && exePath.endsWith('.sh')) {
    try {
      const head = fs.readFileSync(exePath, { encoding: 'utf8', flag: 'r' }).slice(0, 2);
      if (head !== '#!') return { cmd: '/bin/sh', args: [exePath, ...args] };
    } catch {
      // fall through; requireFile reports missing files
    }
  }
  return { cmd: exePath, args };
}

export async function buildLaunch(server: ServerRecord): Promise<LaunchPlan> {
  const dir = instanceDir(server.id);
  const config = launchConfigOf(server);
  const vars = launchVariables(server);
  const expand = (v: string) => expandVariables(v, vars);
  const customArgs = config.args ? splitArgs(expand(config.args)) : null;
  const preset = server.platform === 'steam' ? findPresetFor(server) : undefined;
  const cwd = config.workingDir ? resolveExecutable(server, config.workingDir) : preset?.workingDir ? path.join(dir, preset.workingDir) : dir;
  let env = launchEnv(server, config);
  // In shell mode `executable` is a command line, not a file.
  const executable = config.executable && !config.useShell ? resolveExecutable(server, expand(config.executable)) : null;

  let cmd: string;
  let args: string[];
  let useShell = false;
  let wine: LaunchPlan['wine'];
  const notes: string[] = [];

  if (server.platform === 'docker') {
    ({ cmd, args } = buildContainerLaunch(server));
    return { cmd, args, useShell: false, detached: false, cwd: instanceDir(server.id), env, display: [cmd, ...args].join(' ') };
  }

  if (server.platform === 'java') {
    let javaPath: string | null;
    if (config.javaPath) javaPath = expand(config.javaPath);
    else {
      const pick = await pickRuntime(server.version || null, config.javaVersion);
      javaPath = pick.path;
      if (pick.note) notes.push(pick.note);
      else if (pick.major) notes.push(`Using Java ${pick.major}${config.javaVersion ? ' (chosen in launch settings)' : ` (what Minecraft ${server.version} needs)`}`);
    }
    if (!javaPath) {
      throw new HttpError(
        400,
        'No Java runtime was found on this machine. Install one under Configuration → Java runtimes (one click), or install a Java Runtime Environment and put `java` on PATH.'
      );
    }
    // Forge/NeoForge 1.17+ launch from an argument file (`@libraries/…/unix_args.txt`), not a jar.
    const argsFile = !executable && server.jar_file?.startsWith('@') ? server.jar_file.slice(1).replace(/unix_args\.txt$/, process.platform === 'win32' ? 'win_args.txt' : 'unix_args.txt') : null;
    const jar = argsFile ? path.join(dir, argsFile) : executable ?? (server.jar_file ? path.join(dir, server.jar_file) : null);
    if (!jar) throw new HttpError(400, 'Server has not finished installing yet');
    requireFile(jar, argsFile ? 'Forge launch arguments' : 'Server jar');
    cmd = javaPath;
    args = [
      `-Xms${server.min_memory_mb}M`,
      `-Xmx${server.max_memory_mb}M`,
      ...splitPlain(server.extra_java_args),
      ...(argsFile ? [`@${argsFile}`] : ['-jar', jar]),
      // Proxies have no GUI flag; they take their port from proxyLaunchArgs instead.
      ...(customArgs ?? (isProxyLoader(server.loader) ? [...proxyLaunchArgs(server), ...splitPlain(server.extra_args)] : ['nogui', ...splitPlain(server.extra_args)])),
    ];
  } else if (server.platform === 'bedrock') {
    const exe = executable ?? path.join(dir, process.platform === 'win32' ? 'bedrock_server.exe' : 'bedrock_server');
    requireFile(exe, 'Bedrock server executable');
    ({ cmd, args } = scriptCommand(exe, customArgs ?? splitPlain(server.extra_args)));
  } else if (server.platform === 'steam') {
    const defaultExe = preset ? (process.platform === 'win32' ? preset.executable.win32 : preset.executable.linux) : server.jar_file;
    const exe = executable ?? (defaultExe ? path.join(dir, defaultExe) : null);
    if (!exe) throw new HttpError(400, 'No launch executable is configured for this server');
    requireFile(exe, 'Server executable');
    const gameArgs = [...(customArgs ?? (preset ? preset.buildLaunchArgs(server) : splitPlain(server.extra_args))), ...rconLaunchArgs(server)];
    const viaWine = wineCommand(preset?.label ?? 'This server', config, exe, gameArgs, !!preset?.windowsOnly, dir);
    if (viaWine) {
      ({ cmd, args } = viaWine);
      env = { ...viaWine.env, ...env };
      wine = { bin: viaWine.wine };
    } else {
      ({ cmd, args } = scriptCommand(exe, gameArgs));
    }
    useShell = !viaWine && process.platform === 'win32' && exe.toLowerCase().endsWith('.bat');
  } else {
    // custom: whatever the user configured
    if (!config.executable) throw new HttpError(400, 'This custom instance has no executable configured — set one in Configuration → Launch');
    const argList = customArgs ?? splitPlain(server.extra_args);
    if (config.useShell) {
      const line = [expand(config.executable), ...(config.args ? [expand(config.args)] : splitPlain(server.extra_args))].join(' ');
      return {
        cmd: process.platform === 'win32' ? line : '/bin/sh',
        args: process.platform === 'win32' ? [] : ['-c', line],
        useShell: process.platform === 'win32',
        detached: process.platform !== 'win32',
        cwd,
        env,
        display: line,
      };
    }
    const exe = executable!;
    requireFile(exe, 'Executable');
    const viaWine = wineCommand('This executable', config, exe, argList, false, dir);
    if (viaWine) {
      ({ cmd, args } = viaWine);
      env = { ...viaWine.env, ...env };
      wine = { bin: viaWine.wine };
    } else {
      if (exe.startsWith(dir)) ensureExecutable(exe);
      ({ cmd, args } = scriptCommand(exe, argList));
    }
  }

  return {
    cmd,
    args,
    wine,
    notes,
    useShell,
    detached: server.platform === 'custom' && process.platform !== 'win32',
    cwd,
    env,
    display: [cmd, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' '),
  };
}

function resolveReadyRegex(server: ServerRecord, config: LaunchConfig): RegExp | null {
  if (config.readyPattern) {
    try {
      return new RegExp(config.readyPattern);
    } catch {
      // validated on save; ignore a corrupt value rather than refusing to start
    }
  }
  if (server.platform === 'java') return server.loader === 'bungeecord' || server.loader === 'waterfall' ? BUNGEE_READY_RE : JAVA_READY_RE;
  if (server.platform === 'bedrock') return BEDROCK_READY_RE;
  if (server.platform === 'custom' || server.platform === 'docker') return null;
  return findPresetFor(server)?.readyRegex ?? null;
}

function resolveStopStrategy(server: ServerRecord, config: LaunchConfig): StopPlan {
  const vars = launchVariables(server);
  const stop = config.stop;
  if (stop?.kind === 'stdin') return { kind: 'stdin', commands: stop.commands.map((c) => expandVariables(c, vars)), delayMs: stop.delayMs ?? 0 };
  if (stop?.kind === 'signal') return { kind: 'signal', signal: stop.signal };
  if (stop?.kind === 'script') return { kind: 'script', command: stop.command };
  if (server.platform === 'java') return isProxyLoader(server.loader) ? PROXY_STOP : JAVA_STOP;
  if (server.platform === 'bedrock') return BEDROCK_STOP;
  if (server.platform === 'custom' || server.platform === 'docker') return CUSTOM_STEAM_STOP; // docker: proxied to the container
  return findPresetFor(server)?.stopStrategy ?? CUSTOM_STEAM_STOP;
}

/** Sends a signal to the instance — to its whole process group when it was spawned detached. */
function signalInstance(instance: RunningInstance, signal: NodeJS.Signals) {
  const pid = instance.child.pid;
  // The attached CLI proxies catchable signals into the container, but SIGKILL can't be proxied.
  if (instance.server.platform === 'docker' && signal === 'SIGKILL') killContainer(instance.server);
  // Signalling bwrap itself would kill the sandbox and orphan the game — target the game.
  if (instance.sandboxed && instance.innerPid && !instance.groupKill) {
    try {
      process.kill(instance.innerPid, signal);
      return;
    } catch {
      // already gone; fall through
    }
  }
  if (instance.groupKill && pid) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // group already gone; fall back to the direct child
    }
  }
  instance.child.kill(signal);
}

/** Runs a configured stop/restart script with the instance's environment, streaming its output to the console. */
function runScript(serverId: string, instance: Pick<RunningInstance, 'server' | 'config' | 'cwd'>, command: string, label: string): Promise<number | null> {
  const line = expandVariables(command, launchVariables(instance.server));
  appendLog(serverId, `[Outpost] Running ${label} script: ${line}`, 'system');
  return new Promise((resolve) => {
    const proc = spawn(process.platform === 'win32' ? line : '/bin/sh', process.platform === 'win32' ? [] : ['-c', line], {
      cwd: instance.cwd,
      env: { ...minimalEnv(), ...launchEnv(instance.server, instance.config) },
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    const forward = (chunk: Buffer) => {
      for (const l of chunk.toString('utf8').split(/\r?\n/)) if (l) appendLog(serverId, `[${label}] ${l}`, 'system');
    };
    proc.stdout.on('data', forward);
    proc.stderr.on('data', forward);
    proc.on('error', (err) => {
      appendLog(serverId, `[Outpost] ${label} script failed to run: ${err.message}`, 'system');
      resolve(null);
    });
    proc.on('exit', (code) => {
      appendLog(serverId, `[Outpost] ${label} script exited with code ${code ?? 'null'}`, 'system');
      resolve(code);
    });
  });
}

/** Issues a graceful-stop request per the resolved strategy. The caller is always responsible
 *  for arming a force-kill fallback timer — this never guarantees the process actually exits. */
function issueStop(serverId: string, instance: RunningInstance) {
  const strategy = instance.stopStrategy;
  if (strategy.kind === 'stdin') {
    const server = getServer(serverId);
    const rcon = server ? activeRcon(server) : null;
    void (async () => {
      for (const command of strategy.commands) {
        // Games whose stdin is unreliable get their stop command over RCON (stdin as a fallback).
        if (rcon?.useForConsole) {
          const viaRcon = await rconSend(rcon, command).then(
            () => true,
            () => false
          );
          if (viaRcon) {
            if (strategy.delayMs) await new Promise((resolve) => setTimeout(resolve, strategy.delayMs));
            continue;
          }
        }
        try {
          instance.child.stdin.write(command + '\n');
        } catch {
          return; // stdin already closed — nothing more to do, force-kill timer will handle it
        }
        if (strategy.delayMs) await new Promise((resolve) => setTimeout(resolve, strategy.delayMs));
      }
    })();
  } else if (strategy.kind === 'signal') {
    signalInstance(instance, strategy.signal);
  } else if (strategy.kind === 'script') {
    void runScript(serverId, instance, strategy.command, 'stop');
  } else {
    signalInstance(instance, 'SIGTERM');
  }
}

/**
 * Files in the instance owned by someone other than the panel's user (left by a `sudo` run) are
 * read-only to the server — plugins then fail with "Permission denied". Linux/macOS only; bounded walk.
 */
function foreignOwnedPaths(dir: string): { count: number; examples: string[] } {
  const uid = process.getuid?.();
  if (uid === undefined || uid === 0) return { count: 0, examples: [] };
  const examples: string[] = [];
  let count = 0;
  let seen = 0;
  const walk = (p: string, depth: number) => {
    if (seen++ > 50_000) return;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch {
      return;
    }
    if (st.uid !== uid) {
      count++;
      if (examples.length < 3) examples.push(p);
    }
    if (!st.isDirectory() || depth >= 8) return;
    let names: string[] = [];
    try {
      names = fs.readdirSync(p);
    } catch {
      return;
    }
    for (const n of names) walk(path.join(p, n), depth + 1);
  };
  walk(dir, 0);
  return { count, examples };
}

/** Bedrock and Linux Steam servers ship their shared libraries next to the binary; mod loaders
 *  (e.g. BepInEx for Valheim) may add their own preload libraries and variables on top. */
function buildLaunchEnv(server: ServerRecord, dir: string, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const presetEnv = server.platform === 'steam' ? (findPresetFor(server)?.launchEnv?.(server) ?? {}) : {};
  const needsLocalLibs = server.platform === 'bedrock' || (server.platform === 'steam' && process.platform !== 'win32');
  if (!needsLocalLibs) return { ...base, ...presetEnv };
  const addon = addonLaunchEnv(server, dir);
  const gameLibs = server.platform === 'steam' ? (findPresetFor(server)?.libraryPaths ?? []).map((p) => path.join(dir, p)) : [];
  const libPath = [...addon.libraryPaths, ...gameLibs, dir].join(':');
  return { ...base, ...addon.env, ...presetEnv, LD_LIBRARY_PATH: libPath };
}

export async function startServer(serverId: string, options: { auto?: boolean } = {}): Promise<void> {
  if (running.has(serverId)) throw new HttpError(409, 'Server is already running');
  // A manual start supersedes any scheduled auto-restart and resets its attempt counter.
  if (!options.auto) cancelAutoRestart(serverId);
  const server = getServer(serverId);
  if (!server) throw new HttpError(404, 'Server not found');
  if (server.suspended) throw new HttpError(423, 'This instance is suspended — lift the suspension before starting it');
  if (server.status === 'installing') throw new HttpError(409, 'Server is still installing');
  if (server.status === 'transferring') throw new HttpError(409, 'Server is being transferred to another node');

  const dir = instanceDir(serverId);
  const config = launchConfigOf(server);
  assertDiskRoom(serverId, 'start');
  if (wineBusy(serverId)) throw new HttpError(409, `Wine is busy (${wineBusy(serverId)}) — wait for it to finish`);
  if (server.platform === 'steam') {
    const note = findPresetFor(server)?.prepareInstance?.(server);
    if (note) appendLog(serverId, `[Outpost] ${note}`, 'system');
  }
  const plan = await buildLaunch(server);

  // First start under Wine: set up the instance's prefix in the background (it can take a minute),
  // then start for real. The request returns straight away; progress shows in the console.
  const wineSettings = wineSettingsOf(config);
  if (plan.wine && prefixNeedsWork(dir, wineSettings)) {
    setServerStatus(serverId, 'starting');
    publish(consoleTopic(serverId), { type: 'status', status: 'starting' });
    void withWineJob(serverId, 'setting up the prefix', () => ensurePrefix(server, wineSettings, (line) => appendLog(serverId, line, 'system')))
      .then(() => startServer(serverId, options))
      .catch((err) => {
        appendLog(serverId, `[Outpost] Couldn’t start under Wine: ${err instanceof Error ? err.message : String(err)}`, 'system');
        setServerStatus(serverId, 'crashed');
        publish(consoleTopic(serverId), { type: 'status', status: 'crashed' });
      });
    return;
  }
  if (plan.wine) appendLog(serverId, '[Outpost] Running under Wine', 'system');

  appendLog(serverId, `[Outpost] Host environment: ${process.platform} (${process.arch})`, 'system');
  // Containers map files to their own users, so ownership only means something for host processes.
  const foreign = server.platform === 'docker' ? { count: 0, examples: [] } : foreignOwnedPaths(dir);
  if (foreign.count) {
    appendLog(
      serverId,
      `[Outpost] Warning: ${foreign.count} file(s)/folder(s) in this instance belong to another user (e.g. ${foreign.examples.map((p) => path.relative(dir, p) || '.').join(', ')}), so the server can’t write to them — usually left by running something with sudo. Fix: sudo chown -R ${os.userInfo().username}: "${dir}"`,
      'stderr',
    );
  }
  for (const note of plan.notes ?? []) appendLog(serverId, `[Outpost] ${note}`, 'system');
  appendLog(serverId, `[Outpost] Launching: ${plan.display}`, 'system');
  if (config.env?.length) appendLog(serverId, `[Outpost] Extra environment: ${config.env.map((e) => e.key).join(', ')}`, 'system');

  resetOnlinePlayers(serverId);
  setServerStatus(serverId, 'starting');
  publish(consoleTopic(serverId), { type: 'status', status: 'starting' });

  // The docker/podman *client* needs the panel's full environment (XDG_RUNTIME_DIR, DOCKER_HOST…);
  // the container itself only receives the variables in its config.
  const baseEnv = server.platform === 'docker' ? ({ ...process.env } as Record<string, string>) : minimalEnv();
  const env = { ...buildLaunchEnv(server, dir, baseEnv), ...plan.env } as Record<string, string>;
  const sandboxed = sandboxApplies(server);
  const sandboxTarget = sandboxed ? wrapInSandbox(server, { cmd: plan.cmd, args: plan.args, cwd: plan.cwd, env }) : { cmd: plan.cmd, args: plan.args };
  // CPU / memory / process caps: a systemd scope around everything (the sandbox included).
  const limited = wrapWithLimits(server, sandboxTarget);
  const target = { cmd: limited.cmd, args: limited.args };
  for (const note of limited.notes) appendLog(serverId, `[Outpost] ${note}`, 'system');
  if (sandboxed) {
    appendLog(serverId, `[Outpost] Sandboxed (bubblewrap): only ${dir} is writable; the rest of the host's files are read-only system folders or hidden`, 'system');
  }

  const child = spawn(target.cmd, target.args, {
    cwd: plan.cwd,
    windowsHide: true,
    shell: plan.useShell && !sandboxed,
    detached: plan.detached,
    env,
    // fd 3 carries bwrap's {"child-pid": …} report
    stdio: sandboxed ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
  }) as unknown as ChildProcessWithoutNullStreams;

  const readyRegex = resolveReadyRegex(server, config);
  const instance: RunningInstance = {
    child,
    startedAt: Date.now(),
    manualStop: false,
    lastStats: emptyStats(),
    readyRegex,
    stopStrategy: resolveStopStrategy(server, config),
    stopTimeoutMs: (config.stopTimeoutSec ?? DEFAULT_STOP_TIMEOUT_MS / 1000) * 1000,
    groupKill: plan.detached,
    innerPid: null,
    sandboxed,
    server,
    config,
    cwd: plan.cwd,
  };
  running.set(serverId, instance);
  if (sandboxed) {
    let info = '';
    const fd3 = (child as unknown as { stdio: (NodeJS.ReadableStream | null)[] }).stdio[3];
    fd3?.on('data', (chunk: Buffer) => {
      info += chunk.toString();
      const m = info.match(/"child-pid":\s*(\d+)/);
      if (m) instance.innerPid = Number(m[1]);
    });
  }
  void upnpOnStart(server);

  if (readyRegex === null) {
    // No known "ready" log line for this game — mark it running as soon as we know the process
    // didn't immediately fail to spawn, rather than leaving it stuck in "starting" forever.
    setImmediate(() => {
      if (running.has(serverId)) markRunning(serverId); // else it already exited
    });
  }

  // Writing a command just as the game exits fails with EPIPE; without a listener that error would
  // crash the whole panel. The exit itself is reported by the 'exit' handler.
  child.stdin.on('error', () => {});
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) if (line.length) appendLog(serverId, line, 'stdout');
  });
  child.stderr.on('data', (chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) if (line.length) appendLog(serverId, line, 'stderr');
  });

  child.on('error', (err) => {
    appendLog(serverId, `[Outpost] Failed to start process: ${err.message}`, 'system');
  });

  child.on('exit', (code, signal) => {
    logger.info(`Server ${serverId} exited`, { code, signal });
    const inst = running.get(serverId);
    if (inst?.statsTimer) clearInterval(inst.statsTimer);
    if (inst?.forceKillTimer) clearTimeout(inst.forceKillTimer);
    if (child.pid) clearStatsSample(child.pid);
    const wasManual = inst?.manualStop ?? false;
    running.delete(serverId);
    resetOnlinePlayers(serverId);
    const finalStatus = wasManual || code === 0 ? 'stopped' : 'crashed';
    setServerStatus(serverId, finalStatus);
    appendLog(serverId, `[Outpost] Process exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`, 'system');
    publish(consoleTopic(serverId), { type: 'status', status: finalStatus });
    if (!shuttingDown) {
      const who = { id: server.id, name: server.name };
      if (finalStatus === 'crashed') notify('server.crashed', who, `Exited unexpectedly (code ${code ?? 'none'}${signal ? `, signal ${signal}` : ''}).`);
      else notify('server.stopped', who, wasManual ? 'Stopped from the panel.' : 'Exited cleanly.');
    }
    void upnpOnStop(serverId);
    if (!wasManual) maybeScheduleAutoRestart(serverId, code !== 0, Date.now() - instance.startedAt);
  });

  let prevContainer: { at: number; netRx: number | null; netTx: number | null; read: number | null; write: number | null; baseRx: number | null; baseTx: number | null } | null = null;
  instance.statsTimer = setInterval(async () => {
    if (!child.pid) return;
    let stats: ProcessStats;
    if (server.platform === 'docker') {
      // Container processes aren't children of the CLI — ask the engine (per-container network included).
      const s = await sampleContainer(server);
      if (!s) return;
      const now = Date.now();
      const secs = prevContainer ? (now - prevContainer.at) / 1000 : 0;
      const rate = (cur: number | null, prev: number | null | undefined) => (cur === null || prev == null || secs <= 0 ? null : Math.max(0, Math.round((cur - prev) / secs)));
      const baseRx = prevContainer?.baseRx ?? s.netRx;
      const baseTx = prevContainer?.baseTx ?? s.netTx;
      stats = {
        memoryMb: s.memoryMb,
        cpuPercent: s.cpuPercent,
        diskReadBytes: s.blockRead,
        diskWriteBytes: s.blockWrite,
        diskReadRate: rate(s.blockRead, prevContainer?.read),
        diskWriteRate: rate(s.blockWrite, prevContainer?.write),
        netRxBytes: s.netRx,
        netTxBytes: s.netTx,
        netRxRate: rate(s.netRx, prevContainer?.netRx),
        netTxRate: rate(s.netTx, prevContainer?.netTx),
      };
      prevContainer = { at: now, netRx: s.netRx, netTx: s.netTx, read: s.blockRead, write: s.blockWrite, baseRx, baseTx };
    } else {
      stats = await readProcessStats(child.pid);
    }
    instance.lastStats = stats;
    publish(consoleTopic(serverId), { type: 'stats', ...stats });
  }, STATS_INTERVAL_MS);
}

export function stopServer(serverId: string, options: { force?: boolean } = {}): void {
  const instance = running.get(serverId);
  if (!instance) {
    // "Stop" on a crashed instance that's waiting to auto-restart cancels the restart.
    if (cancelAutoRestart(serverId, 'stopped from the panel')) return;
    throw new HttpError(409, 'Server is not running');
  }
  instance.manualStop = true;

  if (options.force) {
    signalInstance(instance, 'SIGKILL');
    return;
  }

  setServerStatus(serverId, 'stopping');
  publish(consoleTopic(serverId), { type: 'status', status: 'stopping' });
  issueStop(serverId, instance);

  instance.forceKillTimer = setTimeout(() => {
    if (running.has(serverId)) {
      appendLog(serverId, '[Outpost] Graceful stop timed out, forcing termination', 'system');
      signalInstance(instance, 'SIGKILL');
    }
  }, instance.stopTimeoutMs);
}

/**
 * Restarts per the instance's launch config: by default stop → wait for exit → start; a console
 * command (the server restarts itself) or a restart script can be configured instead.
 */
export async function restartServer(serverId: string): Promise<void> {
  const instance = running.get(serverId);
  // Use the saved config, not the one captured at start, so a just-changed restart method applies.
  const current = getServer(serverId);
  const restart = current ? launchConfigOf(current).restart : undefined;
  if (instance && restart?.kind === 'stdin') {
    for (const command of restart.commands) sendCommand(serverId, expandVariables(command, launchVariables(instance.server)));
    return;
  }
  if (instance && restart?.kind === 'script') {
    await runScript(serverId, { ...instance, server: current ?? instance.server }, restart.command, 'restart');
    return;
  }
  if (instance) {
    await new Promise<void>((resolve) => {
      instance.child.once('exit', () => resolve());
      stopServer(serverId);
    });
  }
  await startServer(serverId);
}

export function sendCommand(serverId: string, command: string): void {
  const instance = running.get(serverId);
  if (!instance) throw new HttpError(409, 'Server is not running');
  const server = getServer(serverId);
  const rcon = server ? activeRcon(server) : null;
  if (rcon?.useForConsole) {
    appendLog(serverId, `> ${command} (RCON)`, 'system');
    rconSend(rcon, command.trim())
      .then((reply) => {
        for (const line of reply.split(/\r?\n/)) if (line.trim()) appendLog(serverId, line, 'stdout');
      })
      .catch((err) => appendLog(serverId, `[Outpost] RCON: ${err instanceof Error ? err.message : String(err)}`, 'system'));
    return;
  }
  appendLog(serverId, `> ${command}`, 'system');
  instance.child.stdin.write(command.trim() + '\n');
}

export function isRunning(serverId: string): boolean {
  return running.has(serverId);
}

export function getRuntimeInfo(serverId: string) {
  const instance = running.get(serverId);
  if (!instance) return null;
  return {
    pid: instance.child.pid ?? null,
    uptimeMs: Date.now() - instance.startedAt,
    stats: instance.lastStats,
  };
}

export function getLogBuffer(serverId: string): string[] {
  return consoleLog.getBuffer(serverId);
}

/** Called at server shutdown so child MC processes don't become orphaned. */
export function stopAllForShutdown(): void {
  shuttingDown = true;
  for (const timer of pendingRestarts.values()) clearTimeout(timer.timer);
  for (const [serverId, instance] of running) {
    instance.manualStop = true;
    try {
      issueStop(serverId, instance);
    } catch {
      signalInstance(instance, 'SIGTERM');
    }
    logger.info(`Sent stop to server ${serverId} for panel shutdown`);
  }
}
