/**
 * Filesystem operations for the Host File Manager, on absolute host paths.
 *
 * The same functions run in two places: inside the Outpost process (limited access, acting as the
 * service account) and inside the privileged helper started through sudo (administrative access).
 * Keep this module free of panel imports (database, auth, logging) so the helper stays small and
 * never opens Outpost's database or secrets as root.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const MAX_TEXT_BYTES = 5 * 1024 * 1024;
export const CHUNK_BYTES = 1024 * 1024;

export interface HostFileEntry {
  name: string;
  path: string; // absolute
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  modifiedAt: string;
  /** Unix permission bits, e.g. "rwxr-xr-x"; null on Windows. */
  permissions: string | null;
  owner: string | null;
  group: string | null;
}

export class HostFileError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Turns fs errors into messages an administrator can act on. */
function describe(err: unknown, target: string): HostFileError {
  if (err instanceof HostFileError) return err;
  const code = (err as NodeJS.ErrnoException)?.code;
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      return new HostFileError(403, `Permission denied: ${target}. Turn on Admin Mode to manage files your account can't access.`);
    case 'ENOENT':
      return new HostFileError(404, `Not found: ${target}`);
    case 'ENOTDIR':
      return new HostFileError(400, `Not a directory: ${target}`);
    case 'EISDIR':
      return new HostFileError(400, `Is a directory: ${target}`);
    case 'EEXIST':
      return new HostFileError(409, `Already exists: ${target}`);
    case 'ENOTEMPTY':
      return new HostFileError(409, `Directory not empty: ${target}`);
    case 'EBUSY':
      return new HostFileError(409, `In use: ${target}`);
    case 'EROFS':
      return new HostFileError(403, `Read-only file system: ${target}`);
    default:
      return new HostFileError(500, err instanceof Error ? err.message : 'File operation failed');
  }
}

/** An absolute, normalized host path. Relative input is rejected rather than guessed. */
export function normalizeHostPath(input: unknown, platform: NodeJS.Platform = process.platform): string {
  if (typeof input !== 'string' || !input || input.includes('\0')) throw new HostFileError(400, 'An absolute path is required');
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (!p.isAbsolute(input)) throw new HostFileError(400, `Path must be absolute: ${input}`);
  if (platform === 'win32' && !/^[a-zA-Z]:[\\/]/.test(input) && !input.startsWith('\\\\')) throw new HostFileError(400, 'Windows paths must include a drive letter, e.g. C:\\');
  return p.resolve(input);
}

function isRoot(target: string) {
  return path.dirname(target) === target;
}

function permissionString(mode: number) {
  const chars = 'rwxrwxrwx';
  let out = '';
  for (let i = 0; i < 9; i++) out += mode & (1 << (8 - i)) ? chars[i] : '-';
  return out;
}

/** uid/gid → name maps from /etc/passwd and /etc/group, cached briefly. */
let idCache: { at: number; users: Map<number, string>; groups: Map<number, string> } | null = null;
function idNames() {
  if (process.platform === 'win32') return null;
  if (idCache && Date.now() - idCache.at < 30_000) return idCache;
  const parse = (file: string) => {
    const map = new Map<number, string>();
    try {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const [name, , id] = line.split(':');
        if (name && id && /^\d+$/.test(id)) map.set(Number(id), name);
      }
    } catch { /* not readable: show numeric ids */ }
    return map;
  };
  idCache = { at: Date.now(), users: parse('/etc/passwd'), groups: parse('/etc/group') };
  return idCache;
}

export async function listHostDirectory(dir: string): Promise<HostFileEntry[]> {
  const target = normalizeHostPath(dir);
  let names: fs.Dirent[];
  try {
    names = await fsp.readdir(target, { withFileTypes: true });
  } catch (err) {
    throw describe(err, target);
  }
  const ids = idNames();
  const results: HostFileEntry[] = [];
  await Promise.all(
    names.map(async (entry) => {
      const full = path.join(target, entry.name);
      let lstat: fs.Stats;
      try {
        lstat = await fsp.lstat(full);
      } catch {
        return; // removed while listing
      }
      let stat = lstat;
      if (lstat.isSymbolicLink()) stat = await fsp.stat(full).catch(() => lstat); // broken links still show
      results.push({
        name: entry.name,
        path: full,
        isDirectory: stat.isDirectory(),
        isSymlink: lstat.isSymbolicLink(),
        size: stat.isDirectory() ? 0 : stat.size,
        modifiedAt: stat.mtime.toISOString(),
        permissions: process.platform === 'win32' ? null : permissionString(lstat.mode),
        owner: ids ? (ids.users.get(lstat.uid) ?? String(lstat.uid)) : null,
        group: ids ? (ids.groups.get(lstat.gid) ?? String(lstat.gid)) : null,
      });
    })
  );
  results.sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1));
  return results;
}

export async function statHostFile(file: string) {
  const target = normalizeHostPath(file);
  try {
    const stat = await fsp.stat(target);
    return { path: target, isDirectory: stat.isDirectory(), size: stat.size };
  } catch (err) {
    throw describe(err, target);
  }
}

export async function readHostText(file: string): Promise<string> {
  const target = normalizeHostPath(file);
  try {
    const stat = await fsp.stat(target);
    if (stat.isDirectory()) throw new HostFileError(400, 'Cannot open a directory as a file');
    if (stat.size > MAX_TEXT_BYTES) throw new HostFileError(413, 'File is too large to edit in the browser (limit 5 MB). Download it instead.');
    return await fsp.readFile(target, 'utf8');
  } catch (err) {
    throw describe(err, target);
  }
}

export async function writeHostText(file: string, content: string): Promise<void> {
  const target = normalizeHostPath(file);
  if (typeof content !== 'string') throw new HostFileError(400, 'content is required');
  try {
    // Writing in place keeps the file's owner, mode and hard links — important for /etc files.
    await fsp.writeFile(target, content, 'utf8');
  } catch (err) {
    throw describe(err, target);
  }
}

/** A base64 slice of a file, for streaming downloads through the privileged helper. */
export async function readHostChunk(file: string, offset: number, length: number): Promise<{ data: string; eof: boolean }> {
  const target = normalizeHostPath(file);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > CHUNK_BYTES) throw new HostFileError(400, 'Invalid chunk range');
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(target, 'r');
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return { data: buffer.subarray(0, bytesRead).toString('base64'), eof: bytesRead < length };
  } catch (err) {
    throw describe(err, target);
  } finally {
    await handle?.close();
  }
}

/** Writes a base64 slice; the first slice (`truncate`) creates or empties the file. */
export async function writeHostChunk(file: string, offset: number, data: string, truncate: boolean): Promise<void> {
  const target = normalizeHostPath(file);
  if (!Number.isSafeInteger(offset) || offset < 0 || typeof data !== 'string') throw new HostFileError(400, 'Invalid chunk');
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(target, truncate ? 'w' : 'r+');
    const buffer = Buffer.from(data, 'base64');
    await handle.write(buffer, 0, buffer.length, offset);
  } catch (err) {
    throw describe(err, target);
  } finally {
    await handle?.close();
  }
}

export async function makeHostDirectory(dir: string): Promise<void> {
  const target = normalizeHostPath(dir);
  try {
    await fsp.mkdir(target);
  } catch (err) {
    throw describe(err, target);
  }
}

export async function renameHostEntry(from: string, to: string): Promise<void> {
  const source = normalizeHostPath(from);
  const dest = normalizeHostPath(to);
  if (isRoot(source)) throw new HostFileError(400, 'Refusing to move a filesystem root');
  try {
    if (fs.existsSync(dest)) throw new HostFileError(409, `Already exists: ${dest}`);
    await fsp.rename(source, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EXDEV') {
      // Different filesystem: copy, then remove the original.
      try {
        await fsp.cp(source, dest, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, errorOnExist: true, force: false });
        await fsp.rm(source, { recursive: true });
        return;
      } catch (copyErr) {
        throw describe(copyErr, source);
      }
    }
    throw describe(err, source);
  }
}

export async function removeHostEntry(target: string): Promise<void> {
  const resolved = normalizeHostPath(target);
  if (isRoot(resolved)) throw new HostFileError(400, 'Refusing to delete a filesystem root');
  try {
    const stat = await fsp.lstat(resolved);
    // Symlinks are unlinked, never followed.
    if (stat.isSymbolicLink() || !stat.isDirectory()) await fsp.unlink(resolved);
    else await fsp.rm(resolved, { recursive: true });
  } catch (err) {
    throw describe(err, resolved);
  }
}

/** Operations the privileged helper accepts, by name. Nothing else is reachable through it. */
export const HOST_FILE_OPS = {
  list: (a: { path: string }) => listHostDirectory(a.path),
  stat: (a: { path: string }) => statHostFile(a.path),
  readText: (a: { path: string }) => readHostText(a.path),
  writeText: (a: { path: string; content: string }) => writeHostText(a.path, a.content),
  readChunk: (a: { path: string; offset: number; length: number }) => readHostChunk(a.path, a.offset, a.length),
  writeChunk: (a: { path: string; offset: number; data: string; truncate: boolean }) => writeHostChunk(a.path, a.offset, a.data, a.truncate),
  mkdir: (a: { path: string }) => makeHostDirectory(a.path),
  rename: (a: { from: string; to: string }) => renameHostEntry(a.from, a.to),
  remove: (a: { path: string }) => removeHostEntry(a.path),
} as const;

export type HostFileOp = keyof typeof HOST_FILE_OPS;
export type HostFileArgs<K extends HostFileOp> = Parameters<(typeof HOST_FILE_OPS)[K]>[0];
export type HostFileResult<K extends HostFileOp> = Awaited<ReturnType<(typeof HOST_FILE_OPS)[K]>>;
