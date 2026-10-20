import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { DATA_DIR } from '../utils/paths.js';
import { getSetting, setSetting } from './systemSettingsService.js';
import { logger } from '../utils/logger.js';

/**
 * Console log history: every console line of every instance is kept on disk, one file per day
 * (data/console-logs/<instance>/<YYYY-MM-DD>.log), so it survives restarts and the in-memory
 * scrollback limit. Past days are gzipped; files older than the retention period are deleted.
 */

export const CONSOLE_LOGS_DIR = path.join(DATA_DIR, 'console-logs');
export const SETTING_CONSOLE_RETENTION = 'console_log_retention_days';
const DEFAULT_RETENTION_DAYS = 30;
/** A day's file rolls over to "<date>.2.log" (and so on) past this size. */
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const NAME = /^(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.log(\.gz)?$/;

export const historyDir = (serverId: string) => path.join(CONSOLE_LOGS_DIR, serverId);

export function retentionDays(): number {
  const raw = getSetting(SETTING_CONSOLE_RETENTION);
  if (raw === null) return DEFAULT_RETENTION_DAYS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_RETENTION_DAYS;
}

export function setRetentionDays(days: number) {
  setSetting(SETTING_CONSOLE_RETENTION, String(days));
}

const today = () => new Date().toISOString().slice(0, 10);
const clock = () => new Date().toISOString().slice(11, 19);

// ---------------------------------------------------------------------------
// Writing (buffered — chatty servers print thousands of lines a minute)
// ---------------------------------------------------------------------------

interface Pending {
  lines: string[];
  timer: NodeJS.Timeout | null;
  writing: Promise<void>;
}
const pending = new Map<string, Pending>();

function currentFile(serverId: string): string {
  const dir = historyDir(serverId);
  const date = today();
  let n = 1;
  for (;;) {
    const file = path.join(dir, n === 1 ? `${date}.log` : `${date}.${n}.log`);
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      return file;
    }
    if (size < MAX_FILE_BYTES) return file;
    n++;
  }
}

function flush(serverId: string): Promise<void> {
  const p = pending.get(serverId);
  if (!p || !p.lines.length) return p?.writing ?? Promise.resolve();
  const chunk = p.lines.join('');
  p.lines = [];
  p.timer = null;
  p.writing = p.writing.then(async () => {
    try {
      await fs.promises.mkdir(historyDir(serverId), { recursive: true });
      await fs.promises.appendFile(currentFile(serverId), chunk);
    } catch (err) {
      logger.warn(`Couldn’t write console history for ${serverId}`, err);
    }
  });
  return p.writing;
}

/** Called for every console line (consoleLogService.appendLine). */
export function recordLine(serverId: string, line: string, stream: 'stdout' | 'stderr' | 'system') {
  let p = pending.get(serverId);
  if (!p) pending.set(serverId, (p = { lines: [], timer: null, writing: Promise.resolve() }));
  p.lines.push(`[${clock()}]${stream === 'stderr' ? ' !' : ''} ${line.replace(/\r?\n$/, '')}\n`);
  if (p.lines.length >= 500) void flush(serverId);
  else if (!p.timer) p.timer = setTimeout(() => void flush(serverId), 1000);
}

/** Writes everything still buffered (shutdown, before reading). */
export async function flushAll(): Promise<void> {
  await Promise.all([...pending.keys()].map((id) => flush(id)));
}

/** On exit there's no time for promises — write synchronously. */
export function flushAllSync() {
  for (const [serverId, p] of pending) {
    if (!p.lines.length) continue;
    try {
      fs.mkdirSync(historyDir(serverId), { recursive: true });
      fs.appendFileSync(currentFile(serverId), p.lines.join(''));
      p.lines = [];
    } catch {
      // best effort
    }
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface HistoryFile {
  name: string;
  date: string;
  part: number;
  sizeBytes: number;
  compressed: boolean;
}

export function listHistory(serverId: string): HistoryFile[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(historyDir(serverId));
  } catch {
    return [];
  }
  const out: HistoryFile[] = [];
  for (const name of names) {
    const m = name.match(NAME);
    if (!m) continue;
    try {
      out.push({ name, date: m[1], part: Number(m[2] ?? 1), sizeBytes: fs.statSync(path.join(historyDir(serverId), name)).size, compressed: !!m[3] });
    } catch {
      // vanished
    }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date) || b.part - a.part);
}

/** Resolves a history file name safely (only names this service creates). */
export function historyFile(serverId: string, name: string): string | null {
  if (!NAME.test(name)) return null;
  const file = path.join(historyDir(serverId), name);
  return fs.existsSync(file) ? file : null;
}

/** The lines of one file (decompressed), optionally filtered; the last `limit` matches. */
export async function readHistory(
  serverId: string,
  name: string,
  opts: { q?: string; limit?: number } = {}
): Promise<{ lines: string[]; total: number; matched: number; truncated: boolean } | null> {
  await flush(serverId);
  const file = historyFile(serverId, name);
  if (!file) return null;
  const buf = fs.readFileSync(file);
  const text = (name.endsWith('.gz') ? zlib.gunzipSync(buf) : buf).toString('utf8');
  const all = text.split('\n').filter(Boolean);
  const q = opts.q?.trim().toLowerCase();
  const matches = q ? all.filter((l) => l.toLowerCase().includes(q)) : all;
  const limit = Math.min(Math.max(opts.limit ?? 5000, 1), 20000);
  return { lines: matches.slice(-limit), total: all.length, matched: matches.length, truncated: matches.length > limit };
}

export function deleteHistory(serverId: string, name: string): boolean {
  const file = historyFile(serverId, name);
  if (!file) return false;
  fs.rmSync(file, { force: true });
  return true;
}

export function forgetHistory(serverId: string) {
  pending.delete(serverId);
  fs.rmSync(historyDir(serverId), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Maintenance: gzip past days, drop expired ones
// ---------------------------------------------------------------------------

export async function maintain(): Promise<{ compressed: number; deleted: number }> {
  await flushAll();
  let compressed = 0;
  let deleted = 0;
  const keep = retentionDays();
  const cutoff = keep > 0 ? new Date(Date.now() - keep * 86400_000).toISOString().slice(0, 10) : null;
  let ids: string[] = [];
  try {
    ids = fs.readdirSync(CONSOLE_LOGS_DIR);
  } catch {
    return { compressed, deleted };
  }
  for (const id of ids) {
    for (const f of listHistory(id)) {
      const file = path.join(historyDir(id), f.name);
      if (cutoff && f.date < cutoff) {
        fs.rmSync(file, { force: true });
        deleted++;
        continue;
      }
      if (!f.compressed && f.date < today()) {
        try {
          await pipeline(fs.createReadStream(file), zlib.createGzip(), fs.createWriteStream(`${file}.gz`));
          fs.rmSync(file, { force: true });
          compressed++;
        } catch (err) {
          fs.rmSync(`${file}.gz`, { force: true });
          logger.warn(`Couldn’t compress ${file}`, err);
        }
      }
    }
    try {
      if (!fs.readdirSync(historyDir(id)).length) fs.rmdirSync(historyDir(id));
    } catch {
      // gone
    }
  }
  return { compressed, deleted };
}

export function initConsoleHistory() {
  const run = () => void maintain().catch((err) => logger.warn('Console history maintenance failed', err));
  setTimeout(run, 30_000).unref();
  setInterval(run, 3600_000).unref();
  process.on('exit', flushAllSync);
}
