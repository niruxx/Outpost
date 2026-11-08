import { Router } from 'express';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { prep } from '../db/db.js';
import { AUDIT_SELECT as SELECT, MAX_PAGE, auditFilter, auditStats, shapeAudit as shape, setRetentionDays, type AuditRow } from '../services/auditService.js';
import { systemLogs } from '../services/systemLogsService.js';
import { logAudit } from '../services/userService.js';

/**
 * The audit log (who did what, from where, newest first, with filters, paging and CSV export),
 * how long it's kept, and the host's own system logs. Admin only.
 */
export const auditRouter = Router();
auditRouter.use(requireAuth, requireRole('admin'));

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
