import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DATA_DIR, instanceDir, safeJoinReal } from '../utils/paths.js';
import { HttpError } from '../utils/asyncHandler.js';
import { scanIngestedPath } from './antivirusService.js';
import { snapshotFile, type FileSnapshot } from './fileChangeService.js';

export const CHUNK_SIZE = 1024 * 1024;
const root = path.join(DATA_DIR, 'file-workspace');
const digest = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
export const revision = (content: string) => digest(content);
export function confined(server: string, relative: string, allowRoot = false): string {
  if (typeof relative !== 'string' || relative.length > 2048 || /[\x00-\x1f:]/.test(relative) || /^[\\/]/.test(relative)) throw new HttpError(400, 'Invalid relative path');
  const parts = relative.replace(/\\/g, '/').split('/');
  if (parts.some(p => p === '..' || p === '.' || /[. ]$/.test(p)) || (!allowRoot && !relative)) throw new HttpError(400, 'Invalid relative path');
  const base = instanceDir(server);
  let current = base;
  for (const part of parts.filter(Boolean)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new HttpError(400, 'Symbolic links are not supported by this operation');
  }
  try { return safeJoinReal(base, relative); } catch { throw new HttpError(400, 'Path escapes the instance'); }
}
function privateDir(kind: string, server: string) {
  if (!/^[\w-]+$/.test(server)) throw new HttpError(400, 'Invalid instance');
  const dir = path.join(root, kind, server); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir;
}
function metadataFile(kind: string, server: string, id: string) {
  if (!/^[\da-f-]{36}$/.test(id)) throw new HttpError(400, 'Invalid item ID');
  return path.join(privateDir(kind, server), `${id}.json`);
}
function save(kind: string, server: string, item: { id: string }) {
  const target = metadataFile(kind, server, item.id); const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(item), { mode: 0o600 }); fs.renameSync(tmp, target);
}
function rows<T extends { expires: number; id: string }>(kind: string, server: string): T[] {
  const dir = privateDir(kind, server); const result: T[] = [];
  for (const name of fs.readdirSync(dir).filter(n => /^[\da-f-]{36}\.json$/.test(n))) {
    try { const item = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as T;
      if (item.expires < Date.now() && !busy.has(item.id)) { fs.rmSync(path.join(dir, item.id), { recursive: true, force: true }); fs.unlinkSync(path.join(dir, name)); }
      else result.push(item);
    } catch { /* Leave damaged metadata for administrator inspection. */ }
  }
  return result;
}
const busy = new Set<string>();
export interface Recycled { id: string; path: string; deletedAt: number; expires: number; directory: boolean; }
export function recycle(server: string, relative: string): Recycled {
  // Check the parent but move a leaf link itself, never the link's destination.
  const normalized = relative.replace(/\\/g, '/');
  if (!normalized || normalized.endsWith('/') || /[\x00-\x1f:]/.test(normalized) || normalized.startsWith('/') || normalized.split('/').some(p => p === '.' || p === '..' || /[. ]$/.test(p))) throw new HttpError(400, 'Invalid recycle path');
  const parent = path.posix.dirname(normalized);
  const target = path.join(confined(server, parent === '.' ? '' : parent, true), path.posix.basename(normalized));
  if (!fs.existsSync(target) && !fs.lstatSync(target, { throwIfNoEntry: false })) throw new HttpError(404, 'File not found');
  const id = randomUUID(); const dir = path.join(privateDir('trash', server), id); fs.mkdirSync(dir, { mode: 0o700 });
  const item = { id, path: normalized, deletedAt: Date.now(), expires: Date.now() + 30 * 86400000, directory: fs.lstatSync(target).isDirectory() };
  save('trash', server, item);
  try { fs.renameSync(target, path.join(dir, 'payload')); } catch (err) { fs.rmSync(dir, { recursive: true, force: true }); fs.unlinkSync(metadataFile('trash', server, id)); throw err; }
  return item;
}
export const trash = (server: string) => rows<Recycled>('trash', server);
export async function restore(server: string, id: string, authorize: () => void) {
  if (busy.has(id)) throw new HttpError(409, 'Item is busy');
  const item = trash(server).find(i => i.id === id); if (!item) throw new HttpError(404, 'Recycle item not found');
  busy.add(id);
  try {
    const source = path.join(privateDir('trash', server), id, 'payload');
    let visited = 0;
    const checkLinks = (target: string) => {
      if (++visited > 100000) throw new HttpError(413, 'Restore tree exceeds 100,000 entries; restore administratively');
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new HttpError(400, 'Restore refuses symbolic links and special files');
      if (stat.isDirectory()) for (const name of fs.readdirSync(target)) checkLinks(path.join(target, name));
    };
    checkLinks(source);
    await scanIngestedPath(source, item.directory); authorize();
    const target = confined(server, item.path);
    if (fs.existsSync(target)) throw new HttpError(409, 'Destination exists. Rename or move it before restoring.');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(source, target); fs.unlinkSync(metadataFile('trash', server, id)); fs.rmdirSync(path.dirname(source));
  } finally { busy.delete(id); }
}
export function purge(server: string, id: string) {
  if (busy.has(id)) throw new HttpError(409, 'Item is busy');
  if (!trash(server).some(i => i.id === id)) throw new HttpError(404, 'Recycle item not found');
  fs.rmSync(path.join(privateDir('trash', server), id), { recursive: true, force: true }); fs.unlinkSync(metadataFile('trash', server, id));
}
export function searchFiles(server: string, query: string, name: string, extension: string) {
  if (query.length > 200 || name.length > 200 || extension.length > 30 || (!query && !name && !extension)) throw new HttpError(400, 'Enter a search term or filename/type filter');
  const matches: { path: string; line?: number; preview?: string; size: number }[] = [];
  let visited = 0, bytes = 0, truncated = false;
  const started = Date.now();
  function walk(relative: string) {
    if (truncated) return;
    for (const entry of fs.readdirSync(confined(server, relative, true), { withFileTypes: true })) {
      if (++visited > 10000 || bytes > 32 * 1024 * 1024 || matches.length >= 200 || Date.now() - started > 1500) { truncated = true; break; }
      if (entry.isSymbolicLink()) continue;
      const p = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { walk(p); continue; }
      if (!entry.isFile() || (name && !entry.name.toLowerCase().includes(name.toLowerCase())) || (extension && path.extname(entry.name).toLowerCase() !== `.${extension.replace(/^\./, '').toLowerCase()}`)) continue;
      try {
        const target = confined(server, p); const stat = fs.statSync(target);
        if (!query) { matches.push({ path: p, size: stat.size }); continue; }
        if (stat.size > 1024 * 1024) continue;
        bytes += stat.size; const text = fs.readFileSync(target, 'utf8'); if (text.includes('\0')) continue;
        const lines = text.split('\n'); const line = lines.findIndex(l => l.toLowerCase().includes(query.toLowerCase()));
        if (line >= 0) matches.push({ path: p, size: stat.size, line: line + 1, preview: lines[line].slice(0, 240) });
      } catch { /* Skip unreadable files and concurrent deletion. */ }
    }
  }
  walk(''); return { matches, truncated, visited };
}
export interface Transfer { id: string; owner: string; path: string; size: number; offset: number; hashes: string[]; fingerprint: string; collision: 'skip' | 'rename' | 'replace'; state: string; expires: number; result?: string; }
export function transfers(server: string, owner: string) { return rows<Transfer>('uploads', server).filter(t => t.owner === owner); }
export function transfer(server: string, owner: string, id: string) {
  const item = transfers(server, owner).find(t => t.id === id); if (!item) throw new HttpError(404, 'Transfer not found'); return item;
}
export function createTransfer(server: string, owner: string, input: Partial<Transfer>) {
  confined(server, input.path!);
  if (!Number.isSafeInteger(input.size) || input.size! < 0 || input.size! > 1024 ** 3 || !Array.isArray(input.hashes) || input.hashes.length !== Math.ceil(input.size! / CHUNK_SIZE) || input.hashes.some(h => !/^[a-f0-9]{64}$/.test(h)) || !['skip', 'rename', 'replace'].includes(input.collision!)) throw new HttpError(400, 'Invalid upload manifest');
  const fingerprint = digest(JSON.stringify(input.hashes));
  const existing = transfers(server, owner);
  const same = existing.find(t => t.path === input.path && t.size === input.size && t.fingerprint === fingerprint && !['done', 'skipped'].includes(t.state));
  if (same) return same;
  const pending = existing.filter(t => !['done', 'skipped'].includes(t.state));
  if (pending.length >= 32 || pending.reduce((n, t) => n + t.size, 0) + input.size! > 10 * 1024 ** 3) throw new HttpError(429, 'Cancel pending transfers to free upload capacity');
  let reserved = 0;
  const uploadRoot = path.join(root, 'uploads');
  if (fs.existsSync(uploadRoot)) for (const entry of fs.readdirSync(uploadRoot, { withFileTypes: true })) if (entry.isDirectory() && /^[\w-]+$/.test(entry.name)) {
    for (const item of rows<Transfer>('uploads', entry.name)) if (item.state !== 'done') reserved += item.size;
  }
  if (reserved + input.size! > 30 * 1024 ** 3) throw new HttpError(429, 'Panel upload staging capacity reached; cancel pending transfers');
  const item: Transfer = { id: randomUUID(), owner, path: input.path!, size: input.size!, hashes: input.hashes, fingerprint, offset: 0, collision: input.collision!, state: 'paused', expires: Date.now() + 2 * 86400000 };
  const dir = path.join(privateDir('uploads', server), item.id); fs.mkdirSync(dir, { mode: 0o700 }); fs.writeFileSync(path.join(dir, 'payload'), '', { mode: 0o600 }); save('uploads', server, item); return item;
}

/** Cleanup is independent of whether anyone opens the instance file browser. */
export function cleanFileWorkspace() {
  for (const kind of ['trash', 'uploads']) {
    const dir = path.join(root, kind); if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory() && /^[\w-]+$/.test(entry.name)) rows(kind, entry.name);
  }
}
const cleanupTimer = setInterval(() => { try { cleanFileWorkspace(); } catch { /* Retry next hour if storage is unavailable. */ } }, 3600000);
cleanupTimer.unref();
export function appendChunk(server: string, owner: string, id: string, offset: number, chunk: Buffer) {
  const t = transfer(server, owner, id); if (busy.has(id) || ['done', 'skipped', 'publishing'].includes(t.state)) throw new HttpError(409, 'Transfer is already processing or complete');
  if (offset !== t.offset || chunk.length !== Math.min(CHUNK_SIZE, t.size - offset) || digest(chunk) !== t.hashes[offset / CHUNK_SIZE]) throw new HttpError(409, 'Chunk offset or checksum mismatch. Resume from server offset.');
  const payload = path.join(privateDir('uploads', server), id, 'payload'); const fd = fs.openSync(payload, 'r+');
  try { if (fs.fstatSync(fd).size < offset) throw new HttpError(409, 'Staging data missing; cancel and retry'); fs.ftruncateSync(fd, offset); fs.writeSync(fd, chunk, 0, chunk.length, offset); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  t.offset += chunk.length; t.state = 'paused'; t.expires = Date.now() + 2 * 86400000; save('uploads', server, t); return t;
}
export function cancelTransfer(server: string, owner: string, id: string) {
  transfer(server, owner, id); if (busy.has(id)) throw new HttpError(409, 'Transfer is processing; wait for its result');
  fs.rmSync(path.join(privateDir('uploads', server), id), { recursive: true, force: true }); fs.unlinkSync(metadataFile('uploads', server, id));
}
export async function finishTransfer(server: string, owner: string, id: string, authorize: () => void, onPublished?: (relative: string, before: FileSnapshot, after: FileSnapshot) => void) {
  const t = transfer(server, owner, id);
  if (['done', 'skipped'].includes(t.state)) return t;
  if (busy.has(id)) throw new HttpError(409, 'Transfer is processing');
  if (t.state === 'publishing') throw new HttpError(409, 'Publication was interrupted. Inspect the destination and recycle bin before cancelling this transfer.');
  if (t.offset !== t.size) throw new HttpError(409, 'Upload is incomplete');
  busy.add(id);
  const payload = path.join(privateDir('uploads', server), id, 'payload');
  let temp: string | undefined;
  try {
    await scanIngestedPath(payload); authorize();
    let target = confined(server, t.path); fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target) && t.collision === 'skip') { t.state = 'skipped'; save('uploads', server, t); return t; }
    if (t.collision === 'rename') {
      const original = target; const ext = path.extname(target); let n = 1;
      while (fs.existsSync(target)) { if (n > 10000) throw new HttpError(409, 'Too many duplicate names'); target = `${original.slice(0, original.length - ext.length)} (${n++})${ext}`; }
    }
    temp = path.join(path.dirname(target), `.outpost-upload-${id}`); fs.copyFileSync(payload, temp, fs.constants.COPYFILE_EXCL);
    const before = snapshotFile(target);
    t.state = 'publishing'; t.result = path.relative(instanceDir(server), target).split(path.sep).join('/'); save('uploads', server, t);
    if (t.collision === 'replace' && fs.existsSync(target)) {
      if (fs.statSync(target).isDirectory()) throw new HttpError(409, 'A file cannot replace a directory'); recycle(server, t.result);
    }
    // link provides atomic no-overwrite publication, including collision races.
    fs.linkSync(temp, target); fs.unlinkSync(temp); temp = undefined;
    t.state = 'done'; save('uploads', server, t); fs.unlinkSync(payload);
    onPublished?.(t.result, before, snapshotFile(target)); return t;
  } catch (error) {
    if (t.state !== 'publishing') { t.state = 'paused'; save('uploads', server, t); }
    throw error;
  } finally { if (temp) { try { fs.unlinkSync(temp); } catch {} } busy.delete(id); }
}
