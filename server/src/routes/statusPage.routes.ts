import { Router } from 'express';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { requireAuth, requirePermission, requireServerAccess } from '../auth/middleware.js';
import { getServer } from '../services/serverService.js';
import { logAudit } from '../services/userService.js';
import { publicStatus, saveStatusPage, statusBadgeSvg, statusPageOf } from '../services/statusPageService.js';

/** Public, no sign-in: the status JSON and badge for an enabled page. Lightly rate-limited per IP. */
export const publicStatusRouter = Router();

const hits = new Map<string, { count: number; reset: number }>();
publicStatusRouter.use((req, res, next) => {
  const ip = req.ip ?? 'unknown';
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || h.reset < now) hits.set(ip, { count: 1, reset: now + 60_000 });
  else if (++h.count > 120) return res.status(429).json({ error: 'Too many requests — try again in a minute' });
  if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  res.setHeader('Cache-Control', 'no-store');
  next();
});

publicStatusRouter.get(
  '/:slug',
  asyncHandler(async (req, res) => {
    const status = publicStatus(req.params.slug);
    if (!status) throw new HttpError(404, 'No status page here');
    res.json(status);
  })
);

publicStatusRouter.get(
  '/:slug/badge.svg',
  asyncHandler(async (req, res) => {
    const status = publicStatus(req.params.slug);
    if (!status) throw new HttpError(404, 'No status page here');
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.send(statusBadgeSvg(status));
  })
);

/** Per instance: turn the page on/off and choose what it shows ("settings" permission). */
export const statusPageSettingsRouter = Router({ mergeParams: true });
statusPageSettingsRouter.use(requireAuth, requireServerAccess());

statusPageSettingsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const server = getServer(req.params.serverId);
    if (!server) throw new HttpError(404, 'Server not found');
    res.json({ config: statusPageOf(server) });
  })
);

statusPageSettingsRouter.put(
  '/',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'settings');
    const server = getServer(req.params.serverId);
    if (!server) throw new HttpError(404, 'Server not found');
    const config = saveStatusPage(server, (req.body ?? {}) as Record<string, unknown>);
    logAudit(req.auth!.sub, req.auth!.username, 'server.status_page', server.id, `${config.enabled ? 'on' : 'off'}${req.body?.newLink ? ', new link' : ''}`);
    res.json({ config });
  })
);
