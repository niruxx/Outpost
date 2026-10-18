import { Router } from 'express';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import {
  createUser,
  deleteUser,
  getUserById,
  getUserServerAccess,
  getUserServerAccessDetailed,
  roleDefaultPermissions,
  SERVER_PERMISSIONS,
  listUsers,
  logAudit,
  setUserServerAccess,
  updateUserPassword,
  updateUserRole,
  countOwned,
  getEffectiveCreation,
  roleDefaultCreation,
  sanitizeCreationPolicy,
  setCreationPolicy,
  CREATABLE_PLATFORMS,
  getPublicUser,
} from '../services/userService.js';
import { disableTotp } from '../services/twoFactorService.js';
import type { Role } from '../types/index.js';

export const usersRouter = Router();
usersRouter.use(requireAuth, requireRole('admin'));

usersRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const users = listUsers().map((u) => ({
      ...u,
      serverAccess: getUserServerAccess(u.id),
      serverPermissions: Object.fromEntries(getUserServerAccessDetailed(u.id).map((a) => [a.serverId, a.permissions])),
      creationPolicy: u.creation ? sanitizeCreationPolicy(JSON.parse(u.creation)) : null,
      effectiveCreation: getEffectiveCreation(u.id, u.role),
      owned: countOwned(u.id),
    }));
    res.json({ users });
  })
);

usersRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const { username, password, role } = req.body ?? {};
    if (typeof username !== 'string' || username.trim().length < 3) {
      throw new HttpError(400, 'Username must be at least 3 characters');
    }
    if (typeof password !== 'string' || password.length < 8) {
      throw new HttpError(400, 'Password must be at least 8 characters');
    }
    if (!['admin', 'moderator', 'viewer'].includes(role)) {
      throw new HttpError(400, 'Role must be admin, moderator, or viewer');
    }
    const user = createUser(username.trim(), password, role as Role);
    logAudit(req.auth!.sub, req.auth!.username, 'user.create', user.id, `role=${role}`);
    res.status(201).json({ user });
  })
);

usersRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const target = getUserById(req.params.id);
    if (!target) throw new HttpError(404, 'User not found');
    const { role, password, serverAccess } = req.body ?? {};

    if (role !== undefined) {
      if (!['admin', 'moderator', 'viewer'].includes(role)) {
        throw new HttpError(400, 'Invalid role');
      }
      if (target.id === req.auth!.sub && role !== 'admin') {
        throw new HttpError(400, 'You cannot demote your own account');
      }
      updateUserRole(target.id, role);
    }
    if (password !== undefined) {
      if (typeof password !== 'string' || password.length < 8) {
        throw new HttpError(400, 'Password must be at least 8 characters');
      }
      updateUserPassword(target.id, password);
    }
    if (req.body && 'creation' in req.body) {
      // null = follow the role's default; an object = this user's own creation policy.
      setCreationPolicy(target.id, req.body.creation === null ? null : sanitizeCreationPolicy(req.body.creation));
    }
    if (Array.isArray(serverAccess)) {
      // Plain ids get the role's default permissions; objects carry a per-instance permission set.
      setUserServerAccess(
        target.id,
        serverAccess.filter(
          (s): s is string | { serverId: string; permissions: string[] | null } =>
            typeof s === 'string' || (typeof s === 'object' && s !== null && typeof s.serverId === 'string')
        ) as Parameters<typeof setUserServerAccess>[1]
      );
    }
    logAudit(req.auth!.sub, req.auth!.username, 'user.update', target.id);
    res.json({ user: getPublicUser(target.id) });
  })
);

/** The permission catalog and each role's defaults, for the user editor. */
usersRouter.get(
  '/permissions/catalog',
  asyncHandler(async (_req, res) => {
    res.json({
      permissions: SERVER_PERMISSIONS,
      defaults: { moderator: roleDefaultPermissions('moderator'), viewer: roleDefaultPermissions('viewer') },
      creatablePlatforms: CREATABLE_PLATFORMS,
      creationDefaults: { moderator: roleDefaultCreation('moderator'), viewer: roleDefaultCreation('viewer') },
    });
  })
);

/** Turns off two-factor sign-in for someone who lost their authenticator and recovery codes. */
usersRouter.delete(
  '/:id/2fa',
  asyncHandler(async (req, res) => {
    const target = getUserById(req.params.id);
    if (!target) throw new HttpError(404, 'User not found');
    disableTotp(target.id);
    logAudit(req.auth!.sub, req.auth!.username, 'user.2fa_reset', target.id);
    res.status(204).end();
  })
);

usersRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    if (req.params.id === req.auth!.sub) throw new HttpError(400, 'You cannot delete your own account');
    const target = getUserById(req.params.id);
    if (!target) throw new HttpError(404, 'User not found');
    deleteUser(target.id);
    logAudit(req.auth!.sub, req.auth!.username, 'user.delete', target.id);
    res.status(204).end();
  })
);
