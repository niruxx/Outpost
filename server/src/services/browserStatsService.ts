import { prep } from '../db/db.js';
import { logger } from '../utils/logger.js';
import { HttpError } from '../utils/asyncHandler.js';
import { getServer, listServers } from './serverService.js';
import { activeRcon, rconSend } from './rconService.js';
import { findPresetFor } from './steamGames.js';
import { queryInfo, queryPlayers, type A2sInfo, type A2sPlayer } from './a2sService.js';
import type { ServerRecord } from '../types/index.js';

/**
 * Server-browser stats for Steam instances: what the Steam server list would show (name, map,
 * players), a once-a-minute player-count history, and a live player list that RCON `status`
 * fills in with ping and user ids where the game supports it.
 */

const SAMPLE_INTERVAL_MS = 60_000;
const RETENTION_MS = 7 * 24 * 60 * 60_000;
const GOLDSRC = new Set(['cs16', 'cscz', 'hldm', 'tfc']);
const SOURCE1 = new Set(['csgo', 'css', 'tf2', 'gmod', 'l4d2', 'hl2dm', 'dods']);
/** Games that don't answer A2S at all (their own protocols, or none). */
const NO_A2S = new Set(['palworld', 'satisfactory', 'terraria', 'quake3']);

export interface QuerySettings {
  /** Overrides the guessed query port. */
  port: number | null;
}

export interface QuerySnapshot {
  at: string;
  info: A2sInfo | null;
  players: A2sPlayer[];
  error: string | null;
}

const latest = new Map<string, QuerySnapshot>();
let timer: NodeJS.Timeout | null = null;
let isRunningFn: (id: string) => boolean = () => false;

function settingsOf(server: ServerRecord): QuerySettings {
  try {
    const raw = server.game_settings ? (JSON.parse(server.game_settings) as { query?: Partial<QuerySettings> }) : {};
    const port = Number(raw.query?.port);
    return { port: Number.isInteger(port) && port > 0 && port < 65536 ? port : null };
  } catch {
    return { port: null };
  }
}

export function saveQuerySettings(server: ServerRecord, input: Record<string, unknown>): QuerySettings {
  const port = input.port === null || input.port === '' || input.port === undefined ? null : Number(input.port);
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new HttpError(400, 'Query port must be 1–65535');
  const row = prep('SELECT game_settings FROM servers WHERE id = ?').get(server.id) as { game_settings: string | null } | undefined;
  const raw = row?.game_settings ? (JSON.parse(row.game_settings) as Record<string, unknown>) : {};
  prep('UPDATE servers SET game_settings = ? WHERE id = ?').run(JSON.stringify({ ...raw, query: { port } }), server.id);
  latest.delete(server.id);
  return { port };
}

/** Whether Outpost can query this instance, and on which port. */
export function querySupport(server: ServerRecord): { supported: boolean; port: number | null; guessedPort: number | null; reason: string | null } {
  if (server.platform !== 'steam') return { supported: false, port: null, guessedPort: null, reason: 'Server-browser queries are for Steam games' };
  const preset = findPresetFor(server);
  if (preset && NO_A2S.has(preset.id)) return { supported: false, port: null, guessedPort: null, reason: `${preset.label} doesn’t answer Steam server queries` };
  // Most games answer on the game port; these use the next port up, ARK a fixed one.
  const p = server.server_port;
  const guessed = !preset ? p : ['valheim', 'unturned', 'arma3'].includes(preset.id) ? p + 1 : preset.id === 'ark' ? 27015 : p;
  return { supported: true, port: settingsOf(server).port ?? guessed, guessedPort: guessed, reason: null };
}

export async function queryServer(server: ServerRecord, withPlayers = true): Promise<QuerySnapshot> {
  const support = querySupport(server);
  if (!support.supported || !support.port) throw new HttpError(400, support.reason ?? 'Not queryable');
  const opts = { goldsrc: GOLDSRC.has(server.steam_preset ?? ''), timeoutMs: 2500 };
  const at = new Date().toISOString();
  try {
    const info = await queryInfo('127.0.0.1', support.port, opts);
    // Some games answer info but not players (or only after a challenge they never send); keep the info.
    const players = withPlayers ? await queryPlayers('127.0.0.1', support.port, opts).catch(() => []) : latest.get(server.id)?.players ?? [];
    const snap = { at, info, players, error: null };
    latest.set(server.id, snap);
    return snap;
  } catch (err) {
    const snap = { at, info: null, players: [], error: err instanceof Error ? err.message : String(err) };
    latest.set(server.id, snap);
    return snap;
  }
}

export function latestQuery(serverId: string): QuerySnapshot | null {
  return latest.get(serverId) ?? null;
}

export function clearQuery(serverId: string) {
  latest.delete(serverId);
}

export interface HistoryPoint {
  t: number;
  players: number;
  max: number | null;
  bots: number | null;
}

export function playerHistory(serverId: string, hours: number): HistoryPoint[] {
  const since = Date.now() - Math.min(Math.max(hours, 1), 168) * 3_600_000;
  const rows = prep('SELECT at, players, max_players, bots FROM player_samples WHERE server_id = ? AND at >= ? ORDER BY at').all(serverId, since) as {
    at: number;
    players: number;
    max_players: number | null;
    bots: number | null;
  }[];
  return rows.map((r) => ({ t: r.at, players: r.players, max: r.max_players, bots: r.bots }));
}

async function sampleAll() {
  for (const server of listServers()) {
    if (server.platform !== 'steam' || server.suspended || !isRunningFn(server.id) || !querySupport(server).supported) continue;
    const snap = await queryServer(server, true).catch(() => null);
    if (!snap?.info) continue;
    // Bots fill player slots in A2S; the history counts people.
    const humans = Math.max(0, snap.info.players - snap.info.bots);
    prep('INSERT OR REPLACE INTO player_samples (server_id, at, players, max_players, bots) VALUES (?, ?, ?, ?, ?)').run(server.id, Date.now(), humans, snap.info.maxPlayers, snap.info.bots);
  }
  prep('DELETE FROM player_samples WHERE at < ?').run(Date.now() - RETENTION_MS);
}

export function startBrowserStats(isRunning: (id: string) => boolean) {
  isRunningFn = isRunning;
  if (timer) return;
  timer = setInterval(() => {
    sampleAll().catch((err) => logger.warn('Server-browser sampling failed', { error: err instanceof Error ? err.message : String(err) }));
  }, SAMPLE_INTERVAL_MS);
  timer.unref();
}

// ---------------------------------------------------------------------------
// Live player list
// ---------------------------------------------------------------------------

export interface LivePlayer {
  name: string;
  score: number | null;
  durationSec: number | null;
  ping: number | null;
  /** The game's user id from `status` — what kick/ban by id uses. */
  userId: number | null;
  steamId: string | null;
  bot: boolean;
}

type Family = 'cs2' | 'source' | 'goldsrc' | 'rust' | 'other';

export function gameFamily(server: ServerRecord): Family {
  const id = server.steam_preset ?? '';
  if (id === 'cs2' || (!id && server.steam_app_id === '730')) return 'cs2';
  if (SOURCE1.has(id)) return 'source';
  if (GOLDSRC.has(id)) return 'goldsrc';
  if (id === 'rust') return 'rust';
  return 'other';
}

interface StatusRow {
  userId: number;
  name: string;
  ping: number | null;
  steamId: string | null;
  bot: boolean;
}

/** Pulls user id / name / ping out of `status` from CS2, Source 1 and GoldSrc servers. */
export function parseStatus(text: string): StatusRow[] {
  const rows: StatusRow[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    // CS2: "    2    00:17   19    0     active 786432 1.2.3.4:27005 'Player'"
    let m = line.match(/^\s*(\d+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\w+)\s+\d+\S*(?:\s+(\S+))?\s+'(.*)'$/);
    if (m) {
      if (m[1] === '65535') continue; // the "[NoChan]" placeholder row
      rows.push({ userId: Number(m[1]), name: m[7], ping: Number(m[3]), steamId: null, bot: m[2] === 'BOT' });
      continue;
    }
    // Source 1: '#      2 "Player" STEAM_1:0:123 00:42 45 0 active 1.2.3.4:27005' (CS:GO adds a slot column)
    m = line.match(/^#\s*(\d+)\s+(?:\d+\s+)?"(.*)"\s+(\S+)(?:\s+([\d:]+)\s+(\d+)\s)?/);
    if (m && (m[3] === 'BOT' || m[5])) {
      rows.push({ userId: Number(m[1]), name: m[2], ping: m[5] ? Number(m[5]) : null, steamId: m[3] === 'BOT' ? null : m[3], bot: m[3] === 'BOT' });
      continue;
    }
    // GoldSrc: '#  1 "Player"  2 STEAM_0:0:123   0 00:10   50    0 1.2.3.4:27005'
    m = line.match(/^#\s*\d+\s+"(.*)"\s+(\d+)\s+(\S+)\s+-?\d+\s+([\d:]+)\s+(\d+)\s+\d+/);
    if (m) rows.push({ userId: Number(m[2]), name: m[1], ping: Number(m[5]), steamId: m[3] === 'BOT' ? null : m[3], bot: m[3] === 'BOT' });
  }
  return rows;
}

export async function livePlayers(server: ServerRecord): Promise<{ players: LivePlayer[]; info: A2sInfo | null; error: string | null; at: string; enriched: boolean }> {
  const snap = await queryServer(server, true);
  let status: StatusRow[] = [];
  const rcon = activeRcon(server);
  const family = gameFamily(server);
  if (rcon && rcon.protocol === 'source' && family !== 'other' && family !== 'rust') {
    status = parseStatus(await rconSend(rcon, 'status').catch(() => ''));
  }
  const used = new Set<StatusRow>();
  const players: LivePlayer[] = snap.players.map((p) => {
    const row = status.find((s) => !used.has(s) && s.name === p.name);
    if (row) used.add(row);
    return { name: p.name, score: p.score, durationSec: p.durationSec, ping: row?.ping ?? null, userId: row?.userId ?? null, steamId: row?.steamId ?? null, bot: row?.bot ?? false };
  });
  // Players `status` knows about that A2S hasn't caught up with yet (just joined, or A2S_PLAYER is off).
  for (const row of status) {
    if (!used.has(row)) players.push({ name: row.name, score: null, durationSec: null, ping: row.ping, userId: row.userId, steamId: row.steamId, bot: row.bot });
  }
  return { players, info: snap.info, error: snap.error, at: snap.at, enriched: status.length > 0 };
}

const quoteName = (name: string) => `"${name.replace(/["\r\n;]/g, '')}"`;

/** The console command for kicking or banning a player, or null when this game has no such command. */
export function moderationCommand(server: ServerRecord, action: 'kick' | 'ban', target: { name: string; userId: number | null }, reason = ''): string[] | null {
  const family = gameFamily(server);
  const why = reason.replace(/["\r\n;]/g, '').slice(0, 120);
  if (family === 'rust') return action === 'kick' ? [`kick ${quoteName(target.name)} "${why}"`] : [`ban ${quoteName(target.name)} "${why}"`];
  if (family === 'other') return null;
  if (action === 'kick') {
    if (target.userId !== null) return family === 'cs2' ? [`kickid ${target.userId}${why ? ` "${why}"` : ''}`] : [`kickid ${target.userId}${why ? ` ${why}` : ''}`];
    return [`kick ${quoteName(target.name)}`];
  }
  // Permanent ban by user id, written to banned_user.cfg so it survives restarts. CS2 has no
  // reliable built-in equivalent — bans there come from an admin plugin.
  if (family === 'cs2' || target.userId === null) return null;
  return [`banid 0 ${target.userId} kick`, 'writeid'];
}

export async function moderate(serverId: string, action: 'kick' | 'ban', name: string, reason: string, send: (command: string) => void) {
  const server = getServer(serverId);
  if (!server) throw new HttpError(404, 'Server not found');
  if (!isRunningFn(serverId)) throw new HttpError(409, 'Server is not running');
  let userId: number | null = null;
  const rcon = activeRcon(server);
  if (rcon && rcon.protocol === 'source' && gameFamily(server) !== 'rust') {
    userId = parseStatus(await rconSend(rcon, 'status').catch(() => '')).find((r) => r.name === name)?.userId ?? null;
  }
  const commands = moderationCommand(server, action, { name, userId }, reason);
  if (!commands) {
    if (action === 'ban' && gameFamily(server) === 'cs2') throw new HttpError(400, 'CS2 has no built-in ban command — use an admin plugin such as CS2-SimpleAdmin (css_ban) from the console.');
    throw new HttpError(400, action === 'ban' ? 'Banning needs the player’s user id — turn on RCON for this instance so Outpost can read it from `status`.' : 'This game has no kick command Outpost knows about');
  }
  for (const c of commands) send(c);
  return commands;
}
