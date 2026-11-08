import type { NextFunction, Request, Response } from 'express';
import { prep } from '../db/db.js';
import { requestContext } from '../utils/requestContext.js';
import { logger } from '../utils/logger.js';
import { describeAgent } from './auditService.js';

/**
 * Activity tracking, on top of the audit log:
 *
 *  1. A catch-all: every state-changing API request (POST/PUT/PATCH/DELETE) by a signed-in user is
 *     recorded in the audit log, unless the route already wrote its own, more descriptive entry.
 *     That way nothing a user does in the panel goes unrecorded, even on routes nobody wired up.
 *  2. Presence: each open panel tab reports which page it is on, so admins can see who is online
 *     and what they are looking at right now. Page changes are kept in `activity_views`.
 */

// ---------------------------------------------------------------------------
// 1. Catch-all action log
// ---------------------------------------------------------------------------

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Requests that change nothing worth recording (presence pings, "mark notifications read"). */
const IGNORED = [/^\/api\/activity(\/|$)/, /^\/api\/events\/read$/, /^\/api\/hooks(\/|$)/];
/** Body fields whose values are never written to the log. */
const SENSITIVE = /pass(word|phrase)?|secret|token|api_?key|private|cred|cookie|totp|otp|recovery|content|xml|cert|login|webhook_?url|^url$/i;

const FAMILY: Record<string, string> = { servers: 'server', users: 'user', backups: 'backup', files: 'file', plugins: 'plugin', tasks: 'task', nodes: 'node', templates: 'template', keys: 'key' };

/** Path segments that are ids or names rather than part of the route ("abc123…", "42", "world.zip"). */
function isIdSegment(seg: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(seg) || /^\d+$/.test(seg) || seg.includes('.') || seg.includes('%') || (seg.length >= 16 && /\d/.test(seg));
}

/** "PUT /api/servers/<id>/limits" → { action: "server.limits.update", target: "<id>" }. */
export function describeRequest(method: string, path: string): { action: string; target: string | null } {
  const segments = path.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const [head = 'panel', ...rest] = segments;
  let target: string | null = null;
  if ((head === 'servers' || head === 'users') && rest[0] && !['bulk'].includes(rest[0])) target = decodeURIComponent(rest.shift()!);
  const words = rest.filter((s) => !isIdSegment(s)).map((s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_'));
  const family = FAMILY[head] ?? head.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
  const verb = method === 'DELETE' ? 'delete' : method === 'POST' ? (words.length ? null : 'create') : 'update';
  return { action: [family, ...words, verb].filter(Boolean).join('.').slice(0, 120), target };
}

function summarizeValue(key: string, value: unknown): string {
  if (SENSITIVE.test(key)) return '••••';
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return `[${value.length} item${value.length === 1 ? '' : 's'}]`;
  if (typeof value === 'object') return `{${Object.keys(value).length} fields}`;
  const s = String(value);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

/** "max_memory_mb=4096, auto_start=true" — values of secret-looking fields are masked. */
function summarizeBody(body: unknown): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return '';
  const record = body as Record<string, unknown>;
  // {key: "rcon.password", value: "…"} style edits: the key decides whether the value is secret.
  const named = [record.key, record.name, record.property].find((v) => typeof v === 'string') as string | undefined;
  const maskAll = !!named && SENSITIVE.test(named);
  const parts = Object.entries(record)
    .slice(0, 12)
    .map(([k, v]) => `${k}=${maskAll && k === 'value' ? '••••' : summarizeValue(k, v)}`);
  const more = Object.keys(record).length - parts.length;
  return parts.join(', ') + (more > 0 ? `, +${more} more` : '');
}

export function activityMiddleware(req: Request, res: Response, next: NextFunction) {
  const ctx = requestContext();
  if (!ctx || !MUTATING.has(req.method) || IGNORED.some((re) => re.test(req.path))) return next();

  // Capture the error message of failed requests for the log.
  let errorMessage: string | null = null;
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    if (res.statusCode >= 400 && body && typeof body === 'object' && 'error' in body) errorMessage = String((body as { error: unknown }).error).slice(0, 200);
    return json(body);
  };

  res.on('finish', () => {
    const auth = req.auth;
    // Unauthenticated requests (bad sign-ins, public pages) and requests that already wrote
    // their own audit entry are left alone.
    if (!auth || ctx.audited) return;
    try {
      // `req.path` loses the router's mount prefix inside routers; the original URL doesn't.
      const path = req.originalUrl.split('?')[0];
      const { action, target } = describeRequest(req.method, path);
      const failed = res.statusCode >= 400;
      const body = req.is('multipart/form-data') ? 'file upload' : summarizeBody(req.body);
      const detail = [
        `${req.method} ${path}`,
        body,
        failed ? `failed (${res.statusCode}${errorMessage ? `: ${errorMessage}` : ''})` : '',
      ].filter(Boolean).join(' · ');
      prep('INSERT INTO audit_log (user_id, username, action, target, detail, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        auth.sub,
        auth.username,
        failed ? `${action}.failed` : action,
        target,
        detail.slice(0, 2000),
        ctx.ip,
        ctx.userAgent,
      );
    } catch (err) {
      logger.warn('Activity log: failed to record a request', err);
    }
  });
  next();
}

// ---------------------------------------------------------------------------
// 2. Presence — who has the panel open, and on which page
// ---------------------------------------------------------------------------

export interface PresenceTab {
  tabId: string;
  userId: string;
  username: string;
  path: string;
  label: string;
  serverId: string | null;
  /** False while the tab is in the background. */
  visible: boolean;
  /** When this tab arrived on its current page. */
  since: string;
  lastSeen: string;
  ip: string | null;
  agent: string | null;
}

/** A tab that hasn't pinged for this long is considered closed. */
const STALE_MS = 90_000;
const tabs = new Map<string, PresenceTab & { lastSeenMs: number }>();

function sweep() {
  const cutoff = Date.now() - STALE_MS;
  for (const [key, tab] of tabs) if (tab.lastSeenMs < cutoff) tabs.delete(key);
}

const PAGE_LABELS: Record<string, string> = {
  '/': 'Instances',
  '/configuration': 'Configuration',
  '/configuration/operations': 'Operations',
  '/docker': 'Docker',
  '/storage': 'Storage',
  '/host-console': 'Host console',
  '/users': 'Users',
  '/firewall': 'Firewall',
  '/audit': 'Audit Log',
  '/activity': 'Activity',
  '/files': 'File Management',
};

const INSTANCE_TABS: Record<string, string> = {
  '': 'Status',
  status: 'Status',
  console: 'Console',
  files: 'File Management',
  backups: 'Backups',
  configuration: 'Configuration',
  plugins: 'Plugins & mods',
  players: 'Players',
  operator: 'Operators',
  whitelist: 'Whitelist',
  maps: 'Map',
  rewind: 'World Rewind',
  network: 'Network',
  cs2: 'CS2',
  gmod: "Garry's Mod",
  update: 'Versions & updates',
  upnp: 'UPnP',
  tasks: 'Tasks & Automation',
  wine: 'Wine',
  workshop: 'Workshop',
  activity: 'Activity',
};

function serverName(id: string): string | null {
  const row = prep('SELECT name FROM servers WHERE id = ?').get(id) as { name: string } | undefined;
  return row?.name ?? null;
}

/** "/instances/<id>/console" → { label: "Survival · Console", serverId: "<id>" }. */
export function describePage(path: string): { label: string; serverId: string | null } {
  const clean = path.split(/[?#]/)[0].replace(/\/+$/, '') || '/';
  const instance = clean.match(/^\/instances\/([^/]+)(?:\/([^/]+))?/);
  if (instance) {
    const [, id, tab = ''] = instance;
    const name = serverName(id) ?? 'Deleted instance';
    return { label: `${name} · ${INSTANCE_TABS[tab] ?? tab.replace(/[-_]/g, ' ')}`, serverId: serverName(id) ? id : null };
  }
  const files = clean.match(/^\/files\/([^/]+)/);
  if (files) {
    const name = serverName(files[1]);
    return { label: name ? `File Management · ${name}` : 'File Management', serverId: name ? files[1] : null };
  }
  if (clean.startsWith('/libvirt')) return { label: 'Virtual machines', serverId: null };
  return { label: PAGE_LABELS[clean] ?? clean, serverId: null };
}

/** Records a tab's heartbeat; logs a page view when it lands on a new page. */
export function reportPresence(user: { id: string; username: string }, input: { tabId: unknown; path: unknown; visible: unknown }) {
  const tabId = typeof input.tabId === 'string' ? input.tabId.slice(0, 64) : '';
  const path = typeof input.path === 'string' && input.path.startsWith('/') ? input.path.slice(0, 300) : '';
  if (!tabId || !path) return;
  const key = `${user.id}:${tabId}`;
  const now = new Date();
  const ctx = requestContext();
  const existing = tabs.get(key);
  const moved = !existing || existing.path !== path;
  const page = moved ? describePage(path) : { label: existing.label, serverId: existing.serverId };
  tabs.set(key, {
    tabId,
    userId: user.id,
    username: user.username,
    path,
    label: page.label,
    serverId: page.serverId,
    visible: input.visible !== false,
    since: moved ? now.toISOString() : existing.since,
    lastSeen: now.toISOString(),
    lastSeenMs: now.getTime(),
    ip: ctx?.ip ?? null,
    agent: describeAgent(ctx?.userAgent ?? null),
  });
  if (moved) {
    prep('INSERT INTO activity_views (user_id, username, path, label, server_id) VALUES (?, ?, ?, ?, ?)').run(user.id, user.username, path, page.label, page.serverId);
  }
}

export function leavePresence(userId: string, tabId: unknown) {
  if (typeof tabId === 'string') tabs.delete(`${userId}:${tabId}`);
}

/** Open tabs, newest activity first; optionally only those on one instance. */
export function presence(filter?: { userId?: string; serverId?: string }): PresenceTab[] {
  sweep();
  return [...tabs.values()]
    .filter((t) => (!filter?.userId || t.userId === filter.userId) && (!filter?.serverId || t.serverId === filter.serverId))
    .sort((a, b) => b.lastSeenMs - a.lastSeenMs)
    .map(({ lastSeenMs: _drop, ...tab }) => tab);
}

// ---------------------------------------------------------------------------
// Page-view history
// ---------------------------------------------------------------------------

const utc = (s: string) => `${s.replace(' ', 'T')}Z`;

export function pageViews(userId: string, before: number | null, limit: number) {
  const rows = prep(
    `SELECT id, path, label, server_id, created_at FROM activity_views WHERE user_id = ? ${before ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT ?`,
  ).all(...(before ? [userId, before, limit + 1] : [userId, limit + 1])) as { id: number; path: string; label: string | null; server_id: string | null; created_at: string }[];
  const page = rows.slice(0, limit);
  return {
    views: page.map((r) => ({ id: r.id, path: r.path, label: r.label ?? r.path, serverId: r.server_id, at: utc(r.created_at) })),
    nextBefore: rows.length > limit ? page[page.length - 1].id : null,
  };
}

/** Per-user summary for the Activity page: who's online, what they last did and saw. */
export function userSummaries() {
  const users = prep('SELECT id, username, role, disabled FROM users ORDER BY username COLLATE NOCASE').all() as {
    id: string;
    username: string;
    role: string;
    disabled: number | null;
  }[];
  const lastAction = prep('SELECT action, detail, created_at FROM audit_log WHERE user_id = ? ORDER BY id DESC LIMIT 1');
  const dayCount = prep("SELECT COUNT(*) AS n FROM audit_log WHERE user_id = ? AND created_at >= datetime('now', '-1 day')");
  const lastView = prep('SELECT created_at FROM activity_views WHERE user_id = ? ORDER BY id DESC LIMIT 1');
  const open = presence();
  return users.map((u) => {
    const action = lastAction.get(u.id) as { action: string; detail: string | null; created_at: string } | undefined;
    const view = lastView.get(u.id) as { created_at: string } | undefined;
    const userTabs = open.filter((t) => t.userId === u.id);
    const times = [action?.created_at, view?.created_at].filter((v): v is string => !!v).map(utc);
    if (userTabs[0]) times.push(userTabs[0].lastSeen);
    return {
      id: u.id,
      username: u.username,
      role: u.role,
      disabled: !!u.disabled,
      online: userTabs.length > 0,
      active: userTabs.some((t) => t.visible),
      tabs: userTabs,
      lastAction: action ? { action: action.action, detail: action.detail, at: utc(action.created_at) } : null,
      actionsToday: (dayCount.get(u.id) as { n: number }).n,
      lastSeen: times.sort().pop() ?? null,
    };
  });
}

const VIEW_RETENTION_DAYS = 30;
let pruneTimer: NodeJS.Timeout | null = null;
/** Page views are only useful recently; keep 30 days. */
export function startActivityPruning() {
  const prune = () => {
    try {
      prep(`DELETE FROM activity_views WHERE created_at < datetime('now', ?)`).run(`-${VIEW_RETENTION_DAYS} days`);
    } catch (err) {
      logger.warn('Activity log: pruning page views failed', err);
    }
  };
  prune();
  pruneTimer ??= setInterval(prune, 60 * 60_000);
  pruneTimer.unref();
}
