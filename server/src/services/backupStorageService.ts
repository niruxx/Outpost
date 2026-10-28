import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { prep } from '../db/db.js';
import { BACKUPS_DIR, REWIND_DIR, INSTANCES_DIR, backupDir as defaultBackupDir, rewindDir as defaultRewindDir, safeJoinReal } from '../utils/paths.js';
import { HttpError } from '../utils/asyncHandler.js';

const changing = new Set<string>();
const active = new Map<string, number>();
const MARKER = '.outpost-backup-store';

function within(base: string, target: string) {
  const relative = path.relative(base, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function configuredDirectory(serverId: string): string | null {
  if (!/^[a-zA-Z0-9_-]+$/.test(serverId)) throw new HttpError(400, 'Invalid instance id');
  return (prep('SELECT backup_directory FROM servers WHERE id = ?').get(serverId) as { backup_directory: string | null } | undefined)?.backup_directory ?? null;
}
function paths(serverId: string, directory: string | null) {
  return directory ? { snapshots: path.join(directory, serverId, 'snapshots'), rewind: path.join(directory, serverId, 'rewind') }
    : { snapshots: defaultBackupDir(serverId), rewind: defaultRewindDir(serverId) };
}
function checkDirectory(serverId: string, directory: string | null) {
  if (!directory) return;
  try {
    const root = fs.realpathSync(directory);
    const own = path.join(directory, serverId);
    if (path.relative(root, directory) !== '' || path.relative(fs.realpathSync(own), own) !== '' || fs.readFileSync(path.join(own, MARKER), 'utf8') !== serverId) throw new Error('Storage identity changed');
    for (const dest of Object.values(paths(serverId, directory))) {
      if (fs.existsSync(dest) && path.relative(fs.realpathSync(dest), dest) !== '') throw new Error('Storage subdirectories must not be symlinks');
    }
  } catch {
    throw new HttpError(503, 'The configured backup drive is unavailable or its storage marker is missing. Reconnect the drive; Outpost will not fall back to the system disk.');
  }
}
function checkedPaths(serverId: string) {
  if (changing.has(serverId)) throw new HttpError(409, 'Backup storage is being changed. Try again after the copy finishes.');
  const directory = configuredDirectory(serverId);
  checkDirectory(serverId, directory);
  return paths(serverId, directory);
}
export function backupDir(serverId: string) { return checkedPaths(serverId).snapshots; }
export function rewindDir(serverId: string) { return checkedPaths(serverId).rewind; }
/** Small undo/safety copies are kept with snapshots so they follow storage moves and exports. */
export function fileUndoPath(serverId: string, relative: string) {
  return safeJoinReal(backupDir(serverId), `file-undo/${relative}`);
}

/** Hold across asynchronous backup work so its directory cannot change underneath it. */
export function acquireBackupStorage(serverId: string) {
  checkedPaths(serverId);
  active.set(serverId, (active.get(serverId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return; released = true;
    const count = (active.get(serverId) ?? 1) - 1;
    if (count) active.set(serverId, count); else active.delete(serverId);
  };
}
export function backupStorageInfo(serverId: string) {
  const directory = configuredDirectory(serverId);
  let error: string | null = null;
  try { checkDirectory(serverId, directory); } catch (err) { error = err instanceof Error ? err.message : 'Storage unavailable'; }
  return { directory, ...paths(serverId, directory), available: !error, error, changing: changing.has(serverId) };
}

async function validateDestination(serverId: string, input: unknown, previous: string | null): Promise<string | null> {
  if (input === null || input === '') return null;
  if (typeof input !== 'string' || input.length > 4096 || /[\0\r\n]/.test(input) || !path.isAbsolute(input.trim())) throw new HttpError(400, 'Use an absolute directory path on the Outpost host, or leave it blank for the default');
  let directory: string;
  try {
    directory = await fsp.realpath(input.trim());
    if (!(await fsp.stat(directory)).isDirectory()) throw new Error('Not a directory');
  } catch { throw new HttpError(400, 'The destination directory must already exist. Mount the drive and create its backup folder first.'); }
  if (directory === path.parse(directory).root) throw new HttpError(400, 'Choose a backup folder, not a filesystem root');
  if (directory === previous) { checkDirectory(serverId, directory); return directory; }
  // Never put backups inside live data, or nest the custom layout in the legacy layout.
  for (const reserved of [INSTANCES_DIR, BACKUPS_DIR, REWIND_DIR]) {
    let real = reserved;
    try { real = await fsp.realpath(reserved); } catch { /* compare the planned path */ }
    if (within(real, directory) || within(directory, real)) throw new HttpError(400, 'Choose a folder separate from instance files and the default backup/rewind folders');
  }
  const own = path.join(directory, serverId);
  await fsp.mkdir(own, { recursive: true, mode: 0o700 });
  if (path.relative(await fsp.realpath(own), own) !== '') throw new HttpError(400, 'The instance backup folder must not be a symlink');
  const marker = path.join(own, MARKER);
  try { await fsp.writeFile(marker, serverId, { flag: 'wx', mode: 0o600 }); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || (await fsp.lstat(marker)).isSymbolicLink() || await fsp.readFile(marker, 'utf8') !== serverId) throw new HttpError(400, 'The destination has an invalid storage marker or is not writable');
  }
  checkDirectory(serverId, directory);
  return directory;
}
async function hash(file: string) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
async function copyTree(source: string, target: string, links: Map<string, string>) {
  let stat: fs.Stats;
  try { stat = await fsp.lstat(source); } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; throw err; }
  if (stat.isSymbolicLink()) throw new HttpError(400, 'Backup storage contains a symlink; remove it before copying');
  if (stat.isDirectory()) {
    await fsp.mkdir(target, { recursive: true, mode: 0o700 });
    if ((await fsp.lstat(target)).isSymbolicLink()) throw new HttpError(400, 'Destination backup folders must not be symlinks');
    for (const name of await fsp.readdir(source)) await copyTree(path.join(source, name), path.join(target, name), links);
  } else if (stat.isFile()) {
    try {
      const existing = await fsp.lstat(target);
      if (existing.isSymbolicLink() || !existing.isFile() || existing.size !== stat.size || await hash(source) !== await hash(target)) throw new HttpError(409, `A different backup already exists at ${target}. Choose an empty destination or resolve the conflict.`);
      return;
    } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
    // Preserve World Rewind's hard-link savings when the destination filesystem supports them.
    const key = `${stat.dev}:${stat.ino}`;
    const prior = links.get(key);
    if (prior && stat.nlink > 1) {
      try { await fsp.link(prior, target); return; } catch { /* FAT/exFAT: copy instead */ }
    }
    await fsp.copyFile(source, target, fs.constants.COPYFILE_EXCL);
    await fsp.utimes(target, stat.atime, stat.mtime);
    if (stat.nlink > 1) links.set(key, target);
  } else throw new HttpError(400, 'Backup storage contains an unsupported special file');
}

export async function setBackupStorage(serverId: string, directory: unknown, copyExisting: boolean) {
  if (!prep('SELECT id FROM servers WHERE id = ?').get(serverId)) throw new HttpError(404, 'Instance not found');
  if (changing.has(serverId) || active.has(serverId)) throw new HttpError(409, 'A backup, restore or off-site transfer is active. Wait for it to finish before changing storage.');
  changing.add(serverId);
  try {
    const previous = configuredDirectory(serverId);
    const next = await validateDestination(serverId, directory, previous);
    if (previous === next) return { ...backupStorageInfo(serverId), changing: false };
    if (copyExisting) checkDirectory(serverId, previous);
    const source = paths(serverId, previous), target = paths(serverId, next);
    for (const dest of Object.values(target)) {
      await fsp.mkdir(dest, { recursive: true, mode: 0o700 });
      const probe = path.join(dest, `.write-test-${crypto.randomUUID()}`);
      await fsp.writeFile(probe, '', { flag: 'wx', mode: 0o600 }); await fsp.unlink(probe);
    }
    if (copyExisting) {
      const links = new Map<string, string>();
      await copyTree(source.snapshots, target.snapshots, links);
      await copyTree(source.rewind, target.rewind, links);
    }
    checkDirectory(serverId, next);
    prep('UPDATE servers SET backup_directory = ? WHERE id = ?').run(next, serverId);
    return { ...backupStorageInfo(serverId), changing: false };
  } finally { changing.delete(serverId); }
}
