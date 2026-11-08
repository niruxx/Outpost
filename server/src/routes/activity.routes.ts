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

/** The stored file change of one activity entry; `serverId` limits it to that instance's entries. */
function storedChange(id: string, serverId?: string) {
  const row = prep('SELECT target, file_change FROM audit_log WHERE id = ?').get(id) as { target: string | null; file_change: string | null } | undefined;
  if (!row?.file_change || (serverId && row.target !== serverId)) throw new HttpError(404, 'No file changes recorded for this activity');
  try {
    return JSON.parse(row.file_change) as unknown;
  } catch {
    throw new HttpError(500, 'This file change record is unreadable');
  }
}

/** Filters shared by every activity feed: action family, free text, file changes only, one file. */
const feedFilter = (q: Record<string, unknown>) => ({ action: q.action, search: q.search, files: q.files, path: q.path, server: q.server });

activityRouter.get('/actions/:id/changes', requireRole('admin'), (req, res) => {
  res.json(storedChange(req.params.id));
});

/** Everyone's actions, newest first (the "All users" tab; `?files=1` for the "File changes" tab). */
activityRouter.get('/actions', requireRole('admin'), (req, res) => {
  res.json(auditPage(feedFilter(req.query), req.query));
});

activityRouter.get('/users/:userId/actions', requireRole('admin'), (req, res) => {
  res.json(auditPage({ ...feedFilter(req.query), userId: req.params.userId }, req.query));
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
    const result = auditPage({ ...feedFilter(req.query), server: server.id }, req.query);
    // Client addresses are for admins only.
    const entries = admin ? result.entries : result.entries.map((e) => ({ ...e, ip: null, userAgent: null, agent: null }));
    const viewers = presence({ serverId: server.id }).map((t) => (admin ? t : { ...t, ip: null, agent: null }));
    res.json({ ...result, entries, viewers });
  }),
);

/** What changed in a file, for one of this instance's entries. Same audience as the feed. */
serverActivityRouter.get('/changes/:entryId', (req, res) => {
  // `serverId` comes from the mount path (mergeParams), which the route's types don't know about.
  const server = getServer((req.params as { serverId?: string }).serverId ?? '');
  if (!server) throw new HttpError(404, 'Instance not found');
  if (req.auth!.role !== 'admin' && server.created_by !== req.auth!.sub) throw new HttpError(403, 'Only admins and the instance owner can see its file history');
  res.json(storedChange(req.params.entryId, server.id));
});
