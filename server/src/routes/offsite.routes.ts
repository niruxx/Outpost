import { Router } from 'express';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { requireAuth, requirePermission, requireRole, requireServerAccess } from '../auth/middleware.js';
import { getServer } from '../services/serverService.js';
import { logAudit } from '../services/userService.js';
import { resolveBackupPath } from '../services/backupService.js';
import {
  copiesFor,
  deleteDestination,
  enqueueCopy,
  fetchRemote,
  getDestination,
  listDestinations,
  listRemote,
  publicDestination,
  saveDestination,
  testDestination,
} from '../services/offsiteService.js';

/** Off-site destinations (admins). */
export const offsiteRouter = Router();
offsiteRouter.use(requireAuth, requireRole('admin'));

const all = () => ({ destinations: listDestinations().map(publicDestination) });

offsiteRouter.get('/', asyncHandler(async (_req, res) => res.json(all())));

offsiteRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const d = saveDestination(req.body ?? {});
    logAudit(req.auth!.sub, req.auth!.username, 'offsite.create', undefined, `${d.type}: ${d.name}`);
    res.status(201).json(all());
  })
);

offsiteRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const d = saveDestination(req.body ?? {}, req.params.id);
    logAudit(req.auth!.sub, req.auth!.username, 'offsite.update', undefined, `${d.type}: ${d.name}`);
    res.json(all());
  })
);

offsiteRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const d = getDestination(req.params.id);
    if (!d) throw new HttpError(404, 'Destination not found');
    deleteDestination(d.id);
    logAudit(req.auth!.sub, req.auth!.username, 'offsite.delete', undefined, d.name);
    res.json(all());
  })
);

offsiteRouter.post(
  '/:id/test',
  asyncHandler(async (req, res) => {
    const d = getDestination(req.params.id);
    if (!d) throw new HttpError(404, 'Destination not found');
    try {
      await testDestination(d);
      res.json({ ok: true });
    } catch (err) {
      res.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  })
);

/** Per instance: copy status, remote copies, upload now, fetch back. */
export const instanceOffsiteRouter = Router({ mergeParams: true });
instanceOffsiteRouter.use(requireAuth, requireServerAccess());

instanceOffsiteRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const server = getServer(req.params.serverId);
    if (!server) throw new HttpError(404, 'Server not found');
    res.json({ destinations: listDestinations().map((d) => ({ id: d.id, name: d.name, type: d.type, enabled: d.enabled })), copies: copiesFor(server.id) });
  })
);

instanceOffsiteRouter.get(
  '/:destinationId/remote',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'backups.restore');
    const d = getDestination(req.params.destinationId);
    if (!d) throw new HttpError(404, 'Destination not found');
    try {
      res.json({ objects: (await listRemote(d, req.params.serverId)).sort((a, b) => b.name.localeCompare(a.name)) });
    } catch (err) {
      throw new HttpError(502, err instanceof Error ? err.message : String(err));
    }
  })
);

instanceOffsiteRouter.post(
  '/copy',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'backups.create');
    const fileName = String(req.body?.fileName ?? '');
    resolveBackupPath(req.params.serverId, fileName);
    const n = enqueueCopy(req.params.serverId, fileName, typeof req.body?.destinationId === 'string' ? req.body.destinationId : undefined);
    if (!n) throw new HttpError(400, 'No off-site destination is set up (Configuration → Off-site backups)');
    logAudit(req.auth!.sub, req.auth!.username, 'backup.offsite_copy', req.params.serverId, fileName);
    res.status(202).json({ copies: copiesFor(req.params.serverId) });
  })
);

instanceOffsiteRouter.post(
  '/fetch',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'backups.restore');
    const d = getDestination(String(req.body?.destinationId ?? ''));
    if (!d) throw new HttpError(404, 'Destination not found');
    const name = String(req.body?.fileName ?? '');
    try {
      await fetchRemote(d, req.params.serverId, name);
    } catch (err) {
      throw new HttpError(err instanceof HttpError ? err.status : 502, err instanceof Error ? err.message : String(err));
    }
    logAudit(req.auth!.sub, req.auth!.username, 'backup.offsite_fetch', req.params.serverId, `${d.name}: ${name}`);
    res.json({ ok: true, fileName: name });
  })
);
