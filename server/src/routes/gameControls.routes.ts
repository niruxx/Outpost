import { scanIncomingUploads } from './antivirus.routes.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { requireAuth, requirePermission, requireServerAccess } from '../auth/middleware.js';
import { getServer } from '../services/serverService.js';
import { isRunning, sendCommand } from '../services/processManager.js';
import { logAudit, getServerPermissions } from '../services/userService.js';
import { assertDiskRoom } from '../services/limitsService.js';
import { recordFileChangeSync } from '../services/fileChangeService.js';
import { requireGameProfile, gameControlsView, saveGameControls, gameMaps, validateMap, uploadGameMap, removeGameMapUpload, readGameConfig, writeGameConfig, gameFile } from '../services/gameControlsService.js';
import { satisfactoryConnected, satisfactoryView, connectSatisfactory, disconnectSatisfactory, satisfactoryAction, satisfactoryCall } from '../services/satisfactoryService.js';
import type { Request } from 'express';
import { authorizeFiles } from './fileWorkspace.routes.js';
import { changeCoreKeeperWorld, coreKeeperWorldDownload, coreKeeperWorldServer, coreKeeperWorldSlot, viewCoreKeeperWorlds } from '../services/coreKeeperWorlds.js';
import { holdCoreKeeperBackup } from '../services/backupService.js';

export const gameControlsRouter = Router({ mergeParams: true });
gameControlsRouter.use(requireAuth, requireServerAccess());
function serverOf(req: Request) {
  const s = getServer(req.params.serverId); if (!s) throw new HttpError(404, 'Server not found'); requireGameProfile(s); return s;
}
function stopped(req: Request) {
  const s = serverOf(req);
  if (isRunning(s.id) || !['stopped', 'crashed', 'install_failed'].includes(s.status)) throw new HttpError(409, 'Stop the server and wait for background jobs to finish before changing game files or startup settings');
  return s;
}
function view(req: Request) { const s = serverOf(req); const canEdit = !!getServerPermissions(req.auth!.sub, req.auth!.role, s.id)?.includes('settings'); return gameControlsView(s, canEdit); }
gameControlsRouter.get('/', asyncHandler(async (req, res) => { res.json(view(req)); }));

function authorizeWorldChange(req: Request) {
  authorizeFiles(req);
  requirePermission(req, 'settings');
  requirePermission(req, 'backups.create');
}

gameControlsRouter.get('/core-keeper/worlds', asyncHandler(async (req, res) => {
  authorizeFiles(req, false);
  res.json(viewCoreKeeperWorlds(coreKeeperWorldServer(req.params.serverId)));
}));
gameControlsRouter.get('/core-keeper/worlds/:slot/files/:kind', asyncHandler(async (req, res, next) => {
  authorizeFiles(req, false);
  const server = coreKeeperWorldServer(req.params.serverId);
  const release = await holdCoreKeeperBackup(server.id);
  try {
    authorizeFiles(req, false);
    const file = coreKeeperWorldDownload(coreKeeperWorldServer(server.id), coreKeeperWorldSlot(req.params.slot), req.params.kind);
    res.download(file, path.basename(file), (err) => {
      release?.();
      if (err) next(err);
    });
  } catch (err) { release?.(); throw err; }
}));

const worldUpload = multer({ dest: os.tmpdir(), limits: { fileSize: 512 * 1048576, files: 4, fields: 1, fieldSize: 128 } })
  .fields(['world', 'info', 'map', 'generation'].map((name) => ({ name, maxCount: 1 })));
gameControlsRouter.post('/core-keeper/worlds/:slot/import', (req, _res, next) => {
  try {
    authorizeWorldChange(req);
    coreKeeperWorldSlot(req.params.slot);
    const server = coreKeeperWorldServer(req.params.serverId);
    if (isRunning(server.id) || !['stopped', 'crashed'].includes(server.status)) throw new HttpError(409, 'Stop Core Keeper before importing a world.');
    next();
  } catch (err) { next(err); }
}, worldUpload, scanIncomingUploads, asyncHandler(async (req, res) => {
  const files = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
  try {
    const slot = coreKeeperWorldSlot(req.params.slot);
    const result = await changeCoreKeeperWorld(req.params.serverId, slot, 'import', req.body?.revision, () => authorizeWorldChange(req), files);
    logAudit(req.auth!.sub, req.auth!.username, 'core-keeper.world.import', req.params.serverId, String(slot));
    res.json(result);
  } finally {
    for (const file of Object.values(files).flat()) fs.rm(file.path, { force: true }, () => {});
  }
}));
gameControlsRouter.post('/core-keeper/worlds/:slot/:action', asyncHandler(async (req, res) => {
  authorizeWorldChange(req);
  const action = req.params.action;
  if (action !== 'select' && action !== 'remove') throw new HttpError(404, 'Unknown world action.');
  const slot = coreKeeperWorldSlot(req.params.slot);
  const result = await changeCoreKeeperWorld(req.params.serverId, slot, action, req.body?.revision, () => authorizeWorldChange(req));
  logAudit(req.auth!.sub, req.auth!.username, `core-keeper.world.${action}`, req.params.serverId, String(slot));
  res.json(result);
}));

gameControlsRouter.put('/', asyncHandler(async (req, res) => {
  requirePermission(req, 'settings'); const s = stopped(req); assertDiskRoom(s.id, 'write');
  saveGameControls(s, req.body ?? {}); logAudit(req.auth!.sub, req.auth!.username, 'server.game.settings', s.id, requireGameProfile(s).id); res.json(view(req));
}));
gameControlsRouter.get('/maps', asyncHandler(async (req, res) => { res.json({ maps: gameMaps(serverOf(req)) }); }));
gameControlsRouter.post('/maps/change', asyncHandler(async (req, res) => {
  requirePermission(req, 'console'); const s = serverOf(req), profile = requireGameProfile(s);
  if (!profile.map?.live) throw new HttpError(400, 'This game changes maps/worlds on restart or through its native API');
  if (!isRunning(s.id) || s.status !== 'running') throw new HttpError(409, 'Wait until the server is running');
  if (typeof req.body?.map !== 'string') throw new HttpError(400, 'Choose a map');
  const map = validateMap(req.body.map, profile); sendCommand(s.id, `${profile.map.live} ${map}`);
  logAudit(req.auth!.sub, req.auth!.username, 'server.game.map.change', s.id, map); res.json({ ok: true });
}));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 256 * 1048576, files: 1, fields: 0 } });
gameControlsRouter.post('/maps/upload', (req, _res, next) => {
  try { requirePermission(req, 'settings'); requirePermission(req, 'files.write'); const s = stopped(req); assertDiskRoom(s.id, 'write'); next(); } catch (err) { next(err); }
}, upload.single('file'), scanIncomingUploads, asyncHandler(async (req, res) => {
  const s = stopped(req); assertDiskRoom(s.id, 'write'); if (!req.file) throw new HttpError(400, 'Choose a map or world file');
  const result = uploadGameMap(s, req.file.originalname, req.file.buffer);
  logAudit(req.auth!.sub, req.auth!.username, 'server.game.map.upload', s.id, req.file.originalname); res.json({ ...view(req), uploaded: result.files });
}));
gameControlsRouter.get('/config/:fileId', asyncHandler(async (req, res) => {
  requirePermission(req, 'settings'); res.json(readGameConfig(serverOf(req), req.params.fileId));
}));
gameControlsRouter.delete('/maps/uploads/:uploadId', asyncHandler(async (req, res) => {
  requirePermission(req, 'settings'); requirePermission(req, 'files.write'); const s = stopped(req);
  removeGameMapUpload(s, req.params.uploadId); logAudit(req.auth!.sub, req.auth!.username, 'server.game.map.remove', s.id, req.params.uploadId); res.json(view(req));
}));
gameControlsRouter.put('/config/:fileId', asyncHandler(async (req, res) => {
  requirePermission(req, 'settings'); const s = stopped(req); assertDiskRoom(s.id, 'write');
  const before = readGameConfig(s, req.params.fileId);
  const change = recordFileChangeSync(gameFile(s, before.path), before.path, () => writeGameConfig(s, req.params.fileId, req.body?.content, req.body?.revision));
  const after = readGameConfig(s, req.params.fileId);
  logAudit(req.auth!.sub, req.auth!.username, 'server.game.config', s.id, before.path, change); res.json(after);
}));
function sf(req: Request) { const s = serverOf(req); if (requireGameProfile(s).id !== 'satisfactory') throw new HttpError(400, 'This is not a Satisfactory server'); return s; }
gameControlsRouter.get('/satisfactory', asyncHandler(async (req, res) => {
  requirePermission(req, 'settings'); const s = sf(req);
  if (!isRunning(s.id)) { res.json({ connected: satisfactoryConnected(s.id), offline: true }); return; }
  res.json(await satisfactoryView(s));
}));
gameControlsRouter.post('/satisfactory/connect', asyncHandler(async (req, res) => {
  requirePermission(req, 'settings'); const s = sf(req); if (!isRunning(s.id)) throw new HttpError(409, 'Start Satisfactory first');
  await connectSatisfactory(s, req.body?.token); logAudit(req.auth!.sub, req.auth!.username, 'server.satisfactory.connect', s.id); res.json(await satisfactoryView(s));
}));
gameControlsRouter.delete('/satisfactory/connect', asyncHandler(async (req, res) => {
  requirePermission(req, 'settings'); disconnectSatisfactory(sf(req).id); res.json({ ok: true });
}));
gameControlsRouter.post('/satisfactory/action', asyncHandler(async (req, res) => {
  requirePermission(req, 'settings'); requirePermission(req, 'console'); const s = sf(req); if (!isRunning(s.id)) throw new HttpError(409, 'Start Satisfactory first');
  const action = satisfactoryAction(req.body?.action, req.body ?? {}); await satisfactoryCall(s, action.fn, action.data);
  logAudit(req.auth!.sub, req.auth!.username, 'server.satisfactory.action', s.id, String(req.body?.action)); res.json({ ok: true });
}));
gameControlsRouter.post('/satisfactory/upload', (req, _res, next) => {
  try { requirePermission(req, 'settings'); requirePermission(req, 'files.write'); const s = sf(req); if (!isRunning(s.id)) throw new HttpError(409, 'Start Satisfactory first'); assertDiskRoom(s.id, 'write'); next(); } catch (err) { next(err); }
}, upload.single('file'), scanIncomingUploads, asyncHandler(async (req, res) => {
  const s = sf(req); if (!isRunning(s.id)) throw new HttpError(409, 'Start Satisfactory first');
  if (!req.file || !/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,127}\.sav$/i.test(req.file.originalname)) throw new HttpError(400, 'Upload a .sav file with a simple filename');
  const name = req.file.originalname.slice(0, -4);
  const sessions = await satisfactoryView(s);
  if (sessions.sessions.some((session: { saves: { name: string }[] }) => session.saves.some((save) => save.name === name))) throw new HttpError(409, 'A save with that name already exists');
  await satisfactoryCall(s, 'UploadSaveGame', { SaveName: name, LoadSaveGame: false, EnableAdvancedGameSettings: false }, undefined, { name: req.file.originalname, buffer: req.file.buffer });
  logAudit(req.auth!.sub, req.auth!.username, 'server.satisfactory.upload', s.id, req.file.originalname); res.json(await satisfactoryView(s));
}));
