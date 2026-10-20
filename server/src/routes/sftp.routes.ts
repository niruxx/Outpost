import { Router } from 'express';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { requireAuth, requireRole, requireServerAccess } from '../auth/middleware.js';
import { logAudit } from '../services/userService.js';
import { getServer } from '../services/serverService.js';
import { getServerPermissions } from '../services/userService.js';
import {
  addPublicKey,
  hostKeyFingerprint,
  myCredentials,
  removePublicKey,
  saveSftpSettings,
  setSftpPassword,
  sftpSettings,
  sftpState,
  sftpUsername,
} from '../services/sftpService.js';

/** SFTP: panel-wide settings (admins) and each user's own SFTP password / keys. */
export const sftpRouter = Router();
sftpRouter.use(requireAuth);

function view(userId: string) {
  return { settings: sftpSettings(), state: sftpState(), hostKeyFingerprint: hostKeyFingerprint(), me: myCredentials(userId) };
}

sftpRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(view(req.auth!.sub));
  })
);

sftpRouter.put(
  '/settings',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    await saveSftpSettings(req.body ?? {});
    const s = sftpSettings();
    logAudit(req.auth!.sub, req.auth!.username, 'settings.sftp', undefined, `${s.enabled ? 'on' : 'off'}, port ${s.port}`);
    res.json(view(req.auth!.sub));
  })
);

sftpRouter.put(
  '/me/password',
  asyncHandler(async (req, res) => {
    const password = req.body?.password;
    if (password !== null && typeof password !== 'string') throw new HttpError(400, 'password required');
    setSftpPassword(req.auth!.sub, password);
    logAudit(req.auth!.sub, req.auth!.username, password === null ? 'sftp.password_removed' : 'sftp.password_set');
    res.json(view(req.auth!.sub));
  })
);

sftpRouter.post(
  '/me/keys',
  asyncHandler(async (req, res) => {
    const key = addPublicKey(req.auth!.sub, String(req.body?.key ?? ''));
    logAudit(req.auth!.sub, req.auth!.username, 'sftp.key_added', undefined, `${key.type} ${key.fingerprint}`);
    res.status(201).json(view(req.auth!.sub));
  })
);

sftpRouter.delete(
  '/me/keys/:fingerprint',
  asyncHandler(async (req, res) => {
    removePublicKey(req.auth!.sub, req.params.fingerprint);
    logAudit(req.auth!.sub, req.auth!.username, 'sftp.key_removed', undefined, req.params.fingerprint);
    res.json(view(req.auth!.sub));
  })
);

/** Connection details for one instance (shown in File Management). */
export const instanceSftpRouter = Router({ mergeParams: true });
instanceSftpRouter.use(requireAuth, requireServerAccess());
instanceSftpRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const server = getServer(req.params.serverId);
    if (!server) throw new HttpError(404, 'Server not found');
    const perms = getServerPermissions(req.auth!.sub, req.auth!.role, server.id) ?? [];
    const s = sftpSettings();
    res.json({
      enabled: s.enabled && sftpState().running,
      port: s.port,
      username: sftpUsername(req.auth!.username, server.id),
      canRead: perms.includes('files.read'),
      canWrite: perms.includes('files.write'),
      hostKeyFingerprint: s.enabled ? hostKeyFingerprint() : null,
      me: myCredentials(req.auth!.sub),
    });
  })
);
