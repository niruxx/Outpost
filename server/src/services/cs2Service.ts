import fs from 'node:fs';
import path from 'node:path';
import { prep } from '../db/db.js';
import { HttpError } from '../utils/asyncHandler.js';
import { instanceDir } from '../utils/paths.js';
import type { ServerRecord } from '../types/index.js';

/**
 * Counter-Strike 2 settings: game mode, map (official or Workshop), server identity, bots, presets
 * (surf, bhop, practice…) and cvar overrides.
 *
 * How they reach the game:
 *  - launch arguments: +game_type/+game_mode, the start map (+map or +host_workshop_map), +host_workshop_collection,
 *    -maxplayers, +sv_setsteamaccount (GSLT), +sv_lan
 *  - game/csgo/cfg/outpost.cfg: every cvar (hostname, password, bots, preset, overrides), executed from
 *    server.cfg and from gamemode_<mode>_server.cfg — CS2 runs those on every map load, after the
 *    mode's own defaults, so map changes don't undo the settings.
 */

export type Cs2Mode = 'casual' | 'competitive' | 'wingman' | 'deathmatch' | 'armsrace' | 'custom';

export const MODES: Record<Cs2Mode, { label: string; type: number; mode: number; cfg: string; maxPlayers: number }> = {
  casual: { label: 'Casual', type: 0, mode: 0, cfg: 'gamemode_casual', maxPlayers: 20 },
  competitive: { label: 'Competitive', type: 0, mode: 1, cfg: 'gamemode_competitive', maxPlayers: 10 },
  wingman: { label: 'Wingman', type: 0, mode: 2, cfg: 'gamemode_competitive2v2', maxPlayers: 4 },
  deathmatch: { label: 'Deathmatch', type: 1, mode: 2, cfg: 'gamemode_deathmatch', maxPlayers: 16 },
  armsrace: { label: 'Arms Race', type: 1, mode: 0, cfg: 'gamemode_armsrace', maxPlayers: 10 },
  custom: { label: 'Custom (surf, bhop, community)', type: 3, mode: 0, cfg: 'gamemode_custom', maxPlayers: 32 },
};

export interface Cs2Settings {
  mode: Cs2Mode;
  /** Official map name (de_dust2…), used when no Workshop map is set. */
  map: string;
  /** Workshop map id to start on (host_workshop_map). */
  workshopMap: string | null;
  /** Workshop collection id (host_workshop_collection) — its maps are available to changelevel/votes. */
  workshopCollection: string | null;
  hostname: string;
  password: string;
  maxPlayers: number;
  /** Game Server Login Token — needed to be listed publicly (steamcommunity.com/dev/managegameservers, app 730). */
  gslt: string;
  lan: boolean;
  bots: { quota: number; difficulty: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7; fill: boolean; joinAfterPlayer: boolean };
  preset: string | null;
  /** Extra cvars (key → value), applied last. */
  cvars: Record<string, string>;
  /** CounterStrikeSharp admins (SteamID64) — written to its admins.json when it's installed. */
  admins: string[];
}

export const DEFAULTS: Cs2Settings = {
  mode: 'casual',
  map: 'de_dust2',
  workshopMap: null,
  workshopCollection: null,
  hostname: '',
  password: '',
  maxPlayers: 20,
  gslt: '',
  lan: false,
  bots: { quota: 0, difficulty: 2, fill: true, joinAfterPlayer: true },
  preset: null,
  cvars: {},
  admins: [],
};

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

/** Movement settings shared by surf and bhop: no stamina loss on jumps, no fall damage, no velocity clamp. */
const MOVEMENT = {
  sv_enablebunnyhopping: '1',
  sv_staminamax: '0',
  sv_staminajumpcost: '0',
  sv_staminalandcost: '0',
  sv_staminarecoveryrate: '0',
  sv_falldamage_scale: '0',
  sv_maxvelocity: '3500',
  sv_clamp_unsafe_velocities: '0',
  sv_accelerate: '10',
  sv_friction: '4',
  sv_wateraccelerate: '10',
};

/** Round flow for "play forever" community modes: respawn, no warmup/freeze, rounds never end. */
const ENDLESS = {
  mp_roundtime: '60',
  mp_roundtime_defuse: '60',
  mp_roundtime_hostage: '60',
  mp_freezetime: '0',
  mp_warmuptime: '0',
  mp_do_warmup_period: '0',
  mp_respawn_on_death_ct: '1',
  mp_respawn_on_death_t: '1',
  mp_ignore_round_win_conditions: '1',
  mp_timelimit: '30',
  mp_maxrounds: '0',
  mp_solid_teammates: '0',
  mp_autokick: '0',
  mp_autoteambalance: '0',
  mp_limitteams: '0',
  mp_death_drop_gun: '0',
  mp_free_armor: '0',
  sv_alltalk: '1',
  sv_full_alltalk: '1',
  sv_deadtalk: '1',
  bot_quota: '0',
};

export interface Cs2Preset {
  id: string;
  label: string;
  description: string;
  mode: Cs2Mode;
  maxPlayers: number;
  bots: Cs2Settings['bots'];
  cvars: Record<string, string>;
  /** Shown after applying (e.g. "add a surf map from the Workshop"). */
  tip?: string;
}

export const PRESETS: Cs2Preset[] = [
  {
    id: 'surf',
    label: 'Surf',
    description: 'Air-strafe down ramps: high air acceleration, no velocity clamp, no stamina or fall damage, endless respawning rounds.',
    mode: 'custom',
    maxPlayers: 32,
    bots: { quota: 0, difficulty: 0, fill: false, joinAfterPlayer: true },
    cvars: { ...MOVEMENT, ...ENDLESS, sv_airaccelerate: '150', sv_autobunnyhopping: '0' },
    tip: 'Surf needs surf maps — paste a Workshop surf map (e.g. search "surf" on the CS2 Workshop) or a collection below. Timers, zones and !r need plugins (CounterStrikeSharp + a surf timer).',
  },
  {
    id: 'bhop',
    label: 'Bhop',
    description: 'Bunny hopping: auto-bhop when holding jump, very high air acceleration, no stamina penalties, endless rounds.',
    mode: 'custom',
    maxPlayers: 32,
    bots: { quota: 0, difficulty: 0, fill: false, joinAfterPlayer: true },
    cvars: { ...MOVEMENT, ...ENDLESS, sv_airaccelerate: '1000', sv_autobunnyhopping: '1' },
    tip: 'Add a bhop map from the Workshop below. Timers and checkpoints need plugins (CounterStrikeSharp + a bhop timer).',
  },
  {
    id: 'practice',
    label: 'Practice',
    description: 'Solo or team practice: cheats on, infinite ammo, grenade trajectories, buy anywhere with max money, no round end.',
    mode: 'casual',
    maxPlayers: 10,
    bots: { quota: 0, difficulty: 2, fill: false, joinAfterPlayer: true },
    cvars: {
      ...ENDLESS,
      sv_cheats: '1',
      sv_infinite_ammo: '1',
      ammo_grenade_limit_total: '5',
      sv_grenade_trajectory_prac_pipreview: '1',
      sv_showimpacts: '1',
      mp_buy_anywhere: '1',
      mp_buytime: '9999',
      mp_maxmoney: '60000',
      mp_startmoney: '60000',
      mp_free_armor: '1',
      bot_stop: '1',
    },
  },
  {
    id: 'competitive',
    label: 'Competitive 5v5',
    description: 'Standard MR12 competitive: 24 rounds, overtime, no bots, 10 slots.',
    mode: 'competitive',
    maxPlayers: 10,
    bots: { quota: 0, difficulty: 2, fill: false, joinAfterPlayer: true },
    cvars: { mp_maxrounds: '24', mp_overtime_enable: '1', mp_overtime_maxrounds: '6', mp_freezetime: '15', mp_warmuptime: '60', mp_autokick: '0' },
  },
  {
    id: 'deathmatch',
    label: 'Deathmatch',
    description: 'Free-for-all respawning deathmatch with bots filling empty slots, 10-minute rounds.',
    mode: 'deathmatch',
    maxPlayers: 16,
    bots: { quota: 10, difficulty: 3, fill: true, joinAfterPlayer: false },
    cvars: { mp_timelimit: '10', mp_teammates_are_enemies: '1' },
  },
  {
    id: 'casual',
    label: 'Casual (defaults)',
    description: 'Valve’s casual rules with no extra tweaks — a clean slate.',
    mode: 'casual',
    maxPlayers: 20,
    bots: { quota: 0, difficulty: 2, fill: true, joinAfterPlayer: true },
    cvars: {},
  },
];

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export function isCs2(server: Pick<ServerRecord, 'platform' | 'steam_preset' | 'steam_app_id'>): boolean {
  return server.platform === 'steam' && (server.steam_preset === 'cs2' || (!server.steam_preset && server.steam_app_id === '730'));
}

export function cs2SettingsOf(server: Pick<ServerRecord, 'game_settings'>): Cs2Settings {
  let raw: Partial<Cs2Settings> = {};
  try {
    raw = server.game_settings ? (JSON.parse(server.game_settings) as Partial<Cs2Settings>) : {};
  } catch {
    // defaults
  }
  return { ...DEFAULTS, ...raw, bots: { ...DEFAULTS.bots, ...(raw.bots ?? {}) }, cvars: { ...(raw.cvars ?? {}) }, admins: [...(raw.admins ?? [])] };
}

const CVAR = /^[a-z_][a-z0-9_]{1,63}$/i;
const VALUE = /^[^\r\n";]{0,200}$/;
const MAP = /^[a-z0-9_]{2,64}$/i;
const STEAMID64 = /^7656119\d{10}$/;

/** "https://steamcommunity.com/sharedfiles/filedetails/?id=123" or "123" → "123". */
export function workshopId(input: unknown): string | null {
  if (input === null || input === undefined || input === '') return null;
  const m = String(input).match(/(?:[?&]id=)?(\d{6,12})/);
  if (!m) throw new HttpError(400, 'Workshop maps and collections are a Steam Workshop link or a numeric ID');
  return m[1];
}

export function saveCs2Settings(server: ServerRecord, input: Record<string, unknown>): Cs2Settings {
  const cur = cs2SettingsOf(server);
  const next: Cs2Settings = { ...cur, bots: { ...cur.bots }, cvars: { ...cur.cvars } };
  if (input.mode !== undefined) {
    if (!(String(input.mode) in MODES)) throw new HttpError(400, 'Unknown game mode');
    next.mode = input.mode as Cs2Mode;
  }
  if (input.map !== undefined) {
    if (!MAP.test(String(input.map))) throw new HttpError(400, 'Map names look like de_dust2');
    next.map = String(input.map);
  }
  if (input.workshopMap !== undefined) next.workshopMap = workshopId(input.workshopMap);
  if (input.workshopCollection !== undefined) next.workshopCollection = workshopId(input.workshopCollection);
  for (const key of ['hostname', 'password', 'gslt'] as const) {
    if (input[key] === undefined) continue;
    const v = String(input[key]).trim();
    if (v.length > 120 || /["\r\n;]/.test(v)) throw new HttpError(400, `${key} can’t contain quotes, semicolons or line breaks`);
    next[key] = v;
  }
  if (input.gslt !== undefined && next.gslt && !/^[A-F0-9]{32}$/i.test(next.gslt)) throw new HttpError(400, 'A Game Server Login Token is 32 hex characters');
  if (input.maxPlayers !== undefined) {
    const n = Number(input.maxPlayers);
    if (!Number.isInteger(n) || n < 2 || n > 64) throw new HttpError(400, 'Max players must be 2–64');
    next.maxPlayers = n;
  }
  if (input.lan !== undefined) next.lan = input.lan === true;
  if (input.bots && typeof input.bots === 'object') {
    const b = input.bots as Record<string, unknown>;
    const quota = b.quota === undefined ? next.bots.quota : Number(b.quota);
    const diff = b.difficulty === undefined ? next.bots.difficulty : Number(b.difficulty);
    if (!Number.isInteger(quota) || quota < 0 || quota > 64) throw new HttpError(400, 'Bots must be 0–64');
    if (!Number.isInteger(diff) || diff < 0 || diff > 7) throw new HttpError(400, 'Bot difficulty is 0–7');
    next.bots = { quota, difficulty: diff as Cs2Settings['bots']['difficulty'], fill: b.fill === undefined ? next.bots.fill : b.fill === true, joinAfterPlayer: b.joinAfterPlayer === undefined ? next.bots.joinAfterPlayer : b.joinAfterPlayer === true };
  }
  if (input.cvars && typeof input.cvars === 'object') {
    const cv: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.cvars as Record<string, unknown>)) {
      if (!k.trim()) continue;
      if (!CVAR.test(k)) throw new HttpError(400, `“${k}” isn’t a cvar name`);
      if (!VALUE.test(String(v))) throw new HttpError(400, `The value for ${k} can’t contain quotes, semicolons or line breaks`);
      if (/^(rcon_password|sv_setsteamaccount|exec|alias|quit|exit|_restart)$/i.test(k)) throw new HttpError(400, `${k} can’t be set here`);
      cv[k] = String(v);
    }
    if (Object.keys(cv).length > 200) throw new HttpError(400, 'At most 200 cvars');
    next.cvars = cv;
  }
  if (input.preset !== undefined) next.preset = input.preset === null ? null : String(input.preset).slice(0, 40);
  if (Array.isArray(input.admins)) {
    const ids = [...new Set(input.admins.map((s) => String(s).trim()).filter(Boolean))];
    const bad = ids.find((s) => !STEAMID64.test(s));
    if (bad) throw new HttpError(400, `${bad} isn’t a SteamID64 (17 digits starting 7656119…) — find yours at steamid.io`);
    next.admins = ids.slice(0, 50);
  }
  prep('UPDATE servers SET game_settings = ? WHERE id = ?').run(JSON.stringify(next), server.id);
  return next;
}

/** A preset sets the mode, slots, bots and its cvars. The previous preset's untouched values are replaced; values you set yourself are kept. */
export function applyPreset(server: ServerRecord, presetId: string): { settings: Cs2Settings; preset: Cs2Preset } {
  const preset = PRESETS.find((p) => p.id === presetId);
  if (!preset) throw new HttpError(404, 'Unknown preset');
  const cur = cs2SettingsOf(server);
  const previous = PRESETS.find((p) => p.id === cur.preset);
  const own = Object.fromEntries(Object.entries(cur.cvars).filter(([k, v]) => !previous || previous.cvars[k] !== v));
  const settings = saveCs2Settings(server, {
    mode: preset.mode,
    maxPlayers: preset.maxPlayers,
    bots: preset.bots,
    // Values you changed yourself win over the new preset's.
    cvars: { ...preset.cvars, ...own },
    preset: preset.id,
  });
  return { settings, preset };
}

// ---------------------------------------------------------------------------
// Launch + config files
// ---------------------------------------------------------------------------

export function cs2LaunchArgs(server: ServerRecord): string[] {
  const s = cs2SettingsOf(server);
  const m = MODES[s.mode];
  return [
    '-dedicated',
    '-console',
    '-usercon',
    '-port', String(server.server_port),
    '-maxplayers', String(s.maxPlayers),
    '+game_type', String(m.type),
    '+game_mode', String(m.mode),
    ...(s.workshopCollection ? ['+host_workshop_collection', s.workshopCollection] : []),
    ...(s.workshopMap ? ['+host_workshop_map', s.workshopMap] : ['+map', s.map]),
    ...(s.gslt ? ['+sv_setsteamaccount', s.gslt] : []),
    ...(s.lan ? ['+sv_lan', '1'] : []),
  ];
}

const MARK = '// Managed by Outpost (CS2 tab) — edits here are overwritten. Put your own settings in server.cfg.';

/** All cvars the settings produce, in order (identity, bots, preset, your overrides). */
export function cs2Cvars(s: Cs2Settings): [string, string][] {
  const out: [string, string][] = [];
  if (s.hostname) out.push(['hostname', s.hostname]);
  out.push(['sv_password', s.password]);
  out.push(['bot_quota', String(s.bots.quota)]);
  out.push(['bot_quota_mode', s.bots.fill ? 'fill' : 'normal']);
  out.push(['bot_difficulty', String(s.bots.difficulty)]);
  out.push(['bot_join_after_player', s.bots.joinAfterPlayer ? '1' : '0']);
  if (s.bots.quota === 0) out.push(['bot_kick', '']);
  for (const [k, v] of Object.entries(s.cvars)) out.push([k, v]);
  return out;
}

function writeIfOurs(file: string, content: string) {
  if (fs.existsSync(file)) {
    const cur = fs.readFileSync(file, 'utf8');
    if (!cur.startsWith(MARK)) return false; // someone's own file — leave it
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return true;
}

const EXEC_LINE = 'exec outpost // added by Outpost — applies the CS2 tab settings';

/** Writes cfg/outpost.cfg and makes server.cfg + the mode's gamemode_*_server.cfg run it. Called before every start. */
export function writeCs2Configs(server: ServerRecord): string {
  const s = cs2SettingsOf(server);
  const cfgDir = path.join(instanceDir(server.id), 'game', 'csgo', 'cfg');
  fs.mkdirSync(cfgDir, { recursive: true });
  const lines = cs2Cvars(s).map(([k, v]) => (v === '' && k === 'bot_kick' ? 'bot_kick' : `${k} "${v}"`));
  fs.writeFileSync(path.join(cfgDir, 'outpost.cfg'), [MARK, `// Preset: ${s.preset ?? 'none'} · mode: ${MODES[s.mode].label}`, ...lines, ''].join('\n'));

  const serverCfg = path.join(cfgDir, 'server.cfg');
  const existing = fs.existsSync(serverCfg) ? fs.readFileSync(serverCfg, 'utf8') : '';
  if (!existing.includes('exec outpost')) fs.writeFileSync(serverCfg, `${existing.replace(/\s*$/, existing ? '\n' : '')}${EXEC_LINE}\n`);

  const modeFile = path.join(cfgDir, `${MODES[s.mode].cfg}_server.cfg`);
  writeIfOurs(modeFile, `${MARK}\nexec outpost\n`);
  writeAdmins(server, s);
  return `CS2: ${MODES[s.mode].label}${s.preset ? ` (${PRESETS.find((p) => p.id === s.preset)?.label ?? s.preset} preset)` : ''}, ${s.workshopMap ? `Workshop map ${s.workshopMap}` : s.map}`;
}

// ---------------------------------------------------------------------------
// Maps + CounterStrikeSharp admins
// ---------------------------------------------------------------------------

/** Official maps installed with the server (game/csgo/maps/*.vpk). */
export function installedMaps(server: ServerRecord): string[] {
  const dir = path.join(instanceDir(server.id), 'game', 'csgo', 'maps');
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /^(de|cs|ar|dm|gd|lobby|aim|surf|bhop|kz)_[a-z0-9_]+\.vpk$/i.test(f) && !/(_vanity|_preview|_dir|_\d{3})\.vpk$/i.test(f))
      .map((f) => f.replace(/\.vpk$/i, ''))
      .filter((m) => !m.startsWith('lobby_'))
      .sort();
  } catch {
    return [];
  }
}

const CSS_DIR = (server: ServerRecord) => path.join(instanceDir(server.id), 'game', 'csgo', 'addons', 'counterstrikesharp');

export function hasCounterStrikeSharp(server: ServerRecord): boolean {
  return fs.existsSync(CSS_DIR(server));
}

/** CounterStrikeSharp reads admins from configs/admins.json — Outpost keeps an "outpost_" block of entries in it. */
function writeAdmins(server: ServerRecord, s: Cs2Settings) {
  if (!hasCounterStrikeSharp(server)) return;
  const file = path.join(CSS_DIR(server), 'configs', 'admins.json');
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    // new file
  }
  for (const k of Object.keys(data)) if (k.startsWith('outpost_')) delete data[k];
  s.admins.forEach((id, i) => {
    data[`outpost_${i + 1}`] = { identity: id, flags: ['@css/root'] };
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// Live actions (sent to the running server's console)
// ---------------------------------------------------------------------------

export function liveCommands(server: ServerRecord, action: string, value?: unknown): string[] {
  const s = cs2SettingsOf(server);
  const m = MODES[s.mode];
  switch (action) {
    case 'apply':
      // Re-runs the config now; mode + map take effect with the map reload.
      return ['exec outpost', `game_type ${m.type}`, `game_mode ${m.mode}`, s.workshopMap ? `host_workshop_map ${s.workshopMap}` : `changelevel ${s.map}`];
    case 'changelevel': {
      const v = String(value ?? '');
      if (MAP.test(v)) return [`changelevel ${v}`];
      const id = workshopId(v);
      if (!id) throw new HttpError(400, 'Pick a map');
      return [`host_workshop_map ${id}`];
    }
    case 'restart_round':
      return ['mp_restartgame 1'];
    case 'end_warmup':
      return ['mp_warmup_end'];
    case 'bot_add':
      return ['bot_add'];
    case 'bot_kick':
      return ['bot_kick'];
    case 'reload_cfg':
      return ['exec outpost'];
    default:
      throw new HttpError(400, 'Unknown action');
  }
}

// ---------------------------------------------------------------------------
// Command reference (the Commands panel)
// ---------------------------------------------------------------------------

export interface Cs2Command {
  command: string;
  description: string;
  /** Safe to send from the panel with one click (no arguments needed). */
  oneClick?: boolean;
}

export const COMMANDS: { group: string; commands: Cs2Command[] }[] = [
  {
    group: 'Match',
    commands: [
      { command: 'mp_restartgame 1', description: 'Restart the match in 1 second', oneClick: true },
      { command: 'mp_warmup_end', description: 'End warmup now', oneClick: true },
      { command: 'mp_warmup_start', description: 'Start warmup', oneClick: true },
      { command: 'mp_pause_match', description: 'Pause at the next freeze time', oneClick: true },
      { command: 'mp_unpause_match', description: 'Unpause the match', oneClick: true },
      { command: 'mp_swapteams', description: 'Swap teams (restarts the round)', oneClick: true },
      { command: 'mp_scrambleteams', description: 'Shuffle teams', oneClick: true },
      { command: 'mp_maxrounds 24', description: 'Rounds per match (24 = MR12)' },
      { command: 'mp_roundtime 2', description: 'Round length in minutes' },
      { command: 'mp_freezetime 15', description: 'Freeze time at round start (seconds)' },
      { command: 'mp_buytime 20', description: 'Buy time (seconds)' },
      { command: 'mp_startmoney 800', description: 'Starting money' },
      { command: 'mp_friendlyfire 1', description: 'Friendly fire on (0 = off)' },
      { command: 'mp_autoteambalance 0', description: 'Stop auto-balancing teams' },
      { command: 'mp_limitteams 0', description: 'Allow uneven teams' },
    ],
  },
  {
    group: 'Maps',
    commands: [
      { command: 'changelevel de_dust2', description: 'Change to an official map' },
      { command: 'host_workshop_map 3070284539', description: 'Change to a Workshop map (by ID)' },
      { command: 'host_workshop_collection 1234567890', description: 'Load a Workshop collection' },
      { command: 'ds_workshop_listmaps', description: 'List maps in the loaded collection', oneClick: true },
      { command: 'ds_workshop_changelevel surf_beginner', description: 'Change to a map from the collection' },
      { command: 'maps *', description: 'List installed maps', oneClick: true },
      { command: 'mp_timelimit 30', description: 'Minutes before the map changes (0 = never)' },
    ],
  },
  {
    group: 'Game mode',
    commands: [
      { command: 'game_type 0; game_mode 1', description: 'Competitive (applies on map change)' },
      { command: 'game_type 0; game_mode 0', description: 'Casual' },
      { command: 'game_type 0; game_mode 2', description: 'Wingman' },
      { command: 'game_type 1; game_mode 2', description: 'Deathmatch' },
      { command: 'game_type 1; game_mode 0', description: 'Arms Race' },
      { command: 'game_type 3; game_mode 0', description: 'Custom (surf, bhop, community)' },
    ],
  },
  {
    group: 'Bots',
    commands: [
      { command: 'bot_add', description: 'Add a bot', oneClick: true },
      { command: 'bot_add_ct', description: 'Add a CT bot', oneClick: true },
      { command: 'bot_add_t', description: 'Add a T bot', oneClick: true },
      { command: 'bot_kick', description: 'Kick all bots', oneClick: true },
      { command: 'bot_quota 10', description: 'Number of bots' },
      { command: 'bot_difficulty 3', description: 'Bot skill 0 (easy) – 7 (expert)' },
      { command: 'bot_stop 1', description: 'Freeze bots in place', oneClick: true },
      { command: 'bot_knives_only', description: 'Bots use knives only', oneClick: true },
    ],
  },
  {
    group: 'Players',
    commands: [
      { command: 'status', description: 'Players, IDs, ping and map', oneClick: true },
      { command: 'kickid 2 "reason"', description: 'Kick a player by user ID (from status)' },
      { command: 'banid 0 2', description: 'Ban user ID 2 permanently (0 = minutes, forever)' },
      { command: 'writeid', description: 'Save the ban list', oneClick: true },
      { command: 'listid', description: 'Show banned SteamIDs', oneClick: true },
      { command: 'say Hello!', description: 'Message everyone as the server' },
    ],
  },
  {
    group: 'Practice & movement',
    commands: [
      { command: 'sv_cheats 1', description: 'Allow cheat commands (practice only)' },
      { command: 'sv_infinite_ammo 1', description: 'Infinite ammo' },
      { command: 'sv_grenade_trajectory_prac_pipreview 1', description: 'Grenade trajectory preview' },
      { command: 'sv_airaccelerate 150', description: 'Air acceleration (surf ~150, bhop ~1000)' },
      { command: 'sv_autobunnyhopping 1', description: 'Auto-bhop when holding jump' },
      { command: 'sv_enablebunnyhopping 1', description: 'Remove the bhop speed cap' },
      { command: 'sv_gravity 800', description: 'Gravity (default 800)' },
      { command: 'mp_respawn_on_death_ct 1', description: 'CTs respawn instantly' },
    ],
  },
  {
    group: 'Server',
    commands: [
      { command: 'hostname "My server"', description: 'Server name in the browser' },
      { command: 'sv_password ""', description: 'Join password (empty = none)' },
      { command: 'sv_visiblemaxplayers 10', description: 'Slots shown in the server browser' },
      { command: 'exec outpost', description: 'Re-apply this tab’s settings', oneClick: true },
      { command: 'exec server', description: 'Re-run server.cfg', oneClick: true },
      { command: 'sv_setsteamaccount TOKEN', description: 'Game Server Login Token (set it in the tab instead)' },
      { command: 'sv_lan 1', description: 'LAN only' },
      { command: 'stats', description: 'Server performance', oneClick: true },
    ],
  },
];
