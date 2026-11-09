/**
 * Privileged host-administration operations: systemd unit control, Outpost-managed timers and
 * package-manager transactions.
 *
 * Like hostFileOps, these run either inside Outpost (when it already runs as root) or inside the
 * Admin Mode helper started through sudo. Keep this module free of panel imports (database, auth,
 * logging). Every argument is validated here as well as in the routes: the helper runs as root
 * and trusts nothing it receives. Commands are spawned with argument arrays, never through a shell.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { HostFileError } from './hostFileOps.js';

export type Emit = (chunk: string) => void;

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const MAX_CAPTURE = 4 * 1024 * 1024;

/** Runs a command without a shell. `onOutput` receives stdout and stderr as they arrive. */
export function runCommand(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; env?: Record<string, string>; onOutput?: Emit; input?: string } = {}
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, LC_ALL: 'C', LANG: 'C', SYSTEMD_COLORS: '0', SYSTEMD_PAGER: '', ...(opts.env ?? {}) },
      stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    if (opts.input !== undefined && child.stdin) {
      child.stdin.on('error', () => undefined);
      child.stdin.end(opts.input);
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 60_000);
    child.stdout!.on('data', (d: Buffer) => {
      const s = d.toString();
      if (stdout.length < MAX_CAPTURE) stdout += s;
      opts.onOutput?.(s);
    });
    child.stderr!.on('data', (d: Buffer) => {
      const s = d.toString();
      if (stderr.length < MAX_CAPTURE) stderr += s;
      opts.onOutput?.(s);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// systemd units
// ---------------------------------------------------------------------------

export const UNIT_TYPES = ['service', 'timer', 'socket', 'target', 'path', 'mount', 'automount', 'swap', 'slice'] as const;
export type UnitType = (typeof UNIT_TYPES)[number];

export const UNIT_ACTIONS = ['start', 'stop', 'restart', 'reload', 'enable', 'disable', 'enable-now', 'disable-now', 'mask', 'unmask', 'reset-failed'] as const;
export type UnitAction = (typeof UNIT_ACTIONS)[number];

const UNIT_RE = new RegExp(`^[A-Za-z0-9@._:\\\\-]{1,200}\\.(${UNIT_TYPES.join('|')})$`);

export function validUnitName(name: unknown): name is string {
  return typeof name === 'string' && UNIT_RE.test(name) && !name.startsWith('-') && !name.includes('..');
}

export function assertUnit(name: unknown): string {
  if (!validUnitName(name)) throw new HostFileError(400, 'Invalid unit name');
  return name;
}

/** The systemctl arguments for an action. */
export function unitActionArgs(unit: string, action: UnitAction): string[] {
  assertUnit(unit);
  switch (action) {
    case 'enable-now':
      return ['enable', '--now', '--', unit];
    case 'disable-now':
      return ['disable', '--now', '--', unit];
    default:
      if (!UNIT_ACTIONS.includes(action)) throw new HostFileError(400, 'Unknown action');
      return [action, '--', unit];
  }
}

async function unitAction(a: { unit: string; action: UnitAction }) {
  const args = unitActionArgs(a.unit, a.action);
  const r = await runCommand('systemctl', ['--no-ask-password', ...args], { timeoutMs: 120_000 });
  if (r.code !== 0) {
    const msg = (r.stderr || r.stdout).trim().split('\n').filter(Boolean).slice(-3).join(' ');
    // 422, not 409: the routes use 409 to ask for confirmation.
    throw new HostFileError(r.code === null ? 502 : 422, msg || `systemctl ${a.action} failed (exit ${r.code})`);
  }
  return { output: (r.stdout + r.stderr).trim() };
}

// ---------------------------------------------------------------------------
// Outpost-managed timers: a .service + .timer pair under /etc/systemd/system
// ---------------------------------------------------------------------------

export const MANAGED_MARKER = '# Managed by Outpost — edit in the Services page.';
export const UNIT_DIR = '/etc/systemd/system';

export interface TimerDefinition {
  /** Base name: "nightly-backup" → nightly-backup.service + nightly-backup.timer. */
  name: string;
  description: string;
  command: string;
  /** Account the command runs as; empty = root. */
  user: string;
  workingDirectory: string;
  onCalendar: string;
  /** Seconds after boot / after the last run, as systemd time spans ("15min", "1h"). */
  onBootSec: string;
  onUnitActiveSec: string;
  /** Run a missed calendar event at the next boot. */
  persistent: boolean;
  /** Random delay added to each run, e.g. "5min". */
  randomizedDelaySec: string;
}

const BASE_RE = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,99}$/;
const SPAN_RE = /^(\d+\s*(us|ms|s|sec|second|seconds|m|min|minute|minutes|h|hr|hour|hours|d|day|days|w|week|weeks|M|month|months|y|year|years)?\s*)+$/;
const USER_RE = /^[a-z_][a-z0-9_.-]{0,31}\$?$/;

const oneLine = (s: unknown, field: string, max: number, required = false): string => {
  const v = typeof s === 'string' ? s.trim() : '';
  if (required && !v) throw new HostFileError(400, `${field} is required`);
  if (v.length > max) throw new HostFileError(400, `${field} is too long`);
  if (/[\r\n\0]/.test(v)) throw new HostFileError(400, `${field} must be a single line`);
  return v;
};

/** Validates and normalises a timer definition from untrusted input. */
export function sanitizeTimer(input: unknown): TimerDefinition {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const name = oneLine(o.name, 'Name', 100, true).replace(/\.(timer|service)$/, '');
  if (!BASE_RE.test(name) || name.includes('..')) throw new HostFileError(400, 'Name may only use letters, digits, "-", "_", "." and "@"');
  const def: TimerDefinition = {
    name,
    description: oneLine(o.description, 'Description', 200),
    command: oneLine(o.command, 'Command', 4000, true),
    user: oneLine(o.user, 'User', 32),
    workingDirectory: oneLine(o.workingDirectory, 'Working directory', 1000),
    onCalendar: oneLine(o.onCalendar, 'Schedule', 200),
    onBootSec: oneLine(o.onBootSec, 'Delay after boot', 50),
    onUnitActiveSec: oneLine(o.onUnitActiveSec, 'Repeat interval', 50),
    persistent: o.persistent === true,
    randomizedDelaySec: oneLine(o.randomizedDelaySec, 'Random delay', 50),
  };
  if (def.user && !USER_RE.test(def.user)) throw new HostFileError(400, 'Invalid user name');
  if (def.workingDirectory && !path.posix.isAbsolute(def.workingDirectory)) throw new HostFileError(400, 'Working directory must be an absolute path');
  for (const [v, label] of [[def.onBootSec, 'Delay after boot'], [def.onUnitActiveSec, 'Repeat interval'], [def.randomizedDelaySec, 'Random delay']] as const) {
    if (v && !SPAN_RE.test(v)) throw new HostFileError(400, `${label} must be a time span such as "15min" or "1h 30min"`);
  }
  if (!def.onCalendar && !def.onBootSec && !def.onUnitActiveSec) throw new HostFileError(400, 'Choose when the timer runs: a calendar schedule, a delay after boot or a repeat interval');
  if (def.onUnitActiveSec && !def.onCalendar && !def.onBootSec) {
    // OnUnitActiveSec alone never fires the first time; anchor it to boot like `systemd-run --on-unit-active`.
    def.onBootSec = '1min';
  }
  return def;
}

/** "%" is a specifier in unit files; escape it so commands mean what was typed. */
const escapeSpecifiers = (s: string) => s.replace(/%/g, '%%');

export function renderTimerUnits(def: TimerDefinition): { service: string; timer: string } {
  const desc = def.description || def.name;
  const service = [
    MANAGED_MARKER,
    '[Unit]',
    `Description=${escapeSpecifiers(desc)}`,
    '',
    '[Service]',
    'Type=oneshot',
    `ExecStart=${escapeSpecifiers(def.command)}`,
    ...(def.user ? [`User=${def.user}`] : []),
    ...(def.workingDirectory ? [`WorkingDirectory=${escapeSpecifiers(def.workingDirectory)}`] : []),
    '',
  ].join('\n');
  const timer = [
    MANAGED_MARKER,
    '[Unit]',
    `Description=${escapeSpecifiers(desc)} (timer)`,
    '',
    '[Timer]',
    ...(def.onCalendar ? [`OnCalendar=${def.onCalendar}`] : []),
    ...(def.onBootSec ? [`OnBootSec=${def.onBootSec}`] : []),
    ...(def.onUnitActiveSec ? [`OnUnitActiveSec=${def.onUnitActiveSec}`] : []),
    ...(def.persistent ? ['Persistent=true'] : []),
    ...(def.randomizedDelaySec ? [`RandomizedDelaySec=${def.randomizedDelaySec}`] : []),
    `Unit=${def.name}.service`,
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n');
  return { service, timer };
}

/** Reads back a definition from the unit files written by renderTimerUnits; null if not ours. */
export function parseManagedTimer(name: string, service: string, timer: string): TimerDefinition | null {
  if (!service.startsWith(MANAGED_MARKER) || !timer.startsWith(MANAGED_MARKER)) return null;
  const get = (text: string, key: string) => {
    const m = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
    return m ? m[1] : '';
  };
  const unescape = (s: string) => s.replace(/%%/g, '%');
  const description = unescape(get(service, 'Description'));
  return {
    name,
    description: description === name ? '' : description,
    command: unescape(get(service, 'ExecStart')),
    user: get(service, 'User'),
    workingDirectory: unescape(get(service, 'WorkingDirectory')),
    onCalendar: get(timer, 'OnCalendar'),
    onBootSec: get(timer, 'OnBootSec'),
    onUnitActiveSec: get(timer, 'OnUnitActiveSec'),
    persistent: get(timer, 'Persistent') === 'true',
    randomizedDelaySec: get(timer, 'RandomizedDelaySec'),
  };
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function systemctlOrThrow(args: string[]) {
  const r = await runCommand('systemctl', ['--no-ask-password', ...args], { timeoutMs: 120_000 });
  if (r.code !== 0) throw new HostFileError(409, (r.stderr || r.stdout).trim().split('\n').pop() || `systemctl ${args[0]} failed`);
}

async function writeTimer(a: { definition: TimerDefinition; enable: boolean; replace: boolean; unitDir?: string }) {
  const def = sanitizeTimer(a.definition);
  const dir = a.unitDir ?? UNIT_DIR;
  const servicePath = path.join(dir, `${def.name}.service`);
  const timerPath = path.join(dir, `${def.name}.timer`);
  const [oldService, oldTimer] = await Promise.all([readIfExists(servicePath), readIfExists(timerPath)]);
  for (const [old, file] of [[oldService, servicePath], [oldTimer, timerPath]] as const) {
    if (old === null) continue;
    if (!old.startsWith(MANAGED_MARKER)) throw new HostFileError(409, `${file} already exists and wasn’t created by Outpost`);
    if (!a.replace) throw new HostFileError(409, `A timer called ${def.name} already exists`);
  }
  const units = renderTimerUnits(def);
  await fsp.writeFile(servicePath, units.service, { mode: 0o644 });
  await fsp.writeFile(timerPath, units.timer, { mode: 0o644 });
  if (a.unitDir) return { name: def.name };
  await systemctlOrThrow(['daemon-reload']);
  if (a.enable) await systemctlOrThrow(['enable', '--now', '--', `${def.name}.timer`]);
  else if (oldTimer !== null) await systemctlOrThrow(['restart', '--', `${def.name}.timer`]).catch(() => undefined);
  return { name: def.name };
}

async function deleteTimer(a: { name: string; unitDir?: string }) {
  const name = typeof a.name === 'string' ? a.name.replace(/\.(timer|service)$/, '') : '';
  if (!BASE_RE.test(name) || name.includes('..')) throw new HostFileError(400, 'Invalid timer name');
  const dir = a.unitDir ?? UNIT_DIR;
  const servicePath = path.join(dir, `${name}.service`);
  const timerPath = path.join(dir, `${name}.timer`);
  const [service, timer] = await Promise.all([readIfExists(servicePath), readIfExists(timerPath)]);
  if (service === null && timer === null) throw new HostFileError(404, 'No such timer');
  if ((service !== null && !service.startsWith(MANAGED_MARKER)) || (timer !== null && !timer.startsWith(MANAGED_MARKER))) {
    throw new HostFileError(403, 'Only timers created by Outpost can be deleted here');
  }
  if (!a.unitDir) {
    await runCommand('systemctl', ['--no-ask-password', 'disable', '--now', '--', `${name}.timer`], { timeoutMs: 60_000 });
    await runCommand('systemctl', ['--no-ask-password', 'stop', '--', `${name}.service`], { timeoutMs: 60_000 });
  }
  await fsp.rm(servicePath, { force: true });
  await fsp.rm(timerPath, { force: true });
  if (!a.unitDir) await systemctlOrThrow(['daemon-reload']);
  return { name };
}

// ---------------------------------------------------------------------------
// Package managers
// ---------------------------------------------------------------------------

export const PACKAGE_MANAGERS = ['apt', 'dnf', 'pacman'] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

export const PACKAGE_VERBS = ['refresh', 'install', 'remove', 'upgrade', 'upgrade-all'] as const;
export type PackageVerb = (typeof PACKAGE_VERBS)[number];

const PKG_RE = /^[A-Za-z0-9][A-Za-z0-9+._:@~-]{0,127}$/;
export const MAX_PACKAGES = 200;

export function assertPackages(list: unknown, required: boolean): string[] {
  if (!Array.isArray(list)) {
    if (required) throw new HostFileError(400, 'Choose at least one package');
    return [];
  }
  if (list.length > MAX_PACKAGES) throw new HostFileError(400, `At most ${MAX_PACKAGES} packages at once`);
  const out = [...new Set(list)];
  for (const p of out) if (typeof p !== 'string' || !PKG_RE.test(p)) throw new HostFileError(400, `Invalid package name: ${String(p).slice(0, 60)}`);
  if (required && !out.length) throw new HostFileError(400, 'Choose at least one package');
  return out as string[];
}

const APT_ENV = { DEBIAN_FRONTEND: 'noninteractive', NEEDRESTART_MODE: 'a', APT_LISTCHANGES_FRONTEND: 'none' };
const APT_KEEP_CONFIG = ['-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold'];

/**
 * The command for a package transaction. `preview` simulates it and changes nothing.
 * Arch doesn't support partial upgrades, so pacman installs and upgrades always sync and upgrade
 * the whole system (-Syu), and individual upgrades aren't offered.
 */
export function packageCommand(manager: PackageManager, verb: PackageVerb, packages: string[], preview = false): { cmd: string; args: string[]; env: Record<string, string> } {
  if (!PACKAGE_MANAGERS.includes(manager)) throw new HostFileError(400, 'Unknown package manager');
  if (!PACKAGE_VERBS.includes(verb)) throw new HostFileError(400, 'Unknown package operation');
  const pkgs = assertPackages(packages, verb === 'install' || verb === 'remove' || verb === 'upgrade');
  if (preview && verb === 'refresh') throw new HostFileError(400, 'Nothing to preview');
  switch (manager) {
    case 'apt': {
      const mode = preview ? ['-s'] : ['-y', ...APT_KEEP_CONFIG];
      const args =
        verb === 'refresh' ? ['update']
        : verb === 'install' ? [...mode, 'install', ...pkgs]
        : verb === 'remove' ? [...mode, 'remove', ...pkgs]
        : verb === 'upgrade' ? [...mode, 'install', '--only-upgrade', ...pkgs]
        : [...mode, 'upgrade', '--with-new-pkgs'];
      return { cmd: 'apt-get', args, env: APT_ENV };
    }
    case 'dnf': {
      const mode = preview ? ['--assumeno'] : ['-y'];
      const args =
        verb === 'refresh' ? ['makecache', '--refresh']
        : verb === 'install' ? [...mode, 'install', ...pkgs]
        : verb === 'remove' ? [...mode, 'remove', ...pkgs]
        : verb === 'upgrade' ? [...mode, 'upgrade', ...pkgs]
        : [...mode, 'upgrade'];
      return { cmd: 'dnf', args, env: {} };
    }
    case 'pacman': {
      if (verb === 'upgrade') throw new HostFileError(400, 'Arch Linux doesn’t support upgrading individual packages — upgrade everything instead');
      const mode = preview ? ['--print'] : ['--noconfirm'];
      const args =
        verb === 'refresh' ? ['-Sy']
        : verb === 'install' ? ['-Syu', '--needed', ...mode, ...pkgs]
        : verb === 'remove' ? ['-Rs', ...mode, ...pkgs]
        : ['-Syu', ...mode];
      return { cmd: 'pacman', args, env: {} };
    }
  }
}

async function packageRun(a: { manager: PackageManager; verb: PackageVerb; packages: string[]; preview?: boolean }, emit?: Emit) {
  const c = packageCommand(a.manager, a.verb, a.packages ?? [], a.preview === true);
  emit?.(`$ ${c.cmd} ${c.args.join(' ')}\n`);
  const r = await runCommand(c.cmd, c.args, { env: c.env, timeoutMs: a.preview ? 5 * 60_000 : 60 * 60_000, onOutput: emit });
  const output = `${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`.trim();
  if (r.code === null) throw new HostFileError(502, `${c.cmd} couldn’t run: ${r.stderr.trim() || 'not installed'}`);
  // dnf --assumeno ends with exit 1 after printing the transaction; that's the preview.
  if (a.preview) return { code: r.code, output };
  if (r.code !== 0) throw new HostFileError(409, `${c.cmd} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().split('\n').filter(Boolean).slice(-2).join(' ')}`);
  return { code: r.code, output };
}

export const APT_AUTO_UPGRADES_FILE = '/etc/apt/apt.conf.d/20auto-upgrades';
export const DNF_AUTOMATIC_TIMER = 'dnf-automatic-install.timer';

/** Turns automatic updates on or off: unattended-upgrades on apt, dnf-automatic on dnf. */
async function setAutoUpdates(a: { manager: PackageManager; enabled: boolean }) {
  if (a.manager === 'apt') {
    if (!fs.existsSync('/usr/bin/unattended-upgrade')) throw new HostFileError(409, 'Install the unattended-upgrades package first');
    const v = a.enabled ? '1' : '0';
    await fsp.writeFile(APT_AUTO_UPGRADES_FILE, `APT::Periodic::Update-Package-Lists "${v}";\nAPT::Periodic::Unattended-Upgrade "${v}";\n`, { mode: 0o644 });
    return { enabled: a.enabled };
  }
  if (a.manager === 'dnf') {
    await systemctlOrThrow([a.enabled ? 'enable' : 'disable', '--now', '--', DNF_AUTOMATIC_TIMER]);
    return { enabled: a.enabled };
  }
  throw new HostFileError(400, 'Automatic updates aren’t supported for this package manager');
}

/** Operations the Admin Mode helper may run, besides the file operations. */
export const HOST_SYSTEM_OPS = {
  'unit.action': (a: { unit: string; action: UnitAction }) => unitAction(a),
  'timer.write': (a: { definition: TimerDefinition; enable: boolean; replace: boolean }) => writeTimer({ definition: a.definition, enable: a.enable === true, replace: a.replace === true }),
  'timer.delete': (a: { name: string }) => deleteTimer({ name: a.name }),
  'pkg.run': (a: { manager: PackageManager; verb: PackageVerb; packages: string[]; preview?: boolean }, emit?: Emit) => packageRun(a, emit),
  'pkg.autoUpdates': (a: { manager: PackageManager; enabled: boolean }) => setAutoUpdates({ manager: a.manager, enabled: a.enabled === true }),
};

/** For tests: write/delete timers into a scratch folder without touching systemd. */
export const __testing = { writeTimer, deleteTimer };

export type HostSystemOp = keyof typeof HOST_SYSTEM_OPS;
export type HostSystemArgs<K extends HostSystemOp> = Parameters<(typeof HOST_SYSTEM_OPS)[K]>[0];
export type HostSystemResult<K extends HostSystemOp> = Awaited<ReturnType<(typeof HOST_SYSTEM_OPS)[K]>>;
