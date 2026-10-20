import { prep } from '../db/db.js';
import { getSetting, setSetting } from './systemSettingsService.js';
import { logger } from '../utils/logger.js';
import { HttpError } from '../utils/asyncHandler.js';

/**
 * Audit log housekeeping: how long entries are kept (forever unless an admin picks a period),
 * pruning, and filters shared by the list and the CSV export.
 */

export const SETTING_AUDIT_RETENTION = 'audit_retention_days';
export const RETENTION_CHOICES = [0, 30, 90, 180, 365, 730] as const; // 0 = keep forever

export function retentionDays(): number {
  const n = Number(getSetting(SETTING_AUDIT_RETENTION) ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Deletes entries older than the retention period. Returns how many went. */
export function pruneAudit(): number {
  const days = retentionDays();
  if (!days) return 0;
  const result = prep(`DELETE FROM audit_log WHERE created_at < datetime('now', ?)`).run(`-${days} days`);
  const removed = Number(result.changes);
  if (removed) logger.info(`Audit log: removed ${removed} entr${removed === 1 ? 'y' : 'ies'} older than ${days} days`);
  return removed;
}

export function setRetentionDays(days: unknown): number {
  const n = Number(days);
  if (!RETENTION_CHOICES.includes(n as (typeof RETENTION_CHOICES)[number])) {
    throw new HttpError(400, `Keep entries for one of: ${RETENTION_CHOICES.map((d) => (d ? `${d} days` : 'forever')).join(', ')}`);
  }
  setSetting(SETTING_AUDIT_RETENTION, String(n));
  pruneAudit();
  return n;
}

export function auditStats() {
  const row = prep('SELECT COUNT(*) AS count, MIN(created_at) AS oldest FROM audit_log').get() as { count: number; oldest: string | null };
  return {
    retentionDays: retentionDays(),
    choices: RETENTION_CHOICES,
    count: row.count,
    oldest: row.oldest ? `${row.oldest.replace(' ', 'T')}Z` : null,
  };
}

let timer: NodeJS.Timeout | null = null;
/** Prunes now and then every hour. */
export function startAuditPruning() {
  pruneAudit();
  timer ??= setInterval(pruneAudit, 60 * 60_000);
  timer.unref();
}

/** WHERE clause for the list and the export: user, action family, instance, free text, period. */
export function auditFilter(q: Record<string, unknown>): { where: string; params: (string | number)[] } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  const esc = (s: string) => s.replace(/[\\%_]/g, '\\$&');
  if (typeof q.user === 'string' && q.user) {
    where.push('a.username = ?');
    params.push(q.user);
  }
  if (typeof q.action === 'string' && q.action) {
    where.push("(a.action = ? OR a.action LIKE ? ESCAPE '\\')");
    params.push(q.action, `${esc(q.action)}.%`);
  }
  if (typeof q.server === 'string' && q.server) {
    where.push('a.target = ?');
    params.push(q.server);
  }
  if (typeof q.search === 'string' && q.search.trim()) {
    const like = `%${esc(q.search.trim())}%`;
    where.push(
      "(a.detail LIKE ? ESCAPE '\\' OR a.action LIKE ? ESCAPE '\\' OR s.name LIKE ? ESCAPE '\\' OR a.username LIKE ? ESCAPE '\\' OR a.ip LIKE ? ESCAPE '\\' OR a.user_agent LIKE ? ESCAPE '\\')"
    );
    params.push(like, like, like, like, like, like);
  }
  if (typeof q.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(q.from)) {
    where.push('a.created_at >= ?');
    params.push(`${q.from} 00:00:00`);
  }
  if (typeof q.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(q.to)) {
    where.push('a.created_at <= ?');
    params.push(`${q.to} 23:59:59`);
  }
  return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

/** A short "Firefox on Windows"-style label for a user agent. */
export function describeAgent(ua: string | null): string | null {
  if (!ua) return null;
  const browser =
    /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl\//i.test(ua) ? 'curl' : /node|undici/i.test(ua) ? 'script' : null;
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : null;
  return browser && os ? `${browser} on ${os}` : browser ?? os ?? ua.slice(0, 40);
}
