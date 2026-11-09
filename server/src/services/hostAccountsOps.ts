/**
 * Privileged host account operations (users, groups, SSH keys, sessions) for the Accounts page.
 * Runs inside Outpost when it is root or inside the Admin Mode helper; no panel imports. Every
 * argument is validated here, and system accounts (uid below UID_MIN, and root) can't be deleted,
 * locked or have their passwords changed from the panel.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { HostFileError } from './hostFileOps.js';
import { runCommand } from './hostSystemOps.js';

export const NAME_RE = /^[a-z_][a-z0-9_.-]{0,31}\$?$/;
const KEY_TYPES = /^(ssh-(rsa|dss|ed25519)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com)$/;

export function assertName(v: unknown, what = 'name'): string {
  if (typeof v !== 'string' || !NAME_RE.test(v)) throw new HostFileError(400, `Invalid ${what}: use lowercase letters, digits, "-", "_" or "." (max 32)`);
  return v;
}

function assertPassword(v: unknown): string {
  if (typeof v !== 'string' || v.length < 1 || v.length > 512 || /[\r\n\0]/.test(v)) throw new HostFileError(400, 'Invalid password');
  return v;
}

function assertText(v: unknown, what: string, max = 200): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length > max || /[:\r\n\0]/.test(s)) throw new HostFileError(400, `${what} may not contain ":" or line breaks`);
  return s;
}

export function readShells(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('/'));
}

function assertShell(v: unknown): string {
  if (typeof v !== 'string' || !v) throw new HostFileError(400, 'Choose a shell');
  let shells: string[] = [];
  try {
    shells = readShells(fs.readFileSync('/etc/shells', 'utf8'));
  } catch {
    // no /etc/shells: allow the common nologin shells only
  }
  const allowed = new Set([...shells, '/usr/sbin/nologin', '/sbin/nologin', '/bin/false', '/usr/bin/false']);
  if (!allowed.has(v)) throw new HostFileError(400, `${v} isn’t listed in /etc/shells`);
  return v;
}

/** UID_MIN from /etc/login.defs (default 1000). */
export function uidMin(loginDefs?: string): number {
  let text = loginDefs;
  if (text === undefined) {
    try {
      text = fs.readFileSync('/etc/login.defs', 'utf8');
    } catch {
      text = '';
    }
  }
  const m = text.match(/^\s*UID_MIN\s+(\d+)/m);
  return m ? Number(m[1]) : 1000;
}

export interface PasswdEntry {
  name: string;
  uid: number;
  gid: number;
  gecos: string;
  home: string;
  shell: string;
}

export function parsePasswd(text: string): PasswdEntry[] {
  return text
    .split('\n')
    .map((l) => l.split(':'))
    .filter((f) => f.length >= 7 && f[0])
    .map((f) => ({ name: f[0], uid: Number(f[2]), gid: Number(f[3]), gecos: f[4].split(',')[0], home: f[5], shell: f[6] }));
}

async function lookup(name: string): Promise<PasswdEntry> {
  const r = await runCommand('getent', ['passwd', name], { timeoutMs: 10_000 });
  const entry = parsePasswd(r.stdout)[0];
  if (!entry) throw new HostFileError(404, `No account called ${name}`);
  return entry;
}

/** Refuses changes to root and system accounts. */
async function regularAccount(name: string): Promise<PasswdEntry> {
  const entry = await lookup(assertName(name, 'user name'));
  if (entry.uid === 0) throw new HostFileError(403, 'root can’t be changed here');
  if (entry.uid < uidMin()) throw new HostFileError(403, `${name} is a system account (uid ${entry.uid}) and can’t be changed here`);
  if (process.env.SUDO_USER && process.env.SUDO_USER === name) throw new HostFileError(403, `${name} is the account Outpost runs as`);
  return entry;
}

async function must(cmd: string, args: string[], input?: string) {
  const r = await runCommand(cmd, args, { timeoutMs: 60_000, input });
  if (r.code !== 0) throw new HostFileError(r.code === null ? 502 : 422, `${cmd}: ${(r.stderr || r.stdout).trim().split('\n').pop() || `exit ${r.code}`}`);
  return r;
}

export function adminGroupFrom(groupText: string): string | null {
  const names = new Set(groupText.split('\n').map((l) => l.split(':')[0]));
  return names.has('sudo') ? 'sudo' : names.has('wheel') ? 'wheel' : null;
}

async function adminGroup(): Promise<string | null> {
  return adminGroupFrom((await runCommand('getent', ['group'], { timeoutMs: 10_000 })).stdout);
}

async function setPassword(name: string, password: string) {
  // chpasswd reads "user:password" from stdin, so the password never appears in a process list.
  await must('chpasswd', [], `${name}:${password}\n`);
}

async function createAccount(a: { username: string; fullName?: string; shell: string; groups?: string[]; password?: string; admin?: boolean; forceChange?: boolean }) {
  const name = assertName(a.username, 'user name');
  const groups = (a.groups ?? []).map((g) => assertName(g, 'group'));
  const args = ['-m', '-s', assertShell(a.shell)];
  const full = assertText(a.fullName, 'Full name');
  if (full) args.push('-c', full);
  if (a.admin) {
    const g = await adminGroup();
    if (g) groups.push(g);
  }
  if (groups.length) args.push('-G', [...new Set(groups)].join(','));
  await must('useradd', [...args, '--', name]);
  if (a.password) {
    await setPassword(name, assertPassword(a.password));
    if (a.forceChange) await must('chage', ['-d', '0', '--', name]);
  }
  return { username: name };
}

async function modifyAccount(a: {
  username: string;
  fullName?: string;
  shell?: string;
  groups?: string[];
  admin?: boolean;
  locked?: boolean;
  password?: string;
  forceChange?: boolean;
  expireDate?: string | null;
  maxDays?: number | null;
}) {
  const entry = await regularAccount(a.username);
  const name = entry.name;
  const mod: string[] = [];
  if (a.fullName !== undefined) mod.push('-c', assertText(a.fullName, 'Full name'));
  if (a.shell !== undefined) mod.push('-s', assertShell(a.shell));
  if (a.groups !== undefined || a.admin !== undefined) {
    const current = (await runCommand('id', ['-nG', '--', name], { timeoutMs: 10_000 })).stdout.trim().split(/\s+/).filter(Boolean);
    const primary = (await runCommand('id', ['-gn', '--', name], { timeoutMs: 10_000 })).stdout.trim();
    let next = a.groups !== undefined ? a.groups.map((g) => assertName(g, 'group')) : current.filter((g) => g !== primary);
    const ag = await adminGroup();
    if (ag && a.admin === true) next.push(ag);
    if (ag && a.admin === false) next = next.filter((g) => g !== ag);
    mod.push('-G', [...new Set(next.filter((g) => g !== primary))].join(','));
  }
  if (mod.length) await must('usermod', [...mod, '--', name]);
  if (a.password !== undefined) await setPassword(name, assertPassword(a.password));
  if (a.locked === true) {
    await must('usermod', ['-L', '--', name]);
    // Locking the password doesn't stop SSH keys; expiring the account does.
    await must('chage', ['-E', '0', '--', name]);
  } else if (a.locked === false) {
    await must('usermod', ['-U', '--', name]).catch((err) => {
      // "unlocking would result in a passwordless account" — leave the password locked, re-enable the account.
      if (!/passwordless/.test(String(err?.message))) throw err;
    });
    await must('chage', ['-E', '-1', '--', name]);
  }
  if (a.forceChange) await must('chage', ['-d', '0', '--', name]);
  if (a.expireDate !== undefined && a.locked === undefined) {
    if (a.expireDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(a.expireDate)) throw new HostFileError(400, 'Expiry date must be YYYY-MM-DD');
    await must('chage', ['-E', a.expireDate ?? '-1', '--', name]);
  }
  if (a.maxDays !== undefined) {
    const n = a.maxDays === null ? -1 : Number(a.maxDays);
    if (!Number.isInteger(n) || n < -1 || n > 99999) throw new HostFileError(400, 'Password lifetime must be a number of days');
    await must('chage', ['-M', String(n), '--', name]);
  }
  return { username: name };
}

async function deleteAccount(a: { username: string; removeHome?: boolean }) {
  const entry = await regularAccount(a.username);
  // Stop the account's processes first; userdel refuses while the user is logged in.
  await runCommand('loginctl', ['terminate-user', '--', entry.name], { timeoutMs: 15_000 });
  await must('userdel', [...(a.removeHome ? ['-r'] : []), '--', entry.name]);
  return { username: entry.name };
}

export interface ShadowInfo {
  name: string;
  /** "!" or "*" prefix, or an expired account. */
  locked: boolean;
  hasPassword: boolean;
  lastChange: string | null;
  maxDays: number | null;
  expires: string | null;
  mustChange: boolean;
}

const dayToIso = (d: string) => (d && Number.isFinite(Number(d)) ? new Date(Number(d) * 86_400_000).toISOString().slice(0, 10) : null);

/** /etc/shadow without the hashes. */
export function parseShadow(text: string, today = Math.floor(Date.now() / 86_400_000)): ShadowInfo[] {
  return text
    .split('\n')
    .map((l) => l.split(':'))
    .filter((f) => f.length >= 8 && f[0])
    .map((f) => {
      const hash = f[1];
      const expireDay = f[7] ? Number(f[7]) : null;
      return {
        name: f[0],
        locked: hash.startsWith('!') || (expireDay !== null && expireDay <= today),
        hasPassword: hash.replace(/^!+/, '').length > 2 && !hash.replace(/^!+/, '').startsWith('*'),
        lastChange: f[2] === '0' ? null : dayToIso(f[2]),
        maxDays: f[4] && Number(f[4]) < 99999 ? Number(f[4]) : null,
        expires: expireDay !== null ? dayToIso(String(expireDay)) : null,
        mustChange: f[2] === '0',
      };
    });
}

async function shadow() {
  return parseShadow(await fsp.readFile('/etc/shadow', 'utf8'));
}

/** Validates authorized_keys content line by line (comments and options allowed). */
export function validateAuthorizedKeys(content: string): string {
  if (typeof content !== 'string' || content.length > 256 * 1024 || content.includes('\0')) throw new HostFileError(400, 'Invalid key list');
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  lines.forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    // Options come first when present: find the key type token.
    const tokens = t.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
    const idx = tokens.findIndex((tok) => KEY_TYPES.test(tok));
    if (idx === -1 || !/^[A-Za-z0-9+/]+=*$/.test(tokens[idx + 1] ?? '')) throw new HostFileError(400, `Line ${i + 1} isn’t a valid SSH public key`);
  });
  return lines.join('\n').replace(/\n*$/, '\n');
}

async function readKeys(a: { username: string }) {
  const entry = await lookup(assertName(a.username, 'user name'));
  try {
    return { content: await fsp.readFile(path.join(entry.home, '.ssh', 'authorized_keys'), 'utf8') };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { content: '' };
    throw err;
  }
}

async function writeKeys(a: { username: string; content: string }) {
  const entry = await lookup(assertName(a.username, 'user name'));
  if (entry.uid === 0) throw new HostFileError(403, 'root’s SSH keys can’t be changed here');
  const content = validateAuthorizedKeys(a.content);
  const dir = path.join(entry.home, '.ssh');
  // Never follow a symlink planted by the user into a root-owned location.
  for (const p of [entry.home, dir]) {
    try {
      if ((await fsp.lstat(p)).isSymbolicLink()) throw new HostFileError(409, `${p} is a symbolic link; refusing to write keys`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  await fsp.chown(dir, entry.uid, entry.gid);
  await fsp.chmod(dir, 0o700);
  const file = path.join(dir, 'authorized_keys');
  const tmp = `${file}.outpost-${process.pid}`;
  await fsp.writeFile(tmp, content, { mode: 0o600, flag: 'wx' });
  await fsp.chown(tmp, entry.uid, entry.gid);
  await fsp.rename(tmp, file);
  return { keys: content.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).length };
}

async function createGroup(a: { name: string }) {
  await must('groupadd', ['--', assertName(a.name, 'group')]);
  return { name: a.name };
}

async function deleteGroup(a: { name: string }) {
  const name = assertName(a.name, 'group');
  const r = await runCommand('getent', ['group', name], { timeoutMs: 10_000 });
  const gid = Number(r.stdout.split(':')[2]);
  if (!r.stdout || !Number.isFinite(gid)) throw new HostFileError(404, `No group called ${name}`);
  if (gid < uidMin()) throw new HostFileError(403, `${name} is a system group and can’t be deleted here`);
  await must('groupdel', ['--', name]);
  return { name };
}

async function groupMembers(a: { name: string; add?: string[]; remove?: string[] }) {
  const name = assertName(a.name, 'group');
  for (const u of a.add ?? []) await must('gpasswd', ['-a', assertName(u, 'user name'), name]);
  for (const u of a.remove ?? []) await must('gpasswd', ['-d', assertName(u, 'user name'), name]);
  return { name };
}

async function terminateSession(a: { id: string }) {
  if (typeof a.id !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(a.id)) throw new HostFileError(400, 'Invalid session');
  await must('loginctl', ['terminate-session', '--', a.id]);
  return { id: a.id };
}

export const ACCOUNT_OPS = {
  'account.create': createAccount,
  'account.modify': modifyAccount,
  'account.delete': deleteAccount,
  'account.shadow': () => shadow(),
  'account.keys.read': readKeys,
  'account.keys.write': writeKeys,
  'group.create': createGroup,
  'group.delete': deleteGroup,
  'group.members': groupMembers,
  'session.terminate': terminateSession,
};
