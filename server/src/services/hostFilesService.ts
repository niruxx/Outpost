/**
 * Host File Manager sessions: limited access (the Outpost service account) by default, and an
 * opt-in Admin Mode that works like Cockpit's "administrative access" — the administrator
 * re-authenticates with their operating-system password, sudo starts a small privileged helper,
 * and file operations for that browser session go through the helper until Admin Mode is turned
 * off, the session idles out, or Outpost stops. The password is written once to sudo's stdin and
 * never stored.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { HttpError } from '../utils/asyncHandler.js';
import { HOST_FILE_OPS, HostFileError, type HostFileArgs, type HostFileOp, type HostFileResult } from './hostFileOps.js';
import { HOST_ADMIN_OPS, type HostAdminArgs, type HostAdminOp, type HostAdminResult } from './hostAdminOps.js';

const IDLE_MS = 15 * 60_000;
const MAX_AGE_MS = 8 * 60 * 60_000;
const MAX_HELPERS = 8;
const START_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 120_000;
const FAILURE_WINDOW_MS = 5 * 60_000;
const MAX_FAILURES = 5;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  onProgress?: (chunk: string) => void;
}

interface Helper {
  child: ChildProcessWithoutNullStreams;
  pending: Map<number, PendingRequest>;
  nextId: number;
  /** Admin Mode ended while work was running: stop once the last request finishes. */
  retiring?: boolean;
}

interface AdminSession {
  userId: string;
  username: string;
  startedAt: number;
  lastUsedAt: number;
  helper: Helper | null; // null when Outpost itself already has administrative rights
}

const sessions = new Map<string, AdminSession>();
const failures = new Map<string, number[]>();
const starting = new Set<string>();

const keyOf = (token: string) => crypto.createHash('sha256').update(token).digest('base64url');

let windowsElevated: boolean | null = null;
/** Whether the Outpost process already runs with administrative rights (root / elevated). */
export function processIsPrivileged(): boolean {
  if (process.platform !== 'win32') return process.getuid?.() === 0;
  if (windowsElevated === null) {
    // `net session` only succeeds from an elevated token.
    windowsElevated = spawnSync('net', ['session'], { stdio: 'ignore', windowsHide: true, timeout: 5000 }).status === 0;
  }
  return windowsElevated;
}

let sudoCheck: { at: number; installed: boolean; passwordless: boolean } | null = null;
function sudoState() {
  if (sudoCheck && Date.now() - sudoCheck.at < 60_000) return sudoCheck;
  // -k ignores cached credentials, -n never prompts: success means NOPASSWD rules apply.
  const probe = spawnSync('sudo', ['-k', '-n', 'true'], { stdio: 'ignore', timeout: 5000 });
  const installed = !(probe.error && (probe.error as NodeJS.ErrnoException).code === 'ENOENT');
  sudoCheck = { at: Date.now(), installed, passwordless: installed && probe.status === 0 };
  return sudoCheck;
}

function adminAvailability() {
  if (processIsPrivileged()) return { available: true, needsPassword: false, alwaysOn: true, reason: null as string | null };
  if (process.platform === 'win32') {
    return { available: false, needsPassword: false, alwaysOn: false, reason: 'Windows does not allow elevating a running service without a UAC prompt. Run Outpost as an administrator to manage protected files.' };
  }
  const sudo = sudoState();
  if (!sudo.installed) return { available: false, needsPassword: false, alwaysOn: false, reason: 'sudo is not installed on this host, so Admin Mode is unavailable.' };
  return { available: true, needsPassword: !sudo.passwordless, alwaysOn: false, reason: null };
}

function expire() {
  const now = Date.now();
  for (const [key, session] of sessions) {
    // Never time out in the middle of privileged work (a package upgrade can take a long time).
    if (session.helper?.pending.size) continue;
    if (now - session.lastUsedAt > IDLE_MS || now - session.startedAt > MAX_AGE_MS) endSession(key);
  }
}
const sweeper = setInterval(expire, 30_000);
sweeper.unref();

function endSession(key: string, force = false) {
  const session = sessions.get(key);
  if (!session) return;
  sessions.delete(key);
  if (force || !session.helper?.pending.size) stopHelper(session.helper);
  // A running transaction is left to finish (killing dpkg/rpm halfway can break the system); the
  // session is gone, so nothing new can be sent, and the helper stops after its last answer.
  else session.helper.retiring = true;
}

function stopHelper(helper: Helper | null) {
  if (!helper) return;
  for (const [, request] of helper.pending) {
    clearTimeout(request.timer);
    request.reject(new HttpError(409, 'Admin Mode ended'));
  }
  helper.pending.clear();
  try { helper.child.stdin.end(); } catch { /* already closed */ }
  setTimeout(() => { try { helper.child.kill('SIGTERM'); } catch { /* gone */ } }, 1000).unref();
}

function helperCommand() {
  const here = fileURLToPath(import.meta.url);
  // Same runtime as this process: compiled .js in production, .ts through tsx's loader in dev.
  const script = path.join(path.dirname(here), `hostFilesHelper${path.extname(here)}`);
  const execArgv = process.execArgv.filter((arg) => !/^--(inspect|debug|watch)/.test(arg));
  return { file: process.execPath, args: [...execArgv, script] };
}

/** Starts the helper through sudo and waits for it to report that it runs as root. */
function startHelper(password: string): Promise<Helper> {
  const command = helperCommand();
  if (!fs.existsSync(command.args[command.args.length - 1])) throw new HttpError(500, 'The Admin Mode helper is missing from this installation. Rebuild Outpost.');
  return new Promise((resolve, reject) => {
    // -S reads the password from stdin, -k always asks for it (like Cockpit), -p '' prints no prompt.
    const child = spawn('sudo', ['-S', '-k', '-p', '', '--', command.file, ...command.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: '/',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    });
    const helper: Helper = { child, pending: new Map(), nextId: 1 };
    let settled = false;
    let stderr = '';
    const fail = (message: string, status = 403) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch { /* closed */ }
      try { child.kill('SIGTERM'); } catch { /* gone */ }
      reject(new HttpError(status, message));
    };
    const timer = setTimeout(() => fail('sudo did not respond. Check the host’s sudo configuration.', 504), START_TIMEOUT_MS);
    child.on('error', (err) => fail(`Unable to run sudo: ${err.message}`, 500));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
      if (/sorry, try again|incorrect password/i.test(stderr)) fail('Incorrect password');
      else if (/not in the sudoers|not allowed to (run|execute)|may not run sudo/i.test(stderr)) fail(`${os.userInfo().username} is not allowed to use sudo on this host`);
      else if (/must have a tty|no tty present/i.test(stderr)) fail('This host’s sudo policy requires a terminal (requiretty). Allow the Outpost account to use sudo without a TTY to enable Admin Mode.');
    });
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      let message: { ready?: boolean; uid?: number | null; id?: number; ok?: boolean; result?: unknown; error?: string; status?: number };
      try { message = JSON.parse(line); } catch { return; }
      if (!settled) {
        if (message.ready) {
          settled = true;
          clearTimeout(timer);
          if (message.uid !== 0) { stopHelper(helper); reject(new HttpError(403, 'sudo did not grant root access')); return; }
          resolve(helper);
        }
        return;
      }
      const request = typeof message.id === 'number' ? helper.pending.get(message.id) : undefined;
      if (!request) return;
      if (typeof (message as { progress?: unknown }).progress === 'string') {
        request.onProgress?.((message as { progress: string }).progress);
        return;
      }
      helper.pending.delete(message.id!);
      clearTimeout(request.timer);
      for (const session of sessions.values()) if (session.helper === helper) session.lastUsedAt = Date.now();
      if (message.ok) request.resolve(message.result);
      else request.reject(new HttpError(message.status ?? 500, message.error ?? 'Operation failed'));
      if (helper.retiring && helper.pending.size === 0) stopHelper(helper);
    });
    child.on('exit', () => {
      fail(stderr.trim().split('\n').pop() || 'Authentication failed');
      for (const [, request] of helper.pending) {
        clearTimeout(request.timer);
        request.reject(new HttpError(409, 'Admin Mode helper stopped. Turn Admin Mode on again.'));
      }
      helper.pending.clear();
      for (const [key, session] of sessions) if (session.helper === helper) sessions.delete(key);
    });
    // Password once, then nothing else until requests. With NOPASSWD sudo the helper ignores it.
    child.stdin.write(`${password}\n`);
  });
}

function helperRequest(helper: Helper, op: string, args: unknown, opts: { timeoutMs?: number; onProgress?: (chunk: string) => void } = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = helper.nextId++;
    const timer = setTimeout(() => {
      helper.pending.delete(id);
      reject(new HttpError(504, 'The privileged helper did not answer in time'));
    }, opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
    helper.pending.set(id, { resolve, reject, timer, onProgress: opts.onProgress });
    helper.child.stdin.write(`${JSON.stringify({ id, op, args })}\n`);
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function hostFilesStatus(token: string) {
  expire();
  const account = os.userInfo();
  const availability = adminAvailability();
  const session = sessions.get(keyOf(token));
  const active = availability.alwaysOn || !!session;
  return {
    platform: process.platform,
    serviceUser: account.username,
    home: fs.existsSync(account.homedir) ? account.homedir : process.platform === 'win32' ? 'C:\\' : '/',
    root: process.platform === 'win32' ? path.parse(account.homedir).root || 'C:\\' : '/',
    admin: {
      ...availability,
      active,
      since: session ? new Date(session.startedAt).toISOString() : null,
      idleMinutes: IDLE_MS / 60_000,
    },
  };
}

export async function enableAdminMode(token: string, identity: { id: string; username: string }, password: unknown) {
  const key = keyOf(token);
  const availability = adminAvailability();
  if (!availability.available) throw new HttpError(400, availability.reason ?? 'Admin Mode is unavailable');
  if (availability.alwaysOn) return hostFilesStatus(token);
  if (sessions.has(key)) return hostFilesStatus(token);
  if (availability.needsPassword && (typeof password !== 'string' || !password)) throw new HttpError(400, 'Enter your password');
  if (typeof password === 'string' && (password.length > 1024 || /[\r\n\0]/.test(password))) throw new HttpError(400, 'Invalid password');
  const recent = (failures.get(identity.id) ?? []).filter((at) => Date.now() - at < FAILURE_WINDOW_MS);
  if (recent.length >= MAX_FAILURES) throw new HttpError(429, 'Too many failed attempts. Wait a few minutes and try again.');
  if (starting.has(key)) throw new HttpError(409, 'Admin Mode is already being turned on');
  if ([...sessions.values()].filter((s) => s.helper).length >= MAX_HELPERS) throw new HttpError(429, 'Too many Admin Mode sessions are active. Turn one off first.');
  starting.add(key);
  try {
    const helper = await startHelper(typeof password === 'string' ? password : '');
    sessions.set(key, { userId: identity.id, username: identity.username, startedAt: Date.now(), lastUsedAt: Date.now(), helper });
    failures.delete(identity.id);
  } catch (err) {
    if (err instanceof HttpError && err.status === 403) failures.set(identity.id, [...recent, Date.now()]);
    throw err;
  } finally {
    starting.delete(key);
  }
  return hostFilesStatus(token);
}

export function disableAdminMode(token: string) {
  endSession(keyOf(token));
  return hostFilesStatus(token);
}

/** Ends every Admin Mode session belonging to a user (e.g. on sign-out or demotion). */
export function endAdminModeForUser(userId: string) {
  for (const [key, session] of sessions) if (session.userId === userId) endSession(key);
}

export function isAdminModeActive(token: string) {
  return processIsPrivileged() || sessions.has(keyOf(token));
}

/** Runs one file operation as the service account, or through the helper in Admin Mode. */
export async function runHostFileOp<K extends HostFileOp>(token: string, op: K, args: HostFileArgs<K>): Promise<HostFileResult<K>> {
  expire();
  const session = sessions.get(keyOf(token));
  try {
    if (session?.helper) {
      session.lastUsedAt = Date.now();
      return (await helperRequest(session.helper, op, args)) as HostFileResult<K>;
    }
    return (await (HOST_FILE_OPS[op] as (a: HostFileArgs<K>) => Promise<HostFileResult<K>>)(args));
  } catch (err) {
    if (err instanceof HostFileError) throw new HttpError(err.status, err.message);
    throw err;
  }
}

/**
 * Runs a privileged host-administration operation (services, timers, packages). Unlike file
 * operations there is no limited-access fallback: Admin Mode must be on for this browser session.
 */
export async function runHostSystemOp<K extends HostAdminOp>(
  token: string,
  op: K,
  args: HostAdminArgs<K>,
  opts: { timeoutMs?: number; onProgress?: (chunk: string) => void } = {}
): Promise<HostAdminResult<K>> {
  expire();
  const session = sessions.get(keyOf(token));
  try {
    if (session?.helper) {
      session.lastUsedAt = Date.now();
      return (await helperRequest(session.helper, op, args, opts)) as HostAdminResult<K>;
    }
    if (processIsPrivileged()) {
      const fn = HOST_ADMIN_OPS[op] as unknown as (a: HostAdminArgs<K>, emit?: (chunk: string) => void) => Promise<HostAdminResult<K>>;
      return await fn(args, opts.onProgress);
    }
  } catch (err) {
    if (err instanceof HostFileError) throw new HttpError(err.status, err.message);
    throw err;
  }
  throw new HttpError(403, 'Turn on Admin Mode (top bar) to make changes to the host');
}

export function stopHostFileSessions() {
  for (const key of [...sessions.keys()]) endSession(key, true);
}
