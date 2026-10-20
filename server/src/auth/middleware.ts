import type { NextFunction, Request, Response } from 'express';
import { authenticate } from './tokens.js';
import { requestContext } from '../utils/requestContext.js';
import type { AuthTokenPayload, Role } from '../types/index.js';
import { getServerPermissions, logAudit, userHasServerAccess, type ServerPermission } from '../services/userService.js';
import { HttpError } from '../utils/asyncHandler.js';
import { getServer } from '../services/serverService.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthTokenPayload;
    }
  }
}

function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  if (typeof req.query.token === 'string') return req.query.token;
  return null;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  const payload = authenticate(token);
  if (!payload) return res.status(401).json({ error: token.startsWith('opk_') ? 'Invalid, revoked or expired API key' : 'Invalid or expired session' });
  if (payload.apiKey) {
    // Keys can't manage keys or sign-in settings (password, 2FA, SFTP logins) — that needs a real sign-in.
    if (/^\/api\/(keys|auth|sftp\/me)(\/|$|\?)/.test(req.originalUrl)) return res.status(403).json({ error: 'API keys can’t change API keys or sign-in settings — sign in to the panel for that' });
    if (payload.apiKey.readOnly && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return res.status(403).json({ error: `The API key “${payload.apiKey.name}” is read-only` });
    const ctx = requestContext();
    if (ctx) ctx.userAgent = `API key “${payload.apiKey.name}”${ctx.userAgent ? ` · ${ctx.userAgent}` : ''}`.slice(0, 300);
  }
  req.auth = payload;
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth) return res.status(401).json({ error: 'Authentication required' });
    if (!roles.includes(req.auth.role)) {
      logAudit(req.auth.sub, req.auth.username, 'access.denied', undefined, `${req.method} ${req.originalUrl.split('?')[0]} needs ${roles.join('/')}`);
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

/** Admins and moderators/viewers with explicit access may proceed; others are blocked. */
export function requireServerAccess(paramName = 'serverId') {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth) return res.status(401).json({ error: 'Authentication required' });
    const serverId = req.params[paramName];
    if (req.auth.role === 'admin') return next();
    if (!userHasServerAccess(req.auth.sub, serverId)) {
      logAudit(req.auth.sub, req.auth.username, 'access.denied', serverId, `${req.method} ${req.originalUrl.split('?')[0]} (no access to this instance)`);
      return res.status(403).json({ error: 'You do not have access to this server' });
    }
    // Suspended instances are locked to everyone but admins — files, console, backups, plugins,
    // everything server-scoped goes through this check.
    const server = getServer(serverId);
    if (server?.suspended) {
      return res.status(423).json({ error: suspendedMessage(server.suspended_reason), suspended: true });
    }
    next();
  };
}

export function suspendedMessage(reason: string | null): string {
  return `This instance is suspended${reason ? `: ${reason}` : ''}. Contact the panel owner.`;
}

const PERMISSION_LABEL: Record<ServerPermission, string> = {
  power: 'Start / stop',
  console: 'Console commands',
  'files.read': 'View files',
  'files.write': 'Edit files',
  'backups.create': 'Create snapshots',
  'backups.restore': 'Restore snapshots',
  plugins: 'Manage plugins',
  players: 'Manage players',
  settings: 'Edit configuration',
  update: 'Update server',
  launch: 'Edit launch command',
  network: 'Manage UPnP port forwarding',
};

/** Throws 403 unless the signed-in user holds `permission` on the instance in the route. */
export function requirePermission(req: Request, permission: ServerPermission, serverId: string = req.params.serverId) {
  const perms = getServerPermissions(req.auth!.sub, req.auth!.role, serverId);
  if (!perms?.includes(permission)) {
    logAudit(req.auth!.sub, req.auth!.username, 'access.denied', serverId, `${req.method} ${req.originalUrl.split('?')[0]} needs "${PERMISSION_LABEL[permission]}"`);
    throw new HttpError(403, `You don't have the "${PERMISSION_LABEL[permission]}" permission on this instance`);
  }
}
