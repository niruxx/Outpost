import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import {
  NOTIFY_EVENTS,
  createWebhook,
  deleteWebhook,
  listWebhooks,
  sanitizeWebhookInput,
  testWebhook,
  updateWebhook,
} from '../services/notificationService.js';
import { logAudit } from '../services/userService.js';

/** Panel-wide notification webhooks (Discord or generic JSON). Admin only. */
export const notificationsRouter = Router();
notificationsRouter.use(requireAuth, requireRole('admin'));

notificationsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ webhooks: listWebhooks(), events: NOTIFY_EVENTS });
  })
);

notificationsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const webhook = createWebhook(sanitizeWebhookInput(req.body));
    logAudit(req.auth!.sub, req.auth!.username, 'webhook.create', webhook.id, webhook.name);
    res.status(201).json({ webhook });
  })
);

notificationsRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const webhook = updateWebhook(req.params.id, sanitizeWebhookInput(req.body));
    logAudit(req.auth!.sub, req.auth!.username, 'webhook.update', webhook.id, webhook.name);
    res.json({ webhook });
  })
);

notificationsRouter.post(
  '/:id/test',
  asyncHandler(async (req, res) => {
    await testWebhook(req.params.id);
    res.json({ ok: true });
  })
);

notificationsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    deleteWebhook(req.params.id);
    logAudit(req.auth!.sub, req.auth!.username, 'webhook.delete', req.params.id);
    res.status(204).end();
  })
);
