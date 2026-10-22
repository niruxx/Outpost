import fs from 'node:fs';
import { isModded } from './moddedService.js';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { instanceDir, safeJoinReal } from '../utils/paths.js';
import { extractZipSafely } from '../utils/zip.js';
import { downloadFile, type LogFn } from '../utils/download.js';
import { HttpError } from '../utils/asyncHandler.js';
import { readServerProperties } from './propertiesService.js';
import { findPresetFor } from './steamGames.js';
import { deleteGmodAddon, installGmodUpload, isGmod, listGmodAddons, setGmodAddonEnabled } from './gmodService.js';
import type { ServerRecord } from '../types/index.js';
import { isProxyLoader, PLUGIN_CAPABLE_LOADERS } from '../types/index.js';

/**
 * "Plugins" generalized across every instance type. Each kind of server extends itself a
 * different way, so each gets a profile describing where add-ons live and what files they are:
 *
 *   bukkit   — Paper/Purpur/Spigot plugin jars in /plugins (Modrinth catalog)
 *   datapack — Vanilla Java data packs in <world>/datapacks (Modrinth catalog)
 *   bedrock  — Bedrock behavior/resource packs, activated per world via world_*_packs.json
 *   bepinex  — Valheim BepInEx plugins in BepInEx/plugins
 *   pak      — Palworld .pak mods in Pal/Content/Paks/~mods
 */
export type AddonKind = 'bukkit' | 'datapack' | 'bedrock' | 'bepinex' | 'pak' | 'mod' | 'gmod';
export type AddonCatalog = 'plugin' | 'datapack' | 'bedrock' | `mod:${'fabric' | 'quilt' | 'forge' | 'neoforge'}` | `proxy:${'velocity' | 'bungee'}`;

export interface AddonProfile {
  kind: AddonKind;
  label: string; // "Plugins", "Data packs", …
  singular: string; // "plugin", "data pack", …
  folder: string; // where they live, relative to the instance, for display
  extensions: string[]; // accepted uploads
  catalog: AddonCatalog | null; // searchable catalog, if any (Bedrock: CurseForge only)
  notes: string[];
  warning: string | null;
}

export type AddonSupport = { supported: true; profile: AddonProfile } | { supported: false; reason: string };

export interface InstalledPlugin {
  fileName: string; // stable id used by toggle/delete (on-disk name, or "<type>:<folder>" for Bedrock packs)
  displayName: string;
  enabled: boolean;
  canToggle: boolean;
  sizeBytes: number;
  modifiedAt: string;
  detail: string | null;
}

const DISABLED_SUFFIX = '.disabled';
const BEDROCK_BUILTIN_RE = /^(vanilla|chemistry|experimental|editor)/i;

function levelName(server: ServerRecord): string {
  const fallback = server.platform === 'bedrock' ? 'Bedrock level' : 'world';
  const value = readServerProperties(server.id, server.platform).find((p) => p.key === 'level-name')?.value.trim();
  return value || fallback;
}

/** Joins a path under the instance directory, rejecting anything that escapes it. */
function inInstance(server: ServerRecord, relative: string): string {
  try {
    return safeJoinReal(instanceDir(server.id), relative);
  } catch {
    throw new HttpError(400, 'Invalid path');
  }
}

function isValheim(server: ServerRecord) {
  return server.platform === 'steam' && findPresetFor(server)?.id === 'valheim';
}

function bepinexInstalled(server: ServerRecord): boolean {
  return fs.existsSync(path.join(instanceDir(server.id), 'BepInEx', 'core', 'BepInEx.Preloader.dll'));
}

export function getAddonSupport(server: ServerRecord): AddonSupport {
  if (isModded(server.loader)) {
    const ecosystem = server.loader === 'mohist' || server.loader === 'spongeforge' ? 'forge' : server.loader;
    const notes = ['Restart the server after adding, removing or toggling a mod.', 'Players need the same client-side mods to join (server-only mods excepted).'];
    if (server.loader === 'mohist') notes.push('Mohist also runs Bukkit plugins — put those in plugins/ (File Management).');
    if (server.loader === 'spongeforge') notes.push('Sponge plugins are jars in mods/ too.');
    if (server.loader === 'quilt') notes.push('Quilt also loads most Fabric mods — search results include them.');
    return {
      supported: true,
      profile: {
        kind: 'mod',
        label: 'Mods',
        singular: 'mod',
        folder: 'mods',
        extensions: ['.jar'],
        catalog: `mod:${ecosystem}` as AddonCatalog,
        notes,
        warning: null,
      },
    };
  }
  if (isProxyLoader(server.loader)) {
    const velocity = server.loader === 'velocity';
    return {
      supported: true,
      profile: {
        kind: 'bukkit',
        label: 'Plugins',
        singular: 'plugin',
        folder: 'plugins',
        extensions: ['.jar'],
        catalog: velocity ? 'proxy:velocity' : 'proxy:bungee',
        notes: [
          velocity ? 'Velocity plugins only — Bukkit/Paper plugins go on the backend servers.' : 'BungeeCord plugins (Waterfall runs them too) — Bukkit/Paper plugins go on the backend servers.',
          'Restart the proxy after installing, removing, or toggling a plugin.',
        ],
        warning: null,
      },
    };
  }
  if (PLUGIN_CAPABLE_LOADERS.includes(server.loader)) {
    return {
      supported: true,
      profile: {
        kind: 'bukkit',
        label: 'Plugins',
        singular: 'plugin',
        folder: 'plugins',
        extensions: ['.jar'],
        catalog: 'plugin',
        notes: ['Restart the server after installing, removing, or toggling a plugin.'],
        warning: null,
      },
    };
  }

  if (server.loader === 'vanilla') {
    return {
      supported: true,
      profile: {
        kind: 'datapack',
        label: 'Data packs',
        singular: 'data pack',
        folder: `${levelName(server)}/datapacks`,
        extensions: ['.zip'],
        catalog: 'datapack',
        notes: [
          'Vanilla servers can’t run plugins — data packs are how vanilla Minecraft adds recipes, mechanics and world generation.',
          'New data packs load on restart, or immediately with /reload.',
        ],
        warning: null,
      },
    };
  }

  if (server.platform === 'bedrock') {
    return {
      supported: true,
      profile: {
        kind: 'bedrock',
        label: 'Add-ons',
        singular: 'pack',
        folder: 'behavior_packs · resource_packs',
        extensions: ['.mcpack', '.mcaddon', '.zip'],
        catalog: 'bedrock',
        notes: [
          `Packs are installed and activated for the world “${levelName(server)}” — search CurseForge or upload .mcpack/.mcaddon files. Restart the server to apply changes.`,
          'Resource packs are sent to players when they join. Packs that use experimental features also need those experiments enabled on the world.',
        ],
        warning: null,
      },
    };
  }

  if (server.platform === 'steam') {
    const preset = findPresetFor(server);
    if (preset?.id === 'valheim') {
      return {
        supported: true,
        profile: {
          kind: 'bepinex',
          label: 'Plugins',
          singular: 'plugin',
          folder: 'BepInEx/plugins',
          extensions: ['.dll', '.zip'],
          catalog: null,
          notes: [
            'Upload BepInEx plugin .dll files, or a mod .zip (e.g. from Thunderstore) — zips are unpacked into their own folder.',
            'Server-side mods only load on the server; players need any client-side parts installed themselves.',
          ],
          warning: bepinexInstalled(server)
            ? null
            : 'BepInEx isn’t installed in this instance yet, so plugins won’t load. Upload the contents of BepInExPack_Valheim (BepInEx/, doorstop_libs/, doorstop_config.ini, winhttp.dll) to the instance root in File Management — Outpost loads it automatically on the next start.',
        },
      };
    }
    if (isGmod(server)) {
      return {
        supported: true,
        profile: {
          kind: 'gmod',
          label: 'Addons',
          singular: 'addon',
          folder: 'garrysmod/addons',
          extensions: ['.gma', '.zip', '.bsp'],
          catalog: null,
          notes: [
            'Upload .gma addons, a .zip of a folder addon or a gamemode (e.g. from GitHub), or .bsp maps. Steam Workshop items are added on the Workshop tab and show up here too.',
            'Pick the gamemode and map on the Garry’s Mod tab. Restart the server after changing addons.',
          ],
          warning: null,
        },
      };
    }
    if (preset?.id === 'palworld') {
      return {
        supported: true,
        profile: {
          kind: 'pak',
          label: 'Mods',
          singular: 'mod',
          folder: 'Pal/Content/Paks/~mods',
          extensions: ['.pak'],
          catalog: null,
          notes: [
            '.pak mods load without a mod loader. Lua/UE4SS mods need UE4SS installed manually through File Management.',
            'Restart the server after adding or removing mods.',
          ],
          warning: null,
        },
      };
    }
    if (preset?.id === 'project_zomboid') {
      return {
        supported: false,
        reason:
          'Project Zomboid mods come from the Steam Workshop — add them on the Workshop tab, and Outpost writes them into the server’s settings for you.',
      };
    }
    if (preset?.id === 'terraria') {
      return {
        supported: false,
        reason:
          'The official Terraria dedicated server can’t load mods. Modded Terraria needs tModLoader, which isn’t a supported instance type yet.',
      };
    }
    return { supported: false, reason: 'Outpost doesn’t know this game’s mod format. Manage its files directly from File Management.' };
  }

  if (server.platform === 'docker') {
    return { supported: false, reason: 'Docker instances manage their own software — add plugins or mods through the image’s own options (often environment variables) or by placing files in File Management.' };
  }
  return { supported: false, reason: 'This instance type doesn’t support plugins.' };
}

export function requireAddonProfile(server: ServerRecord): AddonProfile {
  const support = getAddonSupport(server);
  if (!support.supported) throw new HttpError(400, support.reason);
  return support.profile;
}

// ---------------------------------------------------------------------------
// File-based kinds (bukkit, datapack, bepinex, pak)
// ---------------------------------------------------------------------------

function addonDir(server: ServerRecord, profile: AddonProfile): string {
  switch (profile.kind) {
    case 'bukkit':
      return inInstance(server, 'plugins');
    case 'mod':
      return inInstance(server, 'mods');
    case 'datapack':
      return inInstance(server, `${levelName(server)}/datapacks`);
    case 'bepinex':
      return inInstance(server, 'BepInEx/plugins');
    case 'pak':
      return inInstance(server, 'Pal/Content/Paks/~mods');
    case 'gmod':
      return inInstance(server, 'garrysmod/addons');
    case 'bedrock':
      throw new Error('Bedrock packs are not a single directory');
  }
}

function dirSize(dir: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(full);
    else if (entry.isFile()) total += fs.statSync(full).size;
  }
  return total;
}

function hasExtension(name: string, extensions: string[]): boolean {
  const lower = name.toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext) || lower.endsWith(ext + DISABLED_SUFFIX));
}

function listFileAddons(server: ServerRecord, profile: AddonProfile): InstalledPlugin[] {
  const dir = addonDir(server, profile);
  if (!fs.existsSync(dir)) return [];
  // Zips are only an upload format for BepInEx (they get unpacked) — never something on disk to list.
  const listedExtensions = profile.kind === 'bepinex' ? ['.dll'] : profile.extensions;
  // Data packs and BepInEx mods can also be unpacked folders.
  const foldersAllowed = profile.kind === 'datapack' || profile.kind === 'bepinex';
  const out: InstalledPlugin[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const stat = fs.statSync(full);
    if (entry.isFile() && hasExtension(entry.name, listedExtensions)) {
      const enabled = !entry.name.endsWith(DISABLED_SUFFIX);
      out.push({
        fileName: entry.name,
        displayName: enabled ? entry.name : entry.name.slice(0, -DISABLED_SUFFIX.length),
        enabled,
        canToggle: true,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        detail: null,
      });
    } else if (entry.isDirectory() && foldersAllowed) {
      out.push({
        fileName: entry.name,
        displayName: entry.name,
        enabled: true,
        canToggle: false,
        sizeBytes: dirSize(full),
        modifiedAt: stat.mtime.toISOString(),
        detail: 'Folder — delete to remove',
      });
    }
  }
  return out.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function resolveAddonPath(server: ServerRecord, profile: AddonProfile, fileName: string): string {
  if (!fileName || fileName.includes('/') || fileName.includes('\\')) throw new HttpError(400, 'Invalid file name');
  try {
    return safeJoinReal(addonDir(server, profile), fileName);
  } catch {
    throw new HttpError(400, 'Invalid file name');
  }
}

function safeFileName(name: string): string {
  return path.basename(name).replace(/[^a-zA-Z0-9._ +-]/g, '_');
}

// ---------------------------------------------------------------------------
// Bedrock packs
// ---------------------------------------------------------------------------

type PackType = 'behavior' | 'resource';

interface PackManifest {
  uuid: string;
  version: number[];
  name: string;
  type: PackType;
}

function parseManifest(text: string): PackManifest | null {
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    try {
      // Bedrock tolerates // comments in manifests; JSON.parse doesn't.
      json = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));
    } catch {
      return null;
    }
  }
  const uuid = json?.header?.uuid;
  if (typeof uuid !== 'string') return null;
  const modules: { type?: string }[] = Array.isArray(json.modules) ? json.modules : [];
  return {
    uuid,
    version: Array.isArray(json.header.version) ? json.header.version : [1, 0, 0],
    name: typeof json.header.name === 'string' ? json.header.name : uuid,
    type: modules.some((m) => m.type === 'resources') ? 'resource' : 'behavior',
  };
}

function packsDir(server: ServerRecord, type: PackType): string {
  return inInstance(server, `${type}_packs`);
}

function worldPacksFile(server: ServerRecord, type: PackType): string {
  return inInstance(server, `worlds/${levelName(server)}/world_${type}_packs.json`);
}

function readWorldPacks(server: ServerRecord, type: PackType): { pack_id: string; version: number[] }[] {
  const file = worldPacksFile(server, type);
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeWorldPacks(server: ServerRecord, type: PackType, packs: { pack_id: string; version: number[] }[]) {
  const file = worldPacksFile(server, type);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(packs, null, 2));
}

function setPackActive(server: ServerRecord, type: PackType, manifest: PackManifest, active: boolean) {
  const current = readWorldPacks(server, type).filter((p) => p.pack_id !== manifest.uuid);
  if (active) current.push({ pack_id: manifest.uuid, version: manifest.version });
  writeWorldPacks(server, type, current);
}

function readPackFolderManifest(folder: string): PackManifest | null {
  const file = path.join(folder, 'manifest.json');
  return fs.existsSync(file) ? parseManifest(fs.readFileSync(file, 'utf8')) : null;
}

function listBedrockPacks(server: ServerRecord): InstalledPlugin[] {
  const out: InstalledPlugin[] = [];
  for (const type of ['behavior', 'resource'] as const) {
    const dir = packsDir(server, type);
    if (!fs.existsSync(dir)) continue;
    const active = new Set(readWorldPacks(server, type).map((p) => p.pack_id));
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      const manifest = readPackFolderManifest(full);
      if (!manifest) continue;
      const enabled = active.has(manifest.uuid);
      // The server ships its own vanilla/experimental packs here; only show those if someone activated one.
      if (BEDROCK_BUILTIN_RE.test(entry.name) && !enabled) continue;
      out.push({
        fileName: `${type}:${entry.name}`,
        displayName: manifest.name.includes('pack.name') ? entry.name : manifest.name,
        enabled,
        canToggle: true,
        sizeBytes: dirSize(full),
        modifiedAt: fs.statSync(full).mtime.toISOString(),
        detail: `${type === 'behavior' ? 'Behavior' : 'Resource'} pack · v${manifest.version.join('.')}`,
      });
    }
  }
  return out.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function resolveBedrockPack(server: ServerRecord, id: string): { type: PackType; folder: string; manifest: PackManifest } {
  const [type, name] = id.split(':', 2) as [PackType, string];
  if ((type !== 'behavior' && type !== 'resource') || !name || name.includes('/') || name.includes('\\')) {
    throw new HttpError(400, 'Invalid pack id');
  }
  let folder: string;
  try {
    folder = safeJoinReal(packsDir(server, type), name);
  } catch {
    throw new HttpError(400, 'Invalid pack id');
  }
  const manifest = fs.existsSync(folder) ? readPackFolderManifest(folder) : null;
  if (!manifest) throw new HttpError(404, 'Pack not found');
  return { type, folder, manifest };
}

/** Installs every pack inside an .mcpack/.mcaddon/.zip (an .mcaddon may nest .mcpack files). */
function installBedrockArchive(server: ServerRecord, buffer: Buffer, depth = 0): string[] {
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    throw new HttpError(400, 'That file isn’t a valid .mcpack/.mcaddon/.zip archive');
  }
  const installed: string[] = [];
  const entries = zip.getEntries();

  for (const entry of entries) {
    if (entry.isDirectory || path.posix.basename(entry.entryName) !== 'manifest.json') continue;
    const manifest = parseManifest(entry.getData().toString('utf8'));
    if (!manifest) continue;
    const root = path.posix.dirname(entry.entryName);
    const prefix = root === '.' ? '' : `${root}/`;
    const folderName = `${safeFileName(manifest.name.includes('pack.name') ? root : manifest.name).replace(/\s+/g, '_') || 'pack'}_${manifest.uuid.slice(0, 8)}`;
    const dest = path.join(packsDir(server, manifest.type), folderName);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    extractZipSafely(zip, dest, prefix);
    setPackActive(server, manifest.type, manifest, true);
    installed.push(manifest.name);
  }

  if (depth < 2) {
    for (const entry of entries) {
      if (!entry.isDirectory && /\.(mcpack|zip)$/i.test(entry.entryName)) {
        installed.push(...installBedrockArchive(server, entry.getData(), depth + 1));
      }
    }
  }
  return installed;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function listPlugins(server: ServerRecord): InstalledPlugin[] {
  const profile = requireAddonProfile(server);
  if (profile.kind === 'gmod') return listGmodAddons(server);
  return profile.kind === 'bedrock' ? listBedrockPacks(server) : listFileAddons(server, profile);
}

export function setPluginEnabled(server: ServerRecord, fileName: string, enable: boolean): void {
  const profile = requireAddonProfile(server);
  if (profile.kind === 'bedrock') {
    const { type, manifest } = resolveBedrockPack(server, fileName);
    setPackActive(server, type, manifest, enable);
    return;
  }
  if (profile.kind === 'gmod') return setGmodAddonEnabled(server, fileName, enable);
  const current = resolveAddonPath(server, profile, fileName);
  if (!fs.existsSync(current)) throw new HttpError(404, `${profile.singular} not found`);
  if (fs.statSync(current).isDirectory()) throw new HttpError(400, 'Folders can’t be toggled — delete it instead');
  const isDisabled = fileName.endsWith(DISABLED_SUFFIX);
  if (enable === !isDisabled) return; // already in the requested state
  const target = enable ? current.slice(0, -DISABLED_SUFFIX.length) : current + DISABLED_SUFFIX;
  fs.renameSync(current, target);
}

export function deletePlugin(server: ServerRecord, fileName: string): void {
  const profile = requireAddonProfile(server);
  if (profile.kind === 'bedrock') {
    const { type, folder, manifest } = resolveBedrockPack(server, fileName);
    setPackActive(server, type, manifest, false);
    fs.rmSync(folder, { recursive: true, force: true });
    return;
  }
  if (profile.kind === 'gmod') return deleteGmodAddon(server, fileName);
  fs.rmSync(resolveAddonPath(server, profile, fileName), { recursive: true, force: true });
}

/** Installs an uploaded file according to the instance's add-on profile. Returns what was installed. */
export function installUploadedAddon(server: ServerRecord, originalName: string, buffer: Buffer): string[] {
  const profile = requireAddonProfile(server);
  const name = safeFileName(originalName);
  const lower = name.toLowerCase();
  if (!profile.extensions.some((ext) => lower.endsWith(ext))) {
    throw new HttpError(400, `${originalName}: expected ${profile.extensions.join(', ')}`);
  }

  if (profile.kind === 'gmod') return installGmodUpload(server, originalName, buffer);
  if (profile.kind === 'bedrock') {
    const installed = installBedrockArchive(server, buffer);
    if (!installed.length) throw new HttpError(400, `${originalName}: no Bedrock pack (manifest.json) found inside`);
    return installed;
  }

  const dir = addonDir(server, profile);
  fs.mkdirSync(dir, { recursive: true });

  if (profile.kind === 'bepinex' && lower.endsWith('.zip')) {
    let zip: AdmZip;
    try {
      zip = new AdmZip(buffer);
    } catch {
      throw new HttpError(400, `${originalName} isn’t a valid zip`);
    }
    const dest = path.join(dir, name.slice(0, -'.zip'.length));
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    extractZipSafely(zip, dest);
    return [path.basename(dest)];
  }

  fs.writeFileSync(safeJoinReal(dir, name), buffer);
  return [name];
}

/** Downloads a resolved catalog file (plugin jar / data pack zip) into the instance's add-on folder. */
export async function installPluginFile(
  server: ServerRecord,
  downloadUrl: string,
  fileName: string,
  onLog?: LogFn
): Promise<void> {
  const profile = requireAddonProfile(server);
  const dir = addonDir(server, profile);
  fs.mkdirSync(dir, { recursive: true });
  const destination = safeJoinReal(dir, safeFileName(fileName));
  await downloadFile(downloadUrl, destination, undefined, onLog);
}

/** Extra environment a server's mod loader needs at launch (currently: BepInEx for Valheim on Linux,
 *  mirroring what BepInExPack's start_server_bepinex.sh sets — both doorstop 3 and 4 variable names). */
export function addonLaunchEnv(server: ServerRecord, dir: string): { env: Record<string, string>; libraryPaths: string[] } {
  const none = { env: {}, libraryPaths: [] };
  if (process.platform === 'win32' || !isValheim(server) || !bepinexInstalled(server)) return none;
  const doorstopLibs = path.join(dir, 'doorstop_libs');
  if (!fs.existsSync(path.join(doorstopLibs, 'libdoorstop_x64.so'))) return none;
  const preloader = path.join(dir, 'BepInEx', 'core', 'BepInEx.Preloader.dll');
  const env: Record<string, string> = {
    DOORSTOP_ENABLE: 'TRUE',
    DOORSTOP_INVOKE_DLL_PATH: preloader,
    DOORSTOP_ENABLED: '1',
    DOORSTOP_TARGET_ASSEMBLY: preloader,
    LD_PRELOAD: ['libdoorstop_x64.so', process.env.LD_PRELOAD].filter(Boolean).join(':'),
  };
  const corlib = path.join(dir, 'unstripped_corlib');
  if (fs.existsSync(corlib)) env.DOORSTOP_CORLIB_OVERRIDE_PATH = corlib;
  return { env, libraryPaths: [doorstopLibs] };
}
