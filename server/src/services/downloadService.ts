import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import AdmZip from 'adm-zip';
import { logger } from '../utils/logger.js';
import { downloadFile, fetchJson, formatBytes, type LogFn } from '../utils/download.js';
import { findJava, findJavac } from './javaService.js';
import { steamAppUpdate } from './steamCmdService.js';
import { findPresetFor } from './steamGames.js';
import type { Loader, Platform } from '../types/index.js';

const MOJANG_MANIFEST = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json';
const PAPER_API = 'https://fill.papermc.io/v3/projects';
const PURPUR_API = 'https://api.purpurmc.org/v2/purpur';
const BEDROCK_LINKS_API =
  'https://net-secondary.web.minecraft-services.net/api/v1.0/download/links';
const BUILD_TOOLS_URL =
  'https://hub.spigotmc.org/jenkins/job/BuildTools/lastSuccessfulBuild/artifact/target/BuildTools.jar';
const TERRARIA_APP_ID = '105600';
const TERRARIA_NAMES_API = 'https://terraria.org/api/get/dedicated-servers-names';
const TERRARIA_DOWNLOAD_API = 'https://terraria.org/api/download/pc-dedicated-server';

export interface VersionOption {
  version: string;
  build?: string;
  recommended?: boolean;
}

/** Progress callback for the coarse install progress bar. */
export type ProgressFn = (pct: number, message: string) => void;
export type { LogFn };

function describeHost(): string {
  const osName = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
  return `${osName} (${process.platform}/${process.arch})`;
}

/** Runs a child process, streaming every stdout/stderr line through onLog in real time. */
export function runStreamed(cmd: string, args: string[], cwd: string, onLog?: LogFn): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) if (line.length) onLog?.(`  ${line}`);
    });
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) if (line.length) onLog?.(`  ${line}`);
    });
    child.on('error', (err) => reject(err));
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(cmd)} exited with code ${code}`));
    });
  });
}

/** Lists installable versions for a given loader, newest first. */
const isPrerelease = (v: string) => /-(rc|pre|beta|alpha|snapshot)/i.test(v);

/** Orders by version number (newest first), stable before pre-release of the same number. */
export function compareVersionsDesc(a: string, b: string): number {
  const nums = (v: string) => v.split('-')[0].split('.').map((n) => Number(n) || 0);
  const [x, y] = [nums(a), nums(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (y[i] ?? 0) - (x[i] ?? 0);
    if (d) return d;
  }
  if (isPrerelease(a) !== isPrerelease(b)) return isPrerelease(a) ? 1 : -1;
  return b.localeCompare(a, undefined, { numeric: true });
}

/** Sorts a version list newest-first and recommends the newest stable release. Doesn't depend on
 *  the upstream API's own ordering (PaperMC's flipped between API versions). */
function newestFirst(versions: string[]): VersionOption[] {
  const sorted = [...new Set(versions)].sort(compareVersionsDesc);
  const recommended = sorted.find((v) => !isPrerelease(v)) ?? sorted[0];
  return sorted.map((v) => ({ version: v, recommended: v === recommended }));
}

export async function listAvailableVersions(loader: Loader): Promise<VersionOption[]> {
  if (loader === 'vanilla' || loader === 'spigot') {
    const manifest = await fetchJson<{
      latest: { release: string; snapshot: string };
      versions: { id: string; type: string }[];
    }>(MOJANG_MANIFEST);
    return manifest.versions
      .filter((v) => v.type === 'release')
      .map((v) => ({ version: v.id, recommended: v.id === manifest.latest.release }));
  }
  if (loader === 'paper') {
    const data = await fetchJson<{ versions: Record<string, string[]> }>(`${PAPER_API}/paper`);
    return newestFirst(Object.values(data.versions).flat());
  }
  if (loader === 'purpur') {
    const data = await fetchJson<{ versions: string[] }>(PURPUR_API);
    return newestFirst(data.versions);
  }
  if (loader === 'bedrock') {
    // Bedrock dedicated server only ships the latest build; expose it as a single "latest" option.
    return [{ version: 'latest', recommended: true }];
  }
  if (loader === 'steam') {
    // steamcmd always installs the latest depot state via +app_update; there's no meaningful
    // per-version picker for these games.
    return [{ version: 'latest', recommended: true }];
  }
  throw new Error(`Unknown loader: ${loader}`);
}

export interface InstallResult {
  jarFile: string | null; // relative filename inside the instance dir (Java only)
  build: string | null;
  executable: string | null; // relative path to bedrock_server executable (Bedrock only)
}

/** Downloads Terraria's dedicated server directly from terraria.org (no Steam login needed) and
 *  flattens the right platform's files (TerrariaServer.exe / TerrariaServer.bin.x86_64 / the
 *  macOS .app bundle) up to instanceDir's root, discarding the other two platforms' copies. The
 *  zip's top-level folder is named after the current version (e.g. "1458/"), so this discovers
 *  that name at extraction time rather than assuming one. */
async function installTerraria(instanceDir: string, onLog?: LogFn): Promise<void> {
  onLog?.(
    "==> Terraria's SteamCMD depot requires an owned Steam account for anonymous downloads to actually " +
      'work, so fetching the dedicated server directly from terraria.org instead'
  );
  const names = await fetchJson<string[]>(TERRARIA_NAMES_API, onLog);
  const fileName = names[0];
  if (!fileName) throw new Error('Could not determine the latest Terraria dedicated server version from terraria.org');

  const zipPath = path.join(instanceDir, '_terraria_server.zip');
  onLog?.(`==> Downloading ${fileName}`);
  await downloadFile(`${TERRARIA_DOWNLOAD_API}/${fileName}`, zipPath, undefined, onLog);

  const stagingDir = path.join(instanceDir, '_terraria_staging');
  fs.rmSync(stagingDir, { recursive: true, force: true });
  onLog?.('==> Extracting Terraria dedicated server');
  new AdmZip(zipPath).extractAllTo(stagingDir, true);
  fs.rmSync(zipPath, { force: true });

  const versionDirs = fs.readdirSync(stagingDir).filter((n) => fs.statSync(path.join(stagingDir, n)).isDirectory());
  const versionDir = versionDirs[0];
  if (!versionDir) throw new Error('Terraria server zip did not contain the expected version folder');

  const platformFolder = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'Mac' : 'Linux';
  const sourceDir = path.join(stagingDir, versionDir, platformFolder);
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Terraria server zip had no "${platformFolder}" folder for this host's platform`);
  }
  onLog?.(`==> Placing ${platformFolder} server files into the server directory`);
  fs.cpSync(sourceDir, instanceDir, { recursive: true });
  fs.rmSync(stagingDir, { recursive: true, force: true });

  if (process.platform === 'win32') {
    // Unlike the Linux/Mac builds (which bundle the self-contained FNA runtime), the Windows
    // server .exe links against the old Microsoft XNA Framework 4.0 redistributable and does not
    // bundle it — it's not present after this extraction and must be installed separately, or the
    // server will fail immediately with a FileNotFoundException for Microsoft.Xna.Framework.
    onLog?.(
      '==> NOTE: the Windows Terraria server needs the Microsoft XNA Framework 4.0 Redistributable ' +
        'installed separately (it is not bundled in the server download) — search for "Microsoft XNA ' +
        'Framework Redistributable 4.0" and install it, or run this server on Linux instead, before starting it.'
    );
  }
}

/** Downloads and installs the requested server software into `instanceDir`, logging verbosely as it goes. */
export async function installServer(
  platform: Platform,
  loader: Loader,
  version: string,
  instanceDir: string,
  onProgress?: ProgressFn,
  onLog?: LogFn,
  steamAppId?: string,
  steamLogin?: string,
  steamExtraFlags?: string,
  steamPreset?: string | null
): Promise<InstallResult> {
  fs.mkdirSync(instanceDir, { recursive: true });
  onLog?.(`==> Installing ${loader} ${version} (${platform}) into ${instanceDir}`);
  onLog?.(`==> Host environment detected: ${describeHost()}`);

  if (platform === 'steam') {
    if (!steamAppId) throw new Error('steamAppId is required to install a Steam-platform server');
    if (steamAppId === TERRARIA_APP_ID) {
      // App 105600 is Terraria's full paid client depot — anonymous steamcmd login can request
      // it but has no license to actually download the content, and steamcmd doesn't fail loudly
      // when that happens (it reports "Success!" with nothing actually extracted). Community
      // practice (LinuxGSM, various server wrappers) is to fetch the dedicated server zip
      // directly from terraria.org instead, which needs no login at all.
      onProgress?.(0, 'Downloading Terraria dedicated server from terraria.org');
      await installTerraria(instanceDir, onLog);
    } else {
      onProgress?.(0, `Installing Steam app ${steamAppId} via steamcmd`);
      const target = findPresetFor({ steam_app_id: steamAppId, steam_preset: steamPreset });
      if (target?.install) {
        onProgress?.(0, `Downloading ${target.label}`);
        await target.install(instanceDir, onLog);
      } else {
        const extraFlags = steamExtraFlags ? steamExtraFlags.split(' ').filter(Boolean) : [];
        await steamAppUpdate(steamAppId, instanceDir, onLog, true, steamLogin ?? 'anonymous', extraFlags, target?.installFlags ?? []);
      }
    }
    const preset = findPresetFor({ steam_app_id: steamAppId, steam_preset: steamPreset });
    const executable = preset ? (process.platform === 'win32' ? preset.executable.win32 : preset.executable.linux) : null;
    if (preset?.needsExecuteBit && process.platform !== 'win32' && executable) {
      try {
        fs.chmodSync(path.join(instanceDir, executable), 0o755);
        onLog?.(`  chmod +x ${executable} OK`);
      } catch (err) {
        logger.warn(`Failed to chmod ${executable}`, err);
      }
    }
    onLog?.('==> Install complete');
    onProgress?.(100, 'Installed');
    // Custom (non-preset) App IDs have no known executable — the route layer fills jar_file in
    // directly from the user-supplied path in that case.
    return { jarFile: executable, build: null, executable: null };
  }

  if (loader === 'vanilla') {
    onProgress?.(0, 'Resolving vanilla version metadata');
    onLog?.('==> Resolving Vanilla version metadata from Mojang');
    const manifest = await fetchJson<{ versions: { id: string; url: string }[] }>(MOJANG_MANIFEST, onLog);
    const entry = manifest.versions.find((v) => v.id === version);
    if (!entry) throw new Error(`Unknown vanilla version: ${version}`);
    const detail = await fetchJson<{ downloads: { server: { url: string } } }>(entry.url, onLog);
    const jarFile = 'server.jar';
    onLog?.(`==> Resolved Vanilla ${version} -> ${detail.downloads.server.url}`);
    onProgress?.(10, 'Downloading server.jar');
    onLog?.('==> Downloading server.jar');
    await downloadFile(
      detail.downloads.server.url,
      path.join(instanceDir, jarFile),
      (pct) => onProgress?.(10 + Math.round(pct * 0.85), 'Downloading server.jar'),
      onLog
    );
    onLog?.('==> Install complete');
    onProgress?.(100, 'Installed');
    return { jarFile, build: null, executable: null };
  }

  if (loader === 'paper' || loader === 'purpur') {
    if (loader === 'paper') {
      onProgress?.(0, 'Resolving Paper build');
      onLog?.(`==> Resolving Paper builds for ${version} from the PaperMC Fill API`);
      const builds = await fetchJson<
        { id: number; channel: string; downloads: Record<string, { name: string; url: string }> }[]
      >(`${PAPER_API}/paper/versions/${version}/builds`, onLog);
      if (!builds.length) throw new Error(`No Paper builds found for version ${version}`);
      const best =
        builds.find((b) => b.channel === 'STABLE' || b.channel === 'DEFAULT') ?? builds[0];
      const download = best.downloads['server:default'] ?? Object.values(best.downloads)[0];
      const jarFile = download.name;
      onLog?.(`==> Selected build #${best.id} (${best.channel}) -> ${jarFile}`);
      onProgress?.(10, `Downloading ${jarFile}`);
      onLog?.(`==> Downloading ${jarFile}`);
      await downloadFile(
        download.url,
        path.join(instanceDir, jarFile),
        (pct) => onProgress?.(10 + Math.round(pct * 0.85), `Downloading ${jarFile}`),
        onLog
      );
      onLog?.('==> Install complete');
      onProgress?.(100, 'Installed');
      return { jarFile, build: String(best.id), executable: null };
    } else {
      onProgress?.(0, 'Resolving Purpur build');
      onLog?.(`==> Resolving latest Purpur build for ${version} from the PurpurMC API`);
      const info = await fetchJson<{ builds: { latest: string } }>(`${PURPUR_API}/${version}`, onLog);
      const build = info.builds.latest;
      const jarFile = `purpur-${version}-${build}.jar`;
      const url = `${PURPUR_API}/${version}/${build}/download`;
      onLog?.(`==> Selected build #${build} -> ${jarFile}`);
      onProgress?.(10, `Downloading ${jarFile}`);
      onLog?.(`==> Downloading ${jarFile}`);
      await downloadFile(
        url,
        path.join(instanceDir, jarFile),
        (pct) => onProgress?.(10 + Math.round(pct * 0.85), `Downloading ${jarFile}`),
        onLog
      );
      onLog?.('==> Install complete');
      onProgress?.(100, 'Installed');
      return { jarFile, build, executable: null };
    }
  }

  if (loader === 'bedrock') {
    onProgress?.(0, 'Resolving Bedrock dedicated server download');
    onLog?.('==> Fetching current Bedrock Dedicated Server download links from Mojang');
    const data = await fetchJson<{ result: { links: { downloadType: string; downloadUrl: string }[] } }>(
      BEDROCK_LINKS_API,
      onLog
    );
    const isWindows = process.platform === 'win32';
    const platformKey = isWindows ? 'serverBedrockWindows' : 'serverBedrockLinux';
    onLog?.(
      `==> Host OS is ${describeHost()} -> selecting the ${isWindows ? 'Windows' : 'Linux'} Bedrock build (${platformKey})`
    );
    const link = data.result.links.find((l) => l.downloadType === platformKey);
    if (!link) throw new Error('Could not resolve Bedrock server download link');
    onLog?.(`==> Resolved download: ${link.downloadUrl}`);
    const zipPath = path.join(instanceDir, '_bds_download.zip');
    onProgress?.(10, 'Downloading Bedrock dedicated server');
    onLog?.('==> Downloading Bedrock Dedicated Server archive');
    await downloadFile(
      link.downloadUrl,
      zipPath,
      (pct) => onProgress?.(10 + Math.round(pct * 0.7), 'Downloading Bedrock dedicated server'),
      onLog
    );
    onProgress?.(85, 'Extracting archive');
    onLog?.(`==> Extracting archive into ${instanceDir}`);
    const zip = new AdmZip(zipPath);
    const entryCount = zip.getEntries().length;
    zip.extractAllTo(instanceDir, true);
    onLog?.(`  extracted ${entryCount} file(s)`);
    fs.rmSync(zipPath, { force: true });
    onLog?.('  removed temporary archive');

    const executable = isWindows ? 'bedrock_server.exe' : 'bedrock_server';
    if (!isWindows) {
      onLog?.(`==> Configuring environment: chmod +x ${executable} (Linux requires the execute bit)`);
      try {
        fs.chmodSync(path.join(instanceDir, executable), 0o755);
        onLog?.('  chmod OK');
      } catch (err) {
        logger.warn('Failed to chmod bedrock_server', err);
        onLog?.(`  chmod failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const versionMatch = link.downloadUrl.match(/bedrock-server-([\d.]+)\.zip/);
    onLog?.(`==> Installed Bedrock Dedicated Server ${versionMatch?.[1] ?? '(unknown version)'} for ${describeHost()}`);
    onProgress?.(100, 'Installed');
    return { jarFile: null, build: versionMatch?.[1] ?? null, executable };
  }

  if (loader === 'spigot') {
    onLog?.('==> Spigot is built from source with BuildTools — this compiles Minecraft + CraftBukkit + Spigot patches and typically takes several minutes.');
    const javaPath = await findJava();
    const javacPath = await findJavac();
    if (!javaPath) {
      throw new Error(
        'No Java runtime was found on this machine. BuildTools needs a full JDK (Java 21+ recommended) on PATH or JAVA_HOME.'
      );
    }
    if (!javacPath) {
      throw new Error(
        'Building Spigot requires a full JDK (with javac), not just a JRE. Install a JDK (e.g. Temurin 21) and ensure it is on PATH / JAVA_HOME, then try again.'
      );
    }
    onLog?.(`==> Using JDK: ${javacPath}`);

    onProgress?.(2, 'Downloading BuildTools.jar');
    onLog?.('==> Downloading BuildTools.jar from the SpigotMC Jenkins');
    const buildToolsPath = path.join(instanceDir, 'BuildTools.jar');
    await downloadFile(BUILD_TOOLS_URL, buildToolsPath, (pct) => onProgress?.(2 + Math.round(pct * 0.08), 'Downloading BuildTools.jar'), onLog);

    onProgress?.(10, `Running BuildTools for ${version} (this can take a while)`);
    onLog?.(`==> Running BuildTools --rev ${version} (streaming full BuildTools output below)`);
    await runStreamed(
      javaPath,
      ['-jar', 'BuildTools.jar', '--rev', version, '--output-dir', instanceDir, '--nogui'],
      instanceDir,
      (line) => {
        onLog?.(line);
        // BuildTools doesn't report machine-readable progress; nudge the bar so it doesn't look stuck.
        onProgress?.(Math.min(95, 10 + Math.floor(Math.random() * 2)), `Building Spigot ${version} with BuildTools…`);
      }
    );

    const jarFile = `spigot-${version}.jar`;
    if (!fs.existsSync(path.join(instanceDir, jarFile))) {
      throw new Error(
        `BuildTools finished but ${jarFile} was not found — check the build log above for the actual output filename or a failure partway through.`
      );
    }
    fs.rmSync(buildToolsPath, { force: true });
    onLog?.(`==> Built ${jarFile} successfully`);
    onProgress?.(100, 'Installed');
    return { jarFile, build: null, executable: null };
  }

  throw new Error(`Unknown loader: ${loader}`);
}

// --- Lightweight "what's the latest?" lookups, shared with updateService ---

export async function getLatestVanillaRelease(): Promise<string> {
  const manifest = await fetchJson<{ latest: { release: string } }>(MOJANG_MANIFEST);
  return manifest.latest.release;
}

export async function getLatestPaperBuild(version: string): Promise<string | null> {
  const builds = await fetchJson<{ id: number; channel: string }[]>(`${PAPER_API}/paper/versions/${version}/builds`).catch(
    () => []
  );
  if (!builds.length) return null;
  const best = builds.find((b) => b.channel === 'STABLE' || b.channel === 'DEFAULT') ?? builds[0];
  return String(best.id);
}

export async function getLatestPurpurBuild(version: string): Promise<string | null> {
  const info = await fetchJson<{ builds: { latest: string } }>(`${PURPUR_API}/${version}`).catch(() => null);
  return info?.builds.latest ?? null;
}

export interface BedrockDownloadInfo {
  url: string;
  version: string | null;
}

export async function getLatestBedrockDownload(): Promise<BedrockDownloadInfo> {
  const data = await fetchJson<{ result: { links: { downloadType: string; downloadUrl: string }[] } }>(BEDROCK_LINKS_API);
  const platformKey = process.platform === 'win32' ? 'serverBedrockWindows' : 'serverBedrockLinux';
  const link = data.result.links.find((l) => l.downloadType === platformKey);
  if (!link) throw new Error('Could not resolve Bedrock server download link');
  const versionMatch = link.downloadUrl.match(/bedrock-server-([\d.]+)\.zip/);
  return { url: link.downloadUrl, version: versionMatch?.[1] ?? null };
}
