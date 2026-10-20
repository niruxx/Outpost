import { Router } from 'express';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { requireAuth, requirePermission, requireServerAccess } from '../auth/middleware.js';
import { getServer } from '../services/serverService.js';
import {
  addItems,
  applyWorkshop,
  importFromZomboidIni,
  isApplying,
  publicState,
  removeItem,
  setLogin,
  setOptions,
  updateItem,
  workshopSupportOf,
  zomboidIniInfo,
} from '../services/workshopService.js';
import { workshopStateOf } from '../services/workshopState.js';
import { logAudit } from '../services/userService.js';
import type { ServerRecord } from '../types/index.js';

/** Steam Workshop mods for one instance. Viewing needs instance access; changing needs "plugins". */
export const workshopRouter = Router({ mergeParams: true });
workshopRouter.use(requireAuth, requireServerAccess());

function requireServer(id: string): ServerRecord {
  const server = getServer(id);
  if (!server) throw new HttpError(404, 'Server not found');
  return server;
}

function view(serverId: string) {
  const server = requireServer(serverId);
  const support = workshopSupportOf(server);
  return {
    support,
    state: publicState(workshopStateOf(server)),
    applying: isApplying(server.id),
    ini: support?.mode === 'zomboid' ? zomboidIniInfo(server) : null,
  };
}

workshopRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(view(req.params.serverId));
  })
);

workshopRouter.post(
  '/items',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'plugins');
    const server = requireServer(req.params.serverId);
    const input = typeof req.body?.input === 'string' ? req.body.input : '';
    const result = await addItems(server, input);
    if (result.added.length) logAudit(req.auth!.sub, req.auth!.username, 'plugin.workshop_add', server.id, result.added.map((i) => `${i.title} (${i.id})`).join(', '));
    res.status(201).json({ ...view(server.id), added: result.added.length, skipped: result.skipped });
  })
);

workshopRouter.post(
  '/import',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'plugins');
    const server = requireServer(req.params.serverId);
    const result = await importFromZomboidIni(server);
    res.json({ ...view(server.id), added: result.added.length, skipped: result.skipped });
  })
);

workshopRouter.patch(
  '/items/:itemId',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'plugins');
    updateItem(requireServer(req.params.serverId), req.params.itemId, req.body ?? {});
    res.json(view(req.params.serverId));
  })
);

workshopRouter.delete(
  '/items/:itemId',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'plugins');
    const server = requireServer(req.params.serverId);
    removeItem(server, req.params.itemId);
    logAudit(req.auth!.sub, req.auth!.username, 'plugin.workshop_remove', server.id, req.params.itemId);
    res.json(view(server.id));
  })
);

workshopRouter.put(
  '/options',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'plugins');
    setOptions(requireServer(req.params.serverId), req.body ?? {});
    res.json(view(req.params.serverId));
  })
);

/** The Steam account used for downloads. Stored on the panel only; never sent back. */
workshopRouter.put(
  '/login',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'settings');
    const server = requireServer(req.params.serverId);
    const user = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const pass = typeof req.body?.password === 'string' ? req.body.password : '';
    setLogin(server, user && pass ? `${user} ${pass}` : null);
    logAudit(req.auth!.sub, req.auth!.username, 'plugin.workshop_login', server.id, user ? `account ${user}` : 'removed');
    res.json(view(server.id));
  })
);

workshopRouter.post(
  '/apply',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'plugins');
    const server = requireServer(req.params.serverId);
    const guardCode = typeof req.body?.guardCode === 'string' && /^[A-Za-z0-9]{5}$/.test(req.body.guardCode.trim()) ? req.body.guardCode.trim() : undefined;
    const result = await applyWorkshop(server, { guardCode });
    logAudit(req.auth!.sub, req.auth!.username, 'plugin.workshop_apply', server.id, result.message);
    res.json({ ...view(server.id), ...result });
  })
);
