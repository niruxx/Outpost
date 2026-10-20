import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';

/**
 * Who's on the other end of the current request — so the audit log can record the address and
 * browser of every action without each route passing them along.
 */
export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function requestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** The connecting address; a reverse proxy's X-Forwarded-For is noted alongside (it can be spoofed, so it never replaces it). */
function clientIp(req: Request): string | null {
  const socket = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '') || null;
  const forwarded = typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'].split(',')[0].trim() : '';
  return forwarded && forwarded !== socket ? `${forwarded} (via ${socket})` : socket;
}

export function requestContextMiddleware(req: Request, _res: Response, next: NextFunction) {
  const ua = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 300) : null;
  storage.run({ ip: clientIp(req), userAgent: ua }, next);
}
