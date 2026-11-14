import express, { Router, type Request } from 'express';
import { requireAuth, requirePermission, requireServerAccess } from '../auth/middleware.js';
import { getUserById, logAudit, userHasServerAccess } from '../services/userService.js';
import { getServer } from '../services/serverService.js';
import { assertDiskRoom } from '../services/limitsService.js';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import * as workspace from '../services/fileWorkspaceService.js';
import { analyzeConfig } from '../services/configEditorService.js';
import { fileChange } from '../services/fileChangeService.js';

export const fileWorkspaceRouter = Router({ mergeParams: true });
export function authorizeFiles(req: Request, write: boolean | null = true) {
  if (!getServer(req.params.serverId)) throw new HttpError(404, 'Instance not found');
  const user = getUserById(req.auth!.sub);
  if (!user || user.disabled) throw new HttpError(403, 'Account unavailable');
  req.auth!.role = user.role;
  if (user.role !== 'admin' && (!userHasServerAccess(user.id, req.params.serverId) || getServer(req.params.serverId)?.suspended)) throw new HttpError(403, 'Instance access unavailable');
  if (write !== null) requirePermission(req, write ? 'files.write' : 'files.read');
  if (write && !['GET', 'DELETE'].includes(req.method)) assertDiskRoom(req.params.serverId, 'write');
}
fileWorkspaceRouter.use(requireAuth, (req, _res, next) => { try { authorizeFiles(req, null); next(); } catch (e) { next(e); } }, requireServerAccess());
fileWorkspaceRouter.use(['/search', '/recycle', '/validate'], (req, _res, next) => { try { if (req.method === 'GET' || req.path === '/validate') authorizeFiles(req, false); next(); } catch (e) { next(e); } });
fileWorkspaceRouter.use('/transfers', (req, _res, next) => { try { authorizeFiles(req); next(); } catch (e) { next(e); } });
fileWorkspaceRouter.get('/search', (req: Request, res, next) => { try { res.json(workspace.searchFiles(req.params.serverId, String(req.query.q ?? ''), String(req.query.name ?? ''), String(req.query.extension ?? ''))); } catch (e) { next(e); } });
fileWorkspaceRouter.get('/recycle', (req: Request, res) => res.json({ items: workspace.trash(req.params.serverId) }));
fileWorkspaceRouter.post('/recycle/:id/restore', asyncHandler(async (req: Request, res) => {
  authorizeFiles(req); await workspace.restore(req.params.serverId, req.params.id, () => authorizeFiles(req));
  logAudit(req.auth!.sub, req.auth!.username, 'file.restore', req.params.serverId, req.params.id); res.json({ ok: true });
}));
fileWorkspaceRouter.delete('/recycle/:id', (req: Request, res, next) => { try { authorizeFiles(req); workspace.purge(req.params.serverId, req.params.id); logAudit(req.auth!.sub, req.auth!.username, 'file.purge', req.params.serverId, req.params.id); res.status(204).end(); } catch (e) { next(e); } });
fileWorkspaceRouter.post('/validate', (req: Request, res, next) => { try {
  authorizeFiles(req, false);
  if (typeof req.body?.path !== 'string' || typeof req.body?.content !== 'string' || Buffer.byteLength(req.body.content) > 5 * 1024 * 1024) throw new HttpError(400, 'A path and content under 5 MiB are required');
  workspace.confined(req.params.serverId, req.body.path); res.json(analyzeConfig(req.body.path, req.body.content, req.body.format === true, getServer(req.params.serverId)));
} catch (e) { next(e); } });
fileWorkspaceRouter.get('/transfers', (req: Request, res) => res.json({ items: workspace.transfers(req.params.serverId, req.auth!.sub) }));
fileWorkspaceRouter.post('/transfers', (req: Request, res, next) => { try { authorizeFiles(req); res.status(201).json(workspace.createTransfer(req.params.serverId, req.auth!.sub, req.body)); } catch (e) { next(e); } });
fileWorkspaceRouter.get('/transfers/:id', (req: Request, res, next) => { try { res.json(workspace.transfer(req.params.serverId, req.auth!.sub, req.params.id)); } catch (e) { next(e); } });
fileWorkspaceRouter.put('/transfers/:id/chunk', (req, _res, next) => { try { authorizeFiles(req); next(); } catch (e) { next(e); } }, express.raw({ type: 'application/octet-stream', limit: '1mb' }), (req: Request, res, next) => {
  try { if (!Buffer.isBuffer(req.body)) throw new HttpError(400, 'Binary chunk required'); res.json(workspace.appendChunk(req.params.serverId, req.auth!.sub, req.params.id, Number(req.headers['upload-offset']), req.body)); } catch (e) { next(e); }
});
fileWorkspaceRouter.delete('/transfers/:id', (req: Request, res, next) => { try { authorizeFiles(req); workspace.cancelTransfer(req.params.serverId, req.auth!.sub, req.params.id); res.status(204).end(); } catch (e) { next(e); } });
fileWorkspaceRouter.post('/transfers/:id/complete', asyncHandler(async (req: Request, res) => {
  authorizeFiles(req); const result = await workspace.finishTransfer(req.params.serverId, req.auth!.sub, req.params.id, () => authorizeFiles(req),
    (relative, before, after) => logAudit(req.auth!.sub, req.auth!.username, 'file.upload', req.params.serverId, relative, fileChange(relative, before, after)));
  if (result.state === 'skipped') logAudit(req.auth!.sub, req.auth!.username, 'file.upload.skip', req.params.serverId, result.path);
  res.json(result);
}));
