import { Router, type Request } from 'express';
import { requireAuth, requirePermission, requireServerAccess } from '../auth/middleware.js';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { getServer } from '../services/serverService.js';
import { getUserById, logAudit } from '../services/userService.js';
import { worldHealthCapable, worldHealthReport, startWorldHealth, cancelWorldHealth, repairWorldHealth } from '../services/worldHealthService.js';
export const worldHealthRouter = Router({ mergeParams: true });
worldHealthRouter.use(requireAuth, (req, _res, next) => { const user = getUserById(req.auth!.sub); if (!user) return next(new HttpError(401, 'Current account required')); req.auth!.role = user.role; next(); }, requireServerAccess());
worldHealthRouter.get('/', (req: Request, res, next) => { try { requirePermission(req, 'files.read'); const server = getServer(req.params.serverId); if (!server) throw new HttpError(404, 'Instance not found'); res.json({ capable: worldHealthCapable(server), report: worldHealthReport(server.id) }); } catch (err) { next(err); } });
worldHealthRouter.post('/scan', (req: Request, res, next) => { try { requirePermission(req, 'files.read'); const report = startWorldHealth(req.params.serverId); logAudit(req.auth!.sub, req.auth!.username, 'world.health.scan', req.params.serverId); res.status(202).json({ report }); } catch (err) { next(err); } });
worldHealthRouter.post('/cancel', (req: Request, res, next) => { try { requirePermission(req, 'files.read'); cancelWorldHealth(req.params.serverId); res.json({ ok: true }); } catch (err) { next(err); } });
worldHealthRouter.post('/repair', asyncHandler(async (req, res) => {
  for (const permission of ['files.write', 'backups.create', 'backups.restore'] as const) requirePermission(req, permission);
  if (req.body?.confirm !== true) throw new HttpError(400, 'Confirm the displayed repair impact first');
  const result = await repairWorldHealth(req.params.serverId, req.body?.reportId, req.body?.repairId);
  logAudit(req.auth!.sub, req.auth!.username, 'world.health.repair', req.params.serverId, `${result.file}; recovery backup ${result.backup}`); res.json(result);
}));
