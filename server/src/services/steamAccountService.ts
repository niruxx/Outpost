import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { prep } from '../db/db.js';
import { DATA_DIR } from '../utils/paths.js';
import { SESSION_SECRET } from '../auth/secret.js';
import { HttpError } from '../utils/asyncHandler.js';
const key = crypto.createHash('sha256').update(SESSION_SECRET).update('steam-accounts-v1').digest();
export const steamAccountBusy = new Set<string>();
const guards = new Map<string, { code: string; expires: number }>();
function encrypt(value: string) { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]).toString('base64'); }
function decrypt(value: string) { const bytes = Buffer.from(value, 'base64'), decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(-16)); return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString(); }
export function steamAccounts(userId: string) { return prep('SELECT id, username, created_at FROM steam_accounts WHERE user_id=? ORDER BY created_at').all(userId); }
export function saveSteamAccount(userId: string, input: { username?: unknown; password?: unknown }) {
  if (typeof input?.username !== 'string' || !/^[\w.@-]{2,64}$/.test(input.username) || typeof input.password !== 'string' || !input.password || input.password.length > 256 || /^[+]|["\r\n\x00\\]/.test(input.password)) throw new HttpError(400, 'Provide a Steam username and password (no quotes, backslashes or line breaks)');
  const old = prep('SELECT id FROM steam_accounts WHERE user_id=? AND username=?').get(userId, input.username) as { id: string } | undefined;
  const id = old?.id ?? crypto.randomUUID();
  prep('INSERT INTO steam_accounts(id,user_id,username,secret) VALUES (?,?,?,?) ON CONFLICT(user_id,username) DO UPDATE SET secret=excluded.secret').run(id, userId, input.username, encrypt(input.password));
  return { id, username: input.username };
}
export function ownSteamAccount(userId: string, id: string) {
  const row = prep('SELECT id FROM steam_accounts WHERE id=? AND user_id=?').get(id, userId);
  if (!row) throw new HttpError(404, 'Steam account not found');
  return `account:${id}`;
}
export function setSteamGuard(userId: string, id: string, code: unknown) {
  ownSteamAccount(userId, id);
  if (typeof code !== 'string' || !/^[a-zA-Z0-9]{5,8}$/.test(code)) throw new HttpError(400, 'Enter the current Steam Guard code');
  guards.set(id, { code, expires: Date.now() + 120_000 });
}
export function removeSteamAccount(userId: string, id: string) {
  ownSteamAccount(userId, id); if (steamAccountBusy.has(id)) throw new HttpError(409, 'Wait for this account download to finish');
  fs.rmSync(path.join(DATA_DIR, 'steam-accounts', id), { recursive: true, force: true });
  prep('DELETE FROM steam_accounts WHERE id=?').run(id); guards.delete(id);
}
export function removeUserSteamAccounts(userId: string) {
  const accounts = steamAccounts(userId) as { id: string }[];
  if (accounts.some(account => steamAccountBusy.has(account.id))) throw new HttpError(409, 'Wait for this user\'s Steam downloads to finish before deleting the account');
  for (const account of accounts) removeSteamAccount(userId, account.id);
}
export function resolveSteamAccount(login: string) {
  if (!login.startsWith('account:')) return null;
  const id = login.slice(8);
  const row = prep('SELECT username,secret FROM steam_accounts WHERE id=?').get(id) as { username: string; secret: string } | undefined;
  if (!row) throw new HttpError(409, 'The selected Steam account was removed; select another account');
  const guard = guards.get(id); guards.delete(id);
  return { id, username: row.username, password: decrypt(row.secret), guard: guard && guard.expires > Date.now() ? guard.code : undefined, directory: path.join(DATA_DIR, 'steam-accounts', id) };
}
