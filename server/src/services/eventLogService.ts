import { prep } from '../db/db.js';
import { logger } from '../utils/logger.js';
import { getServer } from './serverService.js';
import { getUserServerAccess } from './userService.js';

/**
 * The in-panel event log behind the notification bell and each instance's "Recent activity".
 * Every `notify()` call lands here as well as on configured webhooks. Each account keeps a
 * read watermark (the highest event id it has seen), so unread counts are cheap.
 */
export type EventSeverity = 'error' | 'warning' | 'notice' | 'info';

const SEVERITY: Record<string, EventSeverity> = {
  'health.alert': 'warning',
  'security.upload.blocked': 'error',
  'security.scan.detected': 'error',
  'security.scan.failed': 'warning',
  'server.crashed': 'error',
  'server.restart_gave_up': 'error',
  'update.failed': 'error',
  'backup.failed': 'warning',
  'task.failed': 'warning',
  'quota.exceeded': 'warning',
  'update.available': 'notice',
  'update.applied': 'info',
  'server.started': 'info',
  'server.stopped': 'info',
};

/** Shown to people as the headline; webhooks use their own titles. */
const TITLE: Record<string, string> = {
  'health.alert': 'Instance health alert',
  'security.upload.blocked': 'Upload blocked by antivirus',
  'security.scan.detected': 'Antivirus findings require review',
  'security.scan.failed': 'Antivirus scan incomplete',
  'server.started': 'Instance started',
  'server.stopped': 'Instance stopped',
  'server.crashed': 'Instance crashed',
  'server.restart_gave_up': 'Auto-restart gave up',
  'backup.failed': 'Scheduled snapshot failed',
  'task.failed': 'Scheduled task failed',
  'update.available': 'Update available',
  'update.applied': 'Updated automatically',
  'update.failed': 'Automatic update failed',
  'quota.exceeded': 'Disk limit reached',
};

/** Severities that count toward the bell's badge (start/stop noise doesn't). */
const ATTENTION: EventSeverity[] = ['error', 'warning', 'notice'];
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ROWS = 10_000;

export interface PanelEvent {
  id: number;
  at: number;
  event: string;
  title: string;
  severity: EventSeverity;
  serverId: string | null;
  serverName: string | null;
  message: string;
}

interface EventRow {
  id: number;
  at: number;
  event: string;
  severity: EventSeverity;
  server_id: string | null;
  server_name: string | null;
  message: string;
}

const toEvent = (r: EventRow): PanelEvent => ({
  id: Number(r.id),
  at: Number(r.at),
  event: r.event,
  title: TITLE[r.event] ?? r.event,
  severity: r.severity,
  serverId: r.server_id,
  serverName: r.server_name,
  message: r.message,
});

let inserts = 0;

export function recordEvent(event: string, server: { id: string; name: string } | null, message: string): void {
  try {
    // The instance may already be gone (deleted mid-event): keep the event, unlinked.
    const serverId = server && getServer(server.id) ? server.id : null;
    prep('INSERT INTO panel_events (at, event, severity, server_id, server_name, message) VALUES (?, ?, ?, ?, ?, ?)').run(
      Date.now(),
      event,
      SEVERITY[event] ?? 'info',
      serverId,
      server?.name ?? null,
      message,
    );
    if (++inserts % 200 === 0) pruneEvents();
  } catch (err) {
    logger.warn(`Could not record panel event ${event}: ${(err as Error).message}`);
  }
}

export function pruneEvents(): void {
  try {
    prep('DELETE FROM panel_events WHERE at < ?').run(Date.now() - RETENTION_MS);
    prep('DELETE FROM panel_events WHERE id <= (SELECT id FROM panel_events ORDER BY id DESC LIMIT 1 OFFSET ?)').run(MAX_ROWS);
  } catch (err) {
    logger.warn(`Pruning panel events failed: ${(err as Error).message}`);
  }
}

/**
 * The SQL filter for what an account may see: everything for admins; otherwise only events of
 * instances it has access to (and that aren't suspended). Panel-wide events are admin-only.
 */
function scope(userId: string, isAdmin: boolean): { where: string; params: (string | number)[] } {
  if (isAdmin) return { where: '1 = 1', params: [] };
  const ids = getUserServerAccess(userId).filter((id) => {
    const server = getServer(id);
    return server && !server.suspended;
  });
  if (!ids.length) return { where: '0 = 1', params: [] };
  return { where: `server_id IN (${ids.map(() => '?').join(', ')})`, params: ids };
}

function lastRead(userId: string): number {
  const row = prep('SELECT last_read_id FROM event_reads WHERE user_id = ?').get(userId) as { last_read_id: number } | undefined;
  return Number(row?.last_read_id ?? 0);
}

export function listEvents(
  userId: string,
  isAdmin: boolean,
  options: { serverId?: string; before?: number; limit?: number; important?: boolean } = {},
): { events: PanelEvent[]; unread: number; lastReadId: number } {
  const { where, params } = scope(userId, isAdmin);
  const clauses = [where];
  const args: (string | number)[] = [...params];
  if (options.serverId) {
    clauses.push('server_id = ?');
    args.push(options.serverId);
  }
  if (options.before) {
    clauses.push('id < ?');
    args.push(options.before);
  }
  if (options.important) clauses.push(`severity IN (${ATTENTION.map((s) => `'${s}'`).join(', ')})`);
  const limit = Math.max(1, Math.min(200, options.limit ?? 50));
  const rows = prep(`SELECT * FROM panel_events WHERE ${clauses.join(' AND ')} ORDER BY id DESC LIMIT ${limit}`).all(...args) as unknown as EventRow[];
  return { events: rows.map(toEvent), unread: unreadCount(userId, isAdmin), lastReadId: lastRead(userId) };
}

export function unreadCount(userId: string, isAdmin: boolean): number {
  const { where, params } = scope(userId, isAdmin);
  const row = prep(
    `SELECT COUNT(*) AS n FROM panel_events WHERE ${where} AND id > ? AND severity IN (${ATTENTION.map((s) => `'${s}'`).join(', ')})`,
  ).get(...params, lastRead(userId)) as { n: number };
  return Number(row.n);
}

/** Marks everything up to `upTo` (default: the newest event) as read. Never moves backwards. */
export function markRead(userId: string, upTo?: number): number {
  const newest = Number((prep('SELECT MAX(id) AS id FROM panel_events').get() as { id: number | null }).id ?? 0);
  const target = Math.min(newest, upTo ?? newest);
  prep(
    `INSERT INTO event_reads (user_id, last_read_id) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`,
  ).run(userId, target);
  return lastRead(userId);
}
