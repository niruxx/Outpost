import fs from 'node:fs';
import { Router } from 'express';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { requireAuth, requirePermission, requireRole, requireServerAccess } from '../auth/middleware.js';
import { getServer } from '../services/serverService.js';
import { logAudit } from '../services/userService.js';
import { deleteHistory, historyFile, listHistory, maintain, readHistory, retentionDays, setRetentionDays } from '../services/consoleHistoryService.js';

/** Past console logs of one instance. Reading needs "console"; deleting needs "settings". */
export const consoleLogsRouter = Router({ mergeParams: true });
consoleLogsRouter.use(requireAuth, requireServerAccess());

function requireServer(id: string) {
  const server = getServer(id);
  if (!server) throw new HttpError(404, 'Server not found');
  return server;
}

consoleLogsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'console');
    const server = requireServer(req.params.serverId);
    res.json({ files: listHistory(server.id), retentionDays: retentionDays() });
  })
);

consoleLogsRouter.get(
  '/:name',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'console');
    const server = requireServer(req.params.serverId);
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const result = await readHistory(server.id, req.params.name, { q, limit });
    if (!result) throw new HttpError(404, 'No such log');
    res.json(result);
  })
);

consoleLogsRouter.get(
  '/:name/download',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'console');
    const server = requireServer(req.params.serverId);
    const file = historyFile(server.id, req.params.name);
    if (!file) throw new HttpError(404, 'No such log');
    const safeName = `${server.name.replace(/[^\w.-]+/g, '_')}-${req.params.name}`;
    res.setHeader('Content-Type', req.params.name.endsWith('.gz') ? 'application/gzip' : 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    fs.createReadStream(file).pipe(res);
  })
);

consoleLogsRouter.delete(
  '/:name',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'settings');
    const server = requireServer(req.params.serverId);
    if (!deleteHistory(server.id, req.params.name)) throw new HttpError(404, 'No such log');
    logAudit(req.auth!.sub, req.auth!.username, 'server.console_log.delete', server.id, req.params.name);
    res.json({ files: listHistory(server.id), retentionDays: retentionDays() });
  })
);

/** Panel-wide: how long console logs are kept (admins). */
export const consoleLogSettingsRouter = Router();
consoleLogSettingsRouter.use(requireAuth);

consoleLogSettingsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ retentionDays: retentionDays() });
  })
);

consoleLogSettingsRouter.put(
  '/',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const days = Number(req.body?.retentionDays);
    if (!Number.isInteger(days) || days < 0 || days > 3650) throw new HttpError(400, 'Keep logs for 0 (forever) to 3650 days');
    setRetentionDays(days);
    const swept = await maintain();
    logAudit(req.auth!.sub, req.auth!.username, 'settings.console_log_retention', undefined, days === 0 ? 'forever' : `${days} days`);
    res.json({ retentionDays: days, ...swept });
  })
);
