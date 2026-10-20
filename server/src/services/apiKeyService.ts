import crypto from 'node:crypto';
import { prep } from '../db/db.js';
import { HttpError } from '../utils/asyncHandler.js';
import { getUserById } from './userService.js';
import type { AuthTokenPayload } from '../types/index.js';

/**
 * Personal API keys — for scripts, bots and Discord integrations. A key acts as the user who made
 * it, with that user's current role and instance permissions (optionally read-only), until it's
 * revoked or expires. Only a SHA-256 of the key is stored; the key itself is shown once.
 *
 *   Authorization: Bearer opk_…
 */

export const KEY_PREFIX = 'opk_';

export interface ApiKeyInfo {
  id: string;
  userId: string;
  username?: string;
  name: string;
  /** First characters, to recognise a key in the list. */
  hint: string;
  readOnly: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

interface Row {
  id: string;
  user_id: string;
  name: string;
  hint: string;
  hash: string;
  read_only: number;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
}

const toInfo = (r: Row & { username?: string }): ApiKeyInfo => ({
  id: r.id,
  userId: r.user_id,
  username: r.username,
  name: r.name,
  hint: r.hint,
  readOnly: !!r.read_only,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  expiresAt: r.expires_at,
});

const hashKey = (key: string) => crypto.createHash('sha256').update(key).digest('hex');

export function listKeys(userId?: string): ApiKeyInfo[] {
  const rows = (
    userId
      ? prep('SELECT k.*, u.username FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.user_id = ? ORDER BY k.created_at DESC').all(userId)
      : prep('SELECT k.*, u.username FROM api_keys k JOIN users u ON u.id = k.user_id ORDER BY k.created_at DESC').all()
  ) as unknown as (Row & { username: string })[];
  return rows.map(toInfo);
}

export function createKey(userId: string, input: { name?: unknown; readOnly?: unknown; expiresInDays?: unknown }): { key: string; info: ApiKeyInfo } {
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 60) : '';
  if (!name) throw new HttpError(400, 'Give the key a name (what it’s for)');
  if (listKeys(userId).length >= 25) throw new HttpError(400, 'At most 25 keys per account — revoke some first');
  let expiresAt: string | null = null;
  if (input.expiresInDays !== undefined && input.expiresInDays !== null && input.expiresInDays !== '' && input.expiresInDays !== 0) {
    const days = Number(input.expiresInDays);
    if (!Number.isInteger(days) || days < 1 || days > 3650) throw new HttpError(400, 'Expiry must be 1–3650 days (or never)');
    expiresAt = new Date(Date.now() + days * 86400_000).toISOString();
  }
  const key = `${KEY_PREFIX}${crypto.randomBytes(24).toString('base64url')}`;
  const id = crypto.randomUUID();
  prep('INSERT INTO api_keys (id, user_id, name, hint, hash, read_only, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    userId,
    name,
    key.slice(0, 10),
    hashKey(key),
    input.readOnly === true ? 1 : 0,
    new Date().toISOString(),
    expiresAt
  );
  return { key, info: listKeys(userId).find((k) => k.id === id)! };
}

export function revokeKey(id: string, byUserId: string | null): ApiKeyInfo {
  const row = prep('SELECT * FROM api_keys WHERE id = ?').get(id) as Row | undefined;
  if (!row || (byUserId && row.user_id !== byUserId)) throw new HttpError(404, 'Key not found');
  prep('DELETE FROM api_keys WHERE id = ?').run(id);
  return toInfo(row);
}

const lastTouched = new Map<string, number>();

/** Resolves a presented key to the auth payload of its user — null if unknown, expired, or the user is gone. */
export function authenticateApiKey(key: string): (AuthTokenPayload & { apiKey: { id: string; name: string; readOnly: boolean } }) | null {
  if (!key.startsWith(KEY_PREFIX) || key.length > 100) return null;
  const row = prep('SELECT * FROM api_keys WHERE hash = ?').get(hashKey(key)) as Row | undefined;
  if (!row) return null;
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) return null;
  const user = getUserById(row.user_id);
  if (!user) return null;
  // last_used_at at most once a minute per key
  const now = Date.now();
  if ((lastTouched.get(row.id) ?? 0) < now - 60_000) {
    lastTouched.set(row.id, now);
    prep('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(new Date(now).toISOString(), row.id);
  }
  const t = Math.floor(now / 1000);
  return { sub: user.id, username: user.username, role: user.role, iat: t, exp: t + 60, apiKey: { id: row.id, name: row.name, readOnly: !!row.read_only } };
}

export function deleteKeysForUser(userId: string) {
  prep('DELETE FROM api_keys WHERE user_id = ?').run(userId);
}
