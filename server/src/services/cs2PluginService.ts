import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { HttpError } from '../utils/asyncHandler.js';
import { instanceDir } from '../utils/paths.js';
import { downloadFile, type LogFn } from '../utils/download.js';
import { runStreamed } from './downloadService.js';
import { prep } from '../db/db.js';
import { cs2SettingsOf } from './cs2Service.js';
import type { ServerRecord } from '../types/index.js';

/**
 * CS2 server plugins: Metamod:Source (the loader) + CounterStrikeSharp (the C# plugin framework most
 * CS2 plugins use), a catalog of plugins, installs from any GitHub repo's latest release, and
 * enable / disable / update / remove.
 *
 * Layout (under game/csgo):
 *   addons/metamod/…                          Metamod:Source
 *   addons/counterstrikesharp/plugins/<Name>/  one folder per plugin (…/plugins/disabled/<Name> = off)
 *   addons/counterstrikesharp/configs/…       plugin configs
 * gameinfo.gi gets a "Game csgo/addons/metamod" search path so CS2 loads Metamod — CS2 updates
 * replace that file, so it's re-checked before every start.
 */

const csgo = (server: ServerRecord) => path.join(instanceDir(server.id), 'game', 'csgo');
const cssRoot = (server: ServerRecord) => path.join(csgo(server), 'addons', 'counterstrikesharp');
const pluginsDir = (server: ServerRecord) => path.join(cssRoot(server), 'plugins');
const disabledDir = (server: ServerRecord) => path.join(pluginsDir(server), 'disabled');
const isWin = () => process.platform === 'win32';

// ---------------------------------------------------------------------------
// The plugin catalog (checked: maintained repos with downloadable releases)
// ---------------------------------------------------------------------------

export interface CatalogPlugin {
  id: string;
  name: string;
  repo: string;
  description: string;
  tags: string[];
  /** Asset names to avoid when picking the release download (bundles with CounterStrikeSharp etc.). */
  avoidAssets?: RegExp;
  /** Catalog plugins it needs — installed first if missing. */
  requires?: string[];
  /** Plugin folder it installs, to tell whether a requirement is already there. */
  folder?: string;
  note?: string;
}

export const CATALOG: CatalogPlugin[] = [
  {
    id: 'speedometer-wasd',
    name: 'Speedometer HUD + WASD',
    repo: 'le1t/CS2_SpeedometerHUD_WASD',
    description: 'Shows your speed and the movement keys you’re pressing (W A S D, jump, crouch) on screen — also while spectating. Players toggle it with css_speedometer_toggle.',
    tags: ['speed', 'keys', 'hud', 'surf', 'bhop'],
    requires: ['gamehud'],
    folder: 'CS2_SpeedometerHUD_WASD',
  },
  {
    id: 'gamehud',
    name: 'GameHUD',
    repo: 'darkerz7/CS2-GameHUD',
    description: 'Draws on-screen text for other plugins (needed by Speedometer HUD + WASD).',
    tags: ['hud', 'library'],
    folder: 'CS2-GameHUD',
  },
  {
    id: 'sharptimer',
    name: 'SharpTimer',
    repo: 'SharpTimer/SharpTimer',
    description: 'Surf / bhop / KZ timer: start & end zones, personal bests, map records, !r to restart, speed HUD. Ships zone data for many popular maps.',
    tags: ['timer', 'surf', 'bhop', 'kz', 'speed', 'hud'],
    note: 'Its settings are in game/csgo/cfg/SharpTimer (rename the example.* files to use them).',
  },
  {
    id: 'simpleadmin',
    name: 'CS2-SimpleAdmin',
    repo: 'daffyyyy/CS2-SimpleAdmin',
    description: 'In-game admin menu and commands: !admin, kick, ban, mute, slay, map change, with a ban list.',
    tags: ['admin'],
    note: 'Admins come from the “Becoming an admin” list (CounterStrikeSharp admins).',
  },
  {
    id: 'retakes',
    name: 'Retakes',
    repo: 'B3none/cs2-retakes',
    description: 'Retake mode: rounds start with the bomb planted and attackers defending it. Only for bombsite (de_) maps it has spawns for — on any other map it ends every round, so turn it off there.',
    tags: ['mode', 'retakes'],
    note: 'Retakes takes over every round — turn it off when playing anything else (surf, bhop, arms race…).',
    avoidAssets: /no-map-configs/i,
  },
  {
    id: 'matchzy',
    name: 'MatchZy',
    repo: 'shobhit-pathak/MatchZy',
    description: 'Competitive match management: ready-up, knife round, pauses, demos, practice mode, match configs.',
    tags: ['competitive', 'match', 'practice'],
    avoidAssets: /with-cssharp/i,
  },
];

// ---------------------------------------------------------------------------
// GitHub releases
// ---------------------------------------------------------------------------

interface GhRelease {
  tag_name: string;
  assets: { name: string; browser_download_url: string; size: number }[];
}

async function latestRelease(repo: string): Promise<GhRelease> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new HttpError(400, 'GitHub repositories look like owner/name');
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { 'User-Agent': 'Outpost-Panel', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) throw new HttpError(404, `${repo} has no published releases`);
  if (res.status === 403) throw new HttpError(429, 'GitHub’s rate limit was hit — try again in a few minutes');
  if (!res.ok) throw new HttpError(502, `GitHub answered ${res.status}`);
  return (await res.json()) as GhRelease;
}

/** "https://github.com/owner/name/…" or "owner/name" → "owner/name". */
export function repoOf(input: string): string {
  const m = input.trim().match(/^(?:https?:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?(?:\/.*)?$/i);
  if (!m) throw new HttpError(400, 'Paste a GitHub repository link, e.g. https://github.com/owner/plugin');
  return m[1];
}

function pickAsset(rel: GhRelease, avoid?: RegExp) {
  const other = isWin() ? /linux/i : /windows|win64|win-x64/i;
  const zips = rel.assets.filter((a) => /\.zip$/i.test(a.name) && !other.test(a.name) && !(avoid && avoid.test(a.name)));
  // CounterStrikeSharp itself in a plugin bundle would overwrite the framework — avoid those.
  return zips.find((a) => !/counterstrikesharp|with-cssharp|with-runtime/i.test(a.name)) ?? zips[0];
}

// ---------------------------------------------------------------------------
// Frameworks: Metamod:Source + CounterStrikeSharp
// ---------------------------------------------------------------------------

export interface FrameworkStatus {
  metamod: { installed: boolean; version: string | null };
  css: { installed: boolean; version: string | null };
  gameinfoPatched: boolean;
  /** The "Load plugins" switch. */
  loaded: boolean;
  /** .NET's ICU dependency found on the host (Linux). */
  icu: boolean;
}

function frameworkVersions(server: ServerRecord): { metamod?: string; css?: string } {
  return (cs2SettingsOf(server) as unknown as { frameworks?: { metamod?: string; css?: string } }).frameworks ?? {};
}

function saveFrameworkVersion(server: ServerRecord, key: 'metamod' | 'css', version: string) {
  const raw = server.game_settings ? (JSON.parse(server.game_settings) as Record<string, unknown>) : {};
  const fw = { ...((raw.frameworks as Record<string, string>) ?? {}), [key]: version };
  prep('UPDATE servers SET game_settings = ? WHERE id = ?').run(JSON.stringify({ ...raw, frameworks: fw }), server.id);
}

const gameinfoPath = (server: ServerRecord) => path.join(csgo(server), 'gameinfo.gi');

export function frameworkStatus(server: ServerRecord): FrameworkStatus {
  const v = frameworkVersions(server);
  const mm = fs.existsSync(path.join(csgo(server), 'addons', 'metamod'));
  const css = fs.existsSync(path.join(cssRoot(server), 'api')) || fs.existsSync(path.join(cssRoot(server), 'bin'));
  let patched = false;
  try {
    patched = /Game\s+csgo\/addons\/metamod/i.test(fs.readFileSync(gameinfoPath(server), 'utf8'));
  } catch {
    // not installed yet
  }
  return { metamod: { installed: mm, version: mm ? (v.metamod ?? 'installed') : null }, css: { installed: css, version: css ? (v.css ?? 'installed') : null }, gameinfoPatched: patched, loaded: pluginsLoaded(server), icu: hostHasIcu() };
}

/**
 * Adds "Game csgo/addons/metamod" to gameinfo.gi's SearchPaths (before the first "Game csgo" line),
 * so CS2 loads Metamod. Idempotent; returns true if it changed the file.
 */
export function patchGameinfo(server: ServerRecord): boolean {
  const file = gameinfoPath(server);
  if (!fs.existsSync(file) || !fs.existsSync(path.join(csgo(server), 'addons', 'metamod'))) return false;
  const text = fs.readFileSync(file, 'utf8');
  if (/Game\s+csgo\/addons\/metamod/i.test(text)) return false;
  const lines = text.split(/(\r?\n)/);
  const idx = lines.findIndex((l) => /^\s*Game\s+csgo\s*$/i.test(l));
  if (idx < 0) return false;
  const indent = lines[idx].match(/^\s*/)?.[0] ?? '\t\t\t';
  lines.splice(idx, 0, `${indent}Game\tcsgo/addons/metamod`, lines[idx + 1] ?? '\n');
  fs.writeFileSync(file, lines.join(''));
  return true;
}

/** Takes the Metamod line back out of gameinfo.gi, so CS2 starts without any plugins. */
export function unpatchGameinfo(server: ServerRecord): boolean {
  const file = gameinfoPath(server);
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, 'utf8');
  const next = text.replace(/^[ \t]*Game[ \t]+csgo\/addons\/metamod[ \t]*\r?\n/gim, '');
  if (next === text) return false;
  fs.writeFileSync(file, next);
  return true;
}

/** "Load plugins" switch — off starts CS2 without Metamod (and so without any plugin), files untouched. */
export function pluginsLoaded(server: ServerRecord): boolean {
  try {
    return !(server.game_settings && (JSON.parse(server.game_settings) as { pluginsOff?: boolean }).pluginsOff);
  } catch {
    return true;
  }
}

export function setPluginsLoaded(server: ServerRecord, on: boolean) {
  const row = prep('SELECT game_settings FROM servers WHERE id = ?').get(server.id) as { game_settings: string | null };
  const raw = row?.game_settings ? (JSON.parse(row.game_settings) as Record<string, unknown>) : {};
  prep('UPDATE servers SET game_settings = ? WHERE id = ?').run(JSON.stringify({ ...raw, pluginsOff: !on }), server.id);
  if (on) patchGameinfo(server);
  else unpatchGameinfo(server);
}

const ICU_DIRS = ['/usr/lib', '/usr/lib64', '/usr/lib/x86_64-linux-gnu', '/lib/x86_64-linux-gnu', '/usr/lib/aarch64-linux-gnu', '/usr/local/lib'];
let icuCache: boolean | null = null;
/** .NET (inside CounterStrikeSharp) needs ICU on Linux; without it the runtime aborts while CS2 is loading. */
export function hostHasIcu(): boolean {
  if (process.platform === 'win32') return true;
  if (icuCache === null) {
    icuCache = ICU_DIRS.some((d) => {
      try {
        return fs.readdirSync(d).some((f) => /^libicuuc\.so(\.\d+)*$/.test(f));
      } catch {
        return false;
      }
    });
  }
  return icuCache;
}

/** Extra environment for CS2 when CounterStrikeSharp is in: run .NET without ICU if the host has none. */
export function cs2PluginEnv(server: ServerRecord): Record<string, string> {
  if (!pluginsLoaded(server) || !frameworkStatus(server).css.installed || hostHasIcu()) return {};
  return { DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1' };
}

/** Called before each start: CS2 updates replace gameinfo.gi, which would silently unload every plugin. */
export function ensurePluginLoader(server: ServerRecord): string | null {
  if (!pluginsLoaded(server)) return unpatchGameinfo(server) || frameworkStatus(server).metamod.installed ? 'Plugins are switched off (Metamod not loaded)' : null;
  const notes: string[] = [];
  if (patchGameinfo(server)) notes.push('Re-added Metamod to gameinfo.gi (a CS2 update had replaced it) — plugins load as usual');
  if (frameworkStatus(server).css.installed && !hostHasIcu()) notes.push('No ICU library on this host — running CounterStrikeSharp’s .NET in invariant mode (install libicu to avoid it)');
  return notes.join(' · ') || null;
}

async function extractTarGz(archive: string, dest: string, onLog?: LogFn) {
  await runStreamed('tar', ['-xzf', archive, '-C', dest], dest, onLog);
}

export async function installFrameworks(server: ServerRecord, onLog: LogFn): Promise<FrameworkStatus> {
  if (!fs.existsSync(gameinfoPath(server))) throw new HttpError(409, 'Install the CS2 server first (game/csgo/gameinfo.gi is missing)');
  const tmp = path.join(instanceDir(server.id), '_plugin_dl');
  fs.mkdirSync(tmp, { recursive: true });
  try {
    // Metamod:Source 2.0 (the CS2 branch) — the "latest" file names the current build.
    const latestName = (await (await fetch(`https://mms.alliedmods.net/mmsdrop/2.0/mmsource-latest-${isWin() ? 'windows' : 'linux'}`, { signal: AbortSignal.timeout(20_000) })).text()).trim();
    if (!/^mmsource-[\w.\-]+\.(tar\.gz|zip)$/.test(latestName)) throw new Error('Couldn’t find the latest Metamod:Source build');
    onLog(`==> Metamod:Source ${latestName}`);
    const mmFile = path.join(tmp, latestName);
    await downloadFile(`https://mms.alliedmods.net/mmsdrop/2.0/${latestName}`, mmFile, undefined, onLog);
    if (latestName.endsWith('.zip')) new AdmZip(mmFile).extractAllTo(csgo(server), true);
    else await extractTarGz(mmFile, csgo(server), onLog);
    saveFrameworkVersion(server, 'metamod', latestName.replace(/^mmsource-|-(linux|windows)\.(tar\.gz|zip)$/g, ''));

    // CounterStrikeSharp with its .NET runtime.
    const rel = await latestRelease('roflmuffin/CounterStrikeSharp');
    const asset = rel.assets.find((a) => a.name.startsWith(`counterstrikesharp-with-runtime-${isWin() ? 'windows' : 'linux'}`));
    if (!asset) throw new Error('No CounterStrikeSharp download for this OS in the latest release');
    onLog(`==> CounterStrikeSharp ${rel.tag_name} (with .NET runtime, ~${Math.round(asset.size / 1048576)} MB)`);
    const cssFile = path.join(tmp, asset.name);
    await downloadFile(asset.browser_download_url, cssFile, undefined, onLog);
    new AdmZip(cssFile).extractAllTo(csgo(server), true);
    saveFrameworkVersion({ ...server, game_settings: (prep('SELECT game_settings FROM servers WHERE id = ?').get(server.id) as { game_settings: string }).game_settings }, 'css', rel.tag_name);

    setPluginsLoaded(server, true);
    if (frameworkStatus(server).gameinfoPatched) onLog('==> Added Metamod to gameinfo.gi');
    if (!hostHasIcu()) onLog('==> Note: this host has no ICU library (libicu) — .NET will run in invariant mode. Installing libicu is better.');
    onLog('==> Plugin frameworks ready — restart the server, then type "meta list" / "css_plugins list" in the console to check');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return frameworkStatus(server);
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

export interface InstalledCs2Plugin {
  folder: string;
  enabled: boolean;
  /** Built for SwiftlyS2 (another plugin framework) — CounterStrikeSharp can't load it. */
  swiftly: boolean;
  /** Where it came from (catalog/GitHub), when Outpost installed it. */
  repo: string | null;
  version: string | null;
  catalogId: string | null;
}

interface PluginSource {
  repo: string;
  version: string;
  catalogId: string | null;
  folders: string[];
}

function sourcesOf(server: ServerRecord): Record<string, PluginSource> {
  try {
    const raw = server.game_settings ? (JSON.parse(server.game_settings) as { pluginSources?: Record<string, PluginSource> }) : {};
    return raw.pluginSources ?? {};
  } catch {
    return {};
  }
}

function saveSources(serverId: string, sources: Record<string, PluginSource>) {
  const row = prep('SELECT game_settings FROM servers WHERE id = ?').get(serverId) as { game_settings: string | null };
  const raw = row?.game_settings ? (JSON.parse(row.game_settings) as Record<string, unknown>) : {};
  prep('UPDATE servers SET game_settings = ? WHERE id = ?').run(JSON.stringify({ ...raw, pluginSources: sources }), serverId);
}

/** SwiftlyS2 plugins look like CounterStrikeSharp ones (C# dlls) but reference SwiftlyS2's API instead. */
function isSwiftlyPlugin(dlls: Buffer[]): boolean {
  return dlls.some((d) => d.includes('SwiftlyS2')) && !dlls.some((d) => d.includes('CounterStrikeSharp.API'));
}

function folderIsSwiftly(dir: string): boolean {
  try {
    return isSwiftlyPlugin(
      fs
        .readdirSync(dir)
        .filter((f) => f.toLowerCase().endsWith('.dll'))
        .map((f) => fs.readFileSync(path.join(dir, f))),
    );
  } catch {
    return false;
  }
}

const hasDll = (dir: string) => {
  try {
    return fs.readdirSync(dir).some((f) => f.toLowerCase().endsWith('.dll'));
  } catch {
    return false;
  }
};

export function listCs2Plugins(server: ServerRecord): InstalledCs2Plugin[] {
  const sources = sourcesOf(server);
  const byFolder = new Map<string, PluginSource>();
  for (const s of Object.values(sources)) for (const f of s.folders) byFolder.set(f, s);
  const out: InstalledCs2Plugin[] = [];
  for (const [dir, enabled] of [
    [pluginsDir(server), true],
    [disabledDir(server), false],
  ] as const) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name === 'disabled' || !hasDll(path.join(dir, name))) continue;
      const src = byFolder.get(name);
      out.push({ folder: name, enabled, swiftly: folderIsSwiftly(path.join(dir, name)), repo: src?.repo ?? null, version: src?.version ?? null, catalogId: src?.catalogId ?? null });
    }
  }
  return out.sort((a, b) => a.folder.localeCompare(b.folder));
}

/**
 * Works out where a plugin zip's files belong under game/csgo, whatever its layout. Returns
 * [entry, destination relative to game/csgo] pairs (source code, readmes etc. outside a plugin
 * layout are skipped) and the plugin folders it creates.
 */
export function planZip(entries: string[]): { files: [string, string][]; folders: string[] } {
  const files = entries.filter((e) => !e.endsWith('/'));
  const norm = (e: string) => e.replace(/\\/g, '/');
  const segIndex = (e: string, seg: string) => {
    const parts = norm(e).split('/');
    return parts.findIndex((p) => p.toLowerCase() === seg);
  };
  const plan: [string, string][] = [];
  const add = (entry: string, dest: string) => {
    const clean = path.posix.normalize(dest);
    if (clean.startsWith('..') || path.posix.isAbsolute(clean)) return;
    plan.push([entry, clean]);
  };
  const baseBefore = (seg: string) => {
    // configs/plugins/<Name>/ is a config folder, not the plugins folder.
    const hit = files.find((e) => {
      const i = segIndex(e, seg);
      return i >= 0 && !(seg === 'plugins' && norm(e).split('/')[i - 1]?.toLowerCase() === 'configs');
    });
    if (!hit) return null;
    const parts = norm(hit).split('/');
    return parts.slice(0, segIndex(hit, seg)).join('/');
  };
  const under = (e: string, base: string) => (base ? norm(e).startsWith(base + '/') : true);
  const rest = (e: string, base: string) => (base ? norm(e).slice(base.length + 1) : norm(e));

  let base: string | null;
  if ((base = baseBefore('addons')) !== null) {
    // …/addons/… (+ siblings like cfg/) → game/csgo/…
    for (const e of files) if (under(e, base) && /^(addons|cfg|maps|sound|materials|models|particles|resource)\//i.test(rest(e, base))) add(e, rest(e, base));
  } else if ((base = baseBefore('counterstrikesharp')) !== null) {
    for (const e of files) if (under(e, base) && /^counterstrikesharp\//i.test(rest(e, base))) add(e, `addons/${rest(e, base)}`);
  } else if ((base = baseBefore('plugins')) !== null) {
    // …/plugins/<Name>/… (+ configs/, shared/, gamedata/ beside it) → addons/counterstrikesharp/…
    for (const e of files) if (under(e, base) && /^(plugins|configs|shared|gamedata)\//i.test(rest(e, base))) add(e, `addons/counterstrikesharp/${rest(e, base)}`);
  } else {
    // <Name>/<Name>.dll folders and/or configs/, or bare dlls at the root.
    const dllDirs = new Set(files.filter((e) => /\.dll$/i.test(e)).map((e) => path.posix.dirname(norm(e))));
    for (const e of files) {
      const n = norm(e);
      if (/^configs\//i.test(n)) add(e, `addons/counterstrikesharp/${n}`);
    }
    const rootDlls = files.filter((e) => !norm(e).includes('/') && /\.dll$/i.test(e));
    if (rootDlls.length) {
      const main = rootDlls.find((d) => files.includes(d.replace(/\.dll$/i, '.deps.json'))) ?? rootDlls[0];
      const name = main.replace(/\.dll$/i, '');
      for (const e of files) if (!norm(e).includes('/')) add(e, `addons/counterstrikesharp/plugins/${name}/${e}`);
    }
    for (const d of dllDirs) {
      if (d === '.' || /^configs\//i.test(d)) continue;
      const top = d.split('/')[0];
      for (const e of files) if (norm(e).startsWith(top + '/')) add(e, `addons/counterstrikesharp/plugins/${norm(e)}`);
    }
  }
  const folders = [...new Set(plan.map(([, d]) => d.match(/^addons\/counterstrikesharp\/plugins\/([^/]+)\//i)?.[1]).filter((f): f is string => !!f && f.toLowerCase() !== 'disabled'))];
  // Configs that already exist are the owner's — never overwrite them on install/update.
  return { files: plan, folders };
}

export async function installPlugin(server: ServerRecord, input: { catalogId?: string; repo?: string }, onLog: LogFn): Promise<{ folders: string[]; version: string; repo: string }> {
  if (!frameworkStatus(server).css.installed) throw new HttpError(409, 'Install Metamod + CounterStrikeSharp first');
  const cat = input.catalogId ? CATALOG.find((c) => c.id === input.catalogId) : null;
  if (input.catalogId && !cat) throw new HttpError(404, 'Unknown plugin');
  const repo = cat?.repo ?? repoOf(input.repo ?? '');
  for (const dep of cat?.requires ?? []) {
    const d = CATALOG.find((c) => c.id === dep)!;
    const have = listCs2Plugins(server).some((p) => p.catalogId === dep || p.folder === d.folder);
    if (!have) {
      onLog(`==> ${cat!.name} needs ${d.name} — installing it first`);
      await installPlugin(server, { catalogId: dep }, onLog);
    }
  }
  const rel = await latestRelease(repo);
  const asset = pickAsset(rel, cat?.avoidAssets);
  if (!asset) throw new HttpError(400, `${repo}’s latest release (${rel.tag_name}) has no .zip download`);
  onLog(`==> ${cat?.name ?? repo} ${rel.tag_name} — ${asset.name}`);
  const tmp = path.join(instanceDir(server.id), '_plugin_dl');
  fs.mkdirSync(tmp, { recursive: true });
  const zipFile = path.join(tmp, asset.name);
  try {
    await downloadFile(asset.browser_download_url, zipFile, undefined, onLog);
    const zip = new AdmZip(zipFile);
    const { files, folders } = planZip(zip.getEntries().map((e) => e.entryName));
    if (!folders.length) throw new HttpError(400, `Couldn’t find a CounterStrikeSharp plugin in ${asset.name} — it may need installing by hand`);
    if (files.some(([, d]) => /^addons\/counterstrikesharp\/(api|bin|dotnet)\//i.test(d)))
      throw new HttpError(400, `${asset.name} bundles CounterStrikeSharp itself — refusing to overwrite the framework`);
    const dlls = files.filter(([, d]) => /\/plugins\/[^/]+\/[^/]+\.dll$/i.test(d)).map(([e]) => zip.getEntry(e)?.getData() ?? Buffer.alloc(0));
    if (isSwiftlyPlugin(dlls)) throw new HttpError(400, `${repo} ${rel.tag_name} is a SwiftlyS2 plugin, not a CounterStrikeSharp one — it can’t load here`);
    const root = csgo(server);
    // A disabled copy is replaced by the fresh one (enabled).
    for (const f of folders) fs.rmSync(path.join(disabledDir(server), f), { recursive: true, force: true });
    let written = 0;
    for (const [entry, dest] of files) {
      const target = path.join(root, dest);
      if (!target.startsWith(root + path.sep)) continue;
      if (/\/configs\//i.test(dest) && fs.existsSync(target)) continue; // keep your config
      const data = zip.getEntry(entry)?.getData();
      if (!data) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
      written++;
    }
    const sources = sourcesOf({ ...server, game_settings: (prep('SELECT game_settings FROM servers WHERE id = ?').get(server.id) as { game_settings: string | null }).game_settings });
    sources[repo] = { repo, version: rel.tag_name, catalogId: cat?.id ?? null, folders };
    saveSources(server.id, sources);
    onLog(`==> Installed ${folders.join(', ')} (${written} files)${cat?.note ? ` — ${cat.note}` : ''}`);
    return { folders, version: rel.tag_name, repo };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function folderPath(server: ServerRecord, folder: string, enabled: boolean) {
  if (!/^[\w.\-]+$/.test(folder) || folder === 'disabled') throw new HttpError(400, 'Invalid plugin');
  return path.join(enabled ? pluginsDir(server) : disabledDir(server), folder);
}

/** CounterStrikeSharp skips plugins/disabled/, so turning a plugin off is a move. */
export function setPluginEnabled(server: ServerRecord, folder: string, enabled: boolean) {
  const from = folderPath(server, folder, !enabled);
  const to = folderPath(server, folder, enabled);
  if (!fs.existsSync(from)) throw new HttpError(404, 'Plugin not found');
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.rmSync(to, { recursive: true, force: true });
  fs.renameSync(from, to);
}

export function removePlugin(server: ServerRecord, folder: string) {
  let found = false;
  for (const enabled of [true, false]) {
    const p = folderPath(server, folder, enabled);
    if (fs.existsSync(p)) {
      fs.rmSync(p, { recursive: true, force: true });
      found = true;
    }
  }
  if (!found) throw new HttpError(404, 'Plugin not found');
  const sources = sourcesOf(server);
  for (const [k, s] of Object.entries(sources)) {
    s.folders = s.folders.filter((f) => f !== folder);
    if (!s.folders.length) delete sources[k];
  }
  saveSources(server.id, sources);
}

/** Newer release available for a plugin Outpost installed? */
export async function checkUpdates(server: ServerRecord): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const s of Object.values(sourcesOf(server))) {
    try {
      const rel = await latestRelease(s.repo);
      if (rel.tag_name !== s.version) out[s.repo] = rel.tag_name;
    } catch {
      // unreachable / rate-limited — skip
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Plugin config editor
// ---------------------------------------------------------------------------

export interface PluginConfigFile {
  /** Relative to game/csgo. */
  path: string;
  size: number;
  kind: 'json' | 'text';
  /** An example.* file the plugin ships — copy it to use it. */
  example: boolean;
  /** For an example: the file it becomes, and whether that exists already. */
  target: string | null;
  targetExists: boolean;
}

const CONFIG_EXT = /\.(json|jsonc|toml|ini|cfg|txt|ya?ml)$/i;
const NOT_CONFIG = /\.(deps|runtimeconfig)\.json$|\.outpost\.bak$|^readme/i;
const MAX_CONFIG_BYTES = 512 * 1024;
const BACKUP = '.outpost.bak';
/** "RetakesPlugin", "cs2-retakes", "CS2_Retakes" → "retakes". */
const stem = (s: string) => s.toLowerCase().replace(/plugin|cs2|[^a-z0-9]/g, '');

function pluginDirOf(server: ServerRecord, folder: string): string {
  for (const enabled of [true, false]) {
    const p = folderPath(server, folder, enabled);
    if (fs.existsSync(p)) return p;
  }
  throw new HttpError(404, 'Plugin not found');
}

/** Config files a plugin uses: CounterStrikeSharp's configs/plugins/<Name>/, its own folder, and cfg/<name>/. */
export function pluginConfigFiles(server: ServerRecord, folder: string): PluginConfigFile[] {
  const root = csgo(server);
  const pluginDir = pluginDirOf(server, folder);
  const found = new Map<string, number>();
  const scan = (dir: string, depth: number) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        // translations and per-map/per-player data aren't settings
        if (depth > 0 && !/^(lang|map_?config|mapdata|playerrecords|logs?|data)$/i.test(e.name)) scan(p, depth - 1);
      } else if (e.isFile() && CONFIG_EXT.test(e.name) && !NOT_CONFIG.test(e.name)) {
        const size = fs.statSync(p).size;
        if (size <= MAX_CONFIG_BYTES) found.set(path.relative(root, p).replace(/\\/g, '/'), size);
      }
    }
  };
  scan(path.join(cssRoot(server), 'configs', 'plugins', folder), 2);
  scan(pluginDir, 0);
  try {
    for (const d of fs.readdirSync(path.join(root, 'cfg'), { withFileTypes: true })) if (d.isDirectory() && stem(d.name) && stem(d.name) === stem(folder)) scan(path.join(root, 'cfg', d.name), 1);
  } catch {
    // no cfg yet
  }
  return [...found.entries()]
    .map(([p, size]) => {
      const base = path.posix.basename(p);
      const example = /^example\./i.test(base) || /\.example\.[^.]+$/i.test(base);
      const target = example ? path.posix.join(path.posix.dirname(p), base.replace(/^example\./i, '').replace(/\.example(\.[^.]+)$/i, '$1')) : null;
      return { path: p, size, kind: /\.jsonc?$/i.test(p) ? ('json' as const) : ('text' as const), example, target, targetExists: !!target && found.has(target) };
    })
    .sort((a, b) => Number(a.example) - Number(b.example) || a.path.localeCompare(b.path));
}

function resolveConfig(server: ServerRecord, folder: string, rel: string): { file: PluginConfigFile; abs: string } {
  const file = pluginConfigFiles(server, folder).find((f) => f.path === rel);
  if (!file) throw new HttpError(404, 'Not one of this plugin’s config files');
  return { file, abs: path.join(csgo(server), rel) };
}

export function readPluginConfig(server: ServerRecord, folder: string, rel: string): { path: string; content: string; hasBackup: boolean } {
  const { abs } = resolveConfig(server, folder, rel);
  return { path: rel, content: fs.readFileSync(abs, 'utf8'), hasBackup: fs.existsSync(abs + BACKUP) };
}

/** JSON as CounterStrikeSharp reads it: comments and trailing commas are allowed. */
export function parseLenientJson(text: string): unknown {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** Saves a config (the previous version is kept as <file>.outpost.bak). JSON must parse. */
export function writePluginConfig(server: ServerRecord, folder: string, rel: string, content: string) {
  const { file, abs } = resolveConfig(server, folder, rel);
  if (Buffer.byteLength(content) > MAX_CONFIG_BYTES) throw new HttpError(400, 'Config files are limited to 512 KB');
  if (file.kind === 'json') {
    try {
      parseLenientJson(content);
    } catch (err) {
      throw new HttpError(400, `Not valid JSON — ${(err as Error).message}`);
    }
  }
  fs.copyFileSync(abs, abs + BACKUP);
  fs.writeFileSync(abs, content);
}

/** Puts the version from before the last save back. */
export function revertPluginConfig(server: ServerRecord, folder: string, rel: string) {
  const { abs } = resolveConfig(server, folder, rel);
  if (!fs.existsSync(abs + BACKUP)) throw new HttpError(404, 'No earlier version saved');
  const cur = fs.readFileSync(abs);
  fs.copyFileSync(abs + BACKUP, abs);
  fs.writeFileSync(abs + BACKUP, cur);
}

/** example.foo.json → foo.json (plugins like SharpTimer only read the real name). */
export function useExampleConfig(server: ServerRecord, folder: string, rel: string): string {
  const { file, abs } = resolveConfig(server, folder, rel);
  if (!file.example || !file.target) throw new HttpError(400, 'Not an example file');
  const dest = path.join(csgo(server), file.target);
  if (fs.existsSync(dest)) throw new HttpError(409, `${file.target} already exists`);
  fs.copyFileSync(abs, dest);
  return file.target;
}
