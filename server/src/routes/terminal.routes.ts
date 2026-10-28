import { Router } from 'express';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { createTerminalTicket, terminalIdentity, terminalStatus } from '../services/hostTerminalService.js';

export const terminalRouter = Router();
terminalRouter.use(requireAuth, requireRole('admin'));
terminalRouter.use((req, _res, next) => {
  try {
    // Unlike general panel routes, terminal access always needs the Authorization header.
    terminalIdentity(req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '');
    next();
  } catch (error) { next(error); }
});
terminalRouter.get('/', asyncHandler(async (_req, res) => {
  res.set('Cache-Control', 'no-store').json(await terminalStatus());
}));
terminalRouter.post('/ticket', (req, res, next) => {
  try { res.set('Cache-Control', 'no-store').json(createTerminalTicket(req.headers.authorization!.slice(7), req.body)); }
  catch (error) { next(error); }
});
