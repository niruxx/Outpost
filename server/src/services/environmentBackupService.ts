import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { DATA_DIR } from '../utils/paths.js';
import { closeDatabase } from '../db/db.js';
import { listServers } from './serverService.js';
import { isRunning } from './processManager.js';
import { logger } from '../utils/logger.js';
import { HttpError } from '../utils/asyncHandler.js';
import { DatabaseSync } from 'node:sqlite';
import { acquireBackupStorage, backupDir, rewindDir } from './backupStorageService.js';

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Renames a directory, retrying a few times on Windows' transient EPERM/EBUSY — antivirus or
 * the search indexer can briefly hold a handle into a directory right after it's created or
 * freed, which makes an immediate rename fail even though nothing is actually still using it.
 */
async function renameWithRetry(from: string, to: string, attempts = 5): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (i === attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, 250 * i));
    }
  }
}

/**
 * Zips the entire data directory (database, every server's files, and all backups) to a
 * temp file outside of DATA_DIR (so the zip never tries to include itself). Caller is
 * responsible for streaming it to the client and deleting it afterward.
 */
export async function exportEnvironment(): Promise<{ filePath: string; fileName: string }> {
  const fileName = `outpost-environment-${timestampSlug()}.zip`;
  const filePath = path.join(os.tmpdir(), fileName);
  const release: (() => void)[] = [];
  try {
    const servers = listServers();
    for (const server of servers) release.push(acquireBackupStorage(server.id));
    const zip = new AdmZip();
    zip.addLocalFolder(DATA_DIR, '');
    for (const server of servers.filter((s) => s.backup_directory)) {
      // Export active external archives in the portable default layout, replacing old copies.
      zip.deleteFile(`backups/${server.id}/`);
      zip.deleteFile(`rewind/${server.id}/`);
      const relative = path.relative(DATA_DIR, path.join(server.backup_directory!, server.id));
      if (!relative.startsWith('..') && !path.isAbsolute(relative)) zip.deleteFile(`${relative.split(path.sep).join('/')}/`);
      const snapshots = backupDir(server.id), rewind = rewindDir(server.id);
      if (fs.existsSync(snapshots)) zip.addLocalFolder(snapshots, `backups/${server.id}`);
      if (fs.existsSync(rewind)) zip.addLocalFolder(rewind, `rewind/${server.id}`);
    }
    await zip.writeZipPromise(filePath);
  } finally { for (const done of release) done(); }
  logger.info(`Exported environment backup: ${filePath} (${fs.statSync(filePath).size} bytes)`);
  return { filePath, fileName };
}

/** Checks that an uploaded archive actually looks like an Outpost data directory export. */
export function validateEnvironmentArchive(zipPath: string): void {
  let zip: AdmZip;
  try {
    zip = new AdmZip(zipPath);
  } catch {
    throw new HttpError(400, 'That file is not a valid zip archive');
  }
  const hasDb = zip.getEntries().some((e) => e.entryName === 'outpost.db' || e.entryName === 'multicraft.db' || e.entryName === 'multicraft.db/');
  if (!hasDb) {
    throw new HttpError(400, "This doesn't look like an Outpost environment backup (no outpost.db found in the archive)");
  }
}

/** Ensures it's safe to yank the whole data directory out from under the running process. */
export function assertNoServersRunning(): void {
  const running = listServers().filter((s) => isRunning(s.id));
  if (running.length > 0) {
    throw new HttpError(
      409,
      `Stop all running servers before importing (still running: ${running.map((s) => s.name).join(', ')})`
    );
  }
}

/**
 * Shared "swap the whole data directory for something else" machinery, used by both import
 * and factory-reset. `stagingDir` must already contain the complete replacement contents.
 *
 * Point of no return: node:sqlite can't reopen a closed database, so once we close it the app
 * can no longer serve normal requests (or a normal HTTP error response) regardless of whether
 * the file swap below succeeds. Any failure from here on is handled by restoring the original
 * files as best we can and forcing a restart, rather than returning an error.
 */
async function swapDataDir(stagingDir: string, actionLabel: string): Promise<{ previousDataDirBackup: string }> {
  const previousDataDirBackup = `${DATA_DIR}-${actionLabel}-${timestampSlug()}`;

  closeDatabase();

  try {
    await renameWithRetry(DATA_DIR, previousDataDirBackup);
  } catch (err) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    logger.error(`Environment ${actionLabel} failed before any files were touched; restarting to recover`, err);
    process.exit(1);
  }

  try {
    await renameWithRetry(stagingDir, DATA_DIR);
  } catch (err) {
    await renameWithRetry(previousDataDirBackup, DATA_DIR).catch((rollbackErr) => {
      logger.error(`CRITICAL: ${actionLabel} rollback failed, data directory may be missing`, rollbackErr);
    });
    fs.rmSync(stagingDir, { recursive: true, force: true });
    logger.error(`Environment ${actionLabel} failed applying new files; rolled back and restarting to recover`, err);
    process.exit(1);
  }

  logger.info(`Environment ${actionLabel} applied. Previous data kept at ${previousDataDirBackup}`);
  return { previousDataDirBackup };
}

/**
 * Replaces the entire data directory with the contents of an uploaded archive, then exits
 * the process so the next start reopens a fresh database against the restored files. The
 * previous data directory is kept alongside (renamed, not deleted) as a safety net.
 *
 * Callers MUST have already validated the archive and confirmed no servers are running.
 */
export async function importEnvironment(zipPath: string): Promise<{ previousDataDirBackup: string }> {
  const stagingDir = `${DATA_DIR}-import-staging-${timestampSlug()}`;

  fs.mkdirSync(stagingDir, { recursive: true });
  try {
    new AdmZip(zipPath).extractAllTo(stagingDir, true);
    resetImportedBackupStoragePaths(stagingDir);
  } catch (err) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw new HttpError(400, `Could not extract the archive (${err instanceof Error ? err.message : err})`);
  }

  return swapDataDir(stagingDir, 'pre-import');
}

/** Exported archives use the default layout, so machine-specific mount paths must be cleared. */
export function resetImportedBackupStoragePaths(stagingDir: string) {
  const dbPath = path.join(stagingDir, fs.existsSync(path.join(stagingDir, 'outpost.db')) ? 'outpost.db' : 'multicraft.db');
  const stagedDb = new DatabaseSync(dbPath);
  try {
    if (stagedDb.prepare("SELECT 1 FROM pragma_table_info('servers') WHERE name = 'backup_directory'").get()) stagedDb.exec('UPDATE servers SET backup_directory = NULL');
  } finally { stagedDb.close(); }
}

/**
 * Factory reset: wipes every user account, every server (including its world files), and
 * every backup, replacing the data directory with an empty one. The panel comes back up
 * showing the first-run setup wizard. The previous data directory is kept alongside
 * (renamed, not deleted) so it can be recovered by hand if this was triggered by mistake.
 *
 * Callers MUST have already re-verified the acting admin's password and confirmed no
 * servers are running.
 */
export async function resetEnvironment(): Promise<{ previousDataDirBackup: string }> {
  const stagingDir = `${DATA_DIR}-reset-staging-${timestampSlug()}`;
  fs.mkdirSync(path.join(stagingDir, 'servers'), { recursive: true });
  fs.mkdirSync(path.join(stagingDir, 'backups'), { recursive: true });

  return swapDataDir(stagingDir, 'pre-reset');
}
