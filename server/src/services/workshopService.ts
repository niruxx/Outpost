import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { HttpError } from '../utils/asyncHandler.js';
import { instanceDir } from '../utils/paths.js';
import { getServer, setWorkshopState } from './serverService.js';
import { findPresetFor, type WorkshopSupport } from './steamGames.js';
import { steamWorkshopDownload } from './steamCmdService.js';
import { appendLine } from './consoleLogService.js';
import { workshopStateOf, type WorkshopItem, type WorkshopKind, type WorkshopState } from './workshopState.js';
import type { ServerRecord } from '../types/index.js';

/**
 * Steam Workshop mods for game servers. Item details come from Steam's public Web API (no key
 * needed); how items get onto the server depends on the game (see WorkshopSupport):
 *
 *  - Project Zomboid downloads Workshop items itself — Outpost keeps WorkshopItems= and Mods= in the
 *    server's .ini in sync with the list.
 *  - Black Ops III's server doesn't — Outpost downloads each item with steamcmd (an account that owns
 *    the game is required) and installs maps into usermaps/<codename> and mods into mods/<id>.
 *  - Garry's Mod: Outpost downloads each item, unpacks its .gma into garrysmod/addons, and lists it
 *    with resource.AddWorkshop so joining players download it too.
 *  - ARK downloads mods itself (-automanagedmods); Outpost passes the list as ?GameModIds=.
 *  - Arma 3: Outpost downloads mods into @<id> folders (lower-cased on Linux, which Arma needs) and
 *    copies their signing keys into keys/; the list becomes -mod=.
 */

/** Games whose server fetches Workshop content itself — "apply" only saves the list. */
const SELF_DOWNLOADING = new Set<WorkshopSupport['mode']>(['zomboid', 'ark']);

const API = 'https://api.steampowered.com/ISteamRemoteStorage';
const MAX_ITEMS = 200;

export interface ItemDetails {
  id: string;
  found: boolean;
  title: string;
  appId: string;
  sizeBytes: number;
  previewUrl: string | null;
  updatedAt: number;
  tags: string[];
  description: string;
}

async function steamPost<T>(method: string, params: Record<string, string>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}/${method}/v1/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new HttpError(502, `Couldn’t reach Steam: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new HttpError(502, `Steam answered ${res.status}`);
  return (await res.json()) as T;
}

/** Workshop IDs from anything pasted: plain IDs, ?id= links, several separated by spaces/commas/lines. */
export function parseWorkshopIds(input: string): string[] {
  const ids = new Set<string>();
  for (const m of input.matchAll(/(?:[?&]id=)?(\d{6,12})/g)) ids.add(m[1]);
  return [...ids];
}

export async function fetchDetails(ids: string[]): Promise<ItemDetails[]> {
  const out: ItemDetails[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const params: Record<string, string> = { itemcount: String(chunk.length) };
    chunk.forEach((id, n) => (params[`publishedfileids[${n}]`] = id));
    const body = await steamPost<{ response: { publishedfiledetails?: Record<string, unknown>[] } }>('GetPublishedFileDetails', params);
    for (const f of body.response.publishedfiledetails ?? []) {
      out.push({
        id: String(f.publishedfileid),
        found: f.result === 1,
        title: typeof f.title === 'string' ? f.title : `Item ${f.publishedfileid}`,
        appId: String(f.consumer_app_id ?? ''),
        sizeBytes: Number(f.file_size) || 0,
        previewUrl: typeof f.preview_url === 'string' ? f.preview_url : null,
        updatedAt: Number(f.time_updated) || 0,
        tags: Array.isArray(f.tags) ? (f.tags as { tag: string }[]).map((t) => t.tag) : [],
        description: typeof f.description === 'string' ? f.description : '',
      });
    }
  }
  // Steam's batch answers sometimes leave out an item's size; asking for it on its own fills it in.
  if (ids.length > 1) {
    for (const d of out.filter((x) => x.found && !x.sizeBytes).slice(0, 20)) {
      const [again] = await fetchDetails([d.id]).catch(() => []);
      if (again?.sizeBytes) d.sizeBytes = again.sizeBytes;
    }
  }
  return out;
}

/** Replaces collection IDs with the items they contain; plain item IDs pass through. */
export async function expandCollections(ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const params: Record<string, string> = { collectioncount: String(ids.length) };
  ids.forEach((id, n) => (params[`publishedfileids[${n}]`] = id));
  const body = await steamPost<{ response: { collectiondetails?: { publishedfileid: string; result: number; children?: { publishedfileid: string }[] }[] } }>(
    'GetCollectionDetails',
    params
  );
  const out: string[] = [];
  for (const id of ids) {
    const c = body.response.collectiondetails?.find((x) => String(x.publishedfileid) === id);
    if (c?.result === 1 && c.children?.length) out.push(...c.children.map((x) => String(x.publishedfileid)));
    else out.push(id);
  }
  return [...new Set(out)];
}

/** Project Zomboid items list their mod ids in the description ("Mod ID: foo"). */
export function zomboidModIds(description: string): string[] {
  const ids = new Set<string>();
  // Steam descriptions use BBCode — "[b]Mod ID:[/b] foo" is common — so drop the tags first.
  const text = description.replace(/\[\/?[a-z0-9*]+(?:=[^\]]*)?\]/gi, '');
  for (const m of text.matchAll(/^[^\S\r\n]*mod ?id[^\S\r\n]*:[^\S\r\n]*(.+)$/gim)) {
    for (const part of m[1].split(/[;,]/)) {
      const id = part.trim();
      if (/^[\w .\-'&+]{1,80}$/.test(id)) ids.add(id);
    }
  }
  return [...ids];
}

function kindFor(support: WorkshopSupport, tags: string[]): WorkshopKind {
  if (support.mode === 'zomboid' || support.mode === 'ark' || support.mode === 'arma') return 'mod';
  const t = tags.map((x) => x.toLowerCase());
  if (t.includes('map')) return 'map';
  if (t.includes('mod')) return 'mod';
  return 'item';
}

export function workshopSupportOf(server: ServerRecord): WorkshopSupport | null {
  return server.platform === 'steam' ? findPresetFor(server)?.workshop ?? null : null;
}

function requireSupport(server: ServerRecord): WorkshopSupport {
  const support = workshopSupportOf(server);
  if (!support) throw new HttpError(400, 'This game doesn’t have Workshop support in Outpost yet');
  return support;
}

function save(serverId: string, state: WorkshopState) {
  setWorkshopState(serverId, JSON.stringify(state));
}

/** What the browser sees: never the account password. */
export function publicState(state: WorkshopState) {
  return { items: state.items, activeMod: state.activeMod, startMap: state.startMap, loginUser: state.login ? state.login.split(/\s+/)[0] : null };
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export async function addItems(server: ServerRecord, input: string): Promise<{ added: WorkshopItem[]; skipped: { id: string; reason: string }[] }> {
  const support = requireSupport(server);
  const ids = await expandCollections(parseWorkshopIds(input));
  if (!ids.length) throw new HttpError(400, 'Paste Workshop item IDs or links (a collection link adds everything in it)');
  const state = workshopStateOf(server);
  const skipped: { id: string; reason: string }[] = [];
  const fresh = ids.filter((id) => {
    if (state.items.some((i) => i.id === id)) {
      skipped.push({ id, reason: 'already in the list' });
      return false;
    }
    return true;
  });
  if (state.items.length + fresh.length > MAX_ITEMS) throw new HttpError(400, `At most ${MAX_ITEMS} Workshop items per instance`);
  const details = await fetchDetails(fresh);
  const added: WorkshopItem[] = [];
  for (const d of details) {
    if (!d.found) {
      skipped.push({ id: d.id, reason: 'not found (private, removed, or not a Workshop item)' });
      continue;
    }
    if (d.appId !== support.appId) {
      skipped.push({ id: d.id, reason: `“${d.title}” is for a different game` });
      continue;
    }
    added.push({
      id: d.id,
      title: d.title,
      kind: kindFor(support, d.tags),
      folder: null,
      modIds: support.mode === 'zomboid' ? zomboidModIds(d.description) : [],
      sizeBytes: d.sizeBytes,
      previewUrl: d.previewUrl,
      updatedAt: d.updatedAt,
      installedAt: null,
      status: 'pending',
      error: null,
    });
  }
  state.items.push(...added);
  save(server.id, state);
  return { added, skipped };
}

export function updateItem(server: ServerRecord, itemId: string, patch: { kind?: unknown; modIds?: unknown; move?: unknown }): WorkshopState {
  const support = requireSupport(server);
  const state = workshopStateOf(server);
  const item = state.items.find((i) => i.id === itemId);
  if (!item) throw new HttpError(404, 'Not in the list');
  // Load order: ARK and Arma load mods in list order, Zomboid in Mods= order.
  if (patch.move === 'up' || patch.move === 'down') {
    const from = state.items.indexOf(item);
    const to = patch.move === 'up' ? from - 1 : from + 1;
    if (to >= 0 && to < state.items.length) {
      [state.items[from], state.items[to]] = [state.items[to], state.items[from]];
    }
  }
  if (patch.kind === 'map' || patch.kind === 'mod') {
    if (item.kind !== patch.kind && item.status === 'installed') item.status = 'pending'; // reinstall in the other folder
    item.kind = patch.kind;
  }
  if (Array.isArray(patch.modIds)) {
    item.modIds = patch.modIds.map(String).map((s) => s.trim()).filter((s) => /^\\?[\w .\-'&+]{1,80}$/.test(s));
  }
  save(server.id, state);
  if (patch.move !== undefined && support.mode === 'zomboid' && state.written) writeZomboidIni(server, state, false);
  return state;
}

export function removeItem(server: ServerRecord, itemId: string): WorkshopState {
  const support = requireSupport(server);
  const state = workshopStateOf(server);
  const item = state.items.find((i) => i.id === itemId);
  if (!item) throw new HttpError(404, 'Not in the list');
  if (item.folder) {
    const base =
      support.mode === 'bo3' ? bo3Dir(server, item.kind === 'mod' ? 'mods' : 'usermaps') : support.mode === 'gmod' ? gmodAddonsDir(server) : support.mode === 'arma' ? instanceDir(server.id) : null;
    if (base) {
      const target = path.resolve(base, item.folder);
      if (target.startsWith(base + path.sep)) fs.rmSync(target, { recursive: true, force: true });
    }
  }
  state.items = state.items.filter((i) => i.id !== itemId);
  if (state.activeMod === itemId) state.activeMod = null;
  if (item.folder && state.startMap === item.folder) state.startMap = null;
  save(server.id, state);
  if (support.mode === 'zomboid') writeZomboidIni(server, state, false);
  if (support.mode === 'gmod') writeGmodWorkshopLua(server, state);
  return state;
}

export function setOptions(server: ServerRecord, opts: { activeMod?: unknown; startMap?: unknown }): WorkshopState {
  const support = requireSupport(server);
  if (support.mode !== 'bo3') throw new HttpError(400, 'Nothing to choose for this game');
  const state = workshopStateOf(server);
  if (opts.activeMod !== undefined) {
    if (opts.activeMod !== null && !state.items.some((i) => i.id === opts.activeMod && i.kind === 'mod' && i.status === 'installed')) {
      throw new HttpError(400, 'Pick an installed mod');
    }
    state.activeMod = (opts.activeMod as string | null) ?? null;
  }
  if (opts.startMap !== undefined) {
    if (opts.startMap !== null && !state.items.some((i) => i.folder === opts.startMap && i.kind === 'map' && i.status === 'installed')) {
      throw new HttpError(400, 'Pick an installed map');
    }
    state.startMap = (opts.startMap as string | null) ?? null;
  }
  save(server.id, state);
  return state;
}

/** "user password" for games whose items need an account that owns the game; null removes it. */
export function setLogin(server: ServerRecord, login: unknown): WorkshopState {
  requireSupport(server);
  const state = workshopStateOf(server);
  if (login === null || login === '') state.login = null;
  else if (typeof login === 'string' && /^account:[0-9a-f-]{36}$/i.test(login)) state.login = login;
  else {
    if (typeof login === 'string' && login.startsWith('account:')) throw new HttpError(400, 'Choose a saved Steam account without a manual password');
    if (typeof login !== 'string' || !/^\S{2,64}\s+\S.{0,200}$/.test(login.trim())) throw new HttpError(400, 'Enter the Steam username and password');
    state.login = login.trim();
  }
  save(server.id, state);
  return state;
}

// ---------------------------------------------------------------------------
// Project Zomboid: the server's .ini
// ---------------------------------------------------------------------------

function zomboidServerName(server: ServerRecord): string {
  const m = server.extra_args.match(/-servername\s+(\S+)/);
  return m ? m[1] : 'servertest';
}

function zomboidIniPath(server: ServerRecord): string {
  return path.join(instanceDir(server.id), 'Zomboid', 'Server', `${zomboidServerName(server)}.ini`);
}

function readIniList(text: string, key: string): string[] {
  const m = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m ? m[1].split(';').map((s) => s.trim()).filter(Boolean) : [];
}

function setIniLine(text: string, key: string, value: string): string {
  const re = new RegExp(`^${key}=.*$`, 'm');
  return re.test(text) ? text.replace(re, `${key}=${value}`) : `${text.replace(/\s*$/, '\n')}${key}=${value}\n`;
}

export function zomboidIniInfo(server: ServerRecord): { found: boolean; path: string; workshopItems: string[] } {
  const file = zomboidIniPath(server);
  if (!fs.existsSync(file)) return { found: false, path: path.relative(instanceDir(server.id), file), workshopItems: [] };
  return { found: true, path: path.relative(instanceDir(server.id), file), workshopItems: readIniList(fs.readFileSync(file, 'utf8'), 'WorkshopItems') };
}

/**
 * Writes the list into WorkshopItems= and Mods=. Entries that weren't added through Outpost are
 * kept; ones for items removed from the list are dropped. Mod ids follow the file's existing style
 * (Build 42 writes them with a leading backslash).
 */
function writeZomboidIni(server: ServerRecord, state: WorkshopState, strict: boolean): void {
  const file = zomboidIniPath(server);
  if (!fs.existsSync(file)) {
    if (strict) throw new HttpError(409, `Start the server once so it creates ${path.relative(instanceDir(server.id), file)}, then apply again`);
    return;
  }
  let text = fs.readFileSync(file, 'utf8');
  const knownIds = new Set(state.items.map((i) => i.id));
  const managedMods = new Set(state.items.flatMap((i) => i.modIds.map((m) => m.replace(/^\\/, ''))));
  // What Outpost wrote last time — kept in its own database, because the game rewrites the .ini on start.
  const prevItems = new Set(state.written?.items ?? []);
  const prevMods = new Set(state.written?.mods ?? []);

  const existingItems = readIniList(text, 'WorkshopItems');
  const existingMods = readIniList(text, 'Mods');
  const bareExisting = new Set(existingMods.map((m) => m.replace(/^\\/, '')));
  const backslash = existingMods.some((m) => m.startsWith('\\'));
  const style = (m: string) => (backslash && !m.startsWith('\\') ? `\\${m}` : m);

  // Keep hand-added entries; drop ones Outpost added before that are no longer in the list.
  const items = [...new Set([...existingItems.filter((id) => !prevItems.has(id) || knownIds.has(id)), ...knownIds])];
  const mods = [
    ...existingMods.filter((m) => {
      const bare = m.replace(/^\\/, '');
      return !prevMods.has(bare) || managedMods.has(bare);
    }),
    ...[...managedMods].filter((m) => !bareExisting.has(m)).map(style),
  ];
  text = setIniLine(text, 'WorkshopItems', items.join(';'));
  text = setIniLine(text, 'Mods', mods.join(';'));
  fs.writeFileSync(file, text);
  state.written = { items: [...knownIds], mods: [...managedMods] };
  save(server.id, state);
}

/** Adds the Workshop items already listed in the server's .ini to the list. */
export async function importFromZomboidIni(server: ServerRecord) {
  const info = zomboidIniInfo(server);
  if (!info.found) throw new HttpError(409, 'The server hasn’t created its settings file yet — start it once first');
  if (!info.workshopItems.length) throw new HttpError(400, 'The settings file doesn’t list any Workshop items');
  return addItems(server, info.workshopItems.join(' '));
}

// ---------------------------------------------------------------------------
// Black Ops III: download + install
// ---------------------------------------------------------------------------

function bo3Dir(server: ServerRecord, sub: 'usermaps' | 'mods'): string {
  return path.join(instanceDir(server.id), 'UnrankedServer', sub);
}

const SAFE_FOLDER = /^[A-Za-z0-9_\-]{1,64}$/;

/** A BO3 map's codename (e.g. zm_prison): from workshop.json, else from its zone/*.ff files. */
export function bo3MapCodename(contentDir: string): string | null {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(contentDir, 'workshop.json'), 'utf8')) as Record<string, unknown>;
    const name = meta.FolderName ?? meta.folderName;
    if (typeof name === 'string' && SAFE_FOLDER.test(name)) return name;
  } catch {
    // no / unreadable workshop.json
  }
  const zone = path.join(contentDir, 'zone');
  if (!fs.existsSync(zone)) return null;
  const counts = new Map<string, number>();
  for (const f of fs.readdirSync(zone)) {
    const m = f.match(/^(?:en_)?((?:zm|mp|cp)_[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*?)(?:_patch)?\.ff$/i);
    if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

function moveInto(from: string, to: string) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch {
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Garry's Mod: .gma into garrysmod/addons
// ---------------------------------------------------------------------------

function gmodAddonsDir(server: ServerRecord): string {
  return path.join(instanceDir(server.id), 'garrysmod', 'addons');
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** Older Garry's Mod items arrive as an LZMA-compressed .gma ("…_legacy.bin"); xz unpacks those. */
function unLzma(file: string, target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(target);
    const child = spawn('xz', ['--format=lzma', '--decompress', '--stdout', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stdout.pipe(out);
    child.stderr.on('data', (c: Buffer) => (err += c.toString()));
    child.on('error', (e: NodeJS.ErrnoException) => {
      out.destroy();
      fs.rmSync(target, { force: true });
      reject(new Error(e.code === 'ENOENT' ? 'this item is compressed and needs “xz” to unpack (e.g. sudo apt install xz-utils)' : e.message));
    });
    child.on('close', (code) => {
      out.end(() => {
        if (code === 0) resolve();
        else {
          fs.rmSync(target, { force: true });
          reject(new Error(`couldn’t unpack the item (${err.trim() || `xz exited with ${code}`})`));
        }
      });
    });
  });
}

export async function installGmodItem(server: ServerRecord, itemId: string, contentDir: string): Promise<string> {
  const addons = gmodAddonsDir(server);
  fs.mkdirSync(addons, { recursive: true });
  const folder = `workshop_${itemId}.gma`;
  const target = path.join(addons, folder);
  const files = filesUnder(contentDir);
  const gma = files.find((f) => /\.gma$/i.test(f));
  const bin = files.find((f) => /\.bin$/i.test(f));
  if (gma) fs.copyFileSync(gma, target);
  else if (bin) {
    // Some .bin files are a plain .gma already; the rest are LZMA.
    const head = Buffer.alloc(4);
    const fd = fs.openSync(bin, 'r');
    fs.readSync(fd, head, 0, 4, 0);
    fs.closeSync(fd);
    if (head.toString('latin1') === 'GMAD') fs.copyFileSync(bin, target);
    else await unLzma(bin, target);
  } else throw new Error('the download has no .gma addon in it');
  const fd = fs.openSync(target, 'r');
  const head = Buffer.alloc(4);
  fs.readSync(fd, head, 0, 4, 0);
  fs.closeSync(fd);
  if (head.toString('latin1') !== 'GMAD') {
    fs.rmSync(target, { force: true });
    throw new Error('the unpacked file isn’t a Garry’s Mod addon');
  }
  return folder;
}

/** resource.AddWorkshop for every item, so players joining download the same content. */
export function writeGmodWorkshopLua(server: ServerRecord, state: WorkshopState) {
  const file = path.join(instanceDir(server.id), 'garrysmod', 'lua', 'autorun', 'server', 'outpost_workshop.lua');
  const ids = state.items.filter((i) => i.status === 'installed').map((i) => i.id);
  if (!ids.length) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    ['-- Written by Outpost (Workshop tab) — players download these Workshop items when they join.', ...ids.map((id) => `resource.AddWorkshop("${id}")`), ''].join('\n')
  );
}

// ---------------------------------------------------------------------------
// Arma 3: @<id> folders + keys
// ---------------------------------------------------------------------------

/** Arma on Linux only finds files with lower-case names. Children first, so paths stay valid. */
export function lowercaseTree(dir: string) {
  // Compare against the listing, not existsSync: on a case-insensitive disk the lower-case name always "exists".
  const names = new Set(fs.readdirSync(dir));
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) lowercaseTree(p);
    const lower = e.name.toLowerCase();
    if (lower === e.name || names.has(lower)) continue;
    fs.renameSync(p, path.join(dir, lower));
    names.delete(e.name);
    names.add(lower);
  }
}

export function installArmaItem(server: ServerRecord, itemId: string, contentDir: string): string {
  const root = instanceDir(server.id);
  const folder = `@${itemId}`;
  const dest = path.join(root, folder);
  moveInto(contentDir, dest);
  if (process.platform !== 'win32') lowercaseTree(dest);
  // Servers with verifySignatures need each mod's .bikey in keys/.
  const keys = path.join(root, 'keys');
  for (const e of fs.readdirSync(dest, { withFileTypes: true })) {
    if (!e.isDirectory() || !/^keys?$/i.test(e.name)) continue;
    for (const k of fs.readdirSync(path.join(dest, e.name))) {
      if (!/\.bikey$/i.test(k)) continue;
      fs.mkdirSync(keys, { recursive: true });
      fs.copyFileSync(path.join(dest, e.name, k), path.join(keys, k.toLowerCase()));
    }
  }
  return folder;
}

const applying = new Set<string>();
export const isApplying = (serverId: string) => applying.has(serverId);

/**
 * Brings the server in line with the list. Zomboid: rewrites the .ini (instant). BO3: downloads and
 * installs every item that's new, failed or updated on Steam — in the background, logged to the
 * console, since maps can be several GB.
 */
export async function applyWorkshop(server: ServerRecord, opts: { guardCode?: string }): Promise<{ background: boolean; message: string }> {
  const support = requireSupport(server);
  const state = workshopStateOf(server);
  if (SELF_DOWNLOADING.has(support.mode)) {
    if (support.mode === 'zomboid') writeZomboidIni(server, state, true);
    const now = Math.floor(Date.now() / 1000);
    for (const i of state.items) {
      i.status = 'installed';
      i.installedAt = now;
      i.error = null;
    }
    save(server.id, state);
    if (support.mode === 'ark') {
      return { background: false, message: `Saved ${state.items.length} mod(s). ARK downloads them itself on its next start (-automanagedmods) — the first start takes longer.` };
    }
    const missing = state.items.filter((i) => !i.modIds.length).length;
    return {
      background: false,
      message: `Saved to ${zomboidIniInfo(server).path}. The server downloads the items itself on its next start.${missing ? ` ${missing} item(s) have no Mod ID yet — add one so they load.` : ''}`,
    };
  }

  // Outpost downloads: bo3, gmod, arma
  if (support.needsLogin && !state.login) throw new HttpError(400, 'Add a Steam account that owns the game first — Workshop downloads need one');
  if (applying.has(server.id)) throw new HttpError(409, 'Already downloading — watch the console for progress');
  const todo = state.items.filter((i) => i.status !== 'installed' || (i.installedAt ?? 0) < i.updatedAt);
  if (!todo.length) return { background: false, message: 'Everything is installed and up to date.' };
  applying.add(server.id);
  void (async () => {
    const log = (line: string) => appendLine(server.id, line, 'system');
    const work = path.join(instanceDir(server.id), '_workshop');
    let guard = opts.guardCode;
    try {
      for (const item of todo) {
        log(`[Outpost] Workshop: downloading “${item.title}” (${item.id})…`);
        const current = workshopStateOf(getServer(server.id) ?? server);
        const entry = current.items.find((i) => i.id === item.id);
        if (!entry) continue; // removed meanwhile
        try {
          const contentDir = await steamWorkshopDownload(support.appId, item.id, work, { login: state.login ?? 'anonymous', guardCode: guard, onLog: log });
          guard = undefined; // only valid once; steamcmd keeps the session afterwards
          let folder: string;
          if (support.mode === 'gmod') {
            folder = await installGmodItem(server, item.id, contentDir);
          } else if (support.mode === 'arma') {
            folder = installArmaItem(server, item.id, contentDir);
          } else if (entry.kind === 'map') {
            const codename = bo3MapCodename(contentDir);
            if (!codename) throw new Error('couldn’t tell the map’s codename (no workshop.json or zone/*.ff) — mark it as a mod if that’s what it is');
            folder = codename;
            moveInto(contentDir, path.join(bo3Dir(server, 'usermaps'), folder));
          } else {
            folder = item.id;
            moveInto(contentDir, path.join(bo3Dir(server, 'mods'), folder));
          }
          Object.assign(entry, { folder, status: 'installed', installedAt: Math.floor(Date.now() / 1000), error: null });
          log(`[Outpost] Workshop: installed “${item.title}” → ${installedPath(support, entry.kind, folder)}`);
        } catch (err) {
          Object.assign(entry, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
          log(`[Outpost] Workshop: “${item.title}” failed — ${entry.error}`);
        }
        save(server.id, current);
      }
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
      if (support.mode === 'gmod') writeGmodWorkshopLua(server, workshopStateOf(getServer(server.id) ?? server));
      applying.delete(server.id);
      log('[Outpost] Workshop: done. Restart the server to load new content.');
    }
  })();
  return { background: true, message: `Downloading ${todo.length} item(s) — progress shows in the console.` };
}

/** Where an installed item lives, relative to the instance (for logs and the UI). */
export function installedPath(support: WorkshopSupport, kind: WorkshopKind, folder: string): string {
  switch (support.mode) {
    case 'gmod':
      return `garrysmod/addons/${folder}`;
    case 'arma':
      return folder;
    case 'bo3':
      return kind === 'map' ? `UnrankedServer/usermaps/${folder}` : `UnrankedServer/mods/${folder}`;
    default:
      return folder;
  }
}
