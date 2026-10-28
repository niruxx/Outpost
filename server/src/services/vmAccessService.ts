import { db, prep } from '../db/db.js';
import { getUserById } from './userService.js';
import { libvirtSettings, validateVmUuid, validateLibvirtSettings } from './libvirtService.js';
import { HttpError } from '../utils/asyncHandler.js';

export const VM_PERMISSIONS = ['view', 'power', 'console', 'configure', 'snapshots'] as const;
export type VmPermission = typeof VM_PERMISSIONS[number];
export interface VmGrant { uri: string; uuid: string; permissions: VmPermission[] }
export function vmGrants(userId: string): VmGrant[] {
  return (prep('SELECT uri, uuid, permissions FROM vm_access WHERE user_id = ?').all(userId) as { uri: string; uuid: string; permissions: string }[])
    .map(row => ({ ...row, permissions: JSON.parse(row.permissions) }));
}
export function setVmGrants(userId: string, input: unknown) {
  if (!Array.isArray(input) || input.length > 500) throw new HttpError(400, 'Provide at most 500 VM grants');
  const grants: VmGrant[] = input.map(value => {
    if (!value || !Array.isArray(value.permissions) || !value.permissions.every((p: VmPermission) => VM_PERMISSIONS.includes(p))) throw new HttpError(400, 'Invalid VM permissions');
    return { uri: validateLibvirtSettings({ enabled: true, uri: value.uri }).uri, uuid: validateVmUuid(value.uuid).toLowerCase(), permissions: [...new Set<VmPermission>(['view', ...value.permissions])] };
  });
  // Validate the complete replacement before changing any grants.
  db.exec('BEGIN');
  try {
    prep('DELETE FROM vm_access WHERE user_id = ?').run(userId);
    for (const grant of grants) prep('INSERT OR REPLACE INTO vm_access (user_id, uri, uuid, permissions) VALUES (?, ?, ?, ?)').run(userId, grant.uri, grant.uuid, JSON.stringify(grant.permissions));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function vmPermissions(userId: string, uuid: string): VmPermission[] {
  const user = getUserById(userId);
  if (!user) return [];
  if (user.role === 'admin') return [...VM_PERMISSIONS];
  return vmGrants(userId).find(g => g.uri === libvirtSettings().uri && g.uuid.toLowerCase() === uuid.toLowerCase())?.permissions ?? [];
}
export function requireVmPermission(userId: string, uuid: string, permission: VmPermission) {
  validateVmUuid(uuid);
  if (!vmPermissions(userId, uuid).includes(permission)) throw new HttpError(403, `VM ${permission} permission required`);
}
