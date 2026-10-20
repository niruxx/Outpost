import { Router } from 'express';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { requireAuth, requireRole, requireServerAccess } from '../auth/middleware.js';
import { getServer } from '../services/serverService.js';
import { logAudit } from '../services/userService.js';
import { appendLine } from '../services/consoleLogService.js';
import { diskStatus, limitsOf, limitSupportFor, saveLimits } from '../services/limitsService.js';

/** Resource limits for one instance: anyone with access can see them; admins change them. */
export const limitsRouter = Router({ mergeParams: true });
limitsRouter.use(requireAuth, requireServerAccess());

function view(serverId: string) {
  const server = getServer(serverId);
  if (!server) throw new HttpError(404, 'Server not found');
  return { limits: limitsOf(server), support: limitSupportFor(server), disk: diskStatus(server) };
}

limitsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(view(req.params.serverId));
  })
);

limitsRouter.put(
  '/',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const server = getServer(req.params.serverId);
    if (!server) throw new HttpError(404, 'Server not found');
    const limits = saveLimits(server, (req.body ?? {}) as Record<string, unknown>);
    appendLine(server.id, `[Outpost] Resource limits changed by ${req.auth!.username} — CPU, memory and process limits apply from the next start`, 'system');
    logAudit(req.auth!.sub, req.auth!.username, 'server.limits', server.id, JSON.stringify(limits));
    res.json(view(server.id));
  })
);
