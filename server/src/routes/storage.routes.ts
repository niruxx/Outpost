import { Router, type Request } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { HttpError, asyncHandler } from '../utils/asyncHandler.js';
import { getUserById, storagePermissionsOf } from '../services/userService.js';
import { StorageManager, storageManager } from '../services/storageService.js';
import { validateStorageOperation, storagePermission } from '../services/storageHelper.js';
import type { StoragePermission } from '../types/index.js';

function requireStorage(req: Request, permission: StoragePermission) {
  const user = getUserById(req.auth!.sub);
  if (!user || !storagePermissionsOf(user).includes(permission)) throw new HttpError(403, `Storage permission required: ${permission}`);
  if (permission !== 'view' && req.auth!.apiKey) throw new HttpError(403, 'Sign in to the panel to change host storage; API keys cannot perform disk operations');
  return user;
}
export function createStorageRouter(manager: StorageManager = storageManager) {
  const router = Router(); router.use(requireAuth);
  router.get('/', asyncHandler(async (req, res) => {
    const user = requireStorage(req, 'view');
    res.set('Cache-Control', 'no-store').json({ ...await manager.overview(), permissions: storagePermissionsOf(user) });
  }));
  router.post('/preview', asyncHandler(async (req, res) => {
    let op;
    try { op = validateStorageOperation(req.body); }
    catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'Invalid storage operation'); }
    const user = requireStorage(req, storagePermission(op.action));
    if (op.persistent) requireStorage(req, 'automount');
    if (['luksGrow', 'pvGrow', 'lvResize'].includes(op.action)) requireStorage(req, 'resize');
    res.set('Cache-Control', 'no-store').json(await manager.preview(user.id, op));
  }));
  router.post('/execute', (req, res, next) => {
    try {
      const user = requireStorage(req, 'view');
      const op = manager.plannedOperation(user.id, req.body?.ticket);
      const action = op.action;
      requireStorage(req, storagePermission(action));
      if (op.persistent) requireStorage(req, 'automount');
      if (['luksGrow', 'pvGrow', 'lvResize'].includes(op.action)) requireStorage(req, 'resize');
      if (req.auth!.apiKey) throw new HttpError(403, 'Sign in to the panel to change host storage');
      res.status(202).json({ job: manager.execute(user.id, user.username, req.body?.ticket, req.body?.confirmation, req.body?.secrets) });
    } catch (error) { next(error); }
  });
  return router;
}
export const storageRouter = createStorageRouter();
