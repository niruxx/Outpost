import fs from 'node:fs';
import { sanitizeWineConfig, type WineConfig } from './wineService.js';
import path from 'node:path';
import { HttpError } from '../utils/asyncHandler.js';
import { instanceDir, safeJoinReal } from '../utils/paths.js';
import type { ServerRecord } from '../types/index.js';

/**
 * Per-instance launch customization. Every field is optional for Minecraft/Steam instances
 * (unset = the platform's built-in behavior); custom instances need at least `executable`.
 *
 * Strings in executable/args/env/stop/restart may use variables, expanded at launch:
 *   {{PORT}} {{NAME}} {{ID}} {{DIR}} {{MIN_MEMORY}} {{MAX_MEMORY}}
 * The same values are also exported to the process as SERVER_PORT, SERVER_NAME, SERVER_ID,
 * SERVER_DIR, SERVER_MIN_MEMORY_MB and SERVER_MAX_MEMORY_MB.
 */
export interface LaunchConfig {
  /** Java: the .jar to run. Others: the binary/script to run. Relative to the instance folder;
   *  absolute paths are admin-only. */
  executable?: string;
  /** Java only: a specific java binary instead of the auto-detected one (admin-only). */
  javaPath?: string;
  /** Java instances: the Java major to run with (default: what the Minecraft version needs). */
  javaVersion?: number;
  /** Replaces the platform's default arguments when non-empty. Quotes group words. */
  args?: string;
  /** Run `executable args` as one /bin/sh command line (pipes, &&, $VARS…). Admin-only. */
  useShell?: boolean;
  /** Subfolder of the instance to run in. */
  workingDir?: string;
  env?: { key: string; value: string }[];
  /** Custom instances: which protocol players connect over (for the endpoint display). */
  protocol?: 'tcp' | 'udp';
  /** Regex matched against output lines; the first match marks the instance "running". */
  readyPattern?: string;
  stop?: StopConfig;
  restart?: RestartConfig;
  /** Seconds to wait for a graceful stop before force-killing (default 60). */
  stopTimeoutSec?: number;
  /** Apps with a web interface: the port (usually the instance port) to link to. */
  webUi?: { port: number; scheme: 'http' | 'https'; path: string };
  /** Windows programs on Linux: run through Wine (auto = when the executable is a Windows one). */
  wine?: WineConfig;
}

export const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGQUIT', 'SIGHUP'] as const;
export type StopSignal = (typeof STOP_SIGNALS)[number];

export type StopConfig =
  | { kind: 'default' }
  | { kind: 'stdin'; commands: string[]; delayMs?: number }
  | { kind: 'signal'; signal: StopSignal }
  | { kind: 'script'; command: string };

export type RestartConfig =
  | { kind: 'default' } // stop, wait for exit, start
  | { kind: 'stdin'; commands: string[] } // the server restarts itself on a console command
  | { kind: 'script'; command: string }; // run a command alongside the server

export function parseLaunchConfig(raw: string | null | undefined): LaunchConfig {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as LaunchConfig) : {};
  } catch {
    return {};
  }
}

export function launchConfigOf(server: Pick<ServerRecord, 'launch_config'>): LaunchConfig {
  return parseLaunchConfig(server.launch_config);
}

const str = (v: unknown, max = 2000) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const nonEmpty = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);

/** Validates and normalizes user input. `isAdmin` unlocks shell mode, absolute paths and scripts. */
export function sanitizeLaunchConfig(input: unknown, opts: { isAdmin: boolean; platform: ServerRecord['platform'] }): LaunchConfig {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'launch config must be an object');
  const raw = input as Record<string, unknown>;
  const out: LaunchConfig = {};
  const adminOnly = (what: string) => {
    if (!opts.isAdmin) throw new HttpError(403, `${what} can only be set by an admin`);
  };

  if (raw.useShell === true) {
    if (opts.platform !== 'custom') throw new HttpError(400, 'Shell mode is only available for custom instances');
    adminOnly('Shell mode');
    out.useShell = true;
  }
  const executable = nonEmpty(str(raw.executable, 500));
  if (executable && out.useShell) {
    out.executable = executable; // a command line in shell mode — admin-only, so not path-checked
  } else if (executable) {
    if (path.isAbsolute(executable)) adminOnly('An absolute executable path');
    else if (executable.split(/[\\/]/).includes('..')) throw new HttpError(400, 'executable must stay inside the instance folder');
    out.executable = executable;
  }
  const javaPath = nonEmpty(str(raw.javaPath, 500));
  if (javaPath) {
    if (opts.platform !== 'java') throw new HttpError(400, 'javaPath only applies to Java instances');
    adminOnly('A custom Java binary');
    out.javaPath = javaPath;
  }
  if (raw.javaVersion !== undefined && raw.javaVersion !== null && raw.javaVersion !== '') {
    const v = Number(raw.javaVersion);
    if (opts.platform !== 'java') throw new HttpError(400, 'javaVersion only applies to Java instances');
    if (!Number.isInteger(v) || v < 8 || v > 99) throw new HttpError(400, 'Java version must be between 8 and 99');
    out.javaVersion = v;
  }
  const args = str(raw.args);
  if (args !== undefined && args.trim()) out.args = args.trim();
  const workingDir = nonEmpty(str(raw.workingDir, 500));
  if (workingDir) {
    if (path.isAbsolute(workingDir) || workingDir.split(/[\\/]/).includes('..')) throw new HttpError(400, 'workingDir must be a subfolder of the instance');
    out.workingDir = workingDir;
  }
  if (Array.isArray(raw.env)) {
    out.env = raw.env
      .filter((e): e is { key: string; value: string } => !!e && typeof e.key === 'string' && typeof e.value === 'string')
      .map((e) => ({ key: e.key.trim(), value: e.value.slice(0, 2000) }))
      .filter((e) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(e.key))
      .slice(0, 50);
    if (!out.env.length) delete out.env;
  }
  if (raw.protocol === 'tcp' || raw.protocol === 'udp') out.protocol = raw.protocol;
  const readyPattern = nonEmpty(str(raw.readyPattern, 300));
  if (readyPattern) {
    try {
      new RegExp(readyPattern);
    } catch {
      throw new HttpError(400, 'readyPattern is not a valid regular expression');
    }
    out.readyPattern = readyPattern;
  }
  const web = raw.webUi as Record<string, unknown> | undefined;
  if (web && typeof web === 'object') {
    const port = Number(web.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, 'Web UI port must be 1–65535');
    out.webUi = {
      port,
      scheme: web.scheme === 'https' ? 'https' : 'http',
      path: typeof web.path === 'string' && web.path.startsWith('/') ? web.path.slice(0, 200) : '/',
    };
  }
  const wine = sanitizeWineConfig(raw.wine, { isAdmin: opts.isAdmin });
  if (wine) {
    if (opts.platform !== 'steam' && opts.platform !== 'custom') throw new HttpError(400, 'Wine only applies to Steam and custom instances');
    out.wine = wine;
  }
  const timeout = Number(raw.stopTimeoutSec);
  if (Number.isFinite(timeout) && timeout > 0) out.stopTimeoutSec = Math.min(Math.max(Math.round(timeout), 5), 900);

  const stop = raw.stop as Record<string, unknown> | undefined;
  if (stop && typeof stop === 'object') {
    if (stop.kind === 'stdin') {
      const commands = (Array.isArray(stop.commands) ? stop.commands : []).filter((c): c is string => typeof c === 'string' && !!c.trim());
      if (!commands.length) throw new HttpError(400, 'Stop via console needs at least one command');
      const delayMs = Number(stop.delayMs);
      out.stop = { kind: 'stdin', commands: commands.slice(0, 10), delayMs: Number.isFinite(delayMs) ? Math.min(Math.max(delayMs, 0), 60_000) : 0 };
    } else if (stop.kind === 'signal') {
      if (!STOP_SIGNALS.includes(stop.signal as StopSignal)) throw new HttpError(400, `signal must be one of ${STOP_SIGNALS.join(', ')}`);
      out.stop = { kind: 'signal', signal: stop.signal as StopSignal };
    } else if (stop.kind === 'script') {
      adminOnly('A stop script');
      const command = nonEmpty(str(stop.command));
      if (!command) throw new HttpError(400, 'Stop script needs a command');
      out.stop = { kind: 'script', command };
    }
  }

  const restart = raw.restart as Record<string, unknown> | undefined;
  if (restart && typeof restart === 'object') {
    if (restart.kind === 'stdin') {
      const commands = (Array.isArray(restart.commands) ? restart.commands : []).filter((c): c is string => typeof c === 'string' && !!c.trim());
      if (!commands.length) throw new HttpError(400, 'Restart via console needs at least one command');
      out.restart = { kind: 'stdin', commands: commands.slice(0, 10) };
    } else if (restart.kind === 'script') {
      adminOnly('A restart script');
      const command = nonEmpty(str(restart.command));
      if (!command) throw new HttpError(400, 'Restart script needs a command');
      out.restart = { kind: 'script', command };
    }
  }

  if (opts.platform === 'custom' && !out.executable) throw new HttpError(400, 'Custom instances need an executable or script to launch');
  return out;
}

export function launchVariables(server: ServerRecord): Record<string, string> {
  return {
    PORT: String(server.server_port),
    NAME: server.name,
    ID: server.id,
    DIR: instanceDir(server.id),
    MIN_MEMORY: String(server.min_memory_mb),
    MAX_MEMORY: String(server.max_memory_mb),
  };
}

/** Replaces {{VAR}} placeholders; unknown names are left untouched. */
export function expandVariables(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([A-Z_]+)\s*\}\}/g, (match, name: string) => vars[name] ?? match);
}

/** The environment a launched process (and stop/restart scripts) get on top of the panel's own. */
export function launchEnv(server: ServerRecord, config: LaunchConfig): Record<string, string> {
  const vars = launchVariables(server);
  const env: Record<string, string> = {
    SERVER_PORT: vars.PORT,
    SERVER_NAME: vars.NAME,
    SERVER_ID: vars.ID,
    SERVER_DIR: vars.DIR,
    SERVER_MIN_MEMORY_MB: vars.MIN_MEMORY,
    SERVER_MAX_MEMORY_MB: vars.MAX_MEMORY,
  };
  for (const { key, value } of config.env ?? []) env[key] = expandVariables(value, vars);
  return env;
}

/** Splits a command-line string into arguments, honoring "double" and 'single' quotes. */
export function splitArgs(input: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let hasToken = false;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
    } else if (/\s/.test(ch)) {
      if (hasToken) out.push(current);
      current = '';
      hasToken = false;
    } else {
      current += ch;
      hasToken = true;
    }
  }
  if (hasToken) out.push(current);
  return out;
}

/** Absolute path of a configured executable (relative ones resolve inside the instance). */
export function resolveExecutable(server: ServerRecord, executable: string): string {
  if (path.isAbsolute(executable)) return executable;
  try {
    return safeJoinReal(instanceDir(server.id), executable);
  } catch {
    throw new HttpError(400, 'executable must stay inside the instance folder (symlinks pointing outside it are refused)');
  }
}

/** Best-effort chmod +x for a script/binary inside the instance (uploads lose the execute bit). */
export function ensureExecutable(filePath: string) {
  if (process.platform === 'win32') return;
  try {
    const mode = fs.statSync(filePath).mode;
    if ((mode & 0o111) === 0) fs.chmodSync(filePath, mode | 0o755);
  } catch {
    // missing file is reported at launch
  }
}
