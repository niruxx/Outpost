import { Router } from 'express';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { prep } from '../db/db.js';
import { auditFilter, auditStats, describeAgent, setRetentionDays } from '../services/auditService.js';
import { systemLogs } from '../services/systemLogsService.js';
import { logAudit } from '../services/userService.js';

/**
 * The audit log (who did what, from where, newest first, with filters, paging and CSV export),
 * how long it's kept, and the host's own system logs. Admin only.
 */
export const auditRouter = Router();
auditRouter.use(requireAuth, requireRole('admin'));

interface AuditRow {
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
}

const MAX_PAGE = 200;
const SELECT = `SELECT a.*, s.name AS server_name, u.username AS target_username, w.name AS webhook_name
  FROM audit_log a
  LEFT JOIN servers s ON s.id = a.target
  LEFT JOIN users u ON u.id = a.target
  LEFT JOIN webhooks w ON w.id = a.target`;

function shape(r: AuditRow) {
  return {
    id: r.id,
    userId: r.user_id,
    username: r.username,
    action: r.action,
    target: r.target,
    targetLabel: r.server_name ?? r.target_username ?? r.webhook_name ?? null,
    targetKind: r.server_name ? 'server' : r.target_username ? 'user' : r.webhook_name ? 'webhook' : null,
    detail: r.detail,
    ip: r.ip,
    userAgent: r.user_agent,
    agent: describeAgent(r.user_agent),
    // SQLite's datetime('now') is UTC without a zone marker.
    at: `${r.created_at.replace(' ', 'T')}Z`,
  };
}

auditRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const limit = Math.min(MAX_PAGE, Math.max(1, Number(req.query.limit) || 100));
    const { where, params } = auditFilter(req.query);
    const before = Number(req.query.before) > 0 ? Number(req.query.before) : null;
    const clause = before ? `${where ? `${where} AND` : 'WHERE'} a.id < ?` : where;
    const rows = prep(`${SELECT} ${clause} ORDER BY a.id DESC LIMIT ?`).all(...params, ...(before ? [before] : []), limit + 1) as unknown as AuditRow[];
    const page = rows.slice(0, limit);
    res.json({ entries: page.map(shape), nextBefore: rows.length > limit ? page[page.length - 1].id : null });
  })
);

/** Values for the filter dropdowns. */
auditRouter.get(
  '/facets',
  asyncHandler(async (_req, res) => {
    const actions = (prep('SELECT DISTINCT action FROM audit_log ORDER BY action').all() as { action: string }[]).map((r) => r.action);
    const users = (prep('SELECT DISTINCT username FROM audit_log WHERE username IS NOT NULL ORDER BY username').all() as { username: string }[]).map(
      (r) => r.username
    );
    res.json({ actions, users });
  })
);

/** Everything matching the filters as CSV (up to 100,000 rows). */
auditRouter.get(
  '/export',
  asyncHandler(async (req, res) => {
    const { where, params } = auditFilter(req.query);
    const rows = prep(`${SELECT} ${where} ORDER BY a.id DESC LIMIT 100000`).all(...params) as unknown as AuditRow[];
    const cell = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      // Quote everything; neutralise spreadsheet formulas.
      return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
    };
    const lines = [['Time (UTC)', 'User', 'Action', 'Target', 'Details', 'IP', 'Browser / device', 'User agent'].map(cell).join(',')];
    for (const r of rows) {
      const e = shape(r);
      lines.push([e.at, e.username, e.action, e.targetLabel ?? e.target, e.detail, e.ip, e.agent, e.userAgent].map(cell).join(','));
    }
    logAudit(req.auth!.sub, req.auth!.username, 'audit.export', undefined, `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="outpost-audit-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(`﻿${lines.join('\r\n')}\r\n`);
  })
);

/** How long entries are kept (0 = forever, the default). */
auditRouter.get(
  '/settings',
  asyncHandler(async (_req, res) => {
    res.json(auditStats());
  })
);

auditRouter.put(
  '/settings',
  asyncHandler(async (req, res) => {
    const days = setRetentionDays(req.body?.retentionDays);
    logAudit(req.auth!.sub, req.auth!.username, 'settings.audit_retention', undefined, days ? `keep ${days} days` : 'keep forever');
    res.json(auditStats());
  })
);

// ---------------------------------------------------------------------------
// The host's system logs (Linux)
// ---------------------------------------------------------------------------

auditRouter.get(
  '/system/status',
  asyncHandler(async (_req, res) => {
    const status = await systemLogs.status();
    res.json({ ...status, units: status.available ? await systemLogs.units() : [] });
  })
);

auditRouter.get(
  '/system/journal',
  asyncHandler(async (req, res) => {
    const q = req.query;
    const priority = typeof q.priority === 'string' && q.priority !== '' ? Number(q.priority) : undefined;
    const result = await systemLogs.journal({
      unit: typeof q.unit === 'string' && q.unit ? q.unit : undefined,
      priority,
      since: typeof q.since === 'string' && q.since ? q.since : undefined,
      grep: typeof q.grep === 'string' && q.grep.trim() ? q.grep.trim() : undefined,
      lines: Number(q.lines) || undefined,
    });
    // Polling refreshes aren't worth a row each.
    if (q.refresh !== '1') logAudit(req.auth!.sub, req.auth!.username, 'audit.system_log', undefined, `journal${q.unit ? ` ${q.unit}` : ''}`);
    res.json(result);
  })
);

auditRouter.get(
  '/system/files',
  asyncHandler(async (_req, res) => {
    res.json({ files: systemLogs.files() });
  })
);

auditRouter.get(
  '/system/file',
  asyncHandler(async (req, res) => {
    const rel = typeof req.query.path === 'string' ? req.query.path : '';
    if (!rel) throw new HttpError(400, 'Pick a log file');
    const result = systemLogs.readFile(rel, {
      lines: Number(req.query.lines) || undefined,
      grep: typeof req.query.grep === 'string' && req.query.grep.trim() ? req.query.grep.trim() : undefined,
    });
    if (req.query.refresh !== '1') logAudit(req.auth!.sub, req.auth!.username, 'audit.system_log', undefined, `/var/log/${rel}`);
    res.json(result);
  })
);
