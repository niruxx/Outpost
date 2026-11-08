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
  if (typeof q.userId === 'string' && q.userId) {
    where.push('a.user_id = ?');
    params.push(q.userId);
  }
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
  // File history: only entries that recorded a file change, optionally for one file.
  if (q.files === true || q.files === '1' || q.files === 'true') where.push('a.file_change IS NOT NULL');
  if (typeof q.path === 'string' && q.path) {
    where.push('a.file_path = ?');
    params.push(q.path.replace(/^\/+/, ''));
  }
  if (typeof q.search === 'string' && q.search.trim()) {
    const like = `%${esc(q.search.trim())}%`;
    where.push(
      "(a.detail LIKE ? ESCAPE '\\' OR a.action LIKE ? ESCAPE '\\' OR s.name LIKE ? ESCAPE '\\' OR a.username LIKE ? ESCAPE '\\' OR a.ip LIKE ? ESCAPE '\\' OR a.user_agent LIKE ? ESCAPE '\\' OR a.file_path LIKE ? ESCAPE '\\')"
    );
    params.push(like, like, like, like, like, like, like);
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

// Rows as the audit list, the export and the Activity page return them.
export interface AuditRow {
  id: number;
  user_id: string | null;
  username: string | null;
  action: string;
  target: string | null;
  detail: string | null;
  created_at: string;
  ip: string | null;
  user_agent: string | null;
  server_name: string | null;
  target_username: string | null;
  webhook_name: string | null;
  has_file_change: number;
  file_path: string | null;
  file_from: string | null;
  file_kind: string | null;
  file_created: number | null;
  file_added: number | null;
  file_removed: number | null;
  file_directory: number | null;
  file_hidden: number | null;
}

export const MAX_PAGE = 200;
// The file summary comes out of the stored JSON in SQL, so list rows never load the diff itself.
const FILE_JSON = "CASE WHEN json_valid(a.file_change) THEN a.file_change END";
export const AUDIT_SELECT = `SELECT a.id, a.user_id, a.username, a.action, a.target, a.detail, a.created_at, a.ip, a.user_agent, (a.file_change IS NOT NULL) AS has_file_change,
    a.file_path, json_extract(${FILE_JSON}, '$.from') AS file_from, json_extract(${FILE_JSON}, '$.kind') AS file_kind,
    json_extract(${FILE_JSON}, '$.created') AS file_created, json_extract(${FILE_JSON}, '$.added') AS file_added,
    json_extract(${FILE_JSON}, '$.removed') AS file_removed, json_extract(${FILE_JSON}, '$.directory') AS file_directory,
    (json_extract(${FILE_JSON}, '$.reason') IS NOT NULL) AS file_hidden,
    s.name AS server_name, u.username AS target_username, w.name AS webhook_name
  FROM audit_log a
  LEFT JOIN servers s ON s.id = a.target
  LEFT JOIN users u ON u.id = a.target
  LEFT JOIN webhooks w ON w.id = a.target`;

export function shapeAudit(r: AuditRow) {
  return {
    id: r.id,
    userId: r.user_id,
    username: r.username,
    action: r.action,
    target: r.target,
    targetLabel: r.server_name ?? r.target_username ?? r.webhook_name ?? null,
    targetKind: r.server_name ? 'server' : r.target_username ? 'user' : r.webhook_name ? 'webhook' : null,
    detail: r.detail,
    hasFileChange: !!r.has_file_change,
    file: r.has_file_change
      ? {
          path: r.file_path ?? '',
          from: r.file_from,
          kind: r.file_kind ?? (r.file_created ? 'created' : 'edited'),
          added: r.file_added,
          removed: r.file_removed,
          directory: !!r.file_directory,
          hidden: !!r.file_hidden,
        }
      : null,
    ip: r.ip,
    userAgent: r.user_agent,
    agent: describeAgent(r.user_agent),
    // SQLite's datetime('now') is UTC without a zone marker.
    at: `${r.created_at.replace(' ', 'T')}Z`,
  };
}

/** A short "Firefox on Windows"-style label for a user agent. */
export function describeAgent(ua: string | null): string | null {
  if (!ua) return null;
  const browser =
    /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl\//i.test(ua) ? 'curl' : /node|undici/i.test(ua) ? 'script' : null;
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : null;
  return browser && os ? `${browser} on ${os}` : browser ?? os ?? ua.slice(0, 40);
}
