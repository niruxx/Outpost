import fs from 'node:fs';
import crypto from 'node:crypto';
import AdmZip from 'adm-zip';
import { instanceDir, safeJoinReal } from '../utils/paths.js';
import { downloadFile, fetchJson, type LogFn } from '../utils/download.js';
import { HttpError } from '../utils/asyncHandler.js';
import { launchConfigOf, launchEnv } from './launchConfig.js';
import { isBeamMP, beammpModFolder, BEAMNG_EARTH_MAP } from './beammpService.js';
import { getServer, setLaunchConfig } from './serverService.js';
import { scanUploadBuffers } from './antivirusService.js';
import type { ServerRecord } from '../types/index.js';

const CLIENT = 'Resources/Client/beamng_earth.zip';
const PLUGIN = 'Resources/Server/BeamNGEarth';
const DISABLED_PLUGIN = '.outpost-beamng-earth/disabled/BeamNGEarth';
const STATE = '.outpost-beamng-earth.json';
const DEFAULT_MAP = '/levels/gridmap_v2/info.json';
interface EarthState { version: string; previousMap: string | null }
const RELEASES = 'https://api.github.com/repos/TecnaGamer/BeamNG.Earth/releases/latest';

function confined(server: ServerRecord, relative: string): string {
  const root = instanceDir(server.id);
  try {
    const target = safeJoinReal(root, relative);
    // Managed package files cannot alias another instance file through an internal symlink either.
    let prefix = '';
    for (const part of relative.split('/')) {
      prefix = prefix ? `${prefix}/${part}` : part;
      const probe = safeJoinReal(root, prefix);
      if (fs.existsSync(probe) && fs.lstatSync(probe).isSymbolicLink()) throw new Error('Symbolic link');
    }
    return target;
  } catch { throw new HttpError(400, 'BeamNG.Earth files must stay inside the instance without symbolic links'); }
}

function requireCompatible(server: ServerRecord) {
  if (!isBeamMP(server)) throw new HttpError(400, 'BeamNG.Earth requires a BeamMP instance');
  const launch = launchConfigOf(server);
  const resources = launchEnv(server, launch).BEAMMP_RESOURCE_FOLDER ?? generalValues(fileText(server, 'ServerConfig.toml')).ResourceFolder ?? 'Resources';
  if (launch.workingDir || resources !== 'Resources' || beammpModFolder(server) !== 'Resources/Client') throw new HttpError(400, 'BeamNG.Earth requires the default working directory and Resources folder');
}

function stateOf(server: ServerRecord): EarthState | null {
  const file = confined(server, STATE);
  if (!fs.existsSync(file)) return null;
  if (fs.statSync(file).size > 8192) throw new HttpError(400, 'Invalid BeamNG.Earth state file');
  let value: EarthState;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')) as EarthState; }
  catch { throw new HttpError(400, 'Invalid BeamNG.Earth state file'); }
  if (!value || typeof value.version !== 'string' || value.version.length > 100 || !(value.previousMap === null || typeof value.previousMap === 'string' && /^\/levels\/[^\r\n]+$/.test(value.previousMap) && !value.previousMap.split('/').includes('..'))) throw new HttpError(400, 'Invalid BeamNG.Earth state file');
  return value;
}

function fileText(server: ServerRecord, file: string): string {
  const target = confined(server, file);
  if (!fs.existsSync(target)) return '';
  if (!fs.statSync(target).isFile() || fs.statSync(target).size > 512 * 1024) throw new HttpError(400, `${file} is not a small configuration file`);
  return fs.readFileSync(target, 'utf8');
}

function generalValues(text: string): Record<string, string> {
  let general = false;
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const section = line.match(/^\s*\[([^\]]+)\]/);
    if (section) { general = section[1] === 'General'; continue; }
    const match = general ? line.match(/^\s*(\w+)\s*=\s*(.*)$/) : null;
    if (match) {
      const raw = match[2].trim();
      const quoted = raw.match(/^"(?:[^"\\]|\\.)*"/), literal = raw.match(/^'([^']*)'/);
      try { values[match[1]] = quoted ? JSON.parse(quoted[0]) : literal ? literal[1] : raw.replace(/\s*#.*$/, '').trim(); }
      catch { /* BeamMP itself reports invalid TOML. Unrelated settings are preserved. */ }
    }
  }
  return values;
}

function updateGeneral(text: string, changes: Record<string, string>): string {
  const lines = text.split(/\r?\n/), pending = new Map(Object.entries(changes));
  let general = false, found = false;
  const result: string[] = [];
  const append = () => { for (const [key, value] of pending) result.push(`${key} = ${value}`); pending.clear(); };
  for (const line of lines) {
    const section = line.match(/^\s*\[([^\]]+)\]/);
    if (section) { if (general) append(); general = section[1] === 'General'; found ||= general; }
    const key = general ? line.match(/^\s*(\w+)\s*=/)?.[1] : undefined;
    if (key && key in changes) { result.push(`${key} = ${changes[key]}`); pending.delete(key); }
    else result.push(line);
  }
  if (!found) result.push('[General]');
  append();
  return result.join('\n');
}

/** Bounded, allowlisted extraction: the official server package is not a game binary bundle. */
export function inspectEarthPackage(buffer: Buffer): Map<string, Buffer> {
  let zip: AdmZip;
  try { zip = new AdmZip(buffer); } catch { throw new HttpError(400, 'Invalid BeamNG.Earth server ZIP'); }
  const files = new Map<string, Buffer>();
  let expanded = 0;
  if (zip.getEntries().length > 4096) throw new HttpError(413, 'BeamNG.Earth package has too many entries');
  for (const entry of zip.getEntries()) {
    const name = entry.entryName;
    if (name.includes('\\') || name.startsWith('/') || name.includes(':') || name.replace(/\/$/, '').split('/').some(part => !part || part === '..' || part.endsWith('.') || part.endsWith(' ') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) || ((entry.attr >>> 16) & 0o170000) === 0o120000) throw new HttpError(400, 'Unsafe BeamNG.Earth archive path');
    if (entry.isDirectory) continue;
    const pluginFile = name.startsWith(`${PLUGIN}/`) && !/\/(store|spool|bake)\//.test(name);
    if (name !== CLIENT && !pluginFile && !['BeamNG.Earth-README.md', 'LICENSE-Earth.txt', 'CREDITS-Earth.md'].includes(name)) throw new HttpError(400, `Unexpected BeamNG.Earth package file: ${name}`);
    if (files.has(name)) throw new HttpError(400, 'Duplicate BeamNG.Earth package file');
    expanded += entry.header.size;
    if (entry.header.size > 128 * 1024 ** 2 || expanded > 256 * 1024 ** 2) throw new HttpError(413, 'BeamNG.Earth package exceeds extraction limits');
    files.set(name, entry.getData());
  }
  if (!files.has(CLIENT) || !files.has(`${PLUGIN}/main.lua`)) throw new HttpError(400, 'Package must include the Earth client ZIP and BeamNGEarth/main.lua');
  try {
    const mod = new AdmZip(files.get(CLIENT)!);
    const level = mod.getEntry('levels/beamng_earth/info.json');
    if (!level || level.header.size > 1024 * 1024) throw new Error('Missing level');
    JSON.parse(level.getData().toString('utf8'));
  } catch { throw new HttpError(400, 'Earth client ZIP is missing its valid levels/beamng_earth/info.json'); }
  return files;
}

/** Snapshot only replaced files; existing mods and plugin caches are never recursively overwritten. */
function commitFiles(server: ServerRecord, files: Map<string, Buffer>, finalize: () => void) {
  const before = new Map<string, Buffer | null>();
  for (const [relative] of files) {
    const file = confined(server, relative);
    if (fs.existsSync(file) && (!fs.statSync(file).isFile() || fs.statSync(file).size > 128 * 1024 ** 2)) throw new HttpError(409, `Cannot replace ${relative}`);
    before.set(relative, fs.existsSync(file) ? fs.readFileSync(file) : null);
  }
  try {
    for (const [relative, bytes] of files) {
      const file = confined(server, relative);
      fs.mkdirSync(safeJoinReal(instanceDir(server.id), relative.split('/').slice(0, -1).join('/')), { recursive: true });
      fs.writeFileSync(file, bytes, { mode: relative === 'ServerConfig.toml' ? 0o600 : 0o644 });
    }
    finalize();
  } catch (error) {
    for (const [relative, bytes] of before) {
      const file = confined(server, relative);
      if (bytes === null) fs.rmSync(file, { force: true }); else fs.writeFileSync(file, bytes);
    }
    throw error;
  }
}

export function earthStatus(server: ServerRecord) {
  requireCompatible(server);
  const launch = launchConfigOf(server), state = stateOf(server);
  const installed = [CLIENT, `${PLUGIN}/main.lua`].every(file => { const target = confined(server, file); return fs.existsSync(target) && fs.lstatSync(target).isFile(); });
  const map = launchEnv(server, launch).BEAMMP_MAP || generalValues(fileText(server, 'ServerConfig.toml')).Map;
  return { enabled: installed && map === BEAMNG_EARTH_MAP, requested: launch.beamngEarth === true, installed, version: state?.version ?? null, map, releasesUrl: 'https://github.com/TecnaGamer/BeamNG.Earth/releases', clientRequired: true };
}

/** The plugin reads the TOML directly for its Earth listing, so synchronize launch overrides. */
function earthConfig(server: ServerRecord): string {
  const text = fileText(server, 'ServerConfig.toml'), cfg = generalValues(text);
  const env = launchEnv(server, launchConfigOf(server));
  const privateValue = env.BEAMMP_PRIVATE ?? cfg.Private ?? 'true';
  if (!['true', 'false'].includes(privateValue)) throw new HttpError(400, 'BeamNG.Earth visibility must be true or false');
  const key = env.BEAMMP_AUTH_KEY || cfg.AuthKey || (privateValue === 'true' ? crypto.randomUUID() : '');
  if (!key) throw new HttpError(400, 'Public BeamNG.Earth servers need a Keymaster auth key');
  const port = Number(env.BEAMMP_PORT ?? cfg.Port ?? server.server_port);
  const players = Number(env.BEAMMP_MAX_PLAYERS ?? cfg.MaxPlayers ?? 8);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(players) || players < 1 || players > 128) throw new HttpError(400, 'BeamNG.Earth needs a valid port and a player limit between 1 and 128');
  return updateGeneral(text, {
    Map: JSON.stringify(BEAMNG_EARTH_MAP), Port: String(port),
    Name: JSON.stringify(env.BEAMMP_NAME || cfg.Name || server.name), Private: privateValue, AuthKey: JSON.stringify(key),
    MaxPlayers: String(players), ResourceFolder: '"Resources"',
  });
}

export async function installEarth(server: ServerRecord, log: LogFn = () => {}, authorize: () => void = () => {}) {
  requireCompatible(server);
  const release = await fetchJson<{ tag_name: string; assets: { name: string; size: number; digest?: string; browser_download_url: string }[] }>(RELEASES, log);
  const asset = release.assets.find(asset => asset.name === `BeamNG.Earth-BeamMP-Server-${release.tag_name.replace(/^v/, '')}.zip`);
  if (!asset || asset.size < 1 || asset.size > 128 * 1024 ** 2) throw new HttpError(502, 'The official release has no supported BeamNG.Earth server package');
  const url = new URL(asset.browser_download_url);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !url.pathname.startsWith('/TecnaGamer/BeamNG.Earth/releases/download/')) throw new HttpError(502, 'Unexpected BeamNG.Earth package URL');
  const temporary = confined(server, `.outpost-earth-download-${crypto.randomUUID()}.zip`);
  let files: Map<string, Buffer>;
  try {
    await downloadFile(url.href, temporary, undefined, log);
    const buffer = fs.readFileSync(temporary);
    if (buffer.length !== asset.size) throw new HttpError(502, 'Incomplete BeamNG.Earth package download');
    if (asset.digest && asset.digest !== `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`) throw new HttpError(502, 'BeamNG.Earth checksum mismatch');
    files = inspectEarthPackage(buffer);
    await scanUploadBuffers([{ name: asset.name, buffer }], server.id);
  } finally { fs.rmSync(temporary, { force: true }); }
  authorize();
  const current = getServer(server.id);
  if (!current) throw new HttpError(404, 'Server was deleted while downloading Earth');
  server = current;
  requireCompatible(server);
  const launch = launchConfigOf(server), prior = stateOf(server);
  const previous = launchEnv(server, launch).BEAMMP_MAP ?? generalValues(fileText(server, 'ServerConfig.toml')).Map ?? null;
  if (previous && (!/^\/levels\/[^\r\n]+$/.test(previous) || previous.split('/').includes('..'))) throw new HttpError(400, 'Fix the existing map path before enabling Earth');
  const next = { ...launch, beamngEarth: true, env: [...(launch.env ?? []).filter(e => e.key !== 'BEAMMP_MAP'), { key: 'BEAMMP_MAP', value: BEAMNG_EARTH_MAP }] };
  const state: EarthState = { version: release.tag_name, previousMap: prior?.previousMap ?? (previous === BEAMNG_EARTH_MAP ? DEFAULT_MAP : previous) };
  const updated = { ...server, launch_config: JSON.stringify(next) };
  files.set('ServerConfig.toml', Buffer.from(earthConfig(updated)));
  files.set(STATE, Buffer.from(JSON.stringify(state)));
  const restored: [string, string][] = [];
  try {
    for (const [from, to] of [[DISABLED_PLUGIN, PLUGIN], [`${CLIENT}.disabled`, CLIENT]]) {
      const source = confined(server, from), target = confined(server, to);
      if (!fs.existsSync(source)) continue;
      if (fs.existsSync(target)) throw new HttpError(409, 'Both active and disabled Earth files exist; resolve them in File Management first');
      fs.mkdirSync(safeJoinReal(instanceDir(server.id), to.split('/').slice(0, -1).join('/')), { recursive: true });
      fs.renameSync(source, target); restored.push([target, source]);
    }
    commitFiles(server, files, () => setLaunchConfig(server.id, JSON.stringify(next)));
  } catch (error) { for (const [from, to] of restored.reverse()) fs.renameSync(from, to); throw error; }
  log(`[Outpost] BeamNG.Earth ${release.tag_name} installed. Each player needs the matching Earth app.`);
  return earthStatus(getServer(server.id)!);
}

export function disableEarth(server: ServerRecord) {
  requireCompatible(server);
  const state = stateOf(server), launch = launchConfigOf(server), renamed: [string, string][] = [];
  const next = { ...launch, env: [...(launch.env ?? [])] };
  delete next.beamngEarth;
  const current = next.env.find(e => e.key === 'BEAMMP_MAP')?.value ?? generalValues(fileText(server, 'ServerConfig.toml')).Map;
  next.env = [...next.env.filter(e => e.key !== 'BEAMMP_MAP'), { key: 'BEAMMP_MAP', value: current && current !== BEAMNG_EARTH_MAP ? current : state?.previousMap || DEFAULT_MAP }];
  const restoredMap = next.env.find(e => e.key === 'BEAMMP_MAP')!.value;
  const config = updateGeneral(fileText(server, 'ServerConfig.toml'), { Map: JSON.stringify(restoredMap) });
  try {
    for (const [from, to] of [[PLUGIN, DISABLED_PLUGIN], [CLIENT, `${CLIENT}.disabled`]]) {
      const source = confined(server, from), target = confined(server, to);
      if (!fs.existsSync(source)) continue;
      if (fs.existsSync(target)) throw new HttpError(409, 'Disabled Earth files already exist; resolve them in File Management first');
      fs.mkdirSync(safeJoinReal(instanceDir(server.id), to.split('/').slice(0, -1).join('/')), { recursive: true });
      fs.renameSync(source, target); renamed.push([target, source]);
    }
    commitFiles(server, new Map([['ServerConfig.toml', Buffer.from(config)]]), () => setLaunchConfig(server.id, JSON.stringify(next)));
  } catch (error) { for (const [from, to] of renamed.reverse()) fs.renameSync(from, to); throw error; }
  return earthStatus(getServer(server.id)!);
}

export function prepareEarthStart(server: ServerRecord) {
  if (!launchConfigOf(server).beamngEarth) return;
  if (!earthStatus(server).installed) throw new HttpError(409, 'BeamNG.Earth files are missing or disabled. Finish Earth setup or disable Earth before starting.');
  if (earthStatus(server).map !== BEAMNG_EARTH_MAP) throw new HttpError(409, 'Enable Earth again to select its map, or disable Earth before selecting another map.');
  fs.writeFileSync(confined(server, 'ServerConfig.toml'), earthConfig(server), { mode: 0o600 });
}
