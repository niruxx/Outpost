import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import nbt from 'prismarine-nbt';
import { HttpError } from '../utils/asyncHandler.js';
import { instanceDir } from '../utils/paths.js';
import { readServerProperties } from './propertiesService.js';
import { getOnlinePlayers } from './playerService.js';
import { isRunning } from './processManager.js';
import type { ServerRecord } from '../types/index.js';

/**
 * Offline editing of Java Edition player files (<world>/playerdata/<uuid>.dat).
 *
 * Edits operate on the raw typed NBT tree so every tag we don't understand (custom plugin data,
 * item components, recipe books, …) round-trips untouched. A player who is online holds their
 * data in server memory and would overwrite the file on logout, so edits are refused for them.
 */

type Tag = { type: string; value: any; name?: string };
type Compound = Record<string, Tag>;

export interface PlayerItem {
  slot: number;
  id: string;
  count: number;
  /** True when the stack carries extra data (enchantments, names, components) that is preserved on save. */
  hasExtra?: boolean;
}

export interface PlayerEffect {
  id: string;
  amplifier: number;
  duration: number;
}

export interface PlayerAttribute {
  id: string;
  base: number;
}

export interface PlayerData {
  uuid: string;
  name: string | null;
  online: boolean;
  dataVersion: number | null;
  health: number | null;
  foodLevel: number | null;
  foodSaturation: number | null;
  xpLevel: number | null;
  xpProgress: number | null;
  xpTotal: number | null;
  score: number | null;
  gameMode: number | null;
  selectedSlot: number | null;
  pos: [number, number, number] | null;
  dimension: string | null;
  air: number | null;
  fire: number | null;
  abilities: { flying: boolean; mayfly: boolean; invulnerable: boolean; instabuild: boolean; mayBuild: boolean };
  inventory: PlayerItem[];
  enderItems: PlayerItem[];
  effects: PlayerEffect[];
  attributes: PlayerAttribute[];
}

export interface PlayerSummary {
  uuid: string;
  name: string | null;
  online: boolean;
  modified: number;
}

export type PlayerDataPatch = Partial<
  Pick<PlayerData, 'health' | 'foodLevel' | 'foodSaturation' | 'xpLevel' | 'xpProgress' | 'xpTotal' | 'score' | 'gameMode' | 'selectedSlot' | 'pos' | 'dimension' | 'air' | 'fire' | 'inventory' | 'enderItems' | 'attributes'>
> & {
  abilities?: Partial<PlayerData['abilities']>;
  clearEffects?: boolean;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ITEM_ID_RE = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;
const DIMENSION_RE = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;
/** 1.20.5 (24w14a+) moved stacks from {Count:b, tag:{}} to {count:i, components:{}}. */
const COMPONENTS_DATA_VERSION = 3837;

function requireJava(server: ServerRecord) {
  if (server.platform !== 'java') throw new HttpError(400, 'Player data editing is only available for Java Edition instances');
}

function playerDataDir(server: ServerRecord): string {
  const levelName = readServerProperties(server.id, server.platform).find((p) => p.key === 'level-name')?.value?.trim() || 'world';
  const root = path.resolve(instanceDir(server.id));
  const dir = path.resolve(root, levelName, 'playerdata');
  if (!dir.startsWith(root + path.sep)) throw new HttpError(400, 'Invalid level-name');
  return dir;
}

function playerFile(server: ServerRecord, uuid: string): string {
  if (!UUID_RE.test(uuid)) throw new HttpError(400, 'Invalid player UUID');
  const file = path.join(playerDataDir(server), `${uuid.toLowerCase()}.dat`);
  if (!fs.existsSync(file)) throw new HttpError(404, 'No saved data for this player yet — they need to join the server once.');
  return file;
}

function userCache(server: ServerRecord): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const entries = JSON.parse(fs.readFileSync(path.join(instanceDir(server.id), 'usercache.json'), 'utf8')) as { name: string; uuid: string }[];
    for (const e of entries) if (e?.uuid && e?.name) map.set(e.uuid.toLowerCase(), e.name);
  } catch {
    /* no cache yet */
  }
  return map;
}

function isOnline(server: ServerRecord, name: string | null): boolean {
  if (!name || !isRunning(server.id)) return false;
  return getOnlinePlayers(server.id).some((n) => n.toLowerCase() === name.toLowerCase());
}

export function listPlayerData(server: ServerRecord): PlayerSummary[] {
  requireJava(server);
  const dir = playerDataDir(server);
  if (!fs.existsSync(dir)) return [];
  const names = userCache(server);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.dat') && UUID_RE.test(f.slice(0, -4)))
    .map((f) => {
      const uuid = f.slice(0, -4).toLowerCase();
      const name = names.get(uuid) ?? null;
      return { uuid, name, online: isOnline(server, name), modified: fs.statSync(path.join(dir, f)).mtimeMs };
    })
    .sort((a, b) => (a.name ?? a.uuid).localeCompare(b.name ?? b.uuid));
}

async function readRoot(file: string): Promise<{ root: Tag; gzipped: boolean }> {
  const buf = fs.readFileSync(file);
  const gzipped = buf[0] === 0x1f && buf[1] === 0x8b;
  const { parsed } = await nbt.parse(buf, 'big');
  return { root: parsed as Tag, gzipped };
}

const num = (c: Compound, key: string): number | null => (c[key] && typeof c[key].value === 'number' ? c[key].value : null);
const bool = (c: Compound | undefined, key: string): boolean => !!c?.[key]?.value;

function readItems(c: Compound, key: string): PlayerItem[] {
  const list = c[key]?.value?.value as Compound[] | undefined;
  if (!Array.isArray(list)) return [];
  return list
    .map((it) => ({
      slot: it.Slot?.value ?? 0,
      id: String(it.id?.value ?? 'minecraft:air'),
      count: it.count?.value ?? it.Count?.value ?? 1,
      hasExtra: !!(it.tag || it.components),
    }))
    .sort((a, b) => a.slot - b.slot);
}

function readEffects(c: Compound): PlayerEffect[] {
  const modern = c.active_effects?.value?.value as Compound[] | undefined;
  if (Array.isArray(modern)) return modern.map((e) => ({ id: String(e.id?.value), amplifier: e.amplifier?.value ?? 0, duration: e.duration?.value ?? 0 }));
  const legacy = c.ActiveEffects?.value?.value as Compound[] | undefined;
  if (Array.isArray(legacy)) return legacy.map((e) => ({ id: String(e.id?.value ?? e.Id?.value), amplifier: e.Amplifier?.value ?? 0, duration: e.Duration?.value ?? 0 }));
  return [];
}

function readAttributes(c: Compound): PlayerAttribute[] {
  const modern = c.attributes?.value?.value as Compound[] | undefined;
  if (Array.isArray(modern)) return modern.map((a) => ({ id: String(a.id?.value), base: a.base?.value ?? 0 }));
  const legacy = c.Attributes?.value?.value as Compound[] | undefined;
  if (Array.isArray(legacy)) return legacy.map((a) => ({ id: String(a.Name?.value), base: a.Base?.value ?? 0 }));
  return [];
}

function toPlayerData(server: ServerRecord, uuid: string, root: Tag): PlayerData {
  const c = root.value as Compound;
  const name = userCache(server).get(uuid.toLowerCase()) ?? null;
  const pos = c.Pos?.value?.value as number[] | undefined;
  const dim = c.Dimension?.value;
  const ab = c.abilities?.value as Compound | undefined;
  return {
    uuid: uuid.toLowerCase(),
    name,
    online: isOnline(server, name),
    dataVersion: num(c, 'DataVersion'),
    health: num(c, 'Health'),
    foodLevel: num(c, 'foodLevel'),
    foodSaturation: num(c, 'foodSaturationLevel'),
    xpLevel: num(c, 'XpLevel'),
    xpProgress: num(c, 'XpP'),
    xpTotal: num(c, 'XpTotal'),
    score: num(c, 'Score'),
    gameMode: num(c, 'playerGameType'),
    selectedSlot: num(c, 'SelectedItemSlot'),
    pos: Array.isArray(pos) && pos.length === 3 ? [pos[0], pos[1], pos[2]] : null,
    // Pre-1.16 stored the dimension as an int (-1/0/1).
    dimension: typeof dim === 'string' ? dim : typeof dim === 'number' ? (['minecraft:the_nether', 'minecraft:overworld', 'minecraft:the_end'][dim + 1] ?? null) : null,
    air: num(c, 'Air'),
    fire: num(c, 'Fire'),
    abilities: {
      flying: bool(ab, 'flying'),
      mayfly: bool(ab, 'mayfly'),
      invulnerable: bool(ab, 'invulnerable'),
      instabuild: bool(ab, 'instabuild'),
      mayBuild: bool(ab, 'mayBuild'),
    },
    inventory: readItems(c, 'Inventory'),
    enderItems: readItems(c, 'EnderItems'),
    effects: readEffects(c),
    attributes: readAttributes(c),
  };
}

export async function getPlayerData(server: ServerRecord, uuid: string): Promise<PlayerData> {
  requireJava(server);
  const { root } = await readRoot(playerFile(server, uuid));
  return toPlayerData(server, uuid, root);
}

// ---- writing ----

function finite(v: unknown, label: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new HttpError(400, `${label} must be a number between ${min} and ${max}`);
  return v;
}

/** Sets a numeric tag, keeping the tag's existing NBT type (or `fallbackType` if absent). */
function setNum(c: Compound, key: string, value: number, fallbackType: 'int' | 'float' | 'short' | 'byte' | 'double') {
  const type = c[key]?.type ?? fallbackType;
  const integral = type === 'int' || type === 'short' || type === 'byte';
  c[key] = { type, value: integral ? Math.trunc(value) : value };
}

function writeItems(c: Compound, key: string, items: unknown, dataVersion: number | null, maxSlot: number) {
  if (!Array.isArray(items)) throw new HttpError(400, `${key} must be an array`);
  const modern = (dataVersion ?? 0) >= COMPONENTS_DATA_VERSION;
  const existing = new Map<number, Compound>();
  for (const it of (c[key]?.value?.value as Compound[] | undefined) ?? []) existing.set(it.Slot?.value, it);

  const seen = new Set<number>();
  const out: Compound[] = [];
  for (const raw of items as PlayerItem[]) {
    const slot = finite(raw?.slot, 'Item slot', -128, maxSlot);
    if (!Number.isInteger(slot) || seen.has(slot)) throw new HttpError(400, `Duplicate or invalid slot ${slot}`);
    seen.add(slot);
    const id = String(raw?.id ?? '').trim().toLowerCase();
    const fullId = id.includes(':') ? id : `minecraft:${id}`;
    if (!ITEM_ID_RE.test(fullId)) throw new HttpError(400, `Invalid item id "${raw?.id}"`);
    if (fullId === 'minecraft:air') continue;
    const count = Math.trunc(finite(raw?.count, 'Item count', 1, modern ? 99 : 127));

    const prev = existing.get(slot);
    // Same item in the same slot: keep its enchantments/components, only change the count.
    const item: Compound = prev && prev.id?.value === fullId ? { ...prev } : {};
    item.Slot = { type: 'byte', value: slot };
    item.id = { type: 'string', value: fullId };
    if (modern) {
      delete item.Count;
      item.count = { type: 'int', value: count };
    } else {
      delete item.count;
      item.Count = { type: 'byte', value: count };
    }
    out.push(item);
  }
  c[key] = { type: 'list', value: { type: out.length ? 'compound' : 'end', value: out } };
}

function applyPatch(root: Tag, patch: PlayerDataPatch) {
  const c = root.value as Compound;
  const dataVersion = num(c, 'DataVersion');

  if (patch.health !== undefined) setNum(c, 'Health', finite(patch.health, 'Health', 0, 1024), 'float');
  if (patch.foodLevel !== undefined) setNum(c, 'foodLevel', finite(patch.foodLevel, 'Food level', 0, 20), 'int');
  if (patch.foodSaturation !== undefined) setNum(c, 'foodSaturationLevel', finite(patch.foodSaturation, 'Saturation', 0, 20), 'float');
  if (patch.xpLevel !== undefined) setNum(c, 'XpLevel', finite(patch.xpLevel, 'XP level', 0, 2147483647), 'int');
  if (patch.xpProgress !== undefined) setNum(c, 'XpP', finite(patch.xpProgress, 'XP progress', 0, 1), 'float');
  if (patch.xpTotal !== undefined) setNum(c, 'XpTotal', finite(patch.xpTotal, 'Total XP', 0, 2147483647), 'int');
  if (patch.score !== undefined) setNum(c, 'Score', finite(patch.score, 'Score', 0, 2147483647), 'int');
  if (patch.gameMode !== undefined) {
    const gm = finite(patch.gameMode, 'Game mode', 0, 3);
    setNum(c, 'playerGameType', gm, 'int');
  }
  if (patch.selectedSlot !== undefined) setNum(c, 'SelectedItemSlot', finite(patch.selectedSlot, 'Selected slot', 0, 8), 'int');
  if (patch.air !== undefined) setNum(c, 'Air', finite(patch.air, 'Air', -20, 300), 'short');
  if (patch.fire !== undefined) setNum(c, 'Fire', finite(patch.fire, 'Fire', -32768, 32767), 'short');

  if (patch.pos !== undefined) {
    if (!Array.isArray(patch.pos) || patch.pos.length !== 3) throw new HttpError(400, 'Position must be [x, y, z]');
    const p = patch.pos.map((v, i) => finite(v, `Position ${'xyz'[i]}`, -30_000_000, 30_000_000));
    c.Pos = { type: 'list', value: { type: 'double', value: p } };
  }
  if (patch.dimension !== undefined) {
    if (typeof patch.dimension !== 'string' || !DIMENSION_RE.test(patch.dimension)) throw new HttpError(400, 'Invalid dimension id');
    if (c.Dimension?.type === 'int') {
      const idx = ['minecraft:the_nether', 'minecraft:overworld', 'minecraft:the_end'].indexOf(patch.dimension);
      if (idx < 0) throw new HttpError(400, 'This world version only supports vanilla dimensions');
      c.Dimension = { type: 'int', value: idx - 1 };
    } else {
      c.Dimension = { type: 'string', value: patch.dimension };
    }
  }

  if (patch.abilities) {
    const ab = (c.abilities?.value as Compound | undefined) ?? {};
    for (const key of ['flying', 'mayfly', 'invulnerable', 'instabuild', 'mayBuild'] as const) {
      const v = patch.abilities[key];
      if (v !== undefined) ab[key] = { type: 'byte', value: v ? 1 : 0 };
    }
    c.abilities = { type: 'compound', value: ab };
  }

  if (patch.inventory !== undefined) writeItems(c, 'Inventory', patch.inventory, dataVersion, 150);
  if (patch.enderItems !== undefined) writeItems(c, 'EnderItems', patch.enderItems, dataVersion, 26);

  if (patch.clearEffects) {
    delete c.active_effects;
    delete c.ActiveEffects;
  }

  if (patch.attributes !== undefined) {
    if (!Array.isArray(patch.attributes)) throw new HttpError(400, 'attributes must be an array');
    const modern = c.attributes ? { key: 'attributes', id: 'id', base: 'base' } : c.Attributes ? { key: 'Attributes', id: 'Name', base: 'Base' } : null;
    if (modern) {
      const list = c[modern.key].value.value as Compound[];
      for (const a of patch.attributes) {
        const entry = list.find((e) => e[modern.id]?.value === a?.id);
        if (!entry) throw new HttpError(400, `Unknown attribute "${a?.id}" on this player`);
        entry[modern.base] = { type: 'double', value: finite(a.base, `Attribute ${a.id}`, -1_000_000, 1_000_000) };
      }
    } else if (patch.attributes.length) {
      throw new HttpError(400, 'This player has no saved attributes to edit');
    }
  }
}

export async function updatePlayerData(server: ServerRecord, uuid: string, patch: PlayerDataPatch): Promise<PlayerData> {
  requireJava(server);
  if (!patch || typeof patch !== 'object') throw new HttpError(400, 'Patch body is required');
  const file = playerFile(server, uuid);
  const name = userCache(server).get(uuid.toLowerCase()) ?? null;
  if (isOnline(server, name)) {
    throw new HttpError(409, `${name} is online — the server would overwrite these edits on logout. Kick them first or use the live actions.`);
  }

  const { root, gzipped } = await readRoot(file);
  applyPatch(root, patch);

  const raw = nbt.writeUncompressed(root as any, 'big');
  const out = gzipped ? zlib.gzipSync(raw) : raw;
  // Keep the previous file next to it so a bad edit can be undone by hand.
  fs.copyFileSync(file, `${file}.outpost-bak`);
  const tmp = `${file}.outpost-tmp`;
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, file);

  return toPlayerData(server, uuid, root);
}
