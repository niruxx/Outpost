import { localInventory } from '../services/fleetService.js';
import { provisionOnNode, nodeProvisionIdentity } from './operations.routes.js';
import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { localNodeInfo, receiveTransfer, requireNodeKey } from '../services/nodeService.js';
import { logAudit } from '../services/userService.js';

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

nodeLinkRouter.get('/inventory', (_req, res) => res.json(localInventory()));
nodeLinkRouter.post('/provision', asyncHandler(async (req, res) => { nodeProvisionIdentity(req); await provisionOnNode(req, res); }));
