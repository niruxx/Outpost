import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { HttpError } from '../utils/asyncHandler.js';

/**
 * The host's own logs, for admins: the systemd journal (journalctl), service units (systemctl),
 * and the plain-text logs under /var/log. Read-only; commands run with argument arrays, and file
 * paths are confined to the log folder (symlinks included).
 *
 * Reading other users' journal entries and most of /var/log needs the panel's user to be in the
 * systemd-journal and adm groups — the status says so when it isn't.
 */

export interface JournalEntry {
  time: string; // ISO
  unit: string | null;
  identifier: string | null;
  priority: number; // 0 emerg … 7 debug
  pid: string | null;
  hostname: string | null;
  message: string;
}

export interface LogFile {
  path: string; // relative to the log folder
  size: number;
  modifiedAt: string;
  readable: boolean;
  compressed: boolean;
}

export interface ServiceUnit {
  unit: string;
  load: string;
  active: string;
  sub: string;
  description: string;
}

type Exec = (cmd: string, args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const MAX_LINES = 2000;
const TAIL_BYTES = 2 * 1024 * 1024;
const MAX_GUNZIP_BYTES = 20 * 1024 * 1024;

export const SINCE_CHOICES: Record<string, string> = {
  '15m': '-15m',
  '1h': '-1h',
  '6h': '-6h',
  '24h': '-24h',
  '7d': '-7d',
};

/** Parses `journalctl -o json` output (one JSON object per line). */
export function parseJournal(stdout: string): JournalEntry[] {
  const out: JournalEntry[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    // MESSAGE can be an array of bytes when it isn't valid UTF-8.
    const raw = e.MESSAGE;
    const message = typeof raw === 'string' ? raw : Array.isArray(raw) ? Buffer.from(raw as number[]).toString('utf8') : '';
    const usec = Number(e.__REALTIME_TIMESTAMP);
    out.push({
      time: Number.isFinite(usec) ? new Date(usec / 1000).toISOString() : '',
      unit: typeof e._SYSTEMD_UNIT === 'string' ? e._SYSTEMD_UNIT : typeof e.UNIT === 'string' ? e.UNIT : null,
      identifier: typeof e.SYSLOG_IDENTIFIER === 'string' ? e.SYSLOG_IDENTIFIER : null,
      priority: Number.isFinite(Number(e.PRIORITY)) ? Number(e.PRIORITY) : 6,
      pid: typeof e._PID === 'string' ? e._PID : null,
      hostname: typeof e._HOSTNAME === 'string' ? e._HOSTNAME : null,
      message,
    });
  }
  return out;
}

/** Parses `systemctl list-units --plain --no-legend` lines. */
export function parseUnits(stdout: string): ServiceUnit[] {
  return stdout
    .split('\n')
    .map((l) => l.trim().replace(/^●\s*/, ''))
    .filter(Boolean)
    .map((l) => {
      const [unit, load, active, sub, ...rest] = l.split(/\s+/);
      return { unit, load, active, sub, description: rest.join(' ') };
    })
    .filter((u) => u.unit?.endsWith('.service'));
}

const realExec: Exec = (cmd, args) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { env: { ...process.env, LC_ALL: 'C', SYSTEMD_COLORS: '0', SYSTEMD_PAGER: '' } });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.stdout.on('data', (d) => {
      stdout += d;
      if (stdout.length > 20 * 1024 * 1024) child.kill('SIGKILL');
    });
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

export function createSystemLogs(env: { platform: NodeJS.Platform; root: string; exec: Exec; user: string }) {
  const permissionHint = `Outpost runs as "${env.user}". To read every log, add it to the log groups and restart Outpost: sudo usermod -aG systemd-journal,adm ${env.user}`;

  async function status() {
    if (env.platform !== 'linux') {
      return { available: false, reason: 'System logs (journald and /var/log) are only available on Linux hosts.', journal: false, hint: null as string | null };
    }
    const probe = await env.exec('journalctl', ['--no-pager', '-n', '1', '-o', 'json']);
    const journal = probe.code !== null;
    const limited = /not seeing messages from other users|insufficient permissions/i.test(probe.stderr);
    return { available: true, reason: null, journal, hint: limited ? permissionHint : null };
  }

  async function journal(opts: { unit?: string; priority?: number; since?: string; grep?: string; lines?: number }): Promise<{ entries: JournalEntry[]; hint: string | null }> {
    if (env.platform !== 'linux') throw new HttpError(409, 'Only available on Linux hosts');
    const args = ['--no-pager', '-o', 'json', '-n', String(Math.min(Math.max(opts.lines ?? 300, 1), MAX_LINES))];
    if (opts.unit) {
      if (!/^[\w@.:\-\\]{1,128}$/.test(opts.unit)) throw new HttpError(400, 'Invalid unit name');
      args.push('-u', opts.unit);
    }
    if (opts.priority !== undefined) {
      if (!Number.isInteger(opts.priority) || opts.priority < 0 || opts.priority > 7) throw new HttpError(400, 'Priority must be 0–7');
      args.push('-p', String(opts.priority));
    }
    if (opts.since) {
      const since = SINCE_CHOICES[opts.since];
      if (!since) throw new HttpError(400, 'Unknown period');
      args.push('--since', since);
    }
    if (opts.grep && opts.grep.length > 200) throw new HttpError(400, 'Search is too long');
    // Case-insensitive literal match: escape regex syntax so the search is plain text.
    const grepArgs = opts.grep ? ['--case-sensitive=false', '-g', opts.grep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')] : [];
    let r = await env.exec('journalctl', [...args, ...grepArgs]);
    let filterHere = false;
    // Older journalctl lacks --case-sensitive, and some builds have no pattern matching at all:
    // then fetch a wider window and filter it here.
    if (opts.grep && r.code !== 0 && /unrecognized option|case-sensitive|pattern matching|Compiled without/i.test(r.stderr)) {
      const wider = args.map((a, i) => (args[i - 1] === '-n' ? String(MAX_LINES * 5) : a));
      r = await env.exec('journalctl', wider);
      filterHere = true;
    }
    if (r.code === null) throw new HttpError(502, `journalctl couldn’t run: ${r.stderr.trim() || 'not installed'}`);
    // "-- No entries --" is a normal empty result (exit 1 on some versions with -g).
    if (r.code !== 0 && !/No entries/i.test(r.stdout + r.stderr) && !r.stdout.trim()) {
      throw new HttpError(502, `journalctl failed: ${r.stderr.trim().split('\n').pop()}`);
    }
    const hint = /not seeing messages from other users|insufficient permissions/i.test(r.stderr) ? permissionHint : null;
    let entries = parseJournal(r.stdout);
    if (filterHere && opts.grep) {
      const needle = opts.grep.toLowerCase();
      entries = entries.filter((e) => e.message.toLowerCase().includes(needle)).slice(-(opts.lines ?? 300));
    }
    return { entries: entries.reverse(), hint };
  }

  async function units(): Promise<ServiceUnit[]> {
    if (env.platform !== 'linux') return [];
    const r = await env.exec('systemctl', ['list-units', '--type=service', '--all', '--no-pager', '--plain', '--no-legend']);
    return r.code === 0 ? parseUnits(r.stdout) : [];
  }

  /** Files under the log folder (two levels deep), newest first. */
  function files(): LogFile[] {
    if (env.platform !== 'linux' && env.root === '/var/log') return [];
    const out: LogFile[] = [];
    const walk = (dir: string, depth: number) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory() && depth < 2) walk(full, depth + 1);
        else if (e.isFile()) {
          try {
            const st = fs.statSync(full);
            let readable = true;
            try {
              fs.accessSync(full, fs.constants.R_OK);
            } catch {
              readable = false;
            }
            out.push({
              path: path.relative(env.root, full).split(path.sep).join('/'),
              size: st.size,
              modifiedAt: st.mtime.toISOString(),
              readable,
              compressed: e.name.endsWith('.gz'),
            });
          } catch {
            // vanished while listing
          }
        }
      }
    };
    walk(env.root, 0);
    return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, 1000);
  }

  /** Resolves a relative path inside the log folder, following symlinks, or throws. */
  function resolveInside(rel: string): string {
    if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw new HttpError(400, 'Pick a log file');
    const rootReal = fs.realpathSync(env.root);
    const target = path.resolve(rootReal, rel);
    if (!target.startsWith(rootReal + path.sep)) throw new HttpError(400, 'That file isn’t in the log folder');
    let real: string;
    try {
      real = fs.realpathSync(target);
    } catch {
      throw new HttpError(404, 'No such log file');
    }
    if (!real.startsWith(rootReal + path.sep)) throw new HttpError(400, 'That file links outside the log folder');
    if (!fs.statSync(real).isFile()) throw new HttpError(400, 'Not a file');
    return real;
  }

  /** The last lines of a log file (gzip-rotated files are unpacked), optionally filtered. */
  function readFile(rel: string, opts: { lines?: number; grep?: string }): { lines: string[]; truncated: boolean } {
    const file = resolveInside(rel);
    const wanted = Math.min(Math.max(opts.lines ?? 500, 1), MAX_LINES);
    let text: string;
    let truncated = false;
    try {
      if (file.endsWith('.gz')) {
        const buf = zlib.gunzipSync(fs.readFileSync(file), { maxOutputLength: MAX_GUNZIP_BYTES });
        text = buf.toString('utf8');
      } else {
        const size = fs.statSync(file).size;
        const start = Math.max(0, size - TAIL_BYTES);
        truncated = start > 0;
        const fd = fs.openSync(file, 'r');
        try {
          const buf = Buffer.alloc(size - start);
          fs.readSync(fd, buf, 0, buf.length, start);
          text = buf.toString('utf8');
        } finally {
          fs.closeSync(fd);
        }
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') throw new HttpError(403, `No permission to read ${rel}. ${permissionHint}`);
      if (code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|too large/i.test(String(err))) throw new HttpError(413, 'That archive is too large to open here');
      throw err;
    }
    if (text.slice(0, 4096).includes('\0')) {
      throw new HttpError(415, `${rel} is a binary log — use the Journal tab (or the "last" / "lastb" commands for login records)`);
    }
    let lines = text.split(/\r?\n/);
    if (truncated) lines = lines.slice(1); // first line is probably cut in half
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    if (opts.grep) {
      const needle = opts.grep.toLowerCase();
      lines = lines.filter((l) => l.toLowerCase().includes(needle));
    }
    return { lines: lines.slice(-wanted), truncated: truncated || lines.length > wanted };
  }

  return { status, journal, units, files, readFile };
}

export const systemLogs = createSystemLogs({
  platform: process.platform,
  root: '/var/log',
  exec: realExec,
  user: process.env.USER ?? process.env.LOGNAME ?? 'outpost',
});
