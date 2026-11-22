import { prep } from '../db/db.js';
import { HttpError } from '../utils/asyncHandler.js';

type Kind = 'zip' | 'deduplicated';
export type SnapshotMetadata = { name: string | null; label: string | null };
export const emptySnapshotMetadata: SnapshotMetadata = { name: null, label: null };

export function snapshotMetadata(serverId: string, kind: Kind) {
  const rows = prep('SELECT snapshot_id, name, label FROM snapshot_metadata WHERE server_id = ? AND kind = ?')
    .all(serverId, kind) as ({ snapshot_id: string } & SnapshotMetadata)[];
  return new Map(rows.map(({ snapshot_id, name, label }) => [snapshot_id, { name, label }]));
}

function validateText(key: 'name' | 'label', value: unknown, limit: number) {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value) || value.length > limit) {
    throw new HttpError(400, `Snapshot ${key} must be a single line of at most ${limit} characters.`);
  }
  return value.trim() || null;
}

export function updateSnapshotMetadata(serverId: string, kind: Kind, id: string, input: unknown, defaults = emptySnapshotMetadata) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
    (!Object.hasOwn(input, 'name') && !Object.hasOwn(input, 'label'))) {
    throw new HttpError(400, 'Provide a snapshot name or label.');
  }
  const patch = input as Record<string, unknown>;
  const current = prep('SELECT name, label FROM snapshot_metadata WHERE server_id = ? AND kind = ? AND snapshot_id = ?')
    .get(serverId, kind, id) as SnapshotMetadata | undefined ?? defaults;
  const name = Object.hasOwn(patch, 'name') ? validateText('name', patch.name, 80) : current.name;
  const label = Object.hasOwn(patch, 'label') ? validateText('label', patch.label, 40) : current.label;
  prep(`
    INSERT INTO snapshot_metadata (server_id, kind, snapshot_id, name, label) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (server_id, kind, snapshot_id) DO UPDATE SET name = excluded.name, label = excluded.label
  `).run(serverId, kind, id, name, label);
  return { name, label };
}

export function deleteSnapshotMetadata(serverId: string, kind: Kind, id: string) {
  prep('DELETE FROM snapshot_metadata WHERE server_id = ? AND kind = ? AND snapshot_id = ?').run(serverId, kind, id);
}
