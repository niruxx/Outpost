import { backupDir, rewindDir } from './backupStorageService.js';
import fs from 'node:fs';
import path from 'node:path';
import { instanceDir } from '../utils/paths.js';

interface CacheEntry {
  bytes: number;
  computedAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 20_000;

function dirSize(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      total += dirSize(full);
    } else if (entry.isFile()) {
      try {
        total += fs.statSync(full).size;
      } catch {
        // file removed mid-walk; skip
      }
    }
  }
  return total;
}

/** Recursively sums a server's instance directory size (and its backups), cached briefly since large worlds are slow to walk. */
export function getDiskUsage(serverId: string): { serverBytes: number; backupsBytes: number; backupsAvailable: boolean } {
  const now = Date.now();
  const serverCached = cache.get(`server:${serverId}`);
  const serverBytes =
    serverCached && now - serverCached.computedAt < CACHE_TTL_MS ? serverCached.bytes : dirSize(instanceDir(serverId));
  if (!serverCached || now - serverCached.computedAt >= CACHE_TTL_MS) {
    cache.set(`server:${serverId}`, { bytes: serverBytes, computedAt: now });
  }

  const backupsCached = cache.get(`backups:${serverId}`);
  let backupsAvailable = true;
  let backupsBytes = backupsCached?.bytes ?? 0;
  try {
    const snapshots = backupDir(serverId), rewind = rewindDir(serverId);
    if (!backupsCached || now - backupsCached.computedAt >= CACHE_TTL_MS) backupsBytes = dirSize(snapshots) + dirSize(rewind);
  } catch { backupsAvailable = false; }
  if (!backupsCached || now - backupsCached.computedAt >= CACHE_TTL_MS) {
    cache.set(`backups:${serverId}`, { bytes: backupsBytes, computedAt: now });
  }

  return { serverBytes, backupsBytes, backupsAvailable };
}
