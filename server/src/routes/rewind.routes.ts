import { Router } from 'express';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { requireAuth, requirePermission, requireServerAccess } from '../auth/middleware.js';
import { getServer } from '../services/serverService.js';
import { isRunning } from '../services/processManager.js';
import {
  INTERVALS,
  createPoint,
  deletePoint,
  levelDatInfo,
  listPoints,
  restoreLevelDat,
  restorePoint,
  rewindConfigOf,
  saveRewindConfig,
  worldDirs,
} from '../services/rewindService.js';
import { logAudit } from '../services/userService.js';
import { isMinecraftPlatform, type ServerRecord } from '../types/index.js';

/** World Rewind: Minecraft world restore points. Taking points needs "backups.create"; restoring needs "backups.restore". */
export const rewindRouter = Router({ mergeParams: true });
rewindRouter.use(requireAuth, requireServerAccess());

function requireServer(id: string): ServerRecord {
  const server = getServer(id);
  if (!server) throw new HttpError(404, 'Server not found');
  return server;
}

function view(server: ServerRecord) {
  const supported = isMinecraftPlatform(server.platform);
  return {
    supported,
    config: rewindConfigOf(server),
    intervals: INTERVALS,
    running: isRunning(server.id),
    worlds: supported ? worldDirs(server) : [],
    points: supported ? listPoints(server) : [],
    levelDat: supported ? levelDatInfo(server) : [],
  };
}

rewindRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(view(requireServer(req.params.serverId)));
  })
);

rewindRouter.put(
  '/config',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'backups.create');
    const server = requireServer(req.params.serverId);
    const cfg = saveRewindConfig(server, req.body);
    logAudit(req.auth!.sub, req.auth!.username, 'backup.rewind_config', server.id, cfg.enabled ? `every ${cfg.intervalMinutes} min, keep ${cfg.keep}` : 'off');
    res.json(view(requireServer(server.id)));
  })
);

rewindRouter.post(
  '/points',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'backups.create');
    const server = requireServer(req.params.serverId);
    const point = await createPoint(server, 'manual');
    logAudit(req.auth!.sub, req.auth!.username, 'backup.rewind_point', server.id, point?.id);
    res.status(201).json(view(server));
  })
);

rewindRouter.post(
  '/points/:pointId/restore',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'backups.restore');
    const server = requireServer(req.params.serverId);
    const only = Array.isArray(req.body?.worlds) ? (req.body.worlds as unknown[]).map(String) : undefined;
    const result = await restorePoint(server, req.params.pointId, only);
    logAudit(req.auth!.sub, req.auth!.username, 'backup.rewind_restore', server.id, `${req.params.pointId}: ${result.restored.join(', ')}`);
    res.json({ ...view(server), ...result });
  })
);

rewindRouter.delete(
  '/points/:pointId',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'backups.create');
    const server = requireServer(req.params.serverId);
    deletePoint(server, req.params.pointId);
    logAudit(req.auth!.sub, req.auth!.username, 'backup.rewind_delete', server.id, req.params.pointId);
    res.json(view(server));
  })
);

rewindRouter.post(
  '/level-dat',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'backups.restore');
    const server = requireServer(req.params.serverId);
    const world = typeof req.body?.world === 'string' ? req.body.world : '';
    restoreLevelDat(server, world);
    logAudit(req.auth!.sub, req.auth!.username, 'backup.level_dat_restore', server.id, world);
    res.json(view(server));
  })
);
