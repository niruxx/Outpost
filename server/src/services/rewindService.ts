import { rewindDir, acquireBackupStorage, fileUndoPath } from './backupStorageService.js';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from '../utils/asyncHandler.js';
import { instanceDir } from '../utils/paths.js';
import { logger } from '../utils/logger.js';
import { getServer, listServers, setRewindConfig } from './serverService.js';
import { isRunning, sendCommand } from './processManager.js';
import { appendLine, onLine } from './consoleLogService.js';
import { readServerProperties } from './propertiesService.js';
import { isMinecraftPlatform, type ServerRecord } from '../types/index.js';

/**
 * World Rewind — restore points for Minecraft worlds.
 *
 * Minecraft's autosave overwrites the world in place, so there's nothing to roll back to unless
 * copies are kept. While an instance runs, Outpost takes a world-only restore point on a schedule:
 * it pauses saving the way each edition supports (Java: save-off + save-all flush; Bedrock: save
 * hold + save query, copying exactly the file lengths the server reports), copies the world, and
 * resumes. Files that didn't change since the previous point are hard-linked to it, so a point
 * only costs what changed. Restoring always copies files back (never links), so later saves can't
 * alter a stored point.
 */

export interface RewindConfig {
  enabled: boolean;
  intervalMinutes: number;
  keep: number;
}

export interface RestorePoint {
  id: string;
  createdAt: string;
  reason: 'auto' | 'manual' | 'before-restore';
  worlds: string[];
  newBytes: number;
  totalBytes: number;
  fileCount: number;
}

interface Manifest extends RestorePoint {
  /** Live file stats when copied — unchanged files are linked into the next point. */
  files: Record<string, { size: number; mtimeMs: number }>;
}

const DEFAULTS: RewindConfig = { enabled: false, intervalMinutes: 30, keep: 24 };
export const INTERVALS = [10, 15, 30, 60, 120, 360];
const SKIP = new Set(['session.lock']);

export function rewindConfigOf(server: ServerRecord): RewindConfig {
  try {
    const raw = server.rewind_config ? (JSON.parse(server.rewind_config) as Partial<RewindConfig>) : {};
    return {
      enabled: raw.enabled === true,
      intervalMinutes: INTERVALS.includes(Number(raw.intervalMinutes)) ? Number(raw.intervalMinutes) : DEFAULTS.intervalMinutes,
      keep: Math.min(200, Math.max(1, Number(raw.keep) || DEFAULTS.keep)),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function requireMinecraft(server: ServerRecord) {
  if (!isMinecraftPlatform(server.platform)) throw new HttpError(400, 'World Rewind is for Minecraft Java and Bedrock instances');
}

function levelName(server: ServerRecord): string {
  const fallback = server.platform === 'bedrock' ? 'Bedrock level' : 'world';
  return readServerProperties(server.id, server.platform).find((p) => p.key === 'level-name')?.value.trim() || fallback;
}

/** World folders relative to the instance: Java keeps the Nether/End separately on Bukkit-family servers. */
export function worldDirs(server: ServerRecord): string[] {
  const level = levelName(server);
  // Always "/" — these names are shown in the UI and stored in restore points, on any host OS.
  const candidates = server.platform === 'bedrock' ? [`worlds/${level}`] : [level, `${level}_nether`, `${level}_the_end`];
  return candidates.filter((d) => fs.existsSync(path.join(instanceDir(server.id), d, server.platform === 'bedrock' ? 'level.dat' : '')));
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

function readManifest(dir: string): Manifest | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Manifest;
  } catch {
    return null;
  }
}

function manifests(server: ServerRecord): Manifest[] {
  const root = rewindDir(server.id);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .map((name) => readManifest(path.join(root, name)))
    .filter((m): m is Manifest => !!m)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function listPoints(server: ServerRecord): RestorePoint[] {
  return manifests(server).map(({ files: _files, ...rest }) => rest);
}

// ---------------------------------------------------------------------------
// Taking a point
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits for a console line matching `re`; resolves with that line and the next one. */
function waitForLine(serverId: string, re: RegExp, timeoutMs: number): { promise: Promise<{ line: string; next: Promise<string | null> }>; cancel: () => void } {
  let stop = () => {};
  const promise = new Promise<{ line: string; next: Promise<string | null> }>((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error('timed out waiting for the server'));
    }, timeoutMs);
    stop = onLine(serverId, (line, stream) => {
      if (stream === 'system' || !re.test(line)) return;
      clearTimeout(timer);
      stop();
      // Bedrock prints the file list on the line after "Data saved…".
      const next = new Promise<string | null>((res) => {
        const t = setTimeout(() => {
          off();
          res(null);
        }, 3000);
        const off = onLine(serverId, (l, s) => {
          if (s === 'system') return;
          clearTimeout(t);
          off();
          res(l);
        });
      });
      resolve({ line, next });
    });
  });
  return { promise, cancel: () => stop() };
}

/** Pauses world saving and returns the file lengths to copy (Bedrock), or null (Java / stopped). */
async function quiesce(server: ServerRecord): Promise<Map<string, number> | null> {
  if (!isRunning(server.id)) return null;
  if (server.platform === 'java') {
    sendCommand(server.id, 'save-off');
    const wait = waitForLine(server.id, /Saved the (game|world)/i, 120_000);
    sendCommand(server.id, 'save-all flush');
    await wait.promise;
    return null;
  }
  // Bedrock: hold, then poll until the server says the files are ready.
  sendCommand(server.id, 'save hold');
  for (let attempt = 0; attempt < 30; attempt++) {
    await sleep(1000);
    const wait = waitForLine(server.id, /Data saved\. Files are now ready to be copied|A previous save has not been completed/i, 5000);
    sendCommand(server.id, 'save query');
    let hit: { line: string; next: Promise<string | null> };
    try {
      hit = await wait.promise;
    } catch {
      continue;
    }
    if (/previous save has not been completed/i.test(hit.line)) continue;
    const rest = hit.line.split(/copied\.?/i)[1]?.trim();
    const list = rest && rest.includes(':') ? rest : await hit.next;
    const lengths = new Map<string, number>();
    for (const part of (list ?? '').split(',')) {
      const m = part.trim().match(/^(.*):(\d+)$/);
      if (m) lengths.set(m[1].replace(/\\/g, '/'), Number(m[2]));
    }
    return lengths;
  }
  throw new Error('Bedrock didn’t finish saving in time');
}

function resume(server: ServerRecord) {
  if (!isRunning(server.id)) return;
  try {
    sendCommand(server.id, server.platform === 'java' ? 'save-on' : 'save resume');
  } catch {
    // stopped meanwhile
  }
}

function walk(dir: string, base: string, out: string[]) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else if (e.isFile() && !SKIP.has(e.name)) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
}

const busy = new Set<string>();

/**
 * Takes a restore point. Returns null when nothing changed since the last one (automatic points
 * only — a manual one is always kept).
 */
export async function createPoint(server: ServerRecord, reason: RestorePoint['reason']): Promise<RestorePoint | null> {
  const release = acquireBackupStorage(server.id);
  try {
    requireMinecraft(server);
    if (busy.has(server.id)) throw new HttpError(409, 'A restore point is already being taken');
    const worlds = worldDirs(server);
    if (!worlds.length) throw new HttpError(409, 'No world yet — start the server once so it generates one');
    const live = instanceDir(server.id);
    const id = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(rewindDir(server.id), id);
    const prev = manifests(server)[0] ?? null;
    const prevDir = prev ? path.join(rewindDir(server.id), prev.id) : null;
    let lengths: Map<string, number> | null = null;
    busy.add(server.id);
    try {
      lengths = await quiesce(server);
      const files: Manifest['files'] = {};
      let newBytes = 0;
      let totalBytes = 0;
      let changed = !prev || prev.worlds.join() !== worlds.join();
      for (const world of worlds) {
        const rels: string[] = [];
        walk(path.join(live, world), live, rels);
        for (const rel of rels) {
          const src = path.join(live, rel);
          const target = path.join(dest, rel);
          const st = fs.statSync(src);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          // Bedrock: copy only what the server says is valid (it may be writing past it).
          const bedrockKey = rel.replace(/^worlds\//, '');
          const limit = lengths?.get(bedrockKey);
          const size = limit ?? st.size;
          const before = prev?.files[rel];
          let linked = false;
          if (before && prevDir && before.size === size && before.mtimeMs === st.mtimeMs) {
            try {
              fs.linkSync(path.join(prevDir, rel), target);
              linked = true;
            } catch {
              // different filesystem or no hard links — copy instead
            }
          }
          if (!linked) {
            fs.copyFileSync(src, target);
            if (limit !== undefined && limit < st.size) fs.truncateSync(target, limit);
            newBytes += size;
            changed = true;
          }
          totalBytes += size;
          files[rel] = { size, mtimeMs: st.mtimeMs };
        }
      }
      if (prev && Object.keys(prev.files).length !== Object.keys(files).length) changed = true;
      if (!changed && reason === 'auto') {
        fs.rmSync(dest, { recursive: true, force: true });
        return null;
      }
      const manifest: Manifest = { id, createdAt: new Date().toISOString(), reason, worlds, newBytes, totalBytes, fileCount: Object.keys(files).length, files };
      fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(manifest));
      appendLine(server.id, `[Outpost] World Rewind: restore point taken (${(newBytes / 1048576).toFixed(1)} MB new, ${worlds.join(', ')})`, 'system');
      prune(server);
      const { files: _f, ...point } = manifest;
      return point;
    } catch (err) {
      fs.rmSync(dest, { recursive: true, force: true });
      appendLine(server.id, `[Outpost] World Rewind: couldn’t take a restore point — ${err instanceof Error ? err.message : String(err)}`, 'system');
      throw err instanceof HttpError ? err : new HttpError(500, err instanceof Error ? err.message : String(err));
    } finally {
      resume(server);
      busy.delete(server.id);
    }
  } finally { release(); }
}

/** Keeps the newest `keep` automatic points; manual and pre-restore points stay until deleted. */
function prune(server: ServerRecord) {
  const { keep } = rewindConfigOf(server);
  const autos = manifests(server).filter((m) => m.reason === 'auto');
  for (const m of autos.slice(keep)) fs.rmSync(path.join(rewindDir(server.id), m.id), { recursive: true, force: true });
}

export function deletePoint(server: ServerRecord, pointId: string) {
  requireMinecraft(server);
  if (!/^[\w-]+$/.test(pointId) || !fs.existsSync(path.join(rewindDir(server.id), pointId, 'manifest.json'))) throw new HttpError(404, 'No such restore point');
  fs.rmSync(path.join(rewindDir(server.id), pointId), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Restoring
// ---------------------------------------------------------------------------

export async function restorePoint(server: ServerRecord, pointId: string, only?: string[]): Promise<{ restored: string[]; safetyPoint: string | null }> {
  const release = acquireBackupStorage(server.id);
  try {
    requireMinecraft(server);
    if (isRunning(server.id)) throw new HttpError(409, 'Stop the server before restoring — it would overwrite the world again on its next save');
    const dir = path.join(rewindDir(server.id), pointId);
    const manifest = /^[\w-]+$/.test(pointId) ? readManifest(dir) : null;
    if (!manifest) throw new HttpError(404, 'No such restore point');
    const worlds = only?.length ? manifest.worlds.filter((w) => only.includes(w)) : manifest.worlds;
    if (!worlds.length) throw new HttpError(400, 'Pick at least one world to restore');

    // Keep what's there now, so the restore itself can be undone.
    let safety: RestorePoint | null = null;
    if (worldDirs(server).length) safety = await createPoint(server, 'before-restore').catch(() => null);

    const live = instanceDir(server.id);
    for (const world of worlds) {
      const target = path.join(live, world);
      if (!path.resolve(target).startsWith(path.resolve(live) + path.sep)) continue;
      fs.rmSync(target, { recursive: true, force: true });
      // A real copy — linking would let the next save change the stored point.
      fs.cpSync(path.join(dir, world), target, { recursive: true });
    }
    appendLine(server.id, `[Outpost] World Rewind: restored ${worlds.join(', ')} to ${manifest.createdAt}`, 'system');
    return { restored: worlds, safetyPoint: safety?.id ?? null };
  } finally { release(); }
}

/** level.dat / level.dat_old for each world — Minecraft keeps the previous level.dat on every save. */
export function levelDatInfo(server: ServerRecord) {
  const live = instanceDir(server.id);
  return worldDirs(server)
    .map((world) => {
      const cur = path.join(live, world, 'level.dat');
      const old = path.join(live, world, 'level.dat_old');
      if (!fs.existsSync(cur) && !fs.existsSync(old)) return null;
      const mtime = (p: string) => (fs.existsSync(p) ? fs.statSync(p).mtime.toISOString() : null);
      return { world, current: mtime(cur), previous: mtime(old) };
    })
    .filter((x): x is { world: string; current: string | null; previous: string | null } => !!x);
}

export function restoreLevelDat(server: ServerRecord, world: string) {
  requireMinecraft(server);
  if (isRunning(server.id)) throw new HttpError(409, 'Stop the server first');
  if (!worldDirs(server).includes(world)) throw new HttpError(404, 'No such world');
  const base = path.join(instanceDir(server.id), world);
  const old = path.join(base, 'level.dat_old');
  if (!fs.existsSync(old)) throw new HttpError(404, 'This world has no level.dat_old');
  if (fs.existsSync(path.join(base, 'level.dat'))) {
    const safety = fileUndoPath(server.id, `world-rewind/${world}/level.dat.before-restore-${Date.now()}`);
    fs.mkdirSync(path.dirname(safety), { recursive: true });
    fs.copyFileSync(path.join(base, 'level.dat'), safety);
  }
  fs.copyFileSync(old, path.join(base, 'level.dat'));
  appendLine(server.id, `[Outpost] World Rewind: ${world}/level.dat restored from level.dat_old (the replaced file was kept in backup storage under file-undo/world-rewind)`, 'system');
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

const timers = new Map<string, NodeJS.Timeout>();

function schedule(serverId: string) {
  clearInterval(timers.get(serverId));
  timers.delete(serverId);
  const server = getServer(serverId);
  if (!server || !isMinecraftPlatform(server.platform)) return;
  const cfg = rewindConfigOf(server);
  if (!cfg.enabled) return;
  const t = setInterval(() => {
    const current = getServer(serverId);
    if (!current) {
      clearInterval(t);
      timers.delete(serverId);
      return;
    }
    // Only while running: a stopped world doesn't change.
    if (!isRunning(serverId) || current.status !== 'running') return;
    createPoint(current, 'auto').catch((err) => logger.warn(`World Rewind failed for ${serverId}: ${err instanceof Error ? err.message : String(err)}`));
  }, cfg.intervalMinutes * 60_000);
  t.unref();
  timers.set(serverId, t);
}

export function saveRewindConfig(server: ServerRecord, body: unknown): RewindConfig {
  requireMinecraft(server);
  const b = (body ?? {}) as Record<string, unknown>;
  if (b.intervalMinutes !== undefined && !INTERVALS.includes(Number(b.intervalMinutes))) throw new HttpError(400, `Interval must be one of ${INTERVALS.join(', ')} minutes`);
  const cfg: RewindConfig = {
    enabled: b.enabled === true,
    intervalMinutes: Number(b.intervalMinutes ?? DEFAULTS.intervalMinutes),
    keep: Math.min(200, Math.max(1, Math.round(Number(b.keep ?? DEFAULTS.keep)) || DEFAULTS.keep)),
  };
  setRewindConfig(server.id, JSON.stringify(cfg));
  schedule(server.id);
  prune(getServer(server.id)!);
  return cfg;
}

export function initRewind() {
  for (const s of listServers()) if (isMinecraftPlatform(s.platform) && rewindConfigOf(s).enabled) schedule(s.id);
}
