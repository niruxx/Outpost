import { Router } from 'express';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { requireAuth, requireRole, requireServerAccess } from '../auth/middleware.js';
import { prep } from '../db/db.js';
import { AUDIT_SELECT, MAX_PAGE, auditFilter, shapeAudit, type AuditRow } from '../services/auditService.js';
import { leavePresence, pageViews, presence, reportPresence, userSummaries } from '../services/activityService.js';
import { getServer } from '../services/serverService.js';

/**
 * The Activity page: who is signed in, which page each of their tabs is on, and everything they
 * did (actions from the audit log) and looked at (page views). Admin only — except the presence
 * pings every panel tab sends, and the per-instance feed, which an instance's owner can see too.
 */
export const activityRouter = Router();
activityRouter.use(requireAuth);

const pageArgs = (q: Record<string, unknown>) => ({
  limit: Math.min(MAX_PAGE, Math.max(1, Number(q.limit) || 50)),
  before: Number(q.before) > 0 ? Number(q.before) : null,
});

function auditPage(filter: Record<string, unknown>, q: Record<string, unknown>) {
  const { limit, before } = pageArgs(q);
  const { where, params } = auditFilter(filter);
  const clause = before ? `${where ? `${where} AND` : 'WHERE'} a.id < ?` : where;
  const rows = prep(`${AUDIT_SELECT} ${clause} ORDER BY a.id DESC LIMIT ?`).all(...params, ...(before ? [before] : []), limit + 1) as unknown as AuditRow[];
  const page = rows.slice(0, limit);
  return { entries: page.map(shapeAudit), nextBefore: rows.length > limit ? page[page.length - 1].id : null };
}

/** Heartbeat from an open panel tab: { tabId, path, visible }. API keys aren't browser tabs. */
activityRouter.post('/presence', (req, res) => {
  if (!req.auth!.apiKey) reportPresence({ id: req.auth!.sub, username: req.auth!.username }, req.body ?? {});
  res.status(204).end();
});

activityRouter.post('/leave', (req, res) => {
  leavePresence(req.auth!.sub, req.body?.tabId);
  res.status(204).end();
});

activityRouter.get('/users', requireRole('admin'), (_req, res) => {
  res.json({ users: userSummaries() });
});

activityRouter.get('/actions/:id/changes', requireRole('admin'), (req, res) => {
  const row = prep('SELECT file_change FROM audit_log WHERE id = ?').get(req.params.id) as { file_change: string | null } | undefined;
  if (!row?.file_change) throw new HttpError(404, 'No file changes recorded for this activity');
  res.json(JSON.parse(row.file_change));
});

/** Everyone's actions, newest first (the "All users" tab). */
activityRouter.get('/actions', requireRole('admin'), (req, res) => {
  res.json(auditPage({ action: req.query.action, search: req.query.search }, req.query));
});

activityRouter.get('/users/:userId/actions', requireRole('admin'), (req, res) => {
  res.json(auditPage({ userId: req.params.userId, action: req.query.action, search: req.query.search }, req.query));
});

activityRouter.get('/users/:userId/views', requireRole('admin'), (req, res) => {
  const { limit, before } = pageArgs(req.query);
  res.json(pageViews(req.params.userId, before, limit));
});

/** One instance's activity: who changed what on it, and who has it open right now. */
export const serverActivityRouter = Router({ mergeParams: true });
serverActivityRouter.use(requireAuth, requireServerAccess());
serverActivityRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const server = getServer(req.params.serverId);
    if (!server) throw new HttpError(404, 'Instance not found');
    const admin = req.auth!.role === 'admin';
    if (!admin && server.created_by !== req.auth!.sub) throw new HttpError(403, 'Only admins and the instance owner can see its activity');
    const result = auditPage({ server: server.id, action: req.query.action, search: req.query.search }, req.query);
    // Client addresses are for admins only.
    const entries = admin ? result.entries : result.entries.map((e) => ({ ...e, hasFileChange: false, ip: null, userAgent: null, agent: null }));
    const viewers = presence({ serverId: server.id }).map((t) => (admin ? t : { ...t, ip: null, agent: null }));
    res.json({ ...result, entries, viewers });
  }),
);
