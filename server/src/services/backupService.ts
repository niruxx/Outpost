import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { backupDir, instanceDir, safeJoinReal } from '../utils/paths.js';
import { isRunning } from './processManager.js';
import { HttpError } from '../utils/asyncHandler.js';
import { logger } from '../utils/logger.js';

export interface BackupInfo {
  fileName: string;
  sizeBytes: number;
  createdAt: string;
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Zips the entire instance directory into the server's backup folder. Skips old backup archives. */
export async function createBackup(serverId: string, label?: string): Promise<BackupInfo> {
  const srcDir = instanceDir(serverId);
  if (!fs.existsSync(srcDir)) throw new HttpError(404, 'Server directory not found');
  const destDir = backupDir(serverId);
  fs.mkdirSync(destDir, { recursive: true });

  const safeLabel = label ? '-' + label.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) : '';
  const fileName = `backup-${timestampSlug()}${safeLabel}.zip`;
  const destPath = path.join(destDir, fileName);

  const zip = new AdmZip();
  zip.addLocalFolder(srcDir, '', (entryPath) => !entryPath.startsWith('..' + path.sep + 'backups'));
  await zip.writeZipPromise(destPath);

  const stat = fs.statSync(destPath);
  logger.info(`Created backup for server ${serverId}: ${fileName} (${stat.size} bytes)`);
  // Copy it off-site (in the background) when destinations are set up.
  void import('./offsiteService.js').then((o) => o.enqueueCopy(serverId, fileName)).catch(() => {});
  return { fileName, sizeBytes: stat.size, createdAt: new Date().toISOString() };
}

export function listBackups(serverId: string): BackupInfo[] {
  const dir = backupDir(serverId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.zip'))
    .map((fileName) => {
      const stat = fs.statSync(path.join(dir, fileName));
      return { fileName, sizeBytes: stat.size, createdAt: stat.birthtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function resolveBackupPath(serverId: string, fileName: string): string {
  if (fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) {
    throw new HttpError(400, 'Invalid backup file name');
  }
  const filePath = path.join(backupDir(serverId), fileName);
  if (!fs.existsSync(filePath)) throw new HttpError(404, 'Backup not found');
  return filePath;
}

export function deleteBackup(serverId: string, fileName: string): void {
  const filePath = resolveBackupPath(serverId, fileName);
  fs.rmSync(filePath);
}

/** Restores a backup by wiping the current instance directory and extracting the archive in its place. */
export async function restoreBackup(serverId: string, fileName: string): Promise<void> {
  if (isRunning(serverId)) {
    throw new HttpError(409, 'Stop the server before restoring a backup');
  }
  const filePath = resolveBackupPath(serverId, fileName);
  const dir = instanceDir(serverId);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const zip = new AdmZip(filePath);
  zip.extractAllTo(dir, true);
  logger.info(`Restored server ${serverId} from backup ${fileName}`);
}

export function enforceRetention(serverId: string, retentionCount: number): void {
  const backups = listBackups(serverId);
  if (backups.length <= retentionCount) return;
  const toDelete = backups.slice(retentionCount);
  for (const b of toDelete) {
    fs.rmSync(path.join(backupDir(serverId), b.fileName), { force: true });
    logger.info(`Pruned old backup ${b.fileName} for server ${serverId} (retention ${retentionCount})`);
  }
}

// ---------------------------------------------------------------------------
// Snapshot browsing & single-file restore
// ---------------------------------------------------------------------------

export interface SnapshotEntry {
  path: string; // forward-slash path relative to the instance root
  size: number;
}

export interface FileSide {
  exists: boolean;
  size: number;
  binary: boolean;
  /** Text content, when the file is text and small enough to diff. */
  text: string | null;
}

const MAX_DIFF_BYTES = 1024 * 1024;

function normalizeEntryPath(raw: string): string {
  const cleaned = raw.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!cleaned || cleaned.split('/').some((part) => part === '..')) throw new HttpError(400, 'Invalid file path');
  return cleaned;
}

function describe(buffer: Buffer | null): FileSide {
  if (!buffer) return { exists: false, size: 0, binary: false, text: null };
  const binary = buffer.subarray(0, 8192).includes(0);
  return {
    exists: true,
    size: buffer.length,
    binary,
    text: !binary && buffer.length <= MAX_DIFF_BYTES ? buffer.toString('utf8') : null,
  };
}

function openSnapshot(serverId: string, fileName: string): AdmZip {
  return new AdmZip(resolveBackupPath(serverId, fileName));
}

/** Every file in a snapshot (directories omitted). */
export function listSnapshotEntries(serverId: string, fileName: string): SnapshotEntry[] {
  return openSnapshot(serverId, fileName)
    .getEntries()
    .filter((e) => !e.isDirectory)
    .map((e) => ({ path: e.entryName.replace(/\\/g, '/'), size: e.header.size }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** The snapshot's copy of one file next to the live copy, for a diff before restoring. */
export function compareSnapshotFile(serverId: string, fileName: string, rawPath: string): { snapshot: FileSide; current: FileSide } {
  const entryPath = normalizeEntryPath(rawPath);
  const entry = openSnapshot(serverId, fileName).getEntry(entryPath);
  if (!entry || entry.isDirectory) throw new HttpError(404, 'That file is not in this snapshot');
  let livePath: string;
  try {
    livePath = safeJoinReal(instanceDir(serverId), entryPath);
  } catch {
    throw new HttpError(400, 'Invalid file path');
  }
  const live = fs.existsSync(livePath) && fs.statSync(livePath).isFile() ? fs.readFileSync(livePath) : null;
  return { snapshot: describe(entry.getData()), current: describe(live) };
}

/** Copies one file out of a snapshot over the live instance's copy. */
export function restoreSnapshotFile(serverId: string, fileName: string, rawPath: string): void {
  const entryPath = normalizeEntryPath(rawPath);
  const entry = openSnapshot(serverId, fileName).getEntry(entryPath);
  if (!entry || entry.isDirectory) throw new HttpError(404, 'That file is not in this snapshot');
  let livePath: string;
  try {
    livePath = safeJoinReal(instanceDir(serverId), entryPath);
  } catch {
    throw new HttpError(400, 'Invalid file path');
  }
  fs.mkdirSync(path.dirname(livePath), { recursive: true });
  fs.writeFileSync(livePath, entry.getData());
  logger.info(`Restored ${entryPath} for server ${serverId} from snapshot ${fileName}`);
}
