import crypto from 'node:crypto';
import { prep } from '../db/db.js';
import { HttpError } from '../utils/asyncHandler.js';
import { getServer, updateServerRecord } from './serverService.js';
import { startServer, stopServer, restartServer } from './processManager.js';
import { createBackup } from './backupService.js';
import { getConfigAccess, getUserById, getUserServerAccessDetailed, getServerPermissions, SERVER_PERMISSIONS, userHasServerAccess } from './userService.js';
import type { ServerRecord } from '../types/index.js';

export const WIDGETS = ['instances', 'host', 'players', 'storage', 'backups', 'failures'];
export function readPreference(userId: string, kind: string): unknown {
  const row = prep('SELECT value FROM ui_preferences WHERE user_id=? AND kind=?').get(userId, kind) as { value: string } | undefined;
  return row ? JSON.parse(row.value) : null;
}
export function savePreference(userId: string, kind: string, value: unknown) {
  if (!['dashboard', 'views', 'tags'].includes(kind)) throw new HttpError(400, 'Unknown preference');
  if (value === undefined || JSON.stringify(value).length > 32000) throw new HttpError(400, 'Preference is missing or too large');
  if (kind === 'dashboard' && (!Array.isArray(value) || value.length > 6 || new Set(value).size !== value.length || !value.every(v => WIDGETS.includes(v)))) throw new HttpError(400, 'Choose valid dashboard widgets');
  if (kind === 'views' && (!Array.isArray(value) || value.length > 30 || !value.every(v => v && typeof v.name === 'string' && v.name.length <= 80 && typeof v.query === 'string' && v.query.length < 4000))) throw new HttpError(400, 'Invalid saved views');
  if (kind === 'tags' && (!value || typeof value !== 'object' || Array.isArray(value) || !Object.entries(value).every(([id, tags]) => /^[\w-]{1,100}$/.test(id) && Array.isArray(tags) && tags.length <= 20 && tags.every(t => typeof t === 'string' && /^[\w .-]{1,40}$/.test(t))))) throw new HttpError(400, 'Invalid instance tags');
  prep('INSERT INTO ui_preferences(user_id,kind,value) VALUES (?,?,?) ON CONFLICT(user_id,kind) DO UPDATE SET value=excluded.value').run(userId, kind, JSON.stringify(value));
  return value;
}
const configFields = { name: 'name', minMemoryMb: 'min_memory_mb', maxMemoryMb: 'max_memory_mb', autoStart: 'auto_start', restartPolicy: 'restart_policy', restartDelaySec: 'restart_delay_sec', restartMaxAttempts: 'restart_max_attempts' } as const;
export function configPreview(serverId: string, input: unknown) {
  const server = getServer(serverId); if (!server) throw new HttpError(404, 'Instance not found');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Configuration must be an object');
  const patch = input as Record<string, unknown>;
  if (!Object.keys(patch).length || Object.keys(patch).some(k => !Object.hasOwn(configFields, k))) throw new HttpError(400, 'Supported fields: ' + Object.keys(configFields).join(', '));
  if (patch.name !== undefined && (typeof patch.name !== 'string' || !patch.name.trim() || patch.name.length > 100)) throw new HttpError(400, 'Name must contain 1–100 characters');
  if (patch.autoStart !== undefined && typeof patch.autoStart !== 'boolean') throw new HttpError(400, 'autoStart must be boolean');
  if (patch.restartPolicy !== undefined && !['never', 'on-crash', 'always'].includes(String(patch.restartPolicy))) throw new HttpError(400, 'Invalid restart policy');
  for (const [key, min, max] of [['minMemoryMb', 128, 4194304], ['maxMemoryMb', 128, 4194304], ['restartDelaySec', 1, 3600], ['restartMaxAttempts', 0, 10000]] as const) if (patch[key] !== undefined && (!Number.isInteger(patch[key]) || Number(patch[key]) < min || Number(patch[key]) > max)) throw new HttpError(400, `${key} must be an integer between ${min} and ${max}`);
  if (Number(patch.minMemoryMb ?? server.min_memory_mb) > Number(patch.maxMemoryMb ?? server.max_memory_mb)) throw new HttpError(400, 'Minimum memory cannot exceed maximum memory');
  if (server.suspended) throw new HttpError(409, 'Instance is suspended');
  const before = Object.fromEntries(Object.entries(configFields).map(([k, col]) => [k, k === 'autoStart' ? !!server[col] : server[col]]));
  const revision = crypto.createHash('sha256').update(JSON.stringify(before)).digest('hex');
  const changes = Object.entries(patch).filter(([k, v]) => v !== before[k]).map(([key, after]) => ({ key, before: before[key], after, restartRequired: ['minMemoryMb', 'maxMemoryMb'].includes(key) }));
  return { serverId, name: server.name, revision, changes, patch, restartRequired: changes.some(c => c.restartRequired) };
}
export async function performUiAction(serverId: string, action: string, patch?: unknown, revision?: string) {
  const server = getServer(serverId); if (!server) throw new HttpError(404, 'Instance not found');
  if (server.suspended) throw new HttpError(409, 'Instance is suspended');
  if (action === 'configure') {
    const preview = configPreview(serverId, patch);
    if (preview.revision !== revision) throw new HttpError(409, 'Configuration changed; preview again');
    updateServerRecord(serverId, preview.patch); return;
  }
  if (action === 'backup') { await createBackup(serverId, 'Fleet backup'); return; }
  if (action === 'start') { await startServer(serverId); return; }
  if (action === 'stop') { stopServer(serverId); return; }
  if (action === 'restart') { await restartServer(serverId); return; }
  throw new HttpError(400, 'Unknown action');
}
export function permissionReport(userId: string, serverId: string) {
  const user = getUserById(userId), server = getServer(serverId);
  if (!user || !server) throw new HttpError(404, 'User or instance not found');
  const assigned = userHasServerAccess(userId, serverId), admin = user.role === 'admin';
  const accessible = !user.disabled && (admin || (assigned && !server.suspended));
  const entry = getUserServerAccessDetailed(userId).find(e => e.serverId === serverId);
  const overrides = getConfigAccess(userId, user.role, serverId), restricted = Object.values(overrides).includes(false);
  const permissions = getServerPermissions(userId, user.role, serverId) ?? [];
  const reason = user.disabled ? 'Account is disabled' : admin ? 'Administrator role' : !assigned ? 'No instance assignment' : server.suspended ? 'Instance is suspended' : entry?.permissions ? 'Explicit instance permissions' : `${user.role} role defaults on assigned instance`;
  return { accessible, reason, configurationOverrides: overrides, permissions: SERVER_PERMISSIONS.map(permission => {
    const blocked = restricted && ['files.write', 'console', 'backups.restore', 'launch', 'plugins', 'update', 'players', 'settings'].includes(permission);
    return { permission, allowed: accessible && permissions.includes(permission) && !blocked, reason: !accessible ? reason : blocked ? 'Individual configuration restrictions protect settings from indirect changes' : permissions.includes(permission) ? reason : 'Permission is not granted' };
  }) };
}
