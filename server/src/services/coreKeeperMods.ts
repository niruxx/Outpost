import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { instanceDir, safeJoin } from '../utils/paths.js';
import { HttpError } from '../utils/asyncHandler.js';
import { logger } from '../utils/logger.js';
import type { ServerRecord } from '../types/index.js';
import { text, type AddonMetadata } from './addonMetadataService.js';

export const CORE_KEEPER_MODS = 'CoreKeeperServer_Data/StreamingAssets/Mods';
const disabledMods = 'core-keeper-disabled-mods';
const manifestName = 'ModManifest.json';
const disabledSuffix = '.disabled';
const maxEntries = 10_000;
const maxBytes = 512 * 1024 * 1024;

function modPath(server: ServerRecord, relative: string) {
  let current = instanceDir(server.id);
  for (const part of relative.split('/')) {
    current = safeJoin(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat && !stat.isDirectory()) throw new HttpError(409, 'Core Keeper mods must use instance-local directories.');
  }
  return current;
}

function validComponent(name: string) {
  return !!name && !/^[. ]+$|[<>:"/\\|?*\x00-\x1f]|[. ]$|^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name);
}

function parseManifest(source: Buffer) {
  if (source.length > 1024 * 1024) throw new HttpError(400, 'Core Keeper mod manifest is too large.');
  try {
    const data = JSON.parse(source.toString('utf8').replace(/^\uFEFF/, ''));
    if (data && typeof data.name === 'string' && data.name.trim()) return data;
  } catch { /* Invalid JSON is reported below. */ }
  throw new HttpError(400, 'Core Keeper requires a valid ModManifest.json with a mod name.');
}

function readManifest(dir: string) {
  const file = path.join(dir, manifestName);
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size > 1024 * 1024) throw new HttpError(400, 'Missing or invalid ModManifest.json.');
  return parseManifest(fs.readFileSync(file));
}

function identity(value: unknown) {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/-/g, '').toLowerCase();
  return /^[a-f0-9]{32}$/.test(normalized) ? normalized : null;
}

export function inspectCoreKeeperMod(dir: string, metadata: AddonMetadata) {
  const data = readManifest(dir);
  const guid = identity(data.guid);
  metadata.name = text(data.displayName) || text(data.name) || null;
  metadata.version = text(data.version) || null;
  metadata.description = text(data.description, 4000);
  metadata.format = manifestName;
  if (guid) metadata.provides.push(`corekeeper:${guid}`);
  metadata.provides.push(`corekeeper-name:${text(data.name).trim().toLowerCase()}`);
  const dependencies = Array.isArray(data.dependencies) ? data.dependencies : [];
  for (const dependency of dependencies.slice(0, 128)) {
    const ref = typeof dependency === 'string' ? dependency : dependency?.guid;
    const id = identity(ref);
    const name = text(dependency?.modName).trim() || (!id ? text(ref).trim() : '');
    if (!id && !name) continue;
    metadata.dependencies.push({
      key: id ? `corekeeper:${id}` : `corekeeper-name:${name.toLowerCase()}`,
      name: name || text(dependency?.name) || id!,
      required: dependency?.required !== false && dependency?.required !== 0,
      constraint: '*', source: manifestName,
    });
  }
  metadata.complete = !!guid && Array.isArray(data.dependencies) && metadata.dependencies.length === dependencies.length;
  if (!metadata.complete) metadata.warnings.push('Check the mod’s download page for additional requirements.');
  return metadata;
}

export function coreKeeperModArtifact(server: ServerRecord, file: string) {
  const disabled = file.endsWith(disabledSuffix);
  const name = disabled ? file.slice(0, -disabledSuffix.length) : file;
  if (!validComponent(name) || name.toLowerCase().endsWith(disabledSuffix)) throw new HttpError(400, 'Invalid mod folder.');
  return modPath(server, `${disabled ? disabledMods : CORE_KEEPER_MODS}/${name}`);
}

export function listCoreKeeperMods(server: ServerRecord) {
  return [true, false].flatMap((enabled) => {
    const dir = modPath(server, enabled ? CORE_KEEPER_MODS : disabledMods);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
      if (!item.isDirectory() || !validComponent(item.name) || item.name.toLowerCase().endsWith(disabledSuffix)) return [];
      const folder = path.join(dir, item.name);
      if (!fs.lstatSync(path.join(folder, manifestName), { throwIfNoEntry: false })?.isFile()) return [];
      const fileName = enabled ? item.name : item.name + disabledSuffix;
      return [{
        fileName, displayName: item.name, enabled, canToggle: true,
        modifiedAt: fs.statSync(folder).mtime.toISOString(), detail: null,
        sizeBytes: modTree(folder).bytes,
      }];
    });
  }).sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function modTree(folder: string) {
  let bytes = 0;
  const files: string[] = [];
  const pending = [folder];
  for (let i = 0; i < pending.length; i++) {
    for (const entry of fs.readdirSync(pending[i], { withFileTypes: true })) {
      const full = path.join(pending[i], entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile()) {
        bytes += fs.statSync(full).size;
        files.push(full);
      } else throw new HttpError(409, 'A Core Keeper mod contains a link or special file.');
      if (pending.length + files.length > maxEntries || bytes > maxBytes) throw new HttpError(413, 'Core Keeper mod exceeds archive limits.');
    }
  }
  return { files, bytes };
}

export function setCoreKeeperModEnabled(server: ServerRecord, file: string, enabled: boolean) {
  const disabled = file.endsWith(disabledSuffix);
  if (enabled !== disabled) return;
  const source = coreKeeperModArtifact(server, file);
  const target = coreKeeperModArtifact(server, enabled ? file.slice(0, -disabledSuffix.length) : file + disabledSuffix);
  if (fs.existsSync(target)) throw new HttpError(409, 'A mod folder with this name already exists.');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(source, target);
}

function readPackages(buffer: Buffer, budget: { entries: number; bytes: number }) {
  let entries: AdmZip.IZipEntry[];
  try { entries = new AdmZip(buffer).getEntries(); }
  catch { throw new HttpError(400, 'Upload a valid Core Keeper mod ZIP.'); }
  budget.entries += entries.length;
  if (budget.entries > maxEntries) throw new HttpError(413, 'Core Keeper upload has too many files.');
  const seen = new Set<string>();
  const files = entries.flatMap((entry) => {
    const name = entry.entryName.replace(/\\/g, '/').replace(/\/$/, '');
    const key = name.toLowerCase();
    const type = (entry.attr >>> 16) & 0xf000;
    if (!name.split('/').every(validComponent) || seen.has(key) || (type && type !== (entry.isDirectory ? 0x4000 : 0x8000))) {
      throw new HttpError(400, 'Core Keeper ZIP contains an unsafe, duplicate or unsupported entry.');
    }
    seen.add(key);
    budget.bytes += entry.header.size;
    if (budget.bytes > maxBytes) throw new HttpError(413, 'Expanded Core Keeper upload exceeds 512 MB.');
    if (!entry.header.size && entry.header.compressedSize > 32) throw new HttpError(400, 'Core Keeper ZIP contains an invalid empty file.');
    return entry.isDirectory ? [] : [{ name, entry }];
  });
  const packages = files.filter(({ name }) => name.split('/').at(-1) === manifestName)
    .map(({ name, entry }) => {
      if (entry.header.size > 1024 * 1024) throw new HttpError(400, 'Core Keeper mod manifest is too large.');
      return { prefix: name.slice(0, -manifestName.length), manifest: parseManifest(readEntry(entry)), files };
    });
  if (packages.length > 128) throw new HttpError(413, 'A Core Keeper ZIP can contain at most 128 mods.');
  if (!packages.length || packages.some((mod) => packages.some((other) => mod !== other && other.prefix.toLowerCase().startsWith(mod.prefix.toLowerCase())))) {
    throw new HttpError(400, 'Upload a ZIP with one ModManifest.json per mod folder.');
  }
  return packages;
}

export function installCoreKeeperMods(server: ServerRecord, uploads: { originalname: string; buffer: Buffer }[], replace = false) {
  const budget = { entries: 0, bytes: 0 };
  const packages = uploads.flatMap(({ originalname, buffer }) => {
    if (!originalname.toLowerCase().endsWith('.zip')) throw new HttpError(400, 'Core Keeper mods must be uploaded as ZIP archives.');
    return readPackages(buffer, budget);
  });
  if (packages.length > 128) throw new HttpError(413, 'A Core Keeper upload can contain at most 128 mods.');
  const installed = listCoreKeeperMods(server).map(({ fileName }) => {
    const dir = coreKeeperModArtifact(server, fileName);
    try { return { fileName, guid: identity(readManifest(dir).guid) }; }
    catch { return { fileName, guid: null }; }
  });
  const used = new Set<string>();
  const staged = fs.mkdtempSync(path.join(instanceDir(server.id), '.core-keeper-mod-upload-'));
  const changes: { target: string; prior: string; replaced: boolean; placed: boolean }[] = [];
  let preserveStaging = false;
  try {
    const prepared = packages.map(({ prefix, manifest, files }, index) => {
      const guid = identity(manifest.guid);
      const slug = manifest.name.trim().replace(/[^a-z0-9_-]+/gi, '-').slice(0, 64);
      const name = guid ? `mod-${guid}` : `mod-${slug || 'unnamed'}`;
      const matches = installed.filter((row) => (guid && row.guid === guid) || row.fileName.replace(/\.disabled$/, '').toLowerCase() === name.toLowerCase());
      if (matches.length > 1 || (matches.length && !replace)) {
        throw new HttpError(409, `${manifest.name} is already installed. For a single installed copy, select Replace installed versions to update it.`);
      }
      const fileName = matches[0]?.fileName ?? name;
      const target = coreKeeperModArtifact(server, fileName);
      const targetKey = fileName.replace(/\.disabled$/, '').toLowerCase();
      if (used.has(targetKey) || (!matches.length && fs.existsSync(target))) throw new HttpError(409, 'Core Keeper mod folders conflict.');
      used.add(targetKey);
      const next = path.join(staged, `next-${index}`);
      fs.mkdirSync(next);
      for (const { name: entryName, entry } of files) {
        if (!entryName.startsWith(prefix)) continue;
        const dest = safeJoin(next, entryName.slice(prefix.length));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, readEntry(entry), { flag: 'wx' });
      }
      return { next, target, fileName, existing: !!matches.length };
    });
    for (const [index, mod] of prepared.entries()) {
      fs.mkdirSync(path.dirname(mod.target), { recursive: true });
      const change = { target: mod.target, prior: path.join(staged, `prior-${index}`), replaced: false, placed: false };
      changes.push(change);
      if (mod.existing) {
        fs.renameSync(mod.target, change.prior);
        change.replaced = true;
      }
      fs.renameSync(mod.next, mod.target);
      change.placed = true;
    }
    return prepared.map((mod) => mod.fileName);
  } catch (err) {
    for (const change of changes.reverse()) {
      try {
        if (change.placed) fs.rmSync(change.target, { recursive: true });
        if (change.replaced) fs.renameSync(change.prior, change.target);
      } catch { preserveStaging = true; }
    }
    if (preserveStaging) throw new HttpError(500, `Mod update could not be rolled back. Previous files are in ${path.basename(staged)}.`);
    throw err;
  } finally {
    if (!preserveStaging) {
      try { fs.rmSync(staged, { recursive: true, force: true, maxRetries: 3 }); }
      catch (err) { logger.warn(`Could not remove Core Keeper mod staging directory for ${server.id}`, err); }
    }
  }
}

function readEntry(entry: AdmZip.IZipEntry) {
  try { return entry.getData(); }
  catch { throw new HttpError(400, 'Core Keeper ZIP contains a corrupt or encrypted file.'); }
}

export function exportCoreKeeperMods(server: ServerRecord) {
  const zip = new AdmZip();
  const installed = listCoreKeeperMods(server).filter((mod) => mod.enabled);
  if (!installed.length) throw new HttpError(404, 'There are no enabled Core Keeper mods to download.');
  let files = 0, bytes = 0;
  for (const mod of installed) {
    const folder = coreKeeperModArtifact(server, mod.fileName);
    const tree = modTree(folder);
    files += tree.files.length;
    bytes += tree.bytes;
    if (files > maxEntries || bytes > maxBytes) throw new HttpError(413, 'The enabled mod set exceeds the download limits.');
    for (const file of tree.files) zip.addLocalFile(file, path.posix.join(mod.fileName, path.relative(folder, path.dirname(file)).split(path.sep).join('/')));
  }
  return zip.toBuffer();
}
