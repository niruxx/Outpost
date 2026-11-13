import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import AdmZip from 'adm-zip';
import { prep } from '../db/db.js';
import { instanceDir, safeJoinReal } from '../utils/paths.js';
import { HttpError } from '../utils/asyncHandler.js';
import { splitArgs } from './launchConfig.js';
import { assertManualPort, instanceAllocation } from './allocationService.js';
import { getSetting, setSetting } from './systemSettingsService.js';
import { GAME_PROFILES, profileFor, type GameProfile } from './gameControlProfiles.js';
import { patchNative, readNative, patchArmaMissions, quoteCfg } from './nativeGameConfig.js';
import type { ServerRecord } from '../types/index.js';

export interface GameControls { values: Record<string, string>; rotation: string[]; missionDifficultyManaged?: boolean }
const hash = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
const MAX_CONFIG = 2 * 1048576;
export function requireGameProfile(server: ServerRecord): GameProfile {
  const profile = profileFor(server);
  if (!profile) throw new HttpError(400, 'This game has dedicated controls or no built-in settings profile');
  return profile;
}
export function gameFile(server: ServerRecord, relative: string) { return safeJoinReal(instanceDir(server.id), relative); }
const osFolder = () => process.platform === 'win32' ? 'WindowsServer' : 'LinuxServer';
function extraValue(server: ServerRecord, flag: string) {
  const args = splitArgs(server.extra_args || '');
  for (let i = args.length - 1; i >= 0; i--) {
    if (args[i].startsWith(flag + '=')) return args[i].slice(flag.length + 1);
    if (args[i] === flag) return args[i + 1];
  }
  return undefined;
}
function instanceRelative(server: ServerRecord, filename: string) {
  const relative = path.isAbsolute(filename) ? path.relative(instanceDir(server.id), filename) : filename;
  try { gameFile(server, relative); } catch { throw new HttpError(409, 'Custom configuration/save locations must be inside the instance to manage them here'); }
  return relative.split(path.sep).join('/');
}
function zomboidName(server: ServerRecord) {
  const args = splitArgs(server.extra_args || ''); const i = args.indexOf('-servername');
  const name = i >= 0 ? args[i + 1] : 'servertest';
  if (!name || !/^[A-Za-z0-9_-]{1,80}$/.test(name)) throw new HttpError(409, 'The Zomboid -servername must be a simple profile name');
  return name;
}
export function resolvedFile(server: ServerRecord, relative: string): string {
  if (relative === '@palworld') return `Pal/Saved/Config/${osFolder()}/PalWorldSettings.ini`;
  if (relative === '@ark') return `ShooterGame/Saved/Config/${osFolder()}/GameUserSettings.ini`;
  if (relative === '@arkGame') return `ShooterGame/Saved/Config/${osFolder()}/Game.ini`;
  if (relative.startsWith('@zomboid')) {
    const cache = extraValue(server, '-cachedir');
    const root = cache ? instanceRelative(server, cache) : 'Zomboid';
    return `${root}/Server/${zomboidName(server)}${relative === '@zomboidSandbox' ? '_SandboxVars.lua' : relative === '@zomboidSpawn' ? '_spawnregions.lua' : '.ini'}`;
  }
  const profile = profileFor(server);
  const key = profile?.id === '7dtd' ? '-configfile' : profile?.id === 'terraria' || profile?.id === 'arma3' ? '-config' : ['quake3', 'quakelive', 'bo3'].includes(profile?.id ?? '') ? '+exec' : null;
  if (key && relative === profile?.file) {
    const custom = extraValue(server, key);
    if (custom) return instanceRelative(server, ['quake3', 'quakelive', 'bo3'].includes(profile.id) ? path.posix.join(path.posix.dirname(relative), custom) : custom);
  }
  return relative;
}
function readText(server: ServerRecord, relative: string) {
  const file = gameFile(server, relative);
  if (!fs.existsSync(file)) return '';
  if (!fs.statSync(file).isFile() || fs.statSync(file).size > MAX_CONFIG) throw new HttpError(413, `Configuration file is not a text file under 2 MB: ${relative}`);
  const text = fs.readFileSync(file, 'utf8');
  if (text.includes('\0')) throw new HttpError(400, 'Binary files cannot be edited as configuration');
  return text;
}
function stored(server: ServerRecord): GameControls | null {
  try { return JSON.parse(server.game_settings ?? '{}').controls ?? null; } catch { return null; }
}
export function controlsOf(server: ServerRecord, profile = requireGameProfile(server)): GameControls {
  const nativeText = profile.file ? readText(server, resolvedFile(server, profile.file)) : '';
  const native = readNative(nativeText, profile);
  const values: Record<string, string> = {};
  for (const field of profile.fields) values[field.key] = field.default.replace(/@name/g, server.name);
  Object.assign(values, native);
  if (!stored(server)) {
    const args = splitArgs(server.extra_args || '');
    const read = (key: string, flag: string) => { const value = extraValue(server, flag); if (value !== undefined) values[key] = value; };
    if (profile.map?.live === 'changelevel') { for (const f of profile.fields) if (!f.launch) read(f.key, `+${f.key}`); read('map', '+map'); read('maxPlayers', '+maxplayers'); }
    if (profile.format === 'quake' || profile.format === 'bo3') {
      read('map', '+map');
      for (let i = 0; i < args.length - 2; i++) if (args[i] === '+set' && profile.fields.some((f) => f.key === args[i + 1])) values[args[i + 1]] = args[i + 2];
      if (profile.id === 'quakelive') { const i = args.lastIndexOf('+map'); if (i >= 0 && args[i + 2] && !/^[+-]/.test(args[i + 2])) values.factory = args[i + 2]; }
    }
    if (profile.id === 'valheim') {
      for (const [key, flag] of [['serverName', '-name'], ['world', '-world'], ['password', '-password'], ['saveinterval', '-saveinterval'], ['public', '-public']]) read(key, flag);
      if (args.includes('-crossplay')) values.crossplay = 'true';
    }
    if (profile.id === 'rust') for (const field of profile.fields) read(field.key, `+${field.key}`);
    if (profile.id === 'terraria') { for (const key of ['world', 'worldname', 'password', 'motd', 'maxplayers', 'seed', 'difficulty', 'autocreate']) read(key, `-${key}`); read('maxplayers', '-players'); }
  }
  Object.assign(values, stored(server)?.values ?? {});
  if (!stored(server) && profile.id === 'bo3') {
    try { const ws = JSON.parse(server.workshop ?? '{}'); if (typeof ws.startMap === 'string' && ws.startMap) values.map = ws.startMap; } catch { /* default map */ }
  }
  // Launch-only secrets are kept outside the public server record.
  if (profile.format === 'launch') { try { Object.assign(values, JSON.parse(getSetting(`game_controls_secrets:${server.id}`) ?? '{}')); } catch { /* defaults */ } }
  for (const field of profile.fields) if (field.type === 'boolean') values[field.key] = /^(1|true)$/i.test(values[field.key]) ? 'true' : 'false';
  let rotation = stored(server)?.rotation;
  if (!rotation && profile.id === 'arma3') {
    rotation = [...nativeText.matchAll(/\btemplate\s*=\s*"([A-Za-z0-9_.-]+)"/g)].map((m) => m[1]);
    if (rotation.length) values.mission = rotation[0];
  }
  if (!rotation && profile.id === 'bo3') rotation = [...(native.sv_maprotation ?? '').matchAll(/\bmap\s+([A-Za-z0-9_/-]+)/g)].map((m) => m[1]);
  if (!rotation && profile.format === 'source' && profile.map?.rotation && profile.file) {
    const root = resolvedFile(server, profile.file).split('/')[0];
    const cycle = native.mapcyclefile || 'mapcycle.txt';
    if (!cycle.includes('..') && !path.isAbsolute(cycle)) {
      const candidates = [`${root}/${cycle}`, `${root}/cfg/${cycle}`];
      const relative = candidates.find((p) => fs.existsSync(gameFile(server, p)));
      if (relative) rotation = readText(server, relative).split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('//') && /^[A-Za-z0-9_/-]+$/.test(s));
    }
  }
  return { values: Object.fromEntries(profile.fields.map((f) => [f.key, values[f.key]])), rotation: rotation ?? [], ...(profile.id === 'arma3' ? { missionDifficultyManaged: stored(server)?.missionDifficultyManaged ?? false } : {}) };
}
export function configFiles(server: ServerRecord, profile = requireGameProfile(server)) {
  return [...new Set([...(profile.file ? [profile.file] : []), ...(profile.extraFiles ?? [])].map((f) => resolvedFile(server, f)))].map((relative, index) => ({ id: String(index), path: relative, exists: fs.existsSync(gameFile(server, relative)) }));
}
export function controlsRevision(server: ServerRecord, profile = requireGameProfile(server)) {
  return hash(JSON.stringify({ settings: server.game_settings, port: server.server_port, name: server.name, files: configFiles(server, profile).map((f) => [f.path, f.exists ? readText(server, f.path) : null]) }));
}
export function gameMaps(server: ServerRecord, profile = requireGameProfile(server)) {
  const map = profile.map;
  if (!map) return [];
  const values = new Map<string, { value: string; label: string; source: string }>();
  for (const builtin of map.builtins ?? []) values.set(builtin, { value: builtin, label: builtin, source: 'built-in / requires installed content' });
  const add = (value: string, source: string) => { if (value && !value.split('/').includes('..')) values.set(value, { value, label: value, source }); };
  for (const root of map.roots) {
    const dir = gameFile(server, root); if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      if (map.directories && entry.isDirectory()) add(entry.name, root);
      if (entry.isFile() && map.extension && entry.name.toLowerCase().endsWith(map.extension)) {
        add(profile.id === 'terraria' ? `${root}/${entry.name}` : entry.name.slice(0, -map.extension.length), root);
      }
      if (map.archive && entry.isFile() && entry.name.endsWith('.pk3')) {
        try {
          const zip = new AdmZip(gameFile(server, `${root}/${entry.name}`));
          for (const file of zip.getEntries()) if (/^maps\/.+\.bsp$/i.test(file.entryName)) add(file.entryName.slice(5, -4), `${root}/${entry.name}`);
        } catch { /* A damaged map package must not hide the entire settings page. */ }
      }
      if (map.upload === 'bsp' && entry.isDirectory()) {
        const scan = (sub: string, depth: number) => {
          if (depth > 4 || values.size > 5000) return;
          const folder = gameFile(server, `${root}/${sub}`);
          for (const file of fs.readdirSync(folder, { withFileTypes: true })) {
            if (file.isSymbolicLink()) continue;
            if (file.isDirectory()) scan(`${sub}/${file.name}`, depth + 1);
            else if (file.name.toLowerCase().endsWith('.bsp')) add(`${sub}/${file.name.slice(0, -4)}`, root);
          }
        };
        scan(entry.name, 0);
      }
    }
  }
  if (profile.id === 'project_zomboid' || profile.id === 'unturned') {
    let visited = 0;
    const scan = (relative: string, depth: number) => {
      if (depth > 10 || visited > 10000) return;
      const dir = gameFile(server, relative); if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true }); visited += entries.length;
      if (profile.id === 'project_zomboid' && relative.endsWith('/media/maps')) { for (const e of entries) if (e.isDirectory()) add(e.name, relative); return; }
      if (profile.id === 'unturned' && entries.some((e) => e.isFile() && e.name.toLowerCase() === 'level.dat')) { add(path.posix.basename(relative), relative); return; }
      for (const e of entries) if (e.isDirectory() && !e.isSymbolicLink()) scan(`${relative}/${e.name}`, depth + 1);
    };
    for (const root of profile.id === 'project_zomboid' ? ['steamapps/workshop/content/108600', 'Zomboid/Workshop', 'mods'] : ['Servers/outpost/Workshop', 'steamapps/workshop/content/304930']) scan(root, 0);
  }
  return [...values.values()].sort((a, b) => a.label.localeCompare(b.label));
}
export function gameControlsView(server: ServerRecord, canEdit: boolean) {
  const profile = requireGameProfile(server), settings = controlsOf(server, profile);
  const secretSet: Record<string, boolean> = {};
  for (const f of profile.fields) if (f.type === 'password') { secretSet[f.key] = !!settings.values[f.key]; settings.values[f.key] = ''; }
  const uploads = JSON.parse(server.game_settings ?? '{}').mapUploads ?? [];
  return { profile, settings, secretSet, maps: gameMaps(server, profile), uploads: uploads.map((u: MapUpload) => ({ id: u.id, name: u.name, maps: u.maps, files: u.files.length })), files: configFiles(server, profile), revision: controlsRevision(server, profile), port: server.server_port, allocatedPort: instanceAllocation(server.id)?.port ?? null, canEdit, managed: !!stored(server) };
}
export function validateMap(value: string, profile: GameProfile) {
  if (profile.id === 'arma3' && !value) return value;
  if (profile.id === 'project_zomboid') {
    if (!value || value.length > 2000 || /[\r\n"\\]/.test(value)) throw new HttpError(400, 'Invalid Zomboid map order');
    return value;
  }
  if (profile.id === 'terraria') {
    if (!/^worlds\/[A-Za-z0-9 _.-]+\.wld$/.test(value) || value.split('/').includes('..')) throw new HttpError(400, 'Choose a .wld file inside worlds/');
  } else if (profile.id === 'valheim') {
    if (!/^[A-Za-z0-9 _.-]{1,100}$/.test(value) || value === '.' || value === '..') throw new HttpError(400, 'Use a simple world name');
  } else if (!/^[A-Za-z0-9][A-Za-z0-9_./-]{0,127}$/.test(value) || value.split('/').some((s) => s === '..' || s === '.')) throw new HttpError(400, 'Use an installed map or mission name');
  return value;
}
function sanitize(server: ServerRecord, profile: GameProfile, input: Record<string, unknown>): GameControls {
  const current = controlsOf(server, profile);
  if (!input.values || typeof input.values !== 'object' || Array.isArray(input.values)) throw new HttpError(400, 'Settings values are required');
  const values = { ...current.values };
  const clear = input.clearSecrets;
  if (clear !== undefined && (!Array.isArray(clear) || clear.some((key) => !profile.fields.some((f) => f.key === key && f.type === 'password')))) throw new HttpError(400, 'Invalid password clearing request');
  for (const [key, raw] of Object.entries(input.values)) {
    const field = profile.fields.find((f) => f.key === key);
    if (!field) throw new HttpError(400, `Unknown setting: ${key}`);
    if (typeof raw !== 'string' || raw.length > 2000 || /[\r\n\0]/.test(raw)) throw new HttpError(400, `Invalid ${field.label}`);
    if (field.type === 'password' && !raw && !(clear as string[] | undefined)?.includes(key)) continue;
    if (field.type === 'number' && (!raw || !Number.isFinite(Number(raw)) || Number(raw) < field.min! || Number(raw) > field.max!)) throw new HttpError(400, `${field.label} must be ${field.min}–${field.max}`);
    if (field.type === 'number' && Number.isInteger(field.min) && Number.isInteger(field.max) && !Number.isInteger(Number(raw))) throw new HttpError(400, `${field.label} must be a whole number`);
    if (field.type === 'select' && !field.options?.includes(raw)) throw new HttpError(400, `Invalid ${field.label}`);
    if (field.type === 'boolean' && !['true', 'false'].includes(raw)) throw new HttpError(400, `Invalid ${field.label}`);
    // Never permit quoted values to introduce native commands or Unreal/INI syntax.
    if (/[";\\]/.test(raw) && profile.id !== 'project_zomboid') throw new HttpError(400, `${field.label} cannot contain quotes, semicolons or backslashes`);
    if (profile.id === 'ark' && /[?&=]/.test(raw)) throw new HttpError(400, `${field.label} cannot contain URL option delimiters`);
    values[key] = raw;
  }
  for (const key of (clear as string[] | undefined) ?? []) values[key] = '';
  if (profile.map) validateMap(values[profile.map.key], profile);
  if (profile.id === 'valheim' && values.password && values.password.length < 5) throw new HttpError(400, 'Valheim passwords need at least five characters');
  if (profile.id === 'rust' && values['server.levelurl']) {
    let url: URL;
    try { url = new URL(values['server.levelurl']); } catch { throw new HttpError(400, 'Use a public HTTPS custom map URL'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new HttpError(400, 'Use a public HTTPS custom map URL');
  }
  let rotation = current.rotation;
  if (input.rotation !== undefined) {
    if (!profile.map?.rotation || !Array.isArray(input.rotation) || input.rotation.length > 200 || input.rotation.some((m) => typeof m !== 'string')) throw new HttpError(400, 'This game does not support that map rotation');
    rotation = [...new Set(input.rotation as string[])].map((m) => validateMap(m, profile));
  }
  if (profile.id === 'arma3') {
    if (values.mission && values.mission !== current.values.mission) rotation = [values.mission, ...rotation.filter((m) => m !== values.mission)];
    else if (input.rotation !== undefined) values.mission = rotation[0] ?? '';
  }
  return { values, rotation, ...(profile.id === 'arma3' ? { missionDifficultyManaged: current.missionDifficultyManaged || values.difficulty !== current.values.difficulty } : {}) };
}

/** Write all generated files with rollback so a failed write does not leave half a configuration. */
function writeFiles(server: ServerRecord, files: Record<string, string>) {
  const originals = new Map<string, Buffer | null>();
  const staged: string[] = [];
  try {
    for (const [relative, text] of Object.entries(files)) {
      const file = gameFile(server, relative);
      originals.set(file, fs.existsSync(file) ? fs.readFileSync(file) : null);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + `.outpost-${crypto.randomUUID()}.tmp`; staged.push(tmp);
      fs.writeFileSync(tmp, text); fs.renameSync(tmp, file);
    }
  } catch (err) {
    for (const [file, original] of originals) { if (original) fs.writeFileSync(file, original); else if (fs.existsSync(file)) fs.unlinkSync(file); }
    throw err;
  } finally { for (const file of staged) if (fs.existsSync(file)) fs.unlinkSync(file); }
}
export function renderGameFiles(server: ServerRecord, profile: GameProfile, controls: GameControls): Record<string, string> {
  if (!profile.file) return {};
  const relative = resolvedFile(server, profile.file);
  let text = readText(server, relative);
  if (profile.format === 'palworld' && !text && fs.existsSync(gameFile(server, 'DefaultPalWorldSettings.ini'))) text = readText(server, 'DefaultPalWorldSettings.ini');
  const updates: Record<string, string> = {};
  for (const field of profile.fields) if (!field.launch) {
    const value = controls.values[field.key];
    updates[field.key] = profile.format === 'palworld' ? field.type === 'text' || field.type === 'password' ? quoteCfg(value) : field.type === 'boolean' ? (value === 'true' ? 'True' : 'False') : value : ['source', 'quake', 'bo3', 'arma'].includes(profile.format) && field.type === 'boolean' ? (value === 'true' ? '1' : '0') : value;
  }
  if (profile.id === 'project_zomboid') updates.DefaultPort = String(server.server_port);
  if (profile.id === 'terraria') updates.port = String(server.server_port);
  if (profile.id === '7dtd') updates.ServerPort = String(server.server_port);
  if (profile.id === 'unturned') updates.Port = String(server.server_port);
  let patched = patchNative(text, profile, updates);
  if (profile.id === 'rust') {
    patched = patchNative(patched, profile, { 'server.levelurl': controls.values['server.levelurl'] });
    if (controls.values['server.levelurl']) patched = patched.replace(/^\s*server\.(seed|worldsize)\s+.*$/gm, '');
    else patched = patchNative(patched, profile, { 'server.seed': controls.values['server.seed'], 'server.worldsize': controls.values['server.worldsize'] });
  }
  const files: Record<string, string> = {};
  const rotation = controls.rotation;
  if (profile.map?.rotation) {
    if (profile.format === 'arma') {
      const desired = rotation.length ? rotation : controls.values.mission ? [controls.values.mission] : [];
      const existing = [...text.matchAll(/\btemplate\s*=\s*"([A-Za-z0-9_.-]+)"/g)].map((m) => m[1]);
      if (JSON.stringify(existing) !== JSON.stringify(desired)) patched = patchArmaMissions(patched, desired, controls.values.difficulty);
      else if (controls.missionDifficultyManaged && desired.length && [...text.matchAll(/\bdifficulty\s*=\s*"([^"\r\n]*)"/g)].some((m) => m[1] !== controls.values.difficulty)) patched = patchArmaMissions(patched, desired, controls.values.difficulty, true);
    }
    else if (profile.format === 'source') {
      const goldsrc = ['cs16', 'cscz', 'hldm', 'tfc'].includes(profile.id);
      const cycle = path.posix.join(path.posix.dirname(relative), 'outpost_mapcycle.txt');
      files[cycle] = rotation.join('\n') + '\n';
      patched = patchNative(patched, profile, { mapcyclefile: rotation.length ? (goldsrc ? 'outpost_mapcycle.txt' : 'cfg/outpost_mapcycle.txt') : 'mapcycle.txt' });
    } else if (profile.format === 'quake') {
      const begin = '// BEGIN OUTPOST MAP ROTATION', end = '// END OUTPOST MAP ROTATION';
      patched = patched.replace(/\/\/ BEGIN OUTPOST MAP ROTATION[\s\S]*?\/\/ END OUTPOST MAP ROTATION\r?\n?/g, '');
      const current = rotation.indexOf(controls.values.map), next = current >= 0 ? (current + 1) % rotation.length : 0;
      if (rotation.length) patched += `${begin}\n${rotation.map((m, i) => `set outpost_map${i} "map ${m}; set nextmap vstr outpost_map${(i + 1) % rotation.length}"`).join('\n')}\nset nextmap "vstr outpost_map${next}"\n${end}\n`;
    } else if (profile.format === 'bo3' && rotation.length) {
      const existing = [...(readNative(text, profile).sv_maprotation ?? '').matchAll(/\bmap\s+([A-Za-z0-9_/-]+)/g)].map((m) => m[1]);
      if (JSON.stringify(existing) !== JSON.stringify(rotation)) patched = patchNative(patched, profile, { sv_maprotation: rotation.map((m) => `gametype ${controls.values.gametype} map ${m}`).join(' ') });
    }
  }
  files[relative] = patched;
  return files;
}
export function saveGameControls(server: ServerRecord, input: Record<string, unknown>) {
  const profile = requireGameProfile(server);
  if (input.revision !== controlsRevision(server, profile)) throw new HttpError(409, 'Settings changed since you opened this page. Reload before saving.');
  const controls = sanitize(server, profile, input);
  const port = input.port === undefined ? server.server_port : Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, 'Port must be between 1 and 65535');
  assertManualPort(port, server.id);
  const values = Object.fromEntries(Object.entries(controls.values).filter(([key]) => !profile.fields.some((f) => f.key === key && f.type === 'password')));
  const raw = JSON.parse(server.game_settings ?? '{}');
  writeFiles({ ...server, server_port: port }, renderGameFiles({ ...server, server_port: port }, profile, controls));
  if (profile.format === 'launch') setSetting(`game_controls_secrets:${server.id}`, JSON.stringify(Object.fromEntries(profile.fields.filter((f) => f.type === 'password').map((f) => [f.key, controls.values[f.key]]))));
  prep('UPDATE servers SET game_settings = ?, server_port = ? WHERE id = ?').run(JSON.stringify({ ...raw, controls: { ...controls, values } }), port, server.id);
}
export function prepareGameControls(server: ServerRecord, id: string) {
  const profile = GAME_PROFILES.find((p) => p.id === id);
  if (!profile || !stored(server)) return null;
  writeFiles(server, renderGameFiles(server, profile, controlsOf(server, profile)));
  return `${profile.label} settings refreshed`;
}

export function readGameConfig(server: ServerRecord, id: string) {
  const file = configFiles(server).find((f) => f.id === id);
  if (!file) throw new HttpError(404, 'Configuration file not found');
  const content = readText(server, file.path);
  return { ...file, content, revision: hash(content) };
}
export function writeGameConfig(server: ServerRecord, id: string, content: unknown, revision: unknown) {
  const file = readGameConfig(server, id);
  if (revision !== file.revision) throw new HttpError(409, 'This file changed. Reload before saving.');
  if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_CONFIG || content.includes('\0')) throw new HttpError(400, 'Enter text under 2 MB');
  if (file.path.endsWith('.json')) { try { JSON.parse(content); } catch { throw new HttpError(400, 'The configuration is not valid JSON'); } }
  const profile = requireGameProfile(server);
  if (profile.format === 'palworld' && profile.file && resolvedFile(server, profile.file) === file.path) readNative(content, profile);
  if (profile.format === 'xml' && (!/<ServerSettings\b/i.test(content) || !/<\/ServerSettings>/i.test(content))) throw new HttpError(400, 'The XML needs a ServerSettings root');
  const isPrimary = !!profile.file && resolvedFile(server, profile.file) === file.path;
  const parsed = isPrimary ? readNative(content, profile) : {};
  const portKey = ({ project_zomboid: 'DefaultPort', terraria: 'port', '7dtd': 'ServerPort', unturned: 'Port' } as Record<string, string>)[profile.id];
  const port = portKey && parsed[portKey] !== undefined ? Number(parsed[portKey]) : server.server_port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, 'The native game port must be between 1 and 65535');
  assertManualPort(port, server.id);
  writeFiles(server, { [file.path]: content });
  // Native edits become the saved values, so startup does not undo them.
  const saved = stored(server);
  if (saved && isPrimary) {
    for (const field of profile.fields) if (!field.launch && field.type !== 'password') {
      if (parsed[field.key] !== undefined) saved.values[field.key] = field.type === 'boolean' ? (/^(1|true)$/i.test(parsed[field.key]) ? 'true' : 'false') : parsed[field.key];
      else delete saved.values[field.key];
    }
    if (profile.id === 'arma3') {
      saved.rotation = [...content.matchAll(/\btemplate\s*=\s*"([A-Za-z0-9_.-]+)"/g)].map((m) => m[1]);
      saved.values.mission = saved.rotation[0] ?? '';
      if (parsed.difficulty) saved.values.difficulty = parsed.difficulty;
      saved.missionDifficultyManaged = false;
    }
    const raw = JSON.parse(server.game_settings ?? '{}'); raw.controls = saved;
    prep('UPDATE servers SET game_settings = ? WHERE id = ?').run(JSON.stringify(raw), server.id);
  }
  if (port !== server.server_port) prep('UPDATE servers SET server_port = ? WHERE id = ?').run(port, server.id);
}

/** Installs maps/worlds only; validates the whole archive before touching the instance. */
interface MapUpload { id: string; name: string; files: string[]; maps: string[] }
export function uploadGameMap(server: ServerRecord, name: string, buffer: Buffer) {
  const profile = requireGameProfile(server), map = profile.map;
  if (!map?.upload || !map.uploadRoot) throw new HttpError(400, 'Use this game’s Workshop or native save management to install worlds/maps');
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,127}$/.test(name)) throw new HttpError(400, 'Use a simple map filename');
  const files: Array<{ relative: string; data: Buffer }> = [];
  const ext = path.extname(name).toLowerCase();
  if (ext === '.zip') {
    const zip = new AdmZip(buffer), entries = zip.getEntries().filter((e) => !e.isDirectory);
    if (!entries.length || entries.length > 10000 || entries.reduce((sum, e) => sum + e.header.size, 0) > 1024 * 1048576) throw new HttpError(413, 'Map archive is empty or exceeds 1 GB unpacked');
    for (const e of entries) {
      const rel = e.entryName;
      if (rel.includes('\\') || rel.startsWith('/') || rel.split('/').some((s) => !s || s === '.' || s === '..') || ((e.attr >>> 16) & 0xf000) === 0xa000) throw new HttpError(400, `Unsafe archive path: ${rel}`);
      let relative: string;
      if (map.upload === 'valheim') {
        if (!/\.(db|fwl)$/i.test(rel)) throw new HttpError(400, 'A Valheim world archive must contain matching .db and .fwl files');
        relative = `${map.uploadRoot}/${path.posix.basename(rel)}`;
      } else if (map.upload === 'terraria') {
        if (!/\.wld$/i.test(rel)) throw new HttpError(400, 'Upload Terraria .wld world files');
        relative = `${map.uploadRoot}/${path.posix.basename(rel)}`;
      } else if (map.upload === 'bsp') {
        if (!/^(maps|materials|models|sound|resource|scripts)\//.test(rel)) throw new HttpError(400, 'A Source map package must use maps/, materials/, models/, sound/, resource/ or scripts/ paths');
        relative = `${path.posix.dirname(map.uploadRoot)}/${rel}`;
      } else if (map.upload === 'zip') {
        if (rel.split('/').length < 2) throw new HttpError(400, 'The ZIP must contain one named map/world folder');
        relative = `${map.uploadRoot}/${rel}`;
      } else throw new HttpError(400, 'This game uses a single map file, not a ZIP package');
      files.push({ relative, data: e.getData() });
    }
    if (map.upload === 'valheim') {
      for (const file of files) { const stem = file.relative.replace(/\.(db|fwl)$/i, ''); if (!files.some((f) => f.relative === stem + '.db') || !files.some((f) => f.relative === stem + '.fwl')) throw new HttpError(400, 'Valheim worlds require both matching .db and .fwl files'); }
    }
    if (map.upload === 'bsp' && !files.some((f) => f.relative.endsWith('.bsp'))) throw new HttpError(400, 'The package contains no BSP maps');
    if (map.upload === 'zip') {
      const roots = new Set(entries.map((e) => e.entryName.split('/')[0]));
      if (roots.size !== 1) throw new HttpError(400, 'Upload one named map/world folder at a time');
      const root = [...roots][0];
      const marker = profile.id === '7dtd' ? 'map_info.xml' : 'Level.dat';
      if (!entries.some((e) => e.entryName.toLowerCase() === `${root}/${marker}`.toLowerCase())) throw new HttpError(400, `The map folder needs ${marker}`);
    }
  } else {
    const expected: Record<string, string> = { bsp: '.bsp', pk3: '.pk3', pbo: '.pbo', terraria: '.wld' };
    if (ext !== expected[map.upload]) throw new HttpError(400, `Upload ${map.upload === 'valheim' || map.upload === 'zip' ? 'a world/map ZIP' : expected[map.upload] + ' maps'}`);
    if (map.upload === 'pk3' && !new AdmZip(buffer).getEntries().some((e) => /^maps\/.+\.bsp$/i.test(e.entryName))) throw new HttpError(400, 'This PK3 contains no maps');
    files.push({ relative: `${map.uploadRoot}/${name}`, data: buffer });
  }
  const targets = new Set<string>();
  for (const file of files) {
    const target = gameFile(server, file.relative);
    if (targets.has(target) || fs.existsSync(target)) throw new HttpError(409, 'A map or world with that filename already exists; uploads never overwrite saves');
    targets.add(target);
  }
  const created: string[] = [];
  try {
    for (const file of files) { const target = gameFile(server, file.relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, file.data, { flag: 'wx' }); created.push(target); }
  } catch (err) { for (const target of created) if (fs.existsSync(target)) fs.unlinkSync(target); throw err; }
  const mapNames = map.upload === 'pk3' ? new AdmZip(buffer).getEntries().filter((e) => /^maps\/.+\.bsp$/i.test(e.entryName)).map((e) => e.entryName.slice(5, -4))
    : map.upload === 'zip' ? [files[0].relative.slice(map.uploadRoot.length + 1).split('/')[0]]
    : map.upload === 'valheim' ? files.filter((f) => f.relative.endsWith('.fwl')).map((f) => path.posix.basename(f.relative, '.fwl'))
    : map.upload === 'terraria' ? files.map((f) => f.relative)
    : map.upload === 'pbo' ? [name.slice(0, -4)]
    : files.filter((f) => f.relative.endsWith('.bsp')).map((f) => f.relative.slice(map.uploadRoot!.length + 1, -4));
  const raw = JSON.parse(server.game_settings ?? '{}');
  const uploads: MapUpload[] = raw.mapUploads ?? [];
  uploads.push({ id: crypto.randomUUID(), name, files: files.map((f) => f.relative), maps: mapNames });
  prep('UPDATE servers SET game_settings = ? WHERE id = ?').run(JSON.stringify({ ...raw, mapUploads: uploads }), server.id);
  return { files: files.map((f) => f.relative) };
}

/** Only files recorded by this uploader can be removed; never shipped game content. */
export function removeGameMapUpload(server: ServerRecord, id: string) {
  const profile = requireGameProfile(server), raw = JSON.parse(server.game_settings ?? '{}');
  const uploads: MapUpload[] = raw.mapUploads ?? [], upload = uploads.find((u) => u.id === id);
  if (!upload || !profile.map?.uploadRoot) throw new HttpError(404, 'Uploaded map package not found');
  const settings = controlsOf(server, profile);
  if (upload.maps.some((m) => m === settings.values[profile.map!.key] || settings.rotation.includes(m))) throw new HttpError(409, 'Select a different map/world and remove this entry from the saved rotation before removing its files');
  const targets = upload.files.map((f) => ({ relative: f, absolute: gameFile(server, f) }));
  for (const { absolute } of targets) if (fs.existsSync(absolute) && !fs.lstatSync(absolute).isFile()) throw new HttpError(409, 'An uploaded file was replaced by a directory or link; manage it in File Management');
  for (const { absolute } of targets) if (fs.existsSync(absolute)) fs.unlinkSync(absolute);
  for (const { relative } of targets) {
    let parent = path.posix.dirname(relative);
    while (parent !== '.' && parent !== profile.map.uploadRoot && parent.startsWith(profile.map.uploadRoot + '/')) {
      const dir = gameFile(server, parent);
      if (!fs.existsSync(dir) || fs.readdirSync(dir).length) break;
      fs.rmdirSync(dir); parent = path.posix.dirname(parent);
    }
  }
  prep('UPDATE servers SET game_settings = ? WHERE id = ?').run(JSON.stringify({ ...raw, mapUploads: uploads.filter((u) => u.id !== id) }), server.id);
}
