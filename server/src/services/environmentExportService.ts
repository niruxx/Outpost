import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Worker } from 'node:worker_threads';
import { ZipArchive } from 'archiver';
import { HttpError } from '../utils/asyncHandler.js';
import { BACKUPS_DIR, DATA_DIR, DB_PATH, INSTANCES_DIR, REWIND_DIR, instanceDir } from '../utils/paths.js';
import { acquireBackupStorage, backupDir, backupStorageInfo, rewindDir } from './backupStorageService.js';
import { isCoreKeeper } from './coreKeeper.js';
import { isRunning } from './processManager.js';
import { listServers } from './serverService.js';
import { holdBackupOperation } from './verifiedBackupService.js';

const defaultOptions = {
  includeDatabase: true,
  includeFiles: true,
  includeSnapshots: true,
  includeRestorePoints: true,
  includeSupportFiles: true,
};
export type EnvironmentExportOptions = typeof defaultOptions & { instanceIds: string[] | null };

export function parseEnvironmentExportOptions(input: unknown): EnvironmentExportOptions {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Invalid environment export options.');
  const values = input as Record<string, unknown>;
  const flags = { ...defaultOptions };
  for (const key of Object.keys(flags) as (keyof typeof flags)[]) {
    if (!Object.hasOwn(values, key)) continue;
    const value = values[key];
    if (typeof value !== 'boolean') throw new HttpError(400, 'Export choices must be on or off.');
    flags[key] = value;
  }
  const ids = values.instanceIds ?? null;
  if (ids !== null && (!Array.isArray(ids) || ids.length > 4096 || ids.some((id) => typeof id !== 'string' || !/^[\w-]{1,80}$/.test(id)))) {
    throw new HttpError(400, 'Invalid instance selection.');
  }
  return { ...flags, instanceIds: ids === null ? null : [...new Set<string>(ids)] };
}

export function legacyEnvironmentExportOptions(includeHistory: boolean): EnvironmentExportOptions {
  return { ...defaultOptions, instanceIds: null, includeSnapshots: includeHistory, includeRestorePoints: includeHistory };
}

function planEnvironmentExport(options: EnvironmentExportOptions) {
  const all = listServers();
  const selected = options.instanceIds === null ? null : new Set(options.instanceIds);
  const chosen = selected ? all.filter(({ id }) => selected.has(id)) : all;
  const history = options.includeSnapshots || options.includeRestorePoints;
  const blockers: string[] = [];
  if (options.instanceIds && chosen.length !== options.instanceIds.length) blockers.push('An instance was removed. Refresh the instance selection.');
  if (!options.includeDatabase && !options.includeSupportFiles && (!(options.includeFiles || history) || options.instanceIds?.length === 0)) {
    blockers.push('Choose at least one kind of data to export.');
  }
  for (const server of chosen) {
    if (options.includeFiles && isCoreKeeper(server) && (!['stopped', 'crashed'].includes(server.status) || isRunning(server.id))) {
      blockers.push(`Stop ${server.name} and wait for Core Keeper to finish saving.`);
    }
    if (history) {
      const storage = backupStorageInfo(server.id);
      if (storage.changing) blockers.push(`${server.name}: backup storage is being moved.`);
      else if (!storage.available) blockers.push(`${server.name}: ${storage.error}`);
    }
  }
  return { chosen, all, blockers, history };
}

export function previewEnvironmentExport(options: EnvironmentExportOptions) {
  const { all, blockers } = planEnvironmentExport(options);
  return { blockers, instances: all.map(({ id, name }) => ({ id, name })) };
}

type ArchiveRoot = { file: string; name: string; omit?: (name: string) => boolean };
const dbFiles = /^(?:outpost|multicraft)\.db(?:-(?:wal|shm|journal))?$/i;
const panelKeys = ['session.secret', 'sftp_host_ed25519', 'sftp_host_ed25519.pub', 'tls'];
const scopedSupport = new Set(['file-workspace', 'console-logs', 'map-cache', 'fastdl', 'antivirus', 'billing-archives']);
const transient = new Set(['instance-supervisors', 'libvirt-tmp', 'pack-validation']);
const stored = /\.(?:zip|gz|gzip|7z|rar|jar|png|jpeg|jpg|webp|zst|xz|mp4|ogg)$/i;

function archiveRoots(options: EnvironmentExportOptions, plan: ReturnType<typeof planEnvironmentExport>): ArchiveRoot[] {
  const roots: ArchiveRoot[] = [];
  const custom = new Set(plan.all.flatMap((server) => {
    if (!server.backup_directory) return [];
    const relative = path.relative(DATA_DIR, path.join(server.backup_directory, server.id));
    return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
      ? [relative.split(path.sep).join('/')] : [];
  }));
  if (options.includeSupportFiles) {
    roots.push({ file: DATA_DIR, name: '', omit: (name) => {
      const top = name.split('/')[0].toLowerCase();
      return top === 'servers' || top === 'backups' || top === 'rewind' || top === 'outpost-export.json' || dbFiles.test(top) || transient.has(top) ||
        (!options.includeDatabase && (panelKeys.includes(top) || top === 'steam-accounts')) ||
        (options.instanceIds !== null && scopedSupport.has(top)) ||
        /^recovery-[\w-]+$/.test(top) || custom.has(name);
    } });
  }
  if (options.includeDatabase && !options.includeSupportFiles) {
    // Encrypted panel credentials are tied to this key when it lives in the data directory.
    for (const name of panelKeys) roots.push({ file: path.join(DATA_DIR, name), name });
  }
  if (options.includeFiles) {
    if (options.instanceIds === null) roots.push({ file: INSTANCES_DIR, name: 'servers' });
    else for (const { id } of plan.chosen) roots.push({ file: instanceDir(id), name: `servers/${id}` });
  }
  const registered = new Set(plan.all.map(({ id }) => id));
  for (const [enabled, name, local, active] of [
    [options.includeSnapshots, 'backups', BACKUPS_DIR, backupDir],
    [options.includeRestorePoints, 'rewind', REWIND_DIR, rewindDir],
  ] as const) {
    if (!enabled) continue;
    // Keep orphaned archives in a full export, and use only the active location of each known instance.
    if (options.instanceIds === null) roots.push({ file: local, name, omit: (entry) => registered.has(entry.split('/')[1]) });
    for (const { id } of plan.chosen) roots.push({ file: active(id), name: `${name}/${id}` });
  }
  return roots;
}

async function copyDatabase(target: string, options: EnvironmentExportOptions, signal: AbortSignal) {
  signal.throwIfAborted();
  const compiled = new URL('./environmentExportDatabase.worker.js', import.meta.url);
  const workerData = { source: DB_PATH, target, instanceIds: options.instanceIds, includeFiles: options.includeFiles, includeSnapshots: options.includeSnapshots };
  let worker: Worker;
  if (fs.existsSync(compiled)) {
    worker = new Worker(compiled, { workerData });
  } else {
    // Development uses tsx with no emitted worker file. Compile the small worker as CommonJS
    // so it also runs on the earliest supported Node 22 releases.
    const { transpileModule, ModuleKind } = await import('typescript');
    const source = await fsp.readFile(new URL('./environmentExportDatabase.worker.ts', import.meta.url), 'utf8');
    const { outputText } = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS } });
    signal.throwIfAborted();
    worker = new Worker(outputText, { eval: true, execArgv: [], workerData });
  }
  const exit = once(worker, 'exit');
  const cancel = () => { void worker.terminate().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const [code] = await exit;
    signal.throwIfAborted();
    if (code !== 0) throw new Error('Could not create the panel database snapshot.');
  } finally {
    signal.removeEventListener('abort', cancel);
    await worker.terminate();
  }
}

async function* entries(root: ArchiveRoot, signal: AbortSignal): AsyncGenerator<{ file: string; name: string; stat: fs.Stats }> {
  signal.throwIfAborted();
  if (root.omit?.(root.name)) return;
  const { file, name } = root;
  // A literal backslash cannot be represented safely as part of a ZIP path.
  if (name.includes('\\')) return;
  const stat = await fsp.lstat(file).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
    return null;
  });
  if (!stat || (!stat.isFile() && !stat.isDirectory())) return;
  if (name) yield { file, name, stat };
  if (!stat.isDirectory()) return;
  const dir = await fsp.opendir(file).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
    return null;
  });
  if (!dir) return;
  for await (const child of dir) {
    if (child.isSymbolicLink()) continue;
    yield* entries({ file: path.join(file, child.name), name: name ? `${name}/${child.name}` : child.name, omit: root.omit }, signal);
  }
}

async function writeZip(destination: Writable, roots: ArchiveRoot[], metadata: object, signal: AbortSignal) {
  const zip = new ZipArchive({ zlib: { level: 1 } });
  const cancelled = new AbortController();
  const active = AbortSignal.any([signal, cancelled.signal]);
  let current: fs.ReadStream | undefined;
  const done = pipeline(zip, destination, { signal: active });
  async function append(source: Buffer | fs.ReadStream, options: Parameters<ZipArchive['append']>[1]) {
    active.throwIfAborted();
    const entry = once(zip, 'entry', { signal: active });
    zip.append(source, options);
    await entry;
  }
  const produce = async () => {
    await append(Buffer.from(JSON.stringify(metadata, null, 2)), { name: 'outpost-export.json' });
    for (const root of roots) {
      for await (const { file, name, stat } of entries(root, active)) {
        if (stat.isDirectory()) {
          await append(Buffer.alloc(0), { name: name + '/', type: 'directory', mode: stat.mode, date: stat.mtime });
        } else {
          const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
          const handle = await fsp.open(file, flags).catch((err: NodeJS.ErrnoException) => {
            if (err.code !== 'ENOENT') throw err;
            return null;
          });
          if (!handle) continue;
          if (active.aborted) { await handle.close(); active.throwIfAborted(); }
          current = handle.createReadStream();
          current.on('error', (err) => zip.destroy(err));
          await append(current, { name, date: stat.mtime, mode: stat.mode, store: stored.test(name) });
          current = undefined;
        }
      }
    }
    await zip.finalize();
  };
  try { await Promise.all([done, produce()]); }
  finally {
    cancelled.abort();
    current?.destroy();
    zip.abort();
  }
}

export async function streamEnvironmentExport(
  options: EnvironmentExportOptions,
  destination: () => Writable,
  signal: AbortSignal,
  status?: (stage: string) => void,
) {
  signal.throwIfAborted();
  const plan = planEnvironmentExport(options);
  if (plan.blockers.length) throw new HttpError(409, plan.blockers.join(' '));
  const releases: (() => void)[] = [];
  let temp: string | undefined;
  try {
    if (options.includeFiles) {
      for (const server of plan.chosen.filter(isCoreKeeper)) releases.push(holdBackupOperation(server.id));
    }
    if (plan.history) for (const server of plan.chosen) releases.push(acquireBackupStorage(server.id));
    const roots = archiveRoots(options, plan);
    if (options.includeDatabase) {
      status?.('Taking a consistent snapshot of the panel database');
      temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'outpost-export-db-'));
      const target = path.join(temp, 'outpost.db');
      await copyDatabase(target, options, signal);
      roots.unshift({ file: target, name: 'outpost.db' });
    }
    signal.throwIfAborted();
    status?.('Streaming ZIP to the browser');
    await writeZip(destination(), roots, {
      version: 1, createdAt: new Date().toISOString(), ...options,
      selectedInstances: plan.chosen.map(({ id, name }) => ({ id, name })),
    }, signal);
  } finally {
    for (const release of releases.reverse()) release();
    if (temp) await fsp.rm(temp, { recursive: true, force: true, maxRetries: 3 });
  }
}
