import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError } from '../utils/asyncHandler.js';
import { CORE_KEEPER_DATA, coreKeeperData, isCoreKeeper } from './coreKeeper.js';
import { createBackup, holdCoreKeeperBackup } from './backupService.js';
import { confined, recycleBatch, revision } from './fileWorkspaceService.js';
import { getServer } from './serverService.js';
import { isRunning } from './processManager.js';
import { assertAddonStopped } from './installedAddonService.js';
import { assertAddonIdle } from './addonOperationService.js';
import { assertDiskRoom } from './limitsService.js';
import type { ServerRecord } from '../types/index.js';

const worldFiles = {
  generation: ['worldgenparams', '.json'],
  info: ['worldinfos', '.worldinfo'],
  map: ['servermaps', '.mapparts.gzip'],
  world: ['worlds', '.world.gzip'],
} as const;
type WorldFile = keyof typeof worldFiles;
const kinds = Object.keys(worldFiles) as WorldFile[];
const configPath = `${CORE_KEEPER_DATA}/ServerConfig.json`;
const maxJsonBytes = 1024 * 1024;

export function coreKeeperWorldServer(id: string) {
  const server = getServer(id);
  if (!server || !isCoreKeeper(server)) throw new HttpError(404, 'Core Keeper instance not found.');
  coreKeeperData(server);
  return server;
}

export function coreKeeperWorldSlot(value: unknown) {
  if (!/^(?:[0-9]|[12][0-9])$/.test(String(value))) throw new HttpError(400, 'Choose a world slot from 0 to 29.');
  return Number(value);
}

function relative(slot: number, kind: WorldFile, backup = false) {
  const [dir, ext] = worldFiles[kind];
  return `${CORE_KEEPER_DATA}/${dir}/${slot}${ext}${backup ? '.pugbackup' : ''}`;
}

function fileAt(server: ServerRecord, name: string) {
  const file = confined(server.id, name);
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (stat && !stat.isFile()) throw new HttpError(409, 'Core Keeper world files must be regular instance files.');
  return { file, stat };
}

function jsonAt(file: string) {
  const stat = fs.statSync(file);
  if (stat.size > maxJsonBytes) throw new HttpError(413, 'Core Keeper JSON file is too large.');
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>;
  } catch { /* Report the same error for invalid JSON and unexpected roots. */ }
  throw new HttpError(400, 'Expected a Core Keeper JSON object.');
}

function worldConfig(server: ServerRecord) {
  const { file, stat } = fileAt(server, configPath);
  if (!stat) return { file, data: null, slot: 0 };
  const data = jsonAt(file);
  const slot = coreKeeperWorldSlot(data.world ?? 0);
  return { file, data, slot };
}

function slotFiles(server: ServerRecord, slot: number) {
  return kinds.flatMap((kind) => [false, true].map((backup) => {
    const name = relative(slot, kind, backup);
    return { kind, backup, name, ...fileAt(server, name) };
  })).filter((entry) => entry.stat);
}

export function viewCoreKeeperWorlds(server: ServerRecord) {
  const config = worldConfig(server);
  const slots = Array.from({ length: 30 }, (_, slot) => {
    const entries = slotFiles(server, slot);
    const world = entries.find(({ kind, backup }) => kind === 'world' && !backup);
    const info = entries.find(({ kind, backup }) => kind === 'info' && !backup);
    let name: string | null = null;
    if (info) {
      try {
        const data = jsonAt(info.file);
        if (typeof data.name === 'string') name = data.name.slice(0, 120);
        else if (typeof data.worldName === 'string') name = data.worldName.slice(0, 120);
      } catch { /* A damaged companion file should not hide the world download. */ }
    }
    return {
      slot, name, hasWorld: !!world, occupied: !!entries.length, bytes: world?.stat?.size ?? 0,
      files: entries.filter(({ backup }) => !backup).map(({ kind }) => kind),
      stamps: entries.map(({ name, stat }) => [name, stat?.size, stat?.mtimeMs, stat?.ctimeMs, stat?.ino]),
    };
  });
  return {
    active: config.slot,
    initialized: !!config.data,
    revision: revision(JSON.stringify([config.data, slots.map(({ stamps }) => stamps)])),
    slots: slots.map(({ stamps: _stamps, ...slot }) => slot),
  };
}

export function coreKeeperWorldDownload(server: ServerRecord, slot: number, kind: string) {
  if (!Object.hasOwn(worldFiles, kind)) throw new HttpError(404, 'World file not found.');
  assertWorldStopped(server);
  const { file, stat } = fileAt(server, relative(slot, kind as WorldFile));
  if (!stat) throw new HttpError(404, 'World file not found.');
  return file;
}

function assertWorldStopped(server: ServerRecord) {
  if (isRunning(server.id) || !['stopped', 'crashed'].includes(server.status)) {
    throw new HttpError(409, 'Stop Core Keeper and wait for it to finish saving.');
  }
}

function replaceConfig(file: string, data: Record<string, unknown>) {
  const config = JSON.stringify(data, (_name, value) => {
    if (typeof value === 'number' && (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new HttpError(409, 'ServerConfig.json contains a number that Outpost cannot preserve exactly.');
    }
    return value;
  }, 2);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, config + '\n', { flag: 'wx', mode: fs.statSync(file).mode & 0o777 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

type Uploads = Partial<Record<WorldFile, Express.Multer.File[]>>;

function checkImport(slot: number, uploads: Uploads) {
  const world = uploads.world?.[0];
  const source = world && /^(\d+)\.world\.gzip$/i.exec(world.originalname);
  if (!world || !source || world.size < 16) throw new HttpError(400, 'Choose a numbered Core Keeper .world.gzip save.');
  return kinds.flatMap((kind) => {
    const file = uploads[kind]?.[0];
    if (!file) return [];
    if (file.originalname.toLowerCase() !== source[1] + worldFiles[kind][1] || !file.size) {
      throw new HttpError(400, 'Companion files must use the same source slot number as the world.');
    }
    if (kind === 'info' && Number(source[1]) !== slot) throw new HttpError(400, 'World info is tied to its original slot. Omit it or import into that slot.');
    if (kind === 'info' && file.size > maxJsonBytes) throw new HttpError(413, 'Core Keeper world info is too large.');
    if (kind === 'generation') jsonAt(file.path);
    return [{ kind, file: file.path }];
  });
}

function publishImport(server: ServerRecord, slot: number, entries: ReturnType<typeof checkImport>) {
  const staged = entries.map(({ kind, file }) => {
    const target = fileAt(server, relative(slot, kind)).file;
    return { file, target, stage: `${target}.${randomUUID()}.tmp` };
  });
  const published: string[] = [];
  try {
    for (const { file, target, stage } of staged) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(file, stage, fs.constants.COPYFILE_EXCL);
    }
    // Publish the world last. A partial upload must never look like a ready-to-load world.
    for (const { target, stage } of staged) {
      fs.linkSync(stage, target);
      published.push(target);
    }
  } catch (err) {
    for (const target of published.reverse()) fs.rmSync(target, { force: true });
    throw err;
  } finally {
    for (const { stage } of staged) fs.rmSync(stage, { force: true });
  }
}

export async function changeCoreKeeperWorld(
  id: string, slot: number, action: 'select' | 'remove' | 'import', expected: unknown,
  authorize: () => void, uploads: Uploads = {},
) {
  const entries = action === 'import' ? checkImport(slot, uploads) : [];
  function check() {
    authorize();
    const server = coreKeeperWorldServer(id);
    assertWorldStopped(server);
    assertAddonIdle(id);
    assertAddonStopped(id);
    assertDiskRoom(id, 'write');
    const view = viewCoreKeeperWorlds(server);
    if (view.revision !== expected) throw new HttpError(409, 'World files changed. Refresh the world list and try again.');
    const selected = view.slots[slot];
    if (action === 'select' && !view.initialized) throw new HttpError(409, 'Start and stop Core Keeper once to generate ServerConfig.json.');
    if ((action === 'import' || action === 'select' && !selected.hasWorld) && selected.occupied) {
      throw new HttpError(409, 'This slot contains existing files. Choose an empty slot or remove its old files first.');
    }
    if (action === 'remove' && (!selected.occupied || slot === view.active)) throw new HttpError(409, 'Switch to a different world slot before removing this one.');
    return { server, view };
  }
  const before = check();
  if (action === 'select' && before.view.active === slot) return { ...before.view, backup: null };
  const backup = await createBackup(id, `before-core-keeper-world-${action}`);
  // Recheck permissions and disk state after the asynchronous backup. No yield occurs between the
  // second check and the file changes once the backup/launch fence is held.
  const release = await holdCoreKeeperBackup(id);
  try {
    // The already-held backup fence is expected. The action, status and revision still need to match.
    authorize();
    const server = coreKeeperWorldServer(id);
    assertWorldStopped(server);
    assertAddonIdle(id);
    if (viewCoreKeeperWorlds(server).revision !== expected) throw new HttpError(409, 'World files changed during the backup. Refresh and try again.');
    if (action === 'select') {
      const config = worldConfig(server);
      replaceConfig(config.file, { ...config.data, world: slot });
    } else if (action === 'remove') {
      recycleBatch(id, slotFiles(server, slot).map(({ name }) => name));
    } else {
      publishImport(server, slot, entries);
    }
    return { ...viewCoreKeeperWorlds(server), backup: backup.fileName };
  } finally { release?.(); }
}
