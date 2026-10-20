import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { downloadFile, fetchJson, type LogFn } from '../utils/download.js';
import { safeJoin } from '../utils/paths.js';
import { pickRuntime } from './javaRuntimeService.js';
import type { Loader } from '../types/index.js';

/**
 * Modded Minecraft: Fabric, Quilt, Forge, NeoForge, plus the Mohist (Forge + Bukkit) and SpongeForge
 * hybrids, and Modrinth modpacks (.mrpack) on top of any of them.
 *
 * Every installer leaves something the Java launcher can start: a jar (`-jar <file>`), or for
 * Forge/NeoForge 1.17+ an argument file (`@libraries/…/unix_args.txt` — the launcher swaps in
 * win_args.txt on Windows). The loader version is stored as the instance's "build".
 */

export const MODDED_LOADERS = ['fabric', 'quilt', 'forge', 'neoforge', 'mohist', 'spongeforge'] as const;
export type ModdedLoader = (typeof MODDED_LOADERS)[number];
export const isModded = (loader: Loader | string): loader is ModdedLoader => (MODDED_LOADERS as readonly string[]).includes(loader);

const FABRIC_META = 'https://meta.fabricmc.net/v2';
const QUILT_META = 'https://meta.quiltmc.org/v3';
const QUILT_INSTALLER_MAVEN = 'https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer';
const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge';
const FORGE_PROMOS = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';
const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/neoforge';
const MOHIST_API = 'https://api.mohistmc.com/project/mohist';
const SPONGE_API = 'https://dl-api.spongepowered.org/v2/groups/org.spongepowered/artifacts/spongeforge';
const MODRINTH_API = 'https://api.modrinth.com/v2';

export interface InstallOutcome {
  jarFile: string;
  build: string;
}
export type Progress = (pct: number, message: string) => void;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': 'Outpost-Panel' }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Request to ${url} failed with status ${res.status}`);
  return res.text();
}

const mavenVersions = (xml: string) => [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);

const cache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, fn: () => Promise<T>, ttlMs = 30 * 60_000): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Orders Minecraft versions newest first (1.21.1 > 1.21 > 1.20.6; 26.1 > 1.21.11). */
function mcDesc(a: string, b: string): number {
  const n = (v: string) => v.split('.').map((x) => Number(x) || 0);
  const [x, y] = [n(a), n(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((y[i] ?? 0) !== (x[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
  return 0;
}

/** NeoForge numbers its builds after Minecraft: 21.1.77 → 1.21.1, 20.4.237 → 1.20.4, 26.3.0.94 → 26.3. */
export function neoforgeToMinecraft(v: string): string | null {
  const p = v.split('-')[0].split('.');
  const major = Number(p[0]);
  if (!Number.isFinite(major)) return null;
  if (major >= 25) return p.length >= 4 && p[2] !== '0' ? `${p[0]}.${p[1]}.${p[2]}` : `${p[0]}.${p[1]}`;
  if (major < 20 || p.length < 3) return null;
  return p[1] === '0' ? `1.${p[0]}` : `1.${p[0]}.${p[1]}`;
}

/** Downloads sometimes "succeed" with an empty or HTML body — a jar must be a zip. */
export function assertJar(file: string) {
  let head = Buffer.alloc(0);
  try {
    const fd = fs.openSync(file, 'r');
    head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0);
    fs.closeSync(fd);
  } catch {
    // missing — reported below
  }
  if (head[0] !== 0x50 || head[1] !== 0x4b) {
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
    fs.rmSync(file, { force: true });
    throw new Error(`${path.basename(file)} didn’t download properly (${size} bytes, not a jar) — the download server may be having trouble; try again later`);
  }
}

async function needJava(mcVersion: string): Promise<string> {
  const pick = await pickRuntime(mcVersion);
  if (!pick.path) throw new Error(`The installer needs Java — install it under Configuration → Java runtimes. ${pick.note ?? ''}`.trim());
  return pick.path;
}

async function runJava(java: string, args: string[], cwd: string, onLog?: LogFn): Promise<void> {
  const { runStreamed } = await import('./downloadService.js');
  await runStreamed(java, args, cwd, onLog);
}

// ---------------------------------------------------------------------------
// Version lists (Minecraft versions each loader supports, newest first)
// ---------------------------------------------------------------------------

export async function listModdedVersions(loader: ModdedLoader): Promise<{ version: string; recommended?: boolean }[]> {
  const out = await cached(`versions:${loader}`, async (): Promise<string[]> => {
    switch (loader) {
      case 'fabric':
        return (await fetchJson<{ version: string; stable: boolean }[]>(`${FABRIC_META}/versions/game`)).filter((v) => v.stable).map((v) => v.version);
      case 'quilt':
        return (await fetchJson<{ version: string; stable: boolean }[]>(`${QUILT_META}/versions/game`)).filter((v) => v.stable).map((v) => v.version);
      case 'forge':
        return [...new Set(mavenVersions(await fetchText(`${FORGE_MAVEN}/maven-metadata.xml`)).map((v) => v.split('-')[0]))].filter((v) => /^\d+\.\d+(\.\d+)?$/.test(v));
      case 'neoforge':
        return [...new Set(mavenVersions(await fetchText(`${NEOFORGE_MAVEN}/maven-metadata.xml`)).filter((v) => !/beta|alpha/i.test(v)).map(neoforgeToMinecraft).filter((v): v is string => !!v))];
      case 'mohist':
        return (await fetchJson<{ name: string }[]>(`${MOHIST_API}/versions`)).map((v) => v.name);
      case 'spongeforge': {
        const tags = (await fetchJson<{ tags: { minecraft: string[] } }>(SPONGE_API)).tags.minecraft;
        // Not every tagged Minecraft version has a SpongeForge build — keep the ones that do.
        const has = await Promise.all(
          tags.slice(0, 30).map((mc) =>
            fetchJson<{ size: number }>(`${SPONGE_API}/versions?tags=minecraft:${encodeURIComponent(mc)}&limit=1`)
              .then((r) => r.size > 0)
              .catch(() => false)
          )
        );
        return tags.slice(0, 30).filter((_, i) => has[i]);
      }
    }
  });
  const sorted = [...new Set(out)].sort(mcDesc);
  return sorted.map((v, i) => ({ version: v, recommended: i === 0 }));
}

/** The loader version to install for a Minecraft version (stable/recommended first). */
export async function latestLoaderVersion(loader: ModdedLoader, mc: string): Promise<string> {
  switch (loader) {
    case 'fabric': {
      const list = await fetchJson<{ loader: { version: string; stable: boolean } }[]>(`${FABRIC_META}/versions/loader/${encodeURIComponent(mc)}`);
      if (!list.length) throw new Error(`Fabric doesn’t support Minecraft ${mc}`);
      return (list.find((l) => l.loader.stable) ?? list[0]).loader.version;
    }
    case 'quilt': {
      const list = await fetchJson<{ loader: { version: string } }[]>(`${QUILT_META}/versions/loader/${encodeURIComponent(mc)}`);
      if (!list.length) throw new Error(`Quilt doesn’t support Minecraft ${mc}`);
      return (list.find((l) => !/beta|pre|rc/i.test(l.loader.version)) ?? list[0]).loader.version;
    }
    case 'forge': {
      const promos = (await fetchJson<{ promos: Record<string, string> }>(FORGE_PROMOS)).promos;
      const v = promos[`${mc}-recommended`] ?? promos[`${mc}-latest`];
      if (!v) throw new Error(`Forge doesn’t support Minecraft ${mc}`);
      return v;
    }
    case 'neoforge': {
      const all = mavenVersions(await fetchText(`${NEOFORGE_MAVEN}/maven-metadata.xml`)).filter((v) => neoforgeToMinecraft(v) === mc);
      if (!all.length) throw new Error(`NeoForge doesn’t support Minecraft ${mc}`);
      const stable = all.filter((v) => !/beta|alpha/i.test(v));
      return (stable.length ? stable : all).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
    }
    case 'mohist': {
      const latest = await fetchJson<{ id: number }>(`${MOHIST_API}/${encodeURIComponent(mc)}/builds/latest`).catch(() => null);
      if (!latest?.id) throw new Error(`Mohist has no builds for Minecraft ${mc}`);
      return String(latest.id);
    }
    case 'spongeforge': {
      const pick = async (recommended: boolean) =>
        Object.keys((await fetchJson<{ artifacts: Record<string, unknown> }>(`${SPONGE_API}/versions?tags=minecraft:${encodeURIComponent(mc)}${recommended ? '&recommended=true' : ''}&limit=1`)).artifacts)[0];
      const v = (await pick(true)) ?? (await pick(false));
      if (!v) throw new Error(`SpongeForge has no builds for Minecraft ${mc}`);
      return v;
    }
  }
}

// ---------------------------------------------------------------------------
// Installers
// ---------------------------------------------------------------------------

/** Forge/NeoForge installer: `--installServer`, then work out how to launch what it made. */
async function runForgeStyleInstaller(kind: 'forge' | 'neoforge', mc: string, fullVersion: string, installerUrl: string, dir: string, progress: Progress, onLog?: LogFn): Promise<string> {
  const java = await needJava(mc);
  const installer = path.join(dir, `_${kind}-installer.jar`);
  progress(5, `Downloading the ${kind === 'forge' ? 'Forge' : 'NeoForge'} installer`);
  await downloadFile(installerUrl, installer, (p) => progress(5 + Math.round(p * 0.15), 'Downloading the installer'), onLog);
  assertJar(installer);
  progress(22, 'Running the installer (downloads Minecraft and libraries — this takes a few minutes)');
  onLog?.(`==> java -jar ${path.basename(installer)} --installServer`);
  try {
    await runJava(java, ['-jar', installer, '--installServer'], dir, (line) => {
      onLog?.(line);
      progress(Math.min(90, 22 + Math.floor(Math.random() * 3)), 'Running the installer…');
    });
  } finally {
    fs.rmSync(installer, { force: true });
    fs.rmSync(`${installer}.log`, { force: true });
  }
  // 1.17+: an argument file under libraries/…; older: a runnable jar in the instance root.
  const group = kind === 'forge' ? 'net/minecraftforge/forge' : 'net/neoforged/neoforge';
  const argsFile = path.posix.join('libraries', group, fullVersion, 'unix_args.txt');
  if (fs.existsSync(path.join(dir, argsFile))) return `@${argsFile}`;
  const jar = fs.readdirSync(dir).find((f) => /^(forge|neoforge)-.*\.jar$/i.test(f) && !/installer/i.test(f));
  if (!jar) throw new Error('The installer finished but left nothing to launch — see the log above');
  return jar;
}

export async function installModded(loader: ModdedLoader, mc: string, dir: string, progress: Progress, onLog?: LogFn, wantedLoaderVersion?: string): Promise<InstallOutcome> {
  const lv = wantedLoaderVersion ?? (await latestLoaderVersion(loader, mc));
  onLog?.(`==> ${loader} ${lv} for Minecraft ${mc}`);
  switch (loader) {
    case 'fabric': {
      const installers = await fetchJson<{ version: string; stable: boolean }[]>(`${FABRIC_META}/versions/installer`);
      const inst = (installers.find((i) => i.stable) ?? installers[0]).version;
      const jarFile = 'fabric-server-launch.jar';
      progress(10, 'Downloading the Fabric server launcher');
      await downloadFile(`${FABRIC_META}/versions/loader/${mc}/${lv}/${inst}/server/jar`, path.join(dir, jarFile), (p) => progress(10 + Math.round(p * 0.85), 'Downloading'), onLog);
      assertJar(path.join(dir, jarFile));
      onLog?.('==> The launcher downloads the Minecraft server itself on the first start');
      return { jarFile, build: lv };
    }
    case 'quilt': {
      const java = await needJava(mc);
      const instVer = (await fetchText(`${QUILT_INSTALLER_MAVEN}/maven-metadata.xml`)).match(/<release>([^<]+)<\/release>/)?.[1];
      if (!instVer) throw new Error('Couldn’t find the Quilt installer');
      const installer = path.join(dir, '_quilt-installer.jar');
      progress(5, 'Downloading the Quilt installer');
      await downloadFile(`${QUILT_INSTALLER_MAVEN}/${instVer}/quilt-installer-${instVer}.jar`, installer, (p) => progress(5 + Math.round(p * 0.2), 'Downloading'), onLog);
      assertJar(installer);
      progress(30, 'Running the Quilt installer');
      try {
        await runJava(java, ['-jar', installer, 'install', 'server', mc, lv, '--download-server', `--install-dir=${dir}`], dir, onLog);
      } finally {
        fs.rmSync(installer, { force: true });
      }
      if (!fs.existsSync(path.join(dir, 'quilt-server-launch.jar'))) throw new Error('The Quilt installer didn’t create quilt-server-launch.jar');
      return { jarFile: 'quilt-server-launch.jar', build: lv };
    }
    case 'forge': {
      const full = `${mc}-${lv}`;
      const jarFile = await runForgeStyleInstaller('forge', mc, full, `${FORGE_MAVEN}/${full}/forge-${full}-installer.jar`, dir, progress, onLog);
      return { jarFile, build: lv };
    }
    case 'neoforge': {
      const jarFile = await runForgeStyleInstaller('neoforge', mc, lv, `${NEOFORGE_MAVEN}/${lv}/neoforge-${lv}-installer.jar`, dir, progress, onLog);
      return { jarFile, build: lv };
    }
    case 'mohist': {
      const jarFile = `mohist-${mc}-${lv}.jar`;
      progress(10, `Downloading Mohist ${mc} build ${lv}`);
      await downloadFile(`${MOHIST_API}/${encodeURIComponent(mc)}/builds/${encodeURIComponent(lv)}/download`, path.join(dir, jarFile), (p) => progress(10 + Math.round(p * 0.85), 'Downloading'), onLog);
      assertJar(path.join(dir, jarFile));
      for (const old of fs.readdirSync(dir)) if (/^mohist-.*\.jar$/.test(old) && old !== jarFile) fs.rmSync(path.join(dir, old), { force: true });
      onLog?.('==> Mohist sets up its libraries on the first start. Forge mods go in mods/, Bukkit plugins in plugins/.');
      return { jarFile, build: lv };
    }
    case 'spongeforge': {
      const detail = await fetchJson<{ assets: { classifier: string; extension: string; downloadUrl: string }[]; tags?: Record<string, string> }>(`${SPONGE_API}/versions/${encodeURIComponent(lv)}`);
      const forgeVersion = lv.split('-')[1];
      if (!forgeVersion) throw new Error(`Can’t tell which Forge SpongeForge ${lv} needs`);
      onLog?.(`==> SpongeForge ${lv} needs Forge ${forgeVersion}`);
      const forge = await installModded('forge', mc, dir, (p, m) => progress(Math.round(p * 0.85), m), onLog, forgeVersion);
      const asset = detail.assets.find((a) => a.classifier === 'universal' && a.extension === 'jar') ?? detail.assets.find((a) => a.classifier === '' && a.extension === 'jar');
      if (!asset) throw new Error('No SpongeForge jar in that release');
      fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
      for (const old of fs.readdirSync(path.join(dir, 'mods'))) if (/^spongeforge-/i.test(old)) fs.rmSync(path.join(dir, 'mods', old), { force: true });
      progress(90, 'Downloading SpongeForge');
      await downloadFile(asset.downloadUrl, path.join(dir, 'mods', `spongeforge-${lv}.jar`), undefined, onLog);
      assertJar(path.join(dir, 'mods', `spongeforge-${lv}.jar`));
      return { jarFile: forge.jarFile, build: lv };
    }
  }
}

// ---------------------------------------------------------------------------
// Modrinth modpacks (.mrpack)
// ---------------------------------------------------------------------------

export interface ModpackRef {
  projectId: string;
  versionId: string;
  title: string;
  versionNumber: string;
}

interface MrVersion {
  id: string;
  project_id: string;
  version_number: string;
  name: string;
  game_versions: string[];
  loaders: string[];
  version_type: string;
  featured?: boolean;
  files: { url: string; filename: string; primary: boolean }[];
}

const mrFetch = <T>(p: string) => fetchJson<T>(`${MODRINTH_API}${p}`);

export interface ModpackSearchHit {
  projectId: string;
  slug: string;
  title: string;
  description: string;
  iconUrl: string | null;
  downloads: number;
  categories: string[];
}

export async function searchModpacks(query: string): Promise<ModpackSearchHit[]> {
  const params = new URLSearchParams({ query, facets: JSON.stringify([['project_type:modpack']]), limit: '24', index: query ? 'relevance' : 'downloads' });
  const r = await mrFetch<{ hits: { project_id: string; slug: string; title: string; description: string; icon_url: string | null; downloads: number; categories: string[] }[] }>(`/search?${params}`);
  return r.hits.map((h) => ({ projectId: h.project_id, slug: h.slug, title: h.title, description: h.description, iconUrl: h.icon_url, downloads: h.downloads, categories: h.categories }));
}

const PACK_LOADERS: Record<string, ModdedLoader> = { fabric: 'fabric', quilt: 'quilt', forge: 'forge', neoforge: 'neoforge' };

/** Which pack version to use, and the loader + Minecraft version it targets (for creating the instance). */
export async function resolveModpack(projectId: string, versionId?: string): Promise<{ ref: ModpackRef; loader: ModdedLoader; mc: string }> {
  if (!/^[\w-]{2,64}$/.test(projectId) || (versionId && !/^[\w-]{2,64}$/.test(versionId))) throw new Error('Invalid modpack id');
  const project = await mrFetch<{ id: string; title: string; project_type: string }>(`/project/${projectId}`);
  if (project.project_type !== 'modpack') throw new Error(`${project.title} isn’t a modpack`);
  const versions = versionId ? [await mrFetch<MrVersion>(`/version/${versionId}`)] : await mrFetch<MrVersion[]>(`/project/${projectId}/version`);
  const v = versions.find((x) => x.version_type === 'release' && x.loaders.some((l) => l in PACK_LOADERS)) ?? versions.find((x) => x.loaders.some((l) => l in PACK_LOADERS));
  if (!v || v.project_id !== project.id) throw new Error('No installable version of that modpack (Fabric, Quilt, Forge or NeoForge)');
  const loader = PACK_LOADERS[v.loaders.find((l) => l in PACK_LOADERS)!];
  return { ref: { projectId: project.id, versionId: v.id, title: project.title, versionNumber: v.version_number }, loader, mc: v.game_versions[0] };
}

interface MrIndex {
  formatVersion: number;
  name: string;
  dependencies: Record<string, string>;
  files: { path: string; downloads: string[]; env?: { server?: string }; fileSize?: number }[];
}

const ALLOWED_HOSTS = /^https:\/\/(cdn\.modrinth\.com|github\.com|raw\.githubusercontent\.com|gitlab\.com|objects\.githubusercontent\.com)\//;

/** Downloads a pack's server files and overrides into the instance. Returns the loader version it wants. */
export async function installModpack(ref: ModpackRef, dir: string, progress: Progress, onLog?: LogFn): Promise<{ loader: ModdedLoader; mc: string; loaderVersion: string }> {
  const v = await mrFetch<MrVersion>(`/version/${ref.versionId}`);
  const file = v.files.find((f) => f.primary) ?? v.files[0];
  if (!file?.filename.endsWith('.mrpack')) throw new Error('That version has no .mrpack file');
  const packPath = path.join(dir, '_modpack.mrpack');
  progress(2, `Downloading ${ref.title} ${ref.versionNumber}`);
  await downloadFile(file.url, packPath, (p) => progress(2 + Math.round(p * 0.08), 'Downloading the modpack'), onLog);
  try {
    const zip = new AdmZip(packPath);
    const index = JSON.parse(zip.readAsText('modrinth.index.json')) as MrIndex;
    const deps = index.dependencies;
    const mc = deps.minecraft;
    const [depKey, loader] = (
      [
        ['fabric-loader', 'fabric'],
        ['quilt-loader', 'quilt'],
        ['neoforge', 'neoforge'],
        ['forge', 'forge'],
      ] as const
    ).find(([k]) => deps[k]) ?? [null, null];
    if (!mc || !loader || !depKey) throw new Error('The modpack doesn’t say which loader it needs');
    const serverFiles = index.files.filter((f) => f.env?.server !== 'unsupported');
    onLog?.(`==> ${index.name}: Minecraft ${mc}, ${loader} ${deps[depKey]}, ${serverFiles.length} server files`);
    let done = 0;
    for (const f of serverFiles) {
      const target = safeJoin(dir, f.path);
      const url = f.downloads.find((u) => ALLOWED_HOSTS.test(u));
      if (!url) throw new Error(`${f.path}: download isn’t from a trusted host`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      await downloadFile(url, target, undefined, undefined);
      done++;
      progress(10 + Math.round((done / Math.max(1, serverFiles.length)) * 40), `Downloading mods (${done}/${serverFiles.length})`);
    }
    onLog?.(`==> Downloaded ${done} file(s)`);
    // overrides/ apply to everyone; server-overrides/ on top of them for servers.
    for (const prefix of ['overrides/', 'server-overrides/']) {
      for (const entry of zip.getEntries()) {
        if (entry.isDirectory || !entry.entryName.startsWith(prefix)) continue;
        const rel = entry.entryName.slice(prefix.length);
        if (!rel) continue;
        const target = safeJoin(dir, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, entry.getData());
      }
    }
    return { loader, mc, loaderVersion: deps[depKey] };
  } finally {
    fs.rmSync(packPath, { force: true });
  }
}
