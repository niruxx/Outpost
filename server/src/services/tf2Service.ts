import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { prep } from '../db/db.js';
import { instanceDir, safeJoinReal } from '../utils/paths.js';
import { HttpError } from '../utils/asyncHandler.js';
import type { ServerRecord } from '../types/index.js';

export const isTf2 = (s: ServerRecord) => s.platform === 'steam' && (s.steam_preset === 'tf2' || (!s.steam_preset && s.steam_app_id === '232250'));
export const tf2FrameworkJobs = new Map<string, { state: 'running' | 'failed' | 'done'; error?: string }>();
export interface Tf2Settings {
  map: string;
  rotation: string[];
  maxPlayers: number;
  hostname: string;
  password: string;
  gslt: string;
  preset: string | null;
  cvars: Record<string, string>;
}
const DEFAULTS: Tf2Settings = { map: 'ctf_2fort', rotation: [], maxPlayers: 24, hostname: '', password: '', gslt: '', preset: null, cvars: {} };
export const TF2_PRESETS = [
  { id: 'casual', label: 'Casual', description: '24 slots, team balance, random critical hits and a 30-minute map limit.', maxPlayers: 24, cvars: { mp_timelimit: '30', mp_autoteambalance: '1', mp_teams_unbalance_limit: '1', tf_weapon_criticals: '1', sv_alltalk: '0' } },
  { id: 'competitive', label: 'Competitive', description: '12 slots, no random critical hits, no automatic team balance.', maxPlayers: 12, cvars: { mp_timelimit: '30', mp_autoteambalance: '0', mp_teams_unbalance_limit: '0', tf_weapon_criticals: '0', sv_alltalk: '0' } },
  { id: 'training', label: 'Training', description: 'No map time limit, no random critical hits, voice chat across teams.', maxPlayers: 24, cvars: { mp_timelimit: '0', mp_autoteambalance: '0', mp_teams_unbalance_limit: '0', tf_weapon_criticals: '0', sv_alltalk: '1' } },
];
export function tf2Path(server: ServerRecord, relative: string) {
  return safeJoinReal(instanceDir(server.id), `tf/${relative}`);
}
export function tf2SettingsOf(server: ServerRecord): Tf2Settings {
  try { return { ...DEFAULTS, ...JSON.parse(server.game_settings ?? '{}').tf2 }; }
  catch { return { ...DEFAULTS, rotation: [], cvars: {} }; }
}
export function tf2Map(input: unknown): string {
  const raw = String(input ?? '').trim().replace(/\.bsp$/i, '');
  const link = raw.match(/^https:\/\/steamcommunity\.com\/sharedfiles\/filedetails\/?\?id=(\d{6,12})(?:&[^\s]*)?$/i);
  if (link) return `workshop/${link[1]}`;
  if (/^\d{6,12}$/.test(raw)) return `workshop/${raw}`;
  if (/^workshop\/\d{6,12}$/.test(raw)) return raw;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(raw)) throw new HttpError(400, 'Enter an installed map name or TF2 Workshop map link / ID');
  return raw;
}
const clean = (input: unknown, max: number) => {
  if (typeof input !== 'string' || /[";\r\n\x00]/.test(input) || input.length > max) throw new HttpError(400, 'Invalid configuration value');
  return input.trim();
};
export function sanitizeTf2(input: Record<string, unknown>, previous: Tf2Settings): Tf2Settings {
  const next = { ...previous, rotation: [...previous.rotation], cvars: { ...previous.cvars } };
  if (input.preset !== undefined) {
    if (input.preset === null) next.preset = null;
    else {
      const preset = TF2_PRESETS.find((p) => p.id === input.preset);
      if (!preset) throw new HttpError(400, 'Unknown TF2 preset');
      next.preset = preset.id;
      next.maxPlayers = preset.maxPlayers;
      next.cvars = { ...next.cvars, ...preset.cvars };
    }
  }
  if (input.map !== undefined) next.map = tf2Map(input.map);
  if (input.rotation !== undefined) {
    if (!Array.isArray(input.rotation) || input.rotation.length > 200) throw new HttpError(400, 'Map rotation must contain at most 200 maps');
    next.rotation = [...new Set(input.rotation.map(tf2Map))];
  }
  if (input.maxPlayers !== undefined) {
    const n = Number(input.maxPlayers);
    if (!Number.isInteger(n) || n < 1 || n > 100) throw new HttpError(400, 'Max players must be between 1 and 100');
    next.maxPlayers = n;
  }
  for (const key of ['hostname', 'password', 'gslt'] as const) if (input[key] !== undefined) next[key] = clean(input[key], key === 'hostname' ? 100 : 64);
  if (next.gslt && !/^[a-f0-9]{32}$/i.test(next.gslt)) throw new HttpError(400, 'Game Server Login Token must contain 32 hex characters');
  if (input.cvars !== undefined) {
    if (!input.cvars || typeof input.cvars !== 'object' || Array.isArray(input.cvars) || Object.keys(input.cvars).length > 100) throw new HttpError(400, 'Enter at most 100 cvars');
    next.cvars = {};
    for (const [key, value] of Object.entries(input.cvars)) {
      if (!/^(?:tf_|mp_|sv_)[a-z0-9_]+$/.test(key) || ['sv_password', 'sv_setsteamaccount'].includes(key)) throw new HttpError(400, `Unsupported cvar: ${key}`);
      next.cvars[key] = clean(value, 128);
    }
  }
  return next;
}
export function saveTf2(server: ServerRecord, input: Record<string, unknown>) {
  const next = sanitizeTf2(input, tf2SettingsOf(server));
  const row = prep('SELECT game_settings FROM servers WHERE id = ?').get(server.id) as { game_settings: string | null };
  const raw = JSON.parse(row.game_settings ?? '{}');
  // Validate/write paths before committing settings.
  writeTf2Configs(server, next);
  prep('UPDATE servers SET game_settings = ? WHERE id = ?').run(JSON.stringify({ ...raw, tf2: next }), server.id);
  return next;
}
export function writeTf2Configs(server: ServerRecord, s = tf2SettingsOf(server)) {
  const cfg = tf2Path(server, 'cfg/outpost.cfg');
  const serverCfg = tf2Path(server, 'cfg/server.cfg');
  const rotation = tf2Path(server, 'cfg/outpost_mapcycle.txt');
  const original = fs.existsSync(serverCfg) ? fs.readFileSync(serverCfg, 'utf8') : '';
  const lines = [ '// Managed by Outpost', ...(s.hostname ? [`hostname "${s.hostname}"`] : []), `sv_password "${s.password}"`, ...Object.entries(s.cvars).map(([k, v]) => `${k} "${v}"`), `mapcyclefile "${s.rotation.length ? 'cfg/outpost_mapcycle.txt' : 'mapcycle.txt'}"` ];
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, lines.join('\n') + '\n');
  fs.writeFileSync(rotation, s.rotation.join('\n') + '\n');
  // Reposition our exec at the end so old manual values cannot override saved settings.
  fs.writeFileSync(serverCfg, original.replace(/^\s*exec\s+"?outpost(?:\.cfg)?"?\s*(?:\/\/[^\r\n]*)?$/gim, '').trimEnd() + '\nexec outpost.cfg\n');
}
export function tf2LaunchArgs(server: ServerRecord) {
  const s = tf2SettingsOf(server);
  return ['-game', 'tf', '-console', '-norestart', '-port', String(server.server_port), '+maxplayers', String(s.maxPlayers), '+map', s.map, ...(s.gslt ? ['+sv_setsteamaccount', s.gslt] : [])];
}
export function prepareTf2(server: ServerRecord) {
  if (tf2FrameworkJobs.get(server.id)?.state === 'running') throw new HttpError(409, 'Wait for TF2 framework installation to finish before starting');
  if (!JSON.parse(server.game_settings ?? '{}').tf2) return null;
  writeTf2Configs(server);
  return 'TF2 settings and map rotation refreshed';
}
export function tf2Content(server: ServerRecord) {
  const list = (relative: string) => {
    const dir = tf2Path(server, relative);
    return fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name) : [];
  };
  const customFolders = [true, false].flatMap((enabled) => {
    const dir = tf2Path(server, enabled ? 'custom' : 'custom_disabled');
    return fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => ({ name: e.name, kind: 'custom', enabled })) : [];
  });
  return {
    maps: list('maps').filter((n) => /\.bsp$/i.test(n)).map((n) => n.slice(0, -4)).sort(),
    plugins: [ ...list('addons/sourcemod/plugins').filter((n) => n.endsWith('.smx')).map((name) => ({ name, kind: 'plugin', enabled: true })), ...list('addons/sourcemod/plugins/disabled').filter((n) => n.endsWith('.smx')).map((name) => ({ name, kind: 'plugin', enabled: false })), ...list('custom').filter((n) => /\.vpk(?:\.disabled)?$/i.test(n)).map((n) => ({ name: n.replace(/\.disabled$/, ''), kind: 'vpk', enabled: !n.endsWith('.disabled') })), ...customFolders ],
    frameworks: { metamod: fs.existsSync(tf2Path(server, 'addons/metamod')), sourcemod: fs.existsSync(tf2Path(server, 'addons/sourcemod/bin')) },
  };
}
export function installTf2Upload(server: ServerRecord, name: string, buffer: Buffer, kind: 'map' | 'mod') {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name)) throw new HttpError(400, 'Use a filename with letters, numbers, dashes and underscores');
  let relative: string;
  if (kind === 'map' && /\.bsp$/i.test(name)) relative = `maps/${name}`;
  else if (kind === 'mod' && /\.smx$/i.test(name)) relative = `addons/sourcemod/plugins/${name}`;
  else if (kind === 'mod' && /\.vpk$/i.test(name)) relative = `custom/${name}`;
  else if (kind === 'mod' && /\.zip$/i.test(name)) {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries().filter((e) => !e.isDirectory);
    if (!entries.length || entries.length > 3000 || entries.reduce((n, e) => n + e.header.size, 0) > 512 * 1048576) throw new HttpError(413, 'Mod archive is empty or too large');
    const files = entries.map((entry) => {
      const rel = entry.entryName.replace(/^tf\//, '');
      if (!/^(addons|cfg|custom|materials|models|sound|scripts|resource)\//.test(rel) || rel.split('/').some((p) => !p || p === '.' || p === '..') || rel.includes('\\') || ((entry.attr >>> 16) & 0xf000) === 0xa000) throw new HttpError(400, `Unsupported mod archive path: ${entry.entryName}`);
      return { target: tf2Path(server, rel), data: entry.getData() };
    });
    for (const file of files) { fs.mkdirSync(path.dirname(file.target), { recursive: true }); fs.writeFileSync(file.target, file.data); }
    return;
  } else throw new HttpError(400, kind === 'map' ? 'Upload a .bsp map' : 'Upload a .smx plugin, .vpk mod or TF2 mod .zip');
  const file = tf2Path(server, relative);
  if (fs.existsSync(file)) throw new HttpError(409, 'A file with that name already exists. Remove it first to replace it.');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buffer);
}
export function tf2PluginAction(server: ServerRecord, name: string, kind: unknown, action: unknown) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name) || !['plugin', 'vpk', 'custom'].includes(String(kind)) || !['enable', 'disable', 'remove'].includes(String(action))) throw new HttpError(400, 'Invalid plugin action');
  const item = tf2Content(server).plugins.find((p) => p.name === name && p.kind === kind);
  if (!item) throw new HttpError(404, 'Plugin not found');
  const rel = kind === 'plugin' ? `addons/sourcemod/plugins/${item.enabled ? '' : 'disabled/'}${name}` : kind === 'custom' ? `${item.enabled ? 'custom' : 'custom_disabled'}/${name}` : `custom/${name}${item.enabled ? '' : '.disabled'}`;
  const source = tf2Path(server, rel);
  if (action === 'remove') { if (kind === 'custom') fs.rmSync(source, { recursive: true }); else fs.unlinkSync(source); return; }
  const enabled = action === 'enable';
  if (item.enabled === enabled) return;
  const destination = tf2Path(server, kind === 'plugin' ? `addons/sourcemod/plugins/${enabled ? '' : 'disabled/'}${name}` : kind === 'custom' ? `${enabled ? 'custom' : 'custom_disabled'}/${name}` : `custom/${name}${enabled ? '' : '.disabled'}`);
  if (fs.existsSync(destination)) throw new HttpError(409, 'A plugin already exists at the destination');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.renameSync(source, destination);
}
