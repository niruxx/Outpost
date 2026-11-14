import { Router } from 'express';
import multer from 'multer';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { requireAuth, requirePermission, requireServerAccess } from '../auth/middleware.js';
import { getServer } from '../services/serverService.js';
import { assertDiskRoom } from '../services/limitsService.js';
import { logAudit } from '../services/userService.js';
import { MAX_BANNER_BYTES, bannerFile, saveBannerArtwork, updateBannerPosition, removeBannerArtwork } from '../services/bannerService.js';

export const bannerRouter = Router({ mergeParams: true });
bannerRouter.use(requireAuth, requireServerAccess(), (req, _res, next) => {
  try { if (!getServer(req.params.serverId)) throw new HttpError(404, 'Server not found'); next(); } catch (err) { next(err); }
});
bannerRouter.get('/', asyncHandler(async (req, res) => {
  const banner = bannerFile(req.params.serverId, req.query.v);
  res.set({ 'Content-Type': banner.mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=86400', ETag: `"${banner.version}"` });
  res.sendFile(banner.file);
}));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BANNER_BYTES, files: 1, fields: 0 } });
bannerRouter.post('/', (req, _res, next) => {
  try { requirePermission(req, 'settings'); assertDiskRoom(req.params.serverId, 'write'); next(); } catch (err) { next(err); }
}, upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Choose a banner image');
  assertDiskRoom(req.params.serverId, 'write');
  const banner = saveBannerArtwork(req.params.serverId, req.file.buffer);
  logAudit(req.auth!.sub, req.auth!.username, 'server.banner.upload', req.params.serverId, `${banner.width}×${banner.height} ${banner.mime}`);
  res.json({ banner });
}));
bannerRouter.patch('/', asyncHandler(async (req, res) => {
  requirePermission(req, 'settings');
  const banner = updateBannerPosition(req.params.serverId, req.body ?? {});
  logAudit(req.auth!.sub, req.auth!.username, 'server.banner.position', req.params.serverId); res.json({ banner });
}));
bannerRouter.delete('/', asyncHandler(async (req, res) => {
  requirePermission(req, 'settings'); removeBannerArtwork(req.params.serverId, req.body?.version);
  logAudit(req.auth!.sub, req.auth!.username, 'server.banner.remove', req.params.serverId); res.json({ banner: null });
}));
