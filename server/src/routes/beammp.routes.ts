import { Router, type Request } from 'express';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { requireAuth, requireRole, requireServerAccess } from '../auth/middleware.js';
import { getServer } from '../services/serverService.js';
import { getUserById, logAudit } from '../services/userService.js';
import { earthStatus, installEarth, disableEarth } from '../services/beamngEarthService.js';
import { withAddonOperation } from '../services/addonOperationService.js';
import { assertAddonStopped } from '../services/installedAddonService.js';
import { appendLine } from '../services/consoleLogService.js';
import { beginJob, progressJob, finishJob } from '../services/jobService.js';

export const beammpRouter = Router({ mergeParams: true });
beammpRouter.use(requireAuth, requireServerAccess());
function serverOf(id: string) { const server = getServer(id); if (!server) throw new HttpError(404, 'Server not found'); return server; }
function authorize(req: Request) {
  const user = getUserById(req.auth!.sub);
  if (!user || user.disabled || user.role !== 'admin') throw new HttpError(403, 'An administrator must configure BeamNG.Earth');
  assertAddonStopped(req.params.serverId);
}

beammpRouter.get('/earth', asyncHandler(async (req, res) => { res.json(earthStatus(serverOf(req.params.serverId))); }));
beammpRouter.post('/earth/install', requireRole('admin'), asyncHandler(async (req, res) => {
  const result = await withAddonOperation(req.params.serverId, async () => {
    authorize(req);
    const job = beginJob('beamng-earth', req.params.serverId, 'Installing official BeamNG.Earth package');
    try {
      const result = await installEarth(serverOf(req.params.serverId), line => {
        appendLine(req.params.serverId, line); progressJob(job, line);
      }, () => authorize(req));
      finishJob(job); logAudit(req.auth!.sub, req.auth!.username, 'server.beamng-earth.install', req.params.serverId, result.version ?? undefined);
      return result;
    } catch (error) { finishJob(job, error); throw error; }
  });
  res.json(result);
}));
beammpRouter.post('/earth/disable', requireRole('admin'), asyncHandler(async (req, res) => {
  const result = await withAddonOperation(req.params.serverId, async () => { authorize(req); return disableEarth(serverOf(req.params.serverId)); });
  logAudit(req.auth!.sub, req.auth!.username, 'server.beamng-earth.disable', req.params.serverId);
  res.json(result);
}));
