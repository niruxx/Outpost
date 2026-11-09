/**
 * Host accounts for the Accounts page, read as the Outpost service account: users and groups
 * from NSS (getent), login sessions from logind, recent logins from wtmp, and password policy
 * defaults from /etc/login.defs. Password state (/etc/shadow) needs Admin Mode and is merged in
 * by the route when available.
 */
import fs from 'node:fs';
import os from 'node:os';
import { adminGroupFrom, parsePasswd, readShells, uidMin } from './hostAccountsOps.js';
import { runCommand } from './hostSystemOps.js';

export interface HostGroup {
  name: string;
  gid: number;
  members: string[];
  system: boolean;
}

export interface HostSession {
  id: string;
  user: string;
  tty: string | null;
  remoteHost: string | null;
  service: string | null;
  since: string | null;
  state: string | null;
  type: string | null;
}

export function parseGroups(text: string, min: number): HostGroup[] {
  return text
    .split('\n')
    .map((l) => l.split(':'))
    .filter((f) => f.length >= 4 && f[0])
    .map((f) => ({ name: f[0], gid: Number(f[2]), members: f[3] ? f[3].split(',').filter(Boolean) : [], system: Number(f[2]) < min }));
}

/** `last -F -w` → most recent login per user. */
export function parseLast(text: string): Map<string, { at: string; from: string | null }> {
  const out = new Map<string, { at: string; from: string | null }>();
  for (const line of text.split('\n')) {
    // user  pts/0  192.168.1.5  Mon Nov  9 10:00:01 2026 - ...
    const m = line.match(/^(\S+)\s+(\S+)\s+(\S*)\s+((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \w{3} +\d+ \d\d:\d\d:\d\d \d{4})/);
    if (!m || m[1] === 'reboot' || m[1] === 'wtmp' || out.has(m[1])) continue;
    const at = new Date(`${m[4]}`);
    out.set(m[1], { at: Number.isNaN(at.getTime()) ? m[4] : at.toISOString(), from: m[3] && !/^(:|tty|-)/.test(m[3]) ? m[3] : null });
  }
  return out;
}

export function parseLoginDefs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s+(\S+)/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const read = (file: string) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

async function sessions(): Promise<HostSession[]> {
  const list = await runCommand('loginctl', ['list-sessions', '--no-legend', '--no-pager'], { timeoutMs: 10_000 });
  const ids = list.stdout.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((id) => id && /^[A-Za-z0-9_-]+$/.test(id));
  if (!ids.length) return [];
  const show = await runCommand('loginctl', ['show-session', '-p', 'Id', '-p', 'Name', '-p', 'TTY', '-p', 'RemoteHost', '-p', 'Service', '-p', 'Timestamp', '-p', 'State', '-p', 'Type', '--', ...ids], { timeoutMs: 10_000 });
  return show.stdout
    .split(/\n\s*\n/)
    .map((block) => Object.fromEntries(block.split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])))
    .filter((b) => b.Id)
    .map((b) => {
      const since = b.Timestamp ? new Date(b.Timestamp.replace(/^\w{3} /, '')) : null;
      return {
        id: b.Id,
        user: b.Name ?? '',
        tty: b.TTY || null,
        remoteHost: b.RemoteHost || null,
        service: b.Service || null,
        since: since && !Number.isNaN(since.getTime()) ? since.toISOString() : b.Timestamp || null,
        state: b.State || null,
        type: b.Type || null,
      };
    });
}

export async function accountsOverview() {
  if (process.platform !== 'linux') return { available: false, reason: 'Account management is only available on Linux hosts.' } as const;
  const loginDefs = read('/etc/login.defs');
  const min = uidMin(loginDefs);
  const [passwd, group, last, sess] = await Promise.all([
    runCommand('getent', ['passwd'], { timeoutMs: 15_000 }),
    runCommand('getent', ['group'], { timeoutMs: 15_000 }),
    runCommand('last', ['-F', '-w', '-n', '500'], { timeoutMs: 15_000 }),
    sessions(),
  ]);
  const groups = parseGroups(group.stdout, min);
  const adminGroup = adminGroupFrom(group.stdout);
  const lastLogins = parseLast(last.stdout);
  const primaryByGid = new Map(groups.map((g) => [g.gid, g.name]));
  const users = parsePasswd(passwd.stdout).map((u) => ({
    ...u,
    system: u.uid < min && u.uid !== 0,
    root: u.uid === 0,
    primaryGroup: primaryByGid.get(u.gid) ?? String(u.gid),
    groups: groups.filter((g) => g.members.includes(u.name)).map((g) => g.name),
    admin: adminGroup ? groups.some((g) => g.name === adminGroup && g.members.includes(u.name)) : false,
    canLogin: !/(nologin|false)$/.test(u.shell),
    lastLogin: lastLogins.get(u.name) ?? null,
    sessions: sess.filter((s) => s.user === u.name).length,
  }));
  const defs = parseLoginDefs(loginDefs);
  return {
    available: true,
    reason: null,
    serviceUser: os.userInfo().username,
    uidMin: min,
    adminGroup,
    shells: readShells(read('/etc/shells')),
    policy: {
      maxDays: defs.PASS_MAX_DAYS ? Number(defs.PASS_MAX_DAYS) : null,
      minDays: defs.PASS_MIN_DAYS ? Number(defs.PASS_MIN_DAYS) : null,
      warnAge: defs.PASS_WARN_AGE ? Number(defs.PASS_WARN_AGE) : null,
      minLength: defs.PASS_MIN_LEN ? Number(defs.PASS_MIN_LEN) : null,
    },
    users,
    groups,
    sessions: sess,
  } as const;
}
