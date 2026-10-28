import { Router } from 'express';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { requireAuth, requirePermission, requireServerAccess } from '../auth/middleware.js';
import {
  compareSnapshotFile,
  createBackup,
  deleteBackup,
  listBackups,
  listSnapshotEntries,
  resolveBackupPath,
  restoreBackup,
  restoreSnapshotFile,
} from '../services/backupService.js';
import { getSchedule, removeSchedule, setSchedule } from '../services/schedulerService.js';
import { logAudit } from '../services/userService.js';
import { getUserById } from '../services/userService.js';
import { backupStorageInfo, setBackupStorage } from '../services/backupStorageService.js';
import { getServer } from '../services/serverService.js';

/** Snapshots (zip backups of the instance folder), their schedule, and restore — whole or per file. */
export const backupsRouter = Router({ mergeParams: true });
backupsRouter.use(requireAuth, requireServerAccess());

backupsRouter.get('/storage', asyncHandler(async (req, res) => {
  if (!getServer(req.params.serverId)) throw new HttpError(404, 'Instance not found');
  res.json(backupStorageInfo(req.params.serverId));
}));
backupsRouter.put('/storage', asyncHandler(async (req, res) => {
  // Absolute host paths are host administration, independent of ordinary backup privileges.
  if (req.auth!.role !== 'admin' || getUserById(req.auth!.sub)?.role !== 'admin') throw new HttpError(403, 'Only administrators can choose host backup directories');
  const { directory, copyExisting = true } = req.body ?? {};
  if (typeof copyExisting !== 'boolean') throw new HttpError(400, 'copyExisting must be a boolean');
  const storage = await setBackupStorage(req.params.serverId, directory, copyExisting);
  logAudit(req.auth!.sub, req.auth!.username, 'backup.storage', req.params.serverId, JSON.stringify({ directory: storage.directory, copyExisting }));
  res.json(storage);
}));

// Schedule routes come first: otherwise DELETE /schedule would be captured by DELETE /:fileName.
backupsRouter.get(
  '/schedule',
  asyncHandler(async (req, res) => {
    res.json({ schedule: getSchedule(req.params.serverId) ?? null });
  })
);

backupsRouter.put(
  '/schedule',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'backups.create');
    const { cronExpression, retentionCount, enabled } = req.body ?? {};
    if (typeof cronExpression !== 'string' || !cronExpression) {
      throw new HttpError(400, 'cronExpression is required');
    }
    const schedule = setSchedule(req.params.serverId, cronExpression, Number(retentionCount) || 5, enabled !== false);
    logAudit(req.auth!.sub, req.auth!.username, 'backup.schedule.set', req.params.serverId, cronExpression);
    res.json({ schedule });
  })
);

backupsRouter.delete(
  '/schedule',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'backups.create');
    removeSchedule(req.params.serverId);
    logAudit(req.auth!.sub, req.auth!.username, 'backup.schedule.remove', req.params.serverId);
    res.status(204).end();
  })
);

backupsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ backups: listBackups(req.params.serverId) });
  })
);

backupsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'backups.create');
    const label = typeof req.body?.label === 'string' ? req.body.label : undefined;
    const backup = await createBackup(req.params.serverId, label);
    logAudit(req.auth!.sub, req.auth!.username, 'backup.create', req.params.serverId, backup.fileName);
    res.status(201).json({ backup });
  })
);

backupsRouter.get(
  '/:fileName/download',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'files.read');
    const filePath = resolveBackupPath(req.params.serverId, req.params.fileName);
    logAudit(req.auth!.sub, req.auth!.username, 'backup.download', req.params.serverId, req.params.fileName);
    res.download(filePath, req.params.fileName);
  })
);

backupsRouter.get(
  '/:fileName/entries',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'files.read');
    res.json({ entries: listSnapshotEntries(req.params.serverId, req.params.fileName) });
  })
);

backupsRouter.get(
  '/:fileName/compare',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'files.read');
    const filePath = typeof req.query.path === 'string' ? req.query.path : '';
    res.json(compareSnapshotFile(req.params.serverId, req.params.fileName, filePath));
  })
);

backupsRouter.post(
  '/:fileName/restore-file',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'backups.restore');
    const filePath = typeof req.body?.path === 'string' ? req.body.path : '';
    restoreSnapshotFile(req.params.serverId, req.params.fileName, filePath);
    logAudit(req.auth!.sub, req.auth!.username, 'backup.restore_file', req.params.serverId, `${req.params.fileName}: ${filePath}`);
    res.json({ ok: true });
  })
);

backupsRouter.post(
  '/:fileName/restore',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'backups.restore');
    await restoreBackup(req.params.serverId, req.params.fileName);
    logAudit(req.auth!.sub, req.auth!.username, 'backup.restore', req.params.serverId, req.params.fileName);
    res.json({ ok: true });
  })
);

backupsRouter.delete(
  '/:fileName',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'backups.create');
    deleteBackup(req.params.serverId, req.params.fileName);
    logAudit(req.auth!.sub, req.auth!.username, 'backup.delete', req.params.serverId, req.params.fileName);
    res.status(204).end();
  })
);
