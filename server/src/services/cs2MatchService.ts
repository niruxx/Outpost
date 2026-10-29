import fs from 'node:fs';
import path from 'node:path';
import { instanceDir, safeJoin, safeJoinReal } from '../utils/paths.js';
import { getSetting, setSetting } from './systemSettingsService.js';
import { HttpError } from '../utils/asyncHandler.js';

export interface MatchPlan { team1: string; team2: string; maxRounds: number; roundMinutes: number; freezeSeconds: number; overtime: boolean; rotation: string[] }
export const DEFAULT_MATCH: MatchPlan = { team1: 'Team 1', team2: 'Team 2', maxRounds: 24, roundMinutes: 1.92, freezeSeconds: 15, overtime: true, rotation: [] };
export function matchPlan(id: string): MatchPlan { try { return JSON.parse(getSetting(`cs2_match:${id}`) ?? 'null') ?? { ...DEFAULT_MATCH }; } catch { return { ...DEFAULT_MATCH }; } }
export function validateMatch(input: unknown): MatchPlan {
  const p = input as MatchPlan;
  if (!p || ![p.team1, p.team2].every(t => typeof t === 'string' && /^[\w .()-]{1,48}$/.test(t)) || !Number.isInteger(p.maxRounds) || p.maxRounds < 2 || p.maxRounds > 100 || !Number.isFinite(p.roundMinutes) || p.roundMinutes < 0.5 || p.roundMinutes > 60 || !Number.isInteger(p.freezeSeconds) || p.freezeSeconds < 0 || p.freezeSeconds > 120 || typeof p.overtime !== 'boolean' || !Array.isArray(p.rotation) || p.rotation.length > 64 || !p.rotation.every(m => typeof m === 'string' && /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,79}$/.test(m))) throw new HttpError(400, 'Invalid match plan: use plain team/map names and valid round/freeze limits');
  return { team1: p.team1, team2: p.team2, maxRounds: p.maxRounds, roundMinutes: p.roundMinutes, freezeSeconds: p.freezeSeconds, overtime: p.overtime, rotation: [...new Set(p.rotation)] };
}
const marker = '// Outpost match configuration';
export function writeMatchFiles(id: string, p = matchPlan(id)) {
  const root = safeJoinReal(instanceDir(id), 'game/csgo'), cfg = safeJoinReal(instanceDir(id), 'game/csgo/cfg');
  fs.mkdirSync(cfg, { recursive: true });
  const groups = safeJoinReal(instanceDir(id), 'game/csgo/gamemodes_server.txt');
  if (p.rotation.length && fs.existsSync(groups) && !fs.readFileSync(groups, 'utf8').startsWith(marker)) throw new HttpError(409, 'Existing custom gamemodes_server.txt must be merged or moved before Outpost can manage map rotation');
  if (p.rotation.length) fs.writeFileSync(groups, `${marker}\n"GameModes_Server.txt" { "mapgroups" { "outpost_rotation" { "name" "Outpost rotation" "maps" { ${p.rotation.map(m => `"${m}" ""`).join(' ')} } } } }\n`);
  else if (fs.existsSync(groups) && fs.readFileSync(groups, 'utf8').startsWith(marker)) fs.unlinkSync(groups);
  const lines = [marker, `mp_teamname_1 "${p.team1}"`, `mp_teamname_2 "${p.team2}"`, `mp_maxrounds ${p.maxRounds}`, `mp_roundtime_defuse ${p.roundMinutes}`, `mp_roundtime_hostage ${p.roundMinutes}`, `mp_freezetime ${p.freezeSeconds}`, `mp_overtime_enable ${p.overtime ? 1 : 0}`, ...(p.rotation.length ? ['mapgroup outpost_rotation', 'mp_match_end_changelevel 1', 'mp_match_end_restart 0'] : [])];
  fs.writeFileSync(safeJoinReal(instanceDir(id), 'game/csgo/cfg/outpost_match.cfg'), lines.join('\n') + '\n');
}
export function saveMatch(id: string, input: unknown) { const plan = validateMatch(input); writeMatchFiles(id, plan); setSetting(`cs2_match:${id}`, JSON.stringify(plan)); return plan; }
export function matchCommands(action: string) {
  const commands: Record<string, string[]> = { warmup: ['mp_warmup_start'], live: ['exec outpost_match', 'mp_warmup_end', 'mp_restartgame 1'], pause: ['mp_pause_match'], resume: ['mp_unpause_match'], restart: ['mp_restartgame 1'], swap: ['mp_swapteams'] };
  if (!commands[action]) throw new HttpError(400, 'Unknown match action'); return commands[action];
}
export function demoName(input: unknown) { if (typeof input !== 'string' || !/^[\w-]{1,80}$/.test(input)) throw new HttpError(400, 'Use a demo name with letters, digits, hyphens or underscores'); return input; }
export function demoDirectory(id: string) {
  const dir = safeJoinReal(instanceDir(id), 'game/csgo/outpost_demos');
  fs.mkdirSync(dir, { recursive: true });
  const root = fs.realpathSync(instanceDir(id)), real = fs.realpathSync(dir);
  if (!real.startsWith(root + path.sep)) throw new HttpError(403, 'Demo directory escapes the instance'); return dir;
}
export function demos(id: string) {
  const dir = demoDirectory(id);
  return fs.readdirSync(dir).filter(n => /^[\w-]{1,80}\.dem$/.test(n)).flatMap(name => { const stat = fs.lstatSync(path.join(dir, name)); return stat.isFile() && !stat.isSymbolicLink() ? [{ name, size: stat.size, modified: stat.mtime.toISOString() }] : []; });
}
export function demoPath(id: string, name: string) { if (!/^[\w-]{1,80}\.dem$/.test(name)) throw new HttpError(400, 'Invalid demo filename'); const file = safeJoin(demoDirectory(id), name); const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new HttpError(403, 'Regular demo file required'); return file; }
export function playerCommands(input: { action?: unknown; userId?: unknown; steamId?: unknown; minutes?: unknown; reason?: unknown }) {
  const reason = String(input.reason ?? 'Removed by administrator');
  if (!/^[\w .()-]{1,100}$/.test(reason)) throw new HttpError(400, 'Use a plain player-action reason');
  if (input.action === 'kick') { if (!Number.isInteger(input.userId) || Number(input.userId) < 1 || Number(input.userId) > 65535) throw new HttpError(400, 'A numeric current user ID is required'); return [`kickid ${input.userId} "${reason}"`]; }
  if (!/^STEAM_[0-5]:[01]:\d{1,10}$/.test(String(input.steamId))) throw new HttpError(400, 'Use a legacy Steam ID such as STEAM_1:0:12345 (from status)');
  if (input.action === 'unban') return [`removeid ${input.steamId}`, 'writeid'];
  if (input.action !== 'ban' || !Number.isInteger(input.minutes) || Number(input.minutes) < 0 || Number(input.minutes) > 525600) throw new HttpError(400, 'Use ban/unban and a duration from 0 (permanent) to 525600 minutes');
  return [`banid ${input.minutes} ${input.steamId} kick`, 'writeid'];
}
export function parseCs2Status(text: string) { return [...text.matchAll(/^#\s*(\d+)\s+"([^"\r\n]{1,100})"\s+(STEAM_[0-5]:[01]:\d+|\[U:1:\d+\]|\d{17}|BOT)(?=\s|$)/gm)].map(m => ({ userId: Number(m[1]), name: m[2], steamId: m[3] })); }
