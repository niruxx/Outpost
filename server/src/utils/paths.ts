import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { envVar } from './env.js';

// server/src/utils -> server -> repo root/data
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = path.resolve(__dirname, '..', '..');
/**
 * The real, long form of a folder (created if missing). On Windows a path containing an 8.3 short
 * name (NAME~1) trips up some game servers' own installers (Mohist, Sponge) — they need the long one.
 */
function canonicalDir(p: string): string {
  try {
    fs.mkdirSync(p, { recursive: true });
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

export const DATA_DIR = canonicalDir(envVar('DATA_DIR') ? path.resolve(envVar('DATA_DIR')!) : path.join(SERVER_ROOT, 'data'));

export const DB_PATH = path.join(DATA_DIR, 'outpost.db');
/** The database's name before the rename to Outpost — migrated to DB_PATH on first start. */
export const LEGACY_DB_PATH = path.join(DATA_DIR, 'multicraft.db');
export const INSTANCES_DIR = path.join(DATA_DIR, 'servers');
export const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
export const JAVA_RUNTIMES_DIR = path.join(DATA_DIR, 'runtimes');
export const MAP_CACHE_DIR = path.join(DATA_DIR, 'map-cache');
/** World Rewind restore points (Minecraft worlds), one folder per instance. */
export const REWIND_DIR = path.join(DATA_DIR, 'rewind');
export const STEAMCMD_DIR = path.join(DATA_DIR, 'steamcmd');
export const WEB_DIST_DIR = path.resolve(SERVER_ROOT, '..', 'web', 'dist');

export function instanceDir(serverId: string): string {
  return path.join(INSTANCES_DIR, serverId);
}

export function pluginsDir(serverId: string): string {
  return path.join(instanceDir(serverId), 'plugins');
}

export function rewindDir(serverId: string): string {
  return path.join(REWIND_DIR, serverId);
}

export function backupDir(serverId: string): string {
  return path.join(BACKUPS_DIR, serverId);
}

/** Where a server's rendered map PNG + metadata live — outside instanceDir so it's never
 *  swept into that server's own zip backups. */
export function mapCachePath(serverId: string): { image: string; meta: string } {
  return {
    image: path.join(MAP_CACHE_DIR, `${serverId}.png`),
    meta: path.join(MAP_CACHE_DIR, `${serverId}.json`),
  };
}

/**
 * Resolves a user-supplied relative path against a base directory, guaranteeing
 * the result stays inside that base directory (blocks `..` traversal and absolute
 * path escapes). Throws if the path would escape.
 */
export function safeJoin(base: string, relative: string): string {
  const normalizedRelative = (relative ?? '').split('\\').join('/');
  const target = path.resolve(base, '.' + path.sep + normalizedRelative);
  const baseResolved = path.resolve(base);
  if (target !== baseResolved && !target.startsWith(baseResolved + path.sep)) {
    throw new Error('Path escapes the allowed directory');
  }
  return target;
}

/**
 * Like safeJoin, but also follows symlinks: the deepest part of the path that exists on disk
 * must *really* live inside `base`. Game servers, plugins and scripts can create symlinks in their
 * own folder (`ln -s / escape`); a lexical check alone would let the panel follow them out.
 * Broken symlinks are rejected, since where they'd lead can't be verified.
 */
export function safeJoinReal(base: string, relative: string): string {
  const target = safeJoin(base, relative);
  let realBase: string;
  try {
    realBase = fs.realpathSync(base);
  } catch {
    return target; // base doesn't exist yet — nothing under it can be a symlink
  }
  let probe = target;
  for (;;) {
    try {
      fs.lstatSync(probe);
      break;
    } catch {
      if (probe === base || path.dirname(probe) === probe) return target;
      probe = path.dirname(probe);
    }
  }
  let real: string;
  try {
    real = fs.realpathSync(probe);
  } catch {
    throw new Error('Path goes through a broken symlink');
  }
  if (real !== realBase && !real.startsWith(realBase + path.sep)) {
    throw new Error('Path escapes the allowed directory through a symlink');
  }
  return target;
}

/** True when `relative` is a symlink itself (lexically inside base) — e.g. so it can be deleted
 *  without following it. */
export function isSymlinkAt(base: string, relative: string): boolean {
  try {
    return fs.lstatSync(safeJoin(base, relative)).isSymbolicLink();
  } catch {
    return false;
  }
}
