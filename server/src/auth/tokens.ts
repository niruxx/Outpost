import crypto from 'node:crypto';
import { authenticateApiKey, KEY_PREFIX } from '../services/apiKeyService.js';
import type { AuthTokenPayload, Role } from '../types/index.js';
import { SESSION_SECRET } from './secret.js';

const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(data: string): string {
  return crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
}

/** Creates a stateless, HMAC-signed session token (compact JWT-like format, no external deps). */
export function createToken(userId: string, username: string, role: Role): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: AuthTokenPayload = {
    sub: userId,
    username,
    role,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
  };
  const body = base64url(JSON.stringify(payload));
  const sig = sign(body);
  return `${body}.${sig}`;
}

/** A sign-in token or a personal API key (opk_…) → who's calling. */
export function authenticate(token: string): AuthTokenPayload | null {
  if (token.startsWith(KEY_PREFIX)) return authenticateApiKey(token);
  return verifyToken(token);
}

export function verifyToken(token: string): AuthTokenPayload | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = sign(body);
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as AuthTokenPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
