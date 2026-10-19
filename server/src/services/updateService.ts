import { pullImage } from './containerService.js';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { instanceDir } from '../utils/paths.js';
import { downloadFile, type LogFn } from '../utils/download.js';
import {
  getLatestBedrockDownload,
  getLatestPaperBuild,
  getLatestPurpurBuild,
  getLatestVanillaRelease,
  installServer,
  type ProgressFn,
} from './downloadService.js';
import { logger } from '../utils/logger.js';
import type { ServerRecord } from '../types/index.js';

export interface UpdateCheckResult {
  currentVersion: string;
  currentBuild: string | null;
  latestVersion: string | null;
  latestBuild: string | null;
  updateAvailable: boolean;
  note?: string;
}

export async function checkForUpdate(server: ServerRecord): Promise<UpdateCheckResult> {
  if (server.platform === 'docker') {
    return {
      currentVersion: server.version,
      currentBuild: null,
      latestVersion: server.version,
      latestBuild: null,
      updateAvailable: true,
      note: 'Updating pulls the image tag again; the new image is used from the next start.',
    };
  }

  if (server.platform === 'custom') {
    return {
      currentVersion: server.version,
      currentBuild: null,
      latestVersion: server.version,
      latestBuild: null,
      updateAvailable: false,
      note: 'Custom instances run your own files — update them through File Management.',
    };
  }

  if (server.platform === 'steam') {
    // steamcmd has no cheap "is a newer build available" query short of a full app_update run —
    // always offer to re-run it, same precedent as Spigot's no-version-tracked-builds case.
    return {
      currentVersion: server.version,
      currentBuild: null,
      latestVersion: server.version,
      latestBuild: null,
      updateAvailable: true,
      note: 'Steam servers have no version-tracked builds — updating re-runs steamcmd to pull the latest depot state.',
    };
  }

  if (server.platform === 'bedrock') {
    const latest = await getLatestBedrockDownload();
    return {
      currentVersion: server.build ?? 'unknown',
      currentBuild: null,
      latestVersion: latest.version,
      latestBuild: null,
      updateAvailable: !!latest.version && latest.version !== server.build,
    };
  }

  if (server.loader === 'vanilla') {
    const latest = await getLatestVanillaRelease();
    return {
      currentVersion: server.version,
      currentBuild: null,
      latestVersion: latest,
      latestBuild: null,
      updateAvailable: latest !== server.version,
      note: latest !== server.version ? 'A newer Minecraft version is available.' : undefined,
    };
  }

  if (server.loader === 'paper') {
    const latestBuild = await getLatestPaperBuild(server.version);
    return {
      currentVersion: server.version,
      currentBuild: server.build,
      latestVersion: server.version,
      latestBuild,
      updateAvailable: !!latestBuild && latestBuild !== server.build,
    };
  }

  if (server.loader === 'purpur') {
    const latestBuild = await getLatestPurpurBuild(server.version);
    return {
      currentVersion: server.version,
      currentBuild: server.build,
      latestVersion: server.version,
      latestBuild,
      updateAvailable: !!latestBuild && latestBuild !== server.build,
    };
  }

  if (server.loader === 'spigot') {
    // Spigot has no published build numbers — BuildTools always compiles against the
    // latest Spigot/CraftBukkit patches for the given Minecraft version at build time.
    return {
      currentVersion: server.version,
      currentBuild: null,
      latestVersion: server.version,
      latestBuild: null,
      updateAvailable: true,
      note: 'Spigot has no version-tracked builds — rebuilding with BuildTools pulls the latest patches for this Minecraft version.',
    };
  }

  throw new Error(`Unknown loader: ${server.loader}`);
}

// Bedrock ships worlds/, config, and player files inside the same zip as the server binary.
// An "update" must overlay the new binaries/assets without touching player data.
const BEDROCK_PRESERVE = new Set(['worlds', 'server.properties', 'allowlist.json', 'whitelist.json', 'permissions.json']);

function mergeCopy(srcDir: string, destDir: string, preserve: Set<string> | null, onLog?: LogFn) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (preserve?.has(entry.name)) {
      onLog?.(`  preserving existing ${entry.name} (not overwritten)`);
      continue;
    }
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      mergeCopy(src, dest, null, onLog);
    } else {
      fs.copyFileSync(src, dest);
    }
  }
}

export interface UpdateResult {
  version: string;
  build: string | null;
  jarFile: string | null;
}

/**
 * Updates an existing, already-installed server in place. World data, server.properties,
 * and allowlist/permissions files are always preserved regardless of platform.
 */
export async function performUpdate(
  server: ServerRecord,
  targetVersion: string | undefined,
  onProgress?: ProgressFn,
  onLog?: LogFn
): Promise<UpdateResult> {
  const dir = instanceDir(server.id);
  if (server.platform === 'custom') throw new Error('Custom instances have no managed updates');
  if (server.platform === 'docker') {
    await pullImage(server.version, (line) => onLog?.(line));
    onProgress?.(100, 'Image pulled');
    return { version: server.version, build: null, jarFile: null };
  }

  if (server.platform === 'steam') {
    if (!server.steam_app_id) throw new Error('This server has no Steam App ID recorded');
    onLog?.('==> Updating Steam server in place (only files the game’s own installer tracks are touched)');
    // Delegates to installServer so Terraria's terraria.org special case (see downloadService.ts)
    // is applied consistently on update too, not just on first install.
    const result = await installServer(
      server.platform,
      server.loader,
      server.version,
      dir,
      onProgress,
      onLog,
      server.steam_app_id,
      server.steam_login,
      server.steam_extra_flags,
      server.steam_preset
    );
    return { version: server.version, build: null, jarFile: result.jarFile ?? server.jar_file };
  }

  if (server.platform === 'bedrock') {
    onLog?.('==> Updating Bedrock Dedicated Server in place');
    onLog?.(`==> Preserved paths (never overwritten): ${Array.from(BEDROCK_PRESERVE).join(', ')}`);
    const latest = await getLatestBedrockDownload();
    if (!latest.version) throw new Error('Could not determine the latest Bedrock version');
    onProgress?.(5, `Downloading Bedrock ${latest.version}`);
    const zipPath = path.join(dir, '_bds_update.zip');
    await downloadFile(latest.url, zipPath, (pct) => onProgress?.(5 + Math.round(pct * 0.6), 'Downloading update'), onLog);

    const stagingDir = path.join(dir, '_update_staging');
    fs.rmSync(stagingDir, { recursive: true, force: true });
    onProgress?.(68, 'Extracting update');
    onLog?.('==> Extracting update archive to a staging directory');
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(stagingDir, true);
    fs.rmSync(zipPath, { force: true });

    onProgress?.(75, 'Applying update');
    onLog?.('==> Copying updated files into place (world, properties, and allowlists are left untouched)');
    mergeCopy(stagingDir, dir, BEDROCK_PRESERVE, onLog);
    fs.rmSync(stagingDir, { recursive: true, force: true });

    const executable = process.platform === 'win32' ? 'bedrock_server.exe' : 'bedrock_server';
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(path.join(dir, executable), 0o755);
        onLog?.('  chmod +x bedrock_server OK');
      } catch (err) {
        logger.warn('Failed to chmod bedrock_server after update', err);
      }
    }
    onLog?.(`==> Updated to Bedrock ${latest.version}`);
    onProgress?.(100, 'Updated');
    return { version: latest.version, build: null, jarFile: null };
  }

  // Java family (vanilla/paper/purpur/spigot): installServer only ever writes the jar file(s)
  // it downloads — it never touches world saves, server.properties, or player data files —
  // so re-running it against the existing instance directory *is* an in-place update.
  const version = targetVersion ?? server.version;
  onLog?.(`==> Updating ${server.loader} in place (world data and server.properties are untouched)`);
  const previousJar = server.jar_file;
  const result = await installServer(server.platform, server.loader, version, dir, onProgress, onLog);

  if (previousJar && result.jarFile && previousJar !== result.jarFile) {
    const oldPath = path.join(dir, previousJar);
    if (fs.existsSync(oldPath)) {
      fs.rmSync(oldPath, { force: true });
      onLog?.(`==> Removed superseded ${previousJar}`);
    }
  }

  return { version, build: result.build, jarFile: result.jarFile };
}
