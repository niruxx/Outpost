import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { instanceDir, safeJoinReal } from '../utils/paths.js';
import { HttpError } from '../utils/asyncHandler.js';
import { extractZipSafely } from '../utils/zip.js';
import { prep } from '../db/db.js';
import type { ServerRecord } from '../types/index.js';

/**
 * Garry's Mod: server settings (gamemode, map, slots, hostname…), the addons / gamemodes / maps
 * that make up its "mods", and mounting Counter-Strike: Source content that TTT and many maps use.
 * Workshop items are handled by workshopService; they show up here read-only.
 */

export interface GmodSettings {
  gamemode: string;
  map: string;
  maxPlayers: number;
  hostname: string;
  password: string;
  loadingUrl: string;
  /** Game Server Login Token (optional for GMod; lists the server under a Steam account). */
  gslt: string;
}

const DEFAULTS: GmodSettings = { gamemode: 'sandbox', map: 'gm_construct', maxPlayers: 16, hostname: '', password: '', loadingUrl: '', gslt: '' };
/** Gamemodes that ship with the server — shown in pickers, never deleted. */
const BUILTIN_GAMEMODES = new Set(['base', 'sandbox', 'terrortown']);
const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const CSS_APP_ID = '232330';

const root = (server: ServerRecord) => path.join(instanceDir(server.id), 'garrysmod');
const dirOf = (server: ServerRecord, sub: 'addons' | 'addons_disabled' | 'gamemodes' | 'maps' | 'cfg') => path.join(root(server), sub);
export const cssContentDir = (server: ServerRecord) => path.join(instanceDir(server.id), 'content', 'css');

export const isGmod = (server: ServerRecord) => server.platform === 'steam' && (server.steam_preset === 'gmod' || (!server.steam_preset && server.steam_app_id === '4020'));

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function gmodSettingsOf(server: ServerRecord): GmodSettings {
  try {
    const raw = server.game_settings ? (JSON.parse(server.game_settings) as { gmod?: Partial<GmodSettings> }).gmod : undefined;
    return { ...DEFAULTS, ...(raw ?? {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/["\r\n]/g, '').trim().slice(0, max) : '');

export function sanitizeGmodSettings(input: Record<string, unknown>, prev: GmodSettings): GmodSettings {
  const next = { ...prev };
  if (input.gamemode !== undefined) {
    const g = String(input.gamemode).trim().toLowerCase();
    if (!/^[a-z0-9_-]{1,64}$/.test(g)) throw new HttpError(400, 'Gamemode must be a folder name like “sandbox” or “terrortown”');
    next.gamemode = g;
  }
  if (input.map !== undefined) {
    const m = String(input.map).trim().replace(/\.bsp$/i, '');
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(m)) throw new HttpError(400, 'Map must be a map name like “gm_construct”');
    next.map = m;
  }
  if (input.maxPlayers !== undefined) {
    const n = Number(input.maxPlayers);
    if (!Number.isInteger(n) || n < 1 || n > 128) throw new HttpError(400, 'Max players must be 1–128');
    next.maxPlayers = n;
  }
  if (input.hostname !== undefined) next.hostname = clean(input.hostname, 100);
  if (input.password !== undefined) next.password = clean(input.password, 64);
  if (input.loadingUrl !== undefined) {
    const u = clean(input.loadingUrl, 300);
    if (u && !/^https?:\/\//i.test(u)) throw new HttpError(400, 'Loading screen URL must start with http:// or https://');
    next.loadingUrl = u;
  }
  if (input.gslt !== undefined) {
    const t = clean(input.gslt, 64);
    if (t && !/^[A-Za-z0-9]+$/.test(t)) throw new HttpError(400, 'That doesn’t look like a server login token');
    next.gslt = t;
  }
  return next;
}

/** Sets (or adds) `key "value"` in server.cfg, leaving the rest of the file as it is. */
function setCfg(lines: string[], key: string, value: string) {
  const re = new RegExp(`^\\s*${key}\\s`, 'i');
  const line = `${key} "${value}"`;
  const i = lines.findIndex((l) => re.test(l));
  if (i >= 0) lines[i] = line;
  else lines.push(line);
}

export function saveGmodSettings(server: ServerRecord, input: Record<string, unknown>): GmodSettings {
  const next = sanitizeGmodSettings(input, gmodSettingsOf(server));
  const row = prep('SELECT game_settings FROM servers WHERE id = ?').get(server.id) as { game_settings: string | null } | undefined;
  const raw = row?.game_settings ? (JSON.parse(row.game_settings) as Record<string, unknown>) : {};
  prep('UPDATE servers SET game_settings = ? WHERE id = ?').run(JSON.stringify({ ...raw, gmod: next }), server.id);

  // server.cfg runs after the command line, so these go there or they'd be overridden by it.
  const cfgDir = dirOf(server, 'cfg');
  fs.mkdirSync(cfgDir, { recursive: true });
  const file = path.join(cfgDir, 'server.cfg');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '// server.cfg — written by Outpost; your own lines are kept\n';
  const lines = text.replace(/\n$/, '').split(/\r?\n/);
  if (next.hostname) setCfg(lines, 'hostname', next.hostname);
  setCfg(lines, 'sv_password', next.password);
  if (next.loadingUrl || lines.some((l) => /^\s*sv_loadingurl\s/i.test(l))) setCfg(lines, 'sv_loadingurl', next.loadingUrl);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return next;
}

/** Command-line part of the GMod launch that comes from the settings. */
export function gmodLaunchArgs(server: ServerRecord): string[] {
  const s = gmodSettingsOf(server);
  return ['+maxplayers', String(s.maxPlayers), '+gamemode', s.gamemode, '+map', s.map, ...(s.gslt ? ['+sv_setsteamaccount', s.gslt] : [])];
}

// ---------------------------------------------------------------------------
// .gma headers — enough to name an addon and see which gamemodes / maps it brings
// ---------------------------------------------------------------------------

export interface GmaInfo {
  title: string;
  files: string[];
}

/** Reads the header and file table of a .gma (Garry's Mod addon archive) without loading the content. */
export function readGma(file: string): GmaInfo | null {
  let buf: Buffer;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      buf = Buffer.alloc(Math.min(fs.fstatSync(fd).size, 4 * 1024 * 1024));
      fs.readSync(fd, buf, 0, buf.length, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  return parseGma(buf);
}

export function parseGma(buf: Buffer): GmaInfo | null {
  if (buf.length < 22 || buf.toString('latin1', 0, 4) !== 'GMAD') return null;
  let o = 4;
  const version = buf[o++];
  o += 16; // steamid + timestamp
  const str = () => {
    const end = buf.indexOf(0, o);
    if (end < 0) throw new RangeError('truncated');
    const s = buf.toString('utf8', o, end);
    o = end + 1;
    return s;
  };
  const files: string[] = [];
  let title = '';
  try {
    if (version > 1) while (str() !== '');
    title = str();
    str(); // description (JSON)
    str(); // author
    o += 4; // addon version
    for (;;) {
      if (o + 4 > buf.length) break;
      const index = buf.readUInt32LE(o);
      o += 4;
      if (index === 0) break;
      files.push(str().toLowerCase());
      o += 12; // size (int64) + crc (uint32)
    }
  } catch {
    // a truncated header still gives us what was read
  }
  return { title, files };
}

const gamemodesIn = (files: string[]) => [...new Set(files.map((f) => f.match(/^gamemodes\/([^/]+)\/\1\.txt$/)?.[1]).filter((g): g is string => !!g))];
const mapsIn = (files: string[]) => files.map((f) => f.match(/^maps\/([^/]+)\.bsp$/)?.[1]).filter((m): m is string => !!m);

function listDirs(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];
}

function listFiles(dir: string, re: RegExp): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && re.test(e.name)).map((e) => e.name) : [];
}

/** Gamemodes and maps available to this server, from loose folders, .gma addons and mounted CS:S. */
export function gmodContent(server: ServerRecord): { gamemodes: string[]; maps: string[] } {
  const gamemodes = new Set<string>(['sandbox', 'terrortown']);
  for (const g of listDirs(dirOf(server, 'gamemodes'))) if (g !== 'base' && fs.existsSync(path.join(dirOf(server, 'gamemodes'), g, `${g}.txt`))) gamemodes.add(g);
  const maps = new Set<string>(['gm_construct', 'gm_flatgrass']);
  for (const m of listFiles(dirOf(server, 'maps'), /\.bsp$/i)) maps.add(m.replace(/\.bsp$/i, ''));
  const addons = dirOf(server, 'addons');
  for (const f of listFiles(addons, /\.gma$/i)) {
    const info = readGma(path.join(addons, f));
    if (!info) continue;
    gamemodesIn(info.files).forEach((g) => gamemodes.add(g));
    mapsIn(info.files).forEach((m) => maps.add(m));
  }
  for (const folder of listDirs(addons)) {
    listDirs(path.join(addons, folder, 'gamemodes')).forEach((g) => gamemodes.add(g));
    listFiles(path.join(addons, folder, 'maps'), /\.bsp$/i).forEach((m) => maps.add(m.replace(/\.bsp$/i, '')));
  }
  if (cssStatus(server).mounted) listFiles(path.join(cssContentDir(server), 'cstrike', 'maps'), /\.bsp$/i).forEach((m) => maps.add(m.replace(/\.bsp$/i, '')));
  return { gamemodes: [...gamemodes].sort(), maps: [...maps].sort() };
}

// ---------------------------------------------------------------------------
// Addons page (the "Mods" profile)
// ---------------------------------------------------------------------------

export interface GmodEntry {
  fileName: string;
  displayName: string;
  enabled: boolean;
  canToggle: boolean;
  sizeBytes: number;
  modifiedAt: string;
  detail: string | null;
}

const DISABLED = '.disabled';

function dirSize(dir: string): number {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else if (e.isFile()) total += fs.statSync(p).size;
  }
  return total;
}

const workshopId = (name: string) => name.match(/^workshop_(\d+)\.gma(\.disabled)?$/i)?.[1] ?? null;

export function listGmodAddons(server: ServerRecord): GmodEntry[] {
  const out: GmodEntry[] = [];
  const addons = dirOf(server, 'addons');
  for (const f of listFiles(addons, /\.gma(\.disabled)?$/i)) {
    const full = path.join(addons, f);
    const st = fs.statSync(full);
    const info = readGma(full);
    const enabled = !f.endsWith(DISABLED);
    const ws = workshopId(f);
    const extras = info ? [...gamemodesIn(info.files).map((g) => `gamemode ${g}`), ...(mapsIn(info.files).length ? [`${mapsIn(info.files).length} map(s)`] : [])] : [];
    out.push({
      fileName: f,
      displayName: info?.title || f.replace(/\.disabled$/, ''),
      enabled,
      canToggle: !ws,
      sizeBytes: st.size,
      modifiedAt: st.mtime.toISOString(),
      detail: [ws ? `Workshop ${ws} — managed on the Workshop tab` : 'Addon (.gma)', ...extras].join(' · '),
    });
  }
  for (const [dir, enabled] of [
    [addons, true],
    [dirOf(server, 'addons_disabled'), false],
  ] as const) {
    for (const folder of listDirs(dir)) {
      const full = path.join(dir, folder);
      out.push({ fileName: `folder:${folder}`, displayName: folder, enabled, canToggle: true, sizeBytes: dirSize(full), modifiedAt: fs.statSync(full).mtime.toISOString(), detail: 'Addon folder' });
    }
  }
  const gm = dirOf(server, 'gamemodes');
  for (const g of listDirs(gm)) {
    if (BUILTIN_GAMEMODES.has(g)) continue;
    const full = path.join(gm, g);
    out.push({ fileName: `gamemode:${g}`, displayName: g, enabled: true, canToggle: false, sizeBytes: dirSize(full), modifiedAt: fs.statSync(full).mtime.toISOString(), detail: 'Gamemode — pick it on the Garry’s Mod tab' });
  }
  const maps = dirOf(server, 'maps');
  for (const m of listFiles(maps, /\.bsp$/i)) {
    if (/^gm_(construct|flatgrass)\.bsp$/i.test(m)) continue;
    const st = fs.statSync(path.join(maps, m));
    out.push({ fileName: `map:${m}`, displayName: m.replace(/\.bsp$/i, ''), enabled: true, canToggle: false, sizeBytes: st.size, modifiedAt: st.mtime.toISOString(), detail: 'Map' });
  }
  return out.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** Resolves an entry id to its path on disk. */
function entryPath(server: ServerRecord, id: string): { full: string; kind: 'gma' | 'folder' | 'gamemode' | 'map'; name: string; enabled: boolean } {
  const [prefix, ...rest] = id.includes(':') ? id.split(':') : ['', id];
  const name = rest.join(':');
  const check = (n: string) => {
    if (!NAME_RE.test(n) && !/^[A-Za-z0-9_. +-]{1,128}$/.test(n)) throw new HttpError(400, 'Invalid name');
  };
  try {
    if (prefix === '') {
      check(id);
      return { full: safeJoinReal(dirOf(server, 'addons'), id), kind: 'gma', name: id, enabled: !id.endsWith(DISABLED) };
    }
    check(name);
    if (prefix === 'folder') {
      const on = path.join(dirOf(server, 'addons'), name);
      if (fs.existsSync(on)) return { full: safeJoinReal(dirOf(server, 'addons'), name), kind: 'folder', name, enabled: true };
      return { full: safeJoinReal(dirOf(server, 'addons_disabled'), name), kind: 'folder', name, enabled: false };
    }
    if (prefix === 'gamemode') {
      if (BUILTIN_GAMEMODES.has(name)) throw new HttpError(400, `${name} comes with Garry’s Mod and can’t be removed`);
      return { full: safeJoinReal(dirOf(server, 'gamemodes'), name), kind: 'gamemode', name, enabled: true };
    }
    if (prefix === 'map') return { full: safeJoinReal(dirOf(server, 'maps'), name), kind: 'map', name, enabled: true };
  } catch (err) {
    if (err instanceof HttpError) throw err;
  }
  throw new HttpError(400, 'Invalid addon');
}

export function setGmodAddonEnabled(server: ServerRecord, id: string, enable: boolean) {
  const entry = entryPath(server, id);
  if (!fs.existsSync(entry.full)) throw new HttpError(404, 'Addon not found');
  if (entry.kind === 'gma') {
    if (workshopId(entry.name)) throw new HttpError(400, 'Workshop items are added and removed on the Workshop tab');
    if (enable === entry.enabled) return;
    fs.renameSync(entry.full, enable ? entry.full.slice(0, -DISABLED.length) : entry.full + DISABLED);
    return;
  }
  if (entry.kind !== 'folder') throw new HttpError(400, 'Only addons can be turned off — delete gamemodes and maps instead');
  if (enable === entry.enabled) return;
  // GMod loads every folder in addons/, so a disabled one has to live somewhere else.
  const target = path.join(dirOf(server, enable ? 'addons' : 'addons_disabled'), entry.name);
  if (fs.existsSync(target)) throw new HttpError(409, `There’s already a ${entry.name} folder ${enable ? 'enabled' : 'disabled'}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(entry.full, target);
}

export function deleteGmodAddon(server: ServerRecord, id: string) {
  const entry = entryPath(server, id);
  if (entry.kind === 'gma' && workshopId(entry.name)) throw new HttpError(400, 'Workshop items are removed on the Workshop tab, so they don’t come back on the next apply');
  fs.rmSync(entry.full, { recursive: true, force: true });
}

/** Linux GMod is case-sensitive about addon paths, and addons are authored on Windows — lowercase everything. */
function lowercaseTree(dir: string) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    let p = path.join(dir, e.name);
    const lower = e.name.toLowerCase();
    if (lower !== e.name && !fs.existsSync(path.join(dir, lower))) {
      fs.renameSync(p, path.join(dir, lower));
      p = path.join(dir, lower);
    }
    if (e.isDirectory()) lowercaseTree(p);
  }
}

/** Extracts and lowercases; a rejected archive leaves nothing half-written behind. */
function unpackInto(zip: AdmZip, dest: string, prefix: string) {
  try {
    extractZipSafely(zip, dest, prefix);
    lowercaseTree(dest);
  } catch (err) {
    fs.rmSync(dest, { recursive: true, force: true });
    throw err;
  }
}

const folderName = (s: string) =>
  s
    .toLowerCase()
    .replace(/\.(zip|gma|bsp)$/i, '')
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || 'addon';

/** Installs an uploaded .gma, .bsp map, or a .zip holding a folder addon or a gamemode. */
export function installGmodUpload(server: ServerRecord, originalName: string, buffer: Buffer): string[] {
  const lower = originalName.toLowerCase();
  if (lower.endsWith('.gma')) {
    const info = parseGma(buffer.subarray(0, 4 * 1024 * 1024));
    if (!info) throw new HttpError(400, `${originalName} isn’t a Garry’s Mod addon (.gma)`);
    const dir = dirOf(server, 'addons');
    fs.mkdirSync(dir, { recursive: true });
    const name = `${folderName(originalName)}.gma`;
    fs.writeFileSync(safeJoinReal(dir, name), buffer);
    return [info.title || name];
  }
  if (lower.endsWith('.bsp')) {
    if (buffer.toString('latin1', 0, 4) !== 'VBSP') throw new HttpError(400, `${originalName} isn’t a Source map (.bsp)`);
    const dir = dirOf(server, 'maps');
    fs.mkdirSync(dir, { recursive: true });
    const name = `${folderName(originalName)}.bsp`;
    fs.writeFileSync(safeJoinReal(dir, name), buffer);
    return [name];
  }
  if (!lower.endsWith('.zip')) throw new HttpError(400, `${originalName}: expected .gma, .bsp or .zip`);

  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    throw new HttpError(400, `${originalName} isn’t a valid zip`);
  }
  const names = zip.getEntries().map((e) => e.entryName.replace(/\\/g, '/'));
  const lowerNames = names.map((n) => n.toLowerCase());

  // A gamemode: <name>/<name>.txt next to <name>/gamemode/, possibly under a "gamemodes/" folder.
  for (const n of lowerNames) {
    const m = n.match(/^(.*?)([^/]+)\/\2\.txt$/);
    if (!m || !lowerNames.some((x) => x.startsWith(`${m[1]}${m[2]}/gamemode/`))) continue;
    const prefix = names[lowerNames.indexOf(n)].slice(0, m[1].length + m[2].length + 1);
    const dest = path.join(dirOf(server, 'gamemodes'), folderName(m[2]));
    if (BUILTIN_GAMEMODES.has(path.basename(dest))) throw new HttpError(400, `${m[2]} is a built-in gamemode`);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    unpackInto(zip, dest, prefix);
    return [`gamemode ${path.basename(dest)}`];
  }

  // A folder addon: its root has addon.json or the usual content folders, at the top or one level down.
  const CONTENT = /^(addon\.json|lua|materials|models|sound|maps|gamemodes|resource|particles|scripts|data)(\/|$)/;
  const tops = [...new Set(lowerNames.map((n) => n.split('/')[0]))];
  let prefix = '';
  let name = folderName(originalName);
  if (!lowerNames.some((n) => CONTENT.test(n)) && tops.length === 1 && lowerNames.some((n) => CONTENT.test(n.slice(tops[0].length + 1)))) {
    prefix = names.find((n) => n.toLowerCase().startsWith(`${tops[0]}/`))!.slice(0, tops[0].length + 1);
    name = folderName(tops[0]);
  } else if (!lowerNames.some((n) => CONTENT.test(n))) {
    throw new HttpError(400, `${originalName} doesn’t look like a Garry’s Mod addon or gamemode (no addon.json, lua/, materials/… inside)`);
  }
  const dest = path.join(dirOf(server, 'addons'), name);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.rmSync(path.join(dirOf(server, 'addons_disabled'), name), { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  unpackInto(zip, dest, prefix);
  return [name];
}

// ---------------------------------------------------------------------------
// Counter-Strike: Source content
// ---------------------------------------------------------------------------

export function cssStatus(server: ServerRecord): { installed: boolean; mounted: boolean; path: string } {
  const cstrike = path.join(cssContentDir(server), 'cstrike');
  const installed = fs.existsSync(path.join(cstrike, 'cstrike_pak_dir.vpk'));
  const mountFile = path.join(dirOf(server, 'cfg'), 'mount.cfg');
  const mounted = installed && fs.existsSync(mountFile) && fs.readFileSync(mountFile, 'utf8').includes(cstrike);
  return { installed, mounted, path: cstrike };
}

/** Points mount.cfg's "cstrike" entry at the downloaded CS:S content, keeping other mounts. */
export function writeCssMount(server: ServerRecord, mount: boolean) {
  const file = path.join(dirOf(server, 'cfg'), 'mount.cfg');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '"mountcfg"\n{\n}\n';
  const lines = existing.split(/\r?\n/).filter((l) => !/^\s*"cstrike"\s/i.test(l));
  if (mount) {
    const close = lines.map((l) => l.trim()).lastIndexOf('}');
    const entry = `\t"cstrike"\t"${cssStatus(server).path}"`;
    if (close >= 0) lines.splice(close, 0, entry);
    else lines.push('"mountcfg"', '{', entry, '}');
  }
  fs.writeFileSync(file, lines.join('\n'));
}

export const CSS_CONTENT_APP_ID = CSS_APP_ID;
