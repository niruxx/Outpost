import { Router } from 'express';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { requireAuth } from '../auth/middleware.js';
import { listEvents, markRead, unreadCount } from '../services/eventLogService.js';
import { userHasServerAccess } from '../services/userService.js';

/** The signed-in account's event inbox (notification bell, instance activity). */
export const eventsRouter = Router();
eventsRouter.use(requireAuth);

eventsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const isAdmin = req.auth!.role === 'admin';
    const serverId = typeof req.query.serverId === 'string' ? req.query.serverId : undefined;
    if (serverId && !isAdmin && !userHasServerAccess(req.auth!.sub, serverId)) throw new HttpError(403, 'You do not have access to this server');
    res.json(
      listEvents(req.auth!.sub, isAdmin, {
        serverId,
        before: Number(req.query.before) || undefined,
        limit: Number(req.query.limit) || undefined,
        important: req.query.important === '1',
      }),
    );
  }),
);

eventsRouter.get(
  '/unread',
  asyncHandler(async (req, res) => {
    res.json({ unread: unreadCount(req.auth!.sub, req.auth!.role === 'admin') });
  }),
);

eventsRouter.post(
  '/read',
  asyncHandler(async (req, res) => {
    const upTo = Number(req.body?.upTo);
    const lastReadId = markRead(req.auth!.sub, Number.isFinite(upTo) && upTo > 0 ? upTo : undefined);
    res.json({ lastReadId, unread: unreadCount(req.auth!.sub, req.auth!.role === 'admin') });
  }),
);
