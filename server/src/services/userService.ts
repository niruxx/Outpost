import { vmGrants } from './vmAccessService.js';
import crypto from 'node:crypto';
import { removeUserSteamAccounts } from './steamAccountService.js';
import { prep, db } from '../db/db.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { requestContext } from '../utils/requestContext.js';
import type { PublicUser, Role, User, StoragePermission } from '../types/index.js';

function toPublic(user: User): PublicUser {
  const { password_hash, password_salt, totp_secret, totp_last_step, totp_recovery, storage, ...rest } = user;
  return { ...rest, storagePermissions: storagePermissionsOf(user), vmAccess: vmGrants(user.id) };
}

export const STORAGE_PERMISSIONS: StoragePermission[] = ['view', 'mount', 'automount', 'format', 'wipe', 'partition', 'encrypt', 'lvm', 'resize', 'raid', 'migrate', 'crypttab', 'health', 'erase'];
export function storagePermissionsOf(user: User): StoragePermission[] {
  if (user.role === 'admin') return [...STORAGE_PERMISSIONS];
  try {
    const raw = JSON.parse(user.storage || '[]');
    return STORAGE_PERMISSIONS.filter((key) => Array.isArray(raw) && (raw.includes(key) || (key === 'view' && STORAGE_PERMISSIONS.some((known) => raw.includes(known)))));
  } catch { return []; }
}
export function setStoragePermissions(id: string, permissions: StoragePermission[]) {
  prep('UPDATE users SET storage = ? WHERE id = ?').run(JSON.stringify(permissions), id);
}

/** A user without credentials or 2FA secrets — safe to send to the browser. */
export function getPublicUser(id: string): PublicUser | undefined {
  const user = getUserById(id);
  return user ? toPublic(user) : undefined;
}

export function countUsers(): number {
  const row = prep('SELECT COUNT(*) as c FROM users').get() as { c: number };
  return row.c;
}

export function createUser(username: string, password: string, role: Role): PublicUser {
  const existing = prep('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) throw new Error('A user with that username already exists');
  const { hash, salt } = hashPassword(password);
  const id = crypto.randomUUID();
  prep(
    'INSERT INTO users (id, username, password_hash, password_salt, role) VALUES (?, ?, ?, ?, ?)'
  ).run(id, username, hash, salt, role);
  return toPublic(getUserById(id)!);
}

export function getUserById(id: string): User | undefined {
  return prep('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
}

export function getUserByUsername(username: string): User | undefined {
  return prep('SELECT * FROM users WHERE username = ?').get(username) as User | undefined;
}

export function listUsers(): PublicUser[] {
  const rows = prep('SELECT * FROM users ORDER BY created_at ASC').all() as unknown as User[];
  return rows.map(toPublic);
}

export function authenticate(username: string, password: string): PublicUser | null {
  const user = getUserByUsername(username);
  if (!user) return null;
  if (!verifyPassword(password, user.password_hash, user.password_salt)) return null;
  return toPublic(user);
}

export const FIREWALL_ACCESS = ['none', 'view', 'instances', 'manage'] as const;

/** Theme ids the web app ships (web/src/lib/theme.ts). */
export const THEME_IDS = ['outpost', 'xp', 'minecraft', 'vista', 'aero'] as const;

export function setUserTheme(id: string, theme: (typeof THEME_IDS)[number] | null) {
  prep('UPDATE users SET theme = ? WHERE id = ?').run(theme, id);
}

export function setFirewallAccess(id: string, access: (typeof FIREWALL_ACCESS)[number]) {
  prep('UPDATE users SET firewall = ? WHERE id = ?').run(access, id);
}

/** Admins always manage; everyone else gets what their account allows. */
export function effectiveFirewallAccess(userId: string, role: Role): (typeof FIREWALL_ACCESS)[number] {
  if (role === 'admin') return 'manage';
  return getUserById(userId)?.firewall ?? 'none';
}

export function updateUserRole(id: string, role: Role) {
  prep('UPDATE users SET role = ? WHERE id = ?').run(role, id);
}

export function updateUserPassword(id: string, password: string) {
  const { hash, salt } = hashPassword(password);
  prep('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').run(hash, salt, id);
}

export function deleteUser(id: string) {
  removeUserSteamAccounts(id);
  // servers.created_by references users without ON DELETE — release ownership first (the
  // instances stay; admins can hand them to someone else) or the delete hits the foreign key.
  prep('UPDATE servers SET created_by = NULL WHERE created_by = ?').run(id);
  prep('DELETE FROM api_keys WHERE user_id = ?').run(id);
  prep('DELETE FROM users WHERE id = ?').run(id);
}

/**
 * What a user may do inside an instance they've been assigned. Seeing an assigned instance
 * (status, console output, player list) needs no permission; everything that changes it does.
 */
export const SERVER_PERMISSIONS = [
  'power', // start / stop / restart / kill / retry install
  'console', // send console commands
  'files.read', // browse & download files, browse snapshot contents
  'files.write', // edit, upload, rename, delete files
  'backups.create', // create & delete snapshots, edit the snapshot schedule
  'backups.restore', // restore a whole snapshot or single files from one
  'plugins', // install, toggle, remove plugins / mods / packs
  'players', // op, kick, ban, whitelist
  'settings', // instance configuration & server.properties
  'update', // change version / update the server software
  'launch', // change the launch command/executable — effectively running arbitrary code, so opt-in
  'network', // UPnP: open ports on the router to this host — opt-in for the same reason
] as const;

export type ServerPermission = (typeof SERVER_PERMISSIONS)[number];

export function roleDefaultPermissions(role: Role): ServerPermission[] {
  if (role === 'viewer') return ['files.read'];
  return SERVER_PERMISSIONS.filter((p) => p !== 'launch' && p !== 'network');
}

function sanitizePermissions(value: unknown): ServerPermission[] | null {
  if (!Array.isArray(value)) return null;
  return SERVER_PERMISSIONS.filter((p) => value.includes(p));
}

export interface ServerAccessEntry {
  serverId: string;
  /** null = the role's defaults */
  permissions: ServerPermission[] | null;
  configAccess?: Record<string, boolean>;
}

/** Replaces a user's instance assignments. Accepts plain ids (role defaults) or per-instance permission sets. */
export function setUserServerAccess(userId: string, entries: (string | ServerAccessEntry)[]) {
  db.prepare('DELETE FROM user_server_access WHERE user_id = ?').run(userId);
  const insert = prep('INSERT OR IGNORE INTO user_server_access (user_id, server_id, permissions, config_access) VALUES (?, ?, ?, ?)');
  for (const entry of entries) {
    const serverId = typeof entry === 'string' ? entry : entry.serverId;
    const perms = typeof entry === 'string' ? null : sanitizePermissions(entry.permissions);
    insert.run(userId, serverId, perms ? JSON.stringify(perms) : null, JSON.stringify(typeof entry === 'string' ? {} : sanitizeConfigAccess(entry.configAccess)));
  }
}

export function getUserServerAccessDetailed(userId: string): ServerAccessEntry[] {
  const rows = prep('SELECT server_id, permissions, config_access FROM user_server_access WHERE user_id = ?').all(userId) as {
    server_id: string;
    permissions: string | null;
    config_access: string | null;
  }[];
  return rows.map((r) => ({ serverId: r.server_id, configAccess: JSON.parse(r.config_access || '{}'), permissions: r.permissions ? sanitizePermissions(JSON.parse(r.permissions)) : null }));
}

/** Effective permissions on one instance, or null when the user isn't assigned to it at all. */
function baseServerPermissions(userId: string, role: Role, serverId: string): ServerPermission[] | null {
  if (role === 'admin') return [...SERVER_PERMISSIONS];
  const row = prep('SELECT permissions FROM user_server_access WHERE user_id = ? AND server_id = ?').get(userId, serverId) as
    | { permissions: string | null }
    | undefined;
  if (!row) return null;
  if (!row.permissions) return roleDefaultPermissions(role);
  try {
    return sanitizePermissions(JSON.parse(row.permissions)) ?? roleDefaultPermissions(role);
  } catch {
    return roleDefaultPermissions(role);
  }
}

export function getUserServerAccess(userId: string): string[] {
  const rows = prep('SELECT server_id FROM user_server_access WHERE user_id = ?').all(
    userId
  ) as { server_id: string }[];
  return rows.map((r) => r.server_id);
}

export function userHasServerAccess(userId: string, serverId: string): boolean {
  const row = prep(
    'SELECT 1 FROM user_server_access WHERE user_id = ? AND server_id = ?'
  ).get(userId, serverId);
  return !!row;
}

/** Records an action. The client's address and browser are added from the current request, if any. */
export function logAudit(userId: string | null, username: string | null, action: string, target?: string, detail?: string) {
  const ctx = requestContext();
  prep(
    'INSERT INTO audit_log (user_id, username, action, target, detail, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(userId, username, action, target ?? null, detail?.slice(0, 2000) ?? null, ctx?.ip ?? null, ctx?.userAgent ?? null);
}

// ---------------------------------------------------------------------------
// Instance creation policy (account-level) and ownership
// ---------------------------------------------------------------------------

/** Instance types a non-admin can be allowed to create. Custom and Docker instances run arbitrary
 *  code / containers on the host, so they stay admin-only no matter what. */
export const CREATABLE_PLATFORMS = ['java', 'bedrock', 'steam'] as const;
export type CreatablePlatform = (typeof CREATABLE_PLATFORMS)[number];

export interface CreationPolicy {
  canCreate: boolean;
  platforms: CreatablePlatform[];
  /** Instances this user may own at once (0 = no limit). */
  maxInstances: number;
  /** Highest "max memory" per instance in MB (0 = no limit). */
  maxMemoryMb: number;
  /** Container instances: none, only templates from the app catalog, or any image. */
  containers: 'none' | 'catalog' | 'any';
  /** May mount the container engine's socket (Portainer & other container managers). This means
   *  control over every container on the host — with rootful Docker, effectively the host. */
  engineSocket: boolean;
}

export interface EffectiveCreation extends CreationPolicy {
  /** Every platform this user can create, including admin-only ones for admins. */
  allowedPlatforms: string[];
  owned: number;
  /** True when this comes from the role rather than a per-user setting. */
  fromRole: boolean;
}

export function roleDefaultCreation(role: Role): CreationPolicy {
  if (role === 'viewer') return { canCreate: false, platforms: [], maxInstances: 0, maxMemoryMb: 0, containers: 'none', engineSocket: false };
  // Containers stay opt-in: an admin grants catalog or any-image access per user.
  return { canCreate: true, platforms: [...CREATABLE_PLATFORMS], maxInstances: 0, maxMemoryMb: 0, containers: 'none', engineSocket: false };
}

export function sanitizeCreationPolicy(input: unknown): CreationPolicy {
  const raw = (input ?? {}) as Record<string, unknown>;
  const int = (v: unknown, max: number) => Math.min(Math.max(Math.round(Number(v)) || 0, 0), max);
  return {
    canCreate: raw.canCreate === true,
    platforms: CREATABLE_PLATFORMS.filter((p) => Array.isArray(raw.platforms) && raw.platforms.includes(p)),
    maxInstances: int(raw.maxInstances, 10_000),
    maxMemoryMb: int(raw.maxMemoryMb, 4_194_304),
    containers: raw.containers === 'catalog' || raw.containers === 'any' ? raw.containers : 'none',
    engineSocket: raw.engineSocket === true && (raw.containers === 'catalog' || raw.containers === 'any'),
  };
}

export function countOwned(userId: string): number {
  return (prep('SELECT COUNT(*) AS c FROM servers WHERE created_by = ?').get(userId) as { c: number }).c;
}

export function getEffectiveCreation(userId: string, role: Role): EffectiveCreation {
  const owned = countOwned(userId);
  if (role === 'admin') {
    return {
      canCreate: true,
      platforms: [...CREATABLE_PLATFORMS],
      maxInstances: 0,
      maxMemoryMb: 0,
      containers: 'any',
      engineSocket: true,
      allowedPlatforms: [...CREATABLE_PLATFORMS, 'custom', 'docker'],
      owned,
      fromRole: true,
    };
  }
  const user = getUserById(userId);
  let policy: CreationPolicy | null = null;
  if (user?.creation) {
    try {
      policy = sanitizeCreationPolicy(JSON.parse(user.creation));
    } catch {
      policy = null;
    }
  }
  const effective = policy ?? roleDefaultCreation(role);
  const allowedPlatforms: string[] = effective.canCreate ? [...effective.platforms] : [];
  if (effective.canCreate && effective.containers !== 'none') allowedPlatforms.push('docker');
  return { ...effective, allowedPlatforms, owned, fromRole: !policy };
}

export function setCreationPolicy(userId: string, policy: CreationPolicy | null) {
  prep('UPDATE users SET creation = ? WHERE id = ?').run(policy ? JSON.stringify(policy) : null, userId);
}

/** What an instance's owner can do in it by default: everything except the two opt-in powers
 *  (changing what runs on the host, opening router ports), which an admin grants separately. */
export const OWNER_PERMISSIONS: ServerPermission[] = SERVER_PERMISSIONS.filter((p) => p !== 'launch' && p !== 'network');

/** Gives a user owner-level access to an instance (keeps any extra permissions they already had). */
export function grantOwnerAccess(userId: string, serverId: string) {
  const existing = prep('SELECT permissions FROM user_server_access WHERE user_id = ? AND server_id = ?').get(userId, serverId) as
    | { permissions: string | null }
    | undefined;
  let merged: ServerPermission[] = [...OWNER_PERMISSIONS];
  if (existing?.permissions) {
    try {
      merged = SERVER_PERMISSIONS.filter((p) => merged.includes(p) || (JSON.parse(existing.permissions!) as string[]).includes(p));
    } catch {
      // keep owner defaults
    }
  }
  prep(
    'INSERT INTO user_server_access (user_id, server_id, permissions) VALUES (?, ?, ?) ON CONFLICT(user_id, server_id) DO UPDATE SET permissions = excluded.permissions'
  ).run(userId, serverId, JSON.stringify(merged));
}

export function setServerOwner(serverId: string, userId: string | null) {
  prep('UPDATE servers SET created_by = ? WHERE id = ?').run(userId, serverId);
}

export function usernamesFor(ids: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of new Set(ids)) {
    const u = getUserById(id);
    if (u) out[id] = u.username;
  }
  return out;
}

/** Individual overrides use setting.<field> and property.<key>. */
export const CONFIG_FIELDS = ['name', 'minMemoryMb', 'maxMemoryMb', 'serverPort', 'extraJavaArgs', 'extraArgs', 'autoStart', 'steamLogin', 'steamExtraFlags', 'restartPolicy', 'restartDelaySec', 'restartMaxAttempts', 'isolation'] as const;
export function sanitizeConfigAccess(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, allowed]) =>
    typeof allowed === 'boolean' && (CONFIG_FIELDS.some((field) => key === `setting.${field}`) || /^property\.[a-zA-Z0-9_.-]+$/.test(key))));
}
export function getConfigAccess(userId: string, role: Role, serverId: string): Record<string, boolean> {
  if (role === 'admin') return {};
  const row = prep('SELECT config_access FROM user_server_access WHERE user_id = ? AND server_id = ?').get(userId, serverId) as { config_access: string | null } | undefined;
  return sanitizeConfigAccess(JSON.parse(row?.config_access || '{}'));
}

export function getServerPermissions(userId: string, role: Role, serverId: string): ServerPermission[] | null {
  const permissions = baseServerPermissions(userId, role, serverId);
  if (!Object.values(getConfigAccess(userId, role, serverId)).includes(false)) return permissions;
  // These capabilities can replace protected files or run commands outside the form editor.
  return permissions?.filter((p) => !['files.write', 'console', 'backups.restore', 'launch', 'plugins', 'update', 'players'].includes(p)) ?? null;
}
