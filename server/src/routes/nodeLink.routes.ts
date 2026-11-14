import { capacityNodeRouter,recoveryNodeRouter } from './fleetAdvanced.routes.js';
import { localInventory } from '../services/fleetService.js';
import { configPreview, performUiAction } from '../services/uiWorkspaceService.js';
import { HttpError } from '../utils/asyncHandler.js';
import { provisionOnNode, nodeProvisionIdentity } from './operations.routes.js';
import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { localNodeInfo, receiveTransfer, requireNodeKey } from '../services/nodeService.js';
import { logAudit } from '../services/userService.js';
import { hostAdminApi, remoteHostContext } from './hostAdmin.routes.js';

/** Node-to-node API, authenticated by this panel's node key instead of a user session. */
export const nodeLinkRouter = Router();

nodeLinkRouter.use((req, _res, next) => {
  try {
    requireNodeKey(req);
    next();
  } catch (err) {
    next(err);
  }
});

nodeLinkRouter.get(
  '/info',
  asyncHandler(async (_req, res) => {
    res.json(localNodeInfo());
  })
);

nodeLinkRouter.post(
  '/import',
  asyncHandler(async (req, res) => {
    const server = await receiveTransfer(req);
    logAudit(null, 'node-link', 'server.transfer.receive', server.id, `from ${req.socket.remoteAddress ?? 'unknown'}`);
    res.status(201).json({ serverId: server.id });
  })
);

nodeLinkRouter.use('/capacity',capacityNodeRouter);
nodeLinkRouter.use('/recovery',recoveryNodeRouter);

nodeLinkRouter.get('/inventory', (_req, res) => res.json(localInventory()));
nodeLinkRouter.post('/workspace/preview', asyncHandler(async (req, res) => {
  if (typeof req.body?.serverId !== 'string' || !/^[\w-]{1,100}$/.test(req.body.serverId)) throw new HttpError(400, 'Invalid instance');
  res.json(configPreview(req.body.serverId, req.body.patch));
}));
nodeLinkRouter.post('/workspace/action', asyncHandler(async (req, res) => {
  if (typeof req.body?.serverId !== 'string' || !/^[\w-]{1,100}$/.test(req.body.serverId)) throw new HttpError(400, 'Invalid instance');
  await performUiAction(req.body.serverId, req.body.action, req.body.patch, req.body.revision);
  logAudit(null, 'node-link', `fleet.bulk.${req.body.action}`, req.body.serverId); res.json({ ok: true });
}));
nodeLinkRouter.post('/provision', asyncHandler(async (req, res) => { nodeProvisionIdentity(req); await provisionOnNode(req, res); }));

// Host administration by a linked panel (only when this host allows it; see hostAdmin.routes).
nodeLinkRouter.use('/host', remoteHostContext, hostAdminApi);
