import { Router } from 'express';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { requireAuth, requirePermission, requireRole, requireServerAccess } from '../auth/middleware.js';
import { getServer } from '../services/serverService.js';
import { logAudit } from '../services/userService.js';
import { connectionInfo, createDatabase, deleteHost, dropDatabase, getHost, listDatabases, listHosts, publicHost, rotatePassword, saveHost, testHost } from '../services/databaseService.js';

/** Database hosts (admins). */
export const dbHostsRouter = Router();
dbHostsRouter.use(requireAuth, requireRole('admin'));

const all = () => ({ hosts: listHosts().map(publicHost) });

dbHostsRouter.get('/', (_req, res) => res.json(all()));

dbHostsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const h = await saveHost(req.body ?? {});
    logAudit(req.auth!.sub, req.auth!.username, 'dbhost.create', undefined, `${h.name} (${h.host}:${h.port})`);
    res.status(201).json(all());
  })
);

dbHostsRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const h = await saveHost(req.body ?? {}, req.params.id);
    logAudit(req.auth!.sub, req.auth!.username, 'dbhost.update', undefined, h.name);
    res.json(all());
  })
);

dbHostsRouter.post(
  '/:id/test',
  asyncHandler(async (req, res) => {
    const h = getHost(req.params.id);
    if (!h) throw new HttpError(404, 'Database host not found');
    res.json(await testHost(h));
  })
);

dbHostsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const h = getHost(req.params.id);
    if (!h) throw new HttpError(404, 'Database host not found');
    deleteHost(h.id);
    logAudit(req.auth!.sub, req.auth!.username, 'dbhost.delete', undefined, h.name);
    res.json(all());
  })
);

/** One instance's databases. Viewing (passwords included) and changes need "Edit configuration". */
export const serverDatabasesRouter = Router({ mergeParams: true });
serverDatabasesRouter.use(requireAuth, requireServerAccess());

function view(serverId: string) {
  return { databases: listDatabases(serverId).map(connectionInfo), hosts: listHosts().map((h) => ({ id: h.id, name: h.name })) };
}

serverDatabasesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'settings');
    if (!getServer(req.params.serverId)) throw new HttpError(404, 'Server not found');
    res.json(view(req.params.serverId));
  })
);

serverDatabasesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'settings');
    if (!getServer(req.params.serverId)) throw new HttpError(404, 'Server not found');
    const db = await createDatabase(req.params.serverId, req.body ?? {});
    logAudit(req.auth!.sub, req.auth!.username, 'database.create', req.params.serverId, `${db.name} (${db.username}@${db.remote})`);
    res.status(201).json(view(req.params.serverId));
  })
);

serverDatabasesRouter.post(
  '/:id/rotate-password',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'settings');
    const db = await rotatePassword(req.params.serverId, req.params.id);
    logAudit(req.auth!.sub, req.auth!.username, 'database.rotate_password', req.params.serverId, db.name);
    res.json(view(req.params.serverId));
  })
);

serverDatabasesRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'settings');
    const db = await dropDatabase(req.params.serverId, req.params.id);
    logAudit(req.auth!.sub, req.auth!.username, 'database.delete', req.params.serverId, db.name);
    res.json(view(req.params.serverId));
  })
);
