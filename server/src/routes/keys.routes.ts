import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { requireAuth } from '../auth/middleware.js';
import { logAudit } from '../services/userService.js';
import { createKey, listKeys, revokeKey } from '../services/apiKeyService.js';

/** Personal API keys. Everyone manages their own; admins can see and revoke anyone's (?all=1). */
export const keysRouter = Router();
keysRouter.use(requireAuth);

keysRouter.get('/', (req, res) => {
  const all = req.query.all === '1' && req.auth!.role === 'admin';
  res.json({ keys: listKeys(all ? undefined : req.auth!.sub) });
});

keysRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const { key, info } = createKey(req.auth!.sub, req.body ?? {});
    logAudit(req.auth!.sub, req.auth!.username, 'apikey.create', undefined, `${info.name}${info.readOnly ? ' (read-only)' : ''}${info.expiresAt ? `, expires ${info.expiresAt.slice(0, 10)}` : ''}`);
    // The only time the key is ever shown.
    res.status(201).json({ key, info, keys: listKeys(req.auth!.sub) });
  })
);

keysRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const info = revokeKey(req.params.id, req.auth!.role === 'admin' ? null : req.auth!.sub);
    logAudit(req.auth!.sub, req.auth!.username, 'apikey.revoke', undefined, `${info.name}${info.userId !== req.auth!.sub ? ` (owned by ${info.username ?? info.userId})` : ''}`);
    res.json({ keys: listKeys(req.query.all === '1' && req.auth!.role === 'admin' ? undefined : req.auth!.sub) });
  })
);
