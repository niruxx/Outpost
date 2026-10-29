import { Router } from 'express';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { createTerminalTicket, terminalIdentity, terminalStatus } from '../services/hostTerminalService.js';
import { startTerminalRepair, terminalRepairJob, terminalRepairPlan } from '../services/hostSetupService.js';
import { logAudit } from '../services/userService.js';

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
terminalRouter.get('/dependencies', (_req, res) => res.set('Cache-Control', 'no-store').json({ plan: terminalRepairPlan(), job: terminalRepairJob() }));
terminalRouter.post('/dependencies/install', (req, res, next) => {
  try { const job = startTerminalRepair(req.body?.installSystemTools); logAudit(req.auth!.sub, req.auth!.username, 'terminal.dependencies.install', undefined, req.body?.installSystemTools ? 'OS build tools and node-pty' : 'node-pty repair'); res.status(202).json({ job }); }
  catch (error) { next(error); }
});
terminalRouter.post('/ticket', (req, res, next) => {
  try { res.set('Cache-Control', 'no-store').json(createTerminalTicket(req.headers.authorization!.slice(7), req.body)); }
  catch (error) { next(error); }
});
