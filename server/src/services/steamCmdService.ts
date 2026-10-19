import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import AdmZip from 'adm-zip';
import { STEAMCMD_DIR } from '../utils/paths.js';
import { downloadFile, type LogFn } from '../utils/download.js';
import { runStreamed } from './downloadService.js';
import { SETTING_STEAMCMD_SOURCE, getSetting } from './systemSettingsService.js';

const STEAMCMD_WIN_URL = 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip';
const STEAMCMD_LINUX_URL = 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz';

// steamcmd frequently self-updates itself mid-command — on its own schedule, not just on a
// dedicated bootstrap run — and the process that triggers that exits non-zero (commonly 7) as
// part of the handoff, *even when the actual command (e.g. an app_update) already completed
// successfully first*. Trusting the exit code alone produces false failures on real, completed
// installs. steamcmd does reliably print one of these lines when an app_update genuinely
// finished, so a non-zero exit is only treated as a real failure if neither appears anywhere in
// the captured output.
const STEAMCMD_SUCCESS_MARKER = /Success!\s*App\s*'?\d+'?\s*(fully installed|already up to date)/i;

function steamCmdExecutablePath(): string {
  return path.join(STEAMCMD_DIR, process.platform === 'win32' ? 'steamcmd.exe' : 'steamcmd.sh');
}

function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** Runs a steamcmd command, streaming output like runStreamed(), but tolerant of steamcmd's own
 *  habit of self-updating mid-command and exiting non-zero afterward even when the actual
 *  command already succeeded — checked by scanning the captured output for steamcmd's own
 *  success line rather than trusting the exit code alone. */
function runSteamCmd(exePath: string, args: string[], cwd: string, onLog?: LogFn): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(exePath, args, { cwd, windowsHide: true });
    let captured = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      captured += chunk;
      for (const line of chunk.split(/\r?\n/)) if (line.length) onLog?.(`  ${line}`);
    });
    child.stderr.on('data', (chunk: string) => {
      captured += chunk;
      for (const line of chunk.split(/\r?\n/)) if (line.length) onLog?.(`  ${line}`);
    });
    child.on('error', (err) => reject(err));
    child.on('exit', (code) => {
      if (code === 0) return resolve();
      if (STEAMCMD_SUCCESS_MARKER.test(captured)) {
        onLog?.(
          `  (steamcmd exited with code ${code} after reporting success — it likely self-updated itself mid-command; treating this as OK)`
        );
        return resolve();
      }
      reject(new Error(`steamcmd exited with code ${code}`));
    });
  });
}

async function extractSteamCmdArchive(archivePath: string, onLog?: LogFn): Promise<void> {
  onLog?.('==> Extracting steamcmd');
  if (archivePath.toLowerCase().endsWith('.zip')) {
    new AdmZip(archivePath).extractAllTo(STEAMCMD_DIR, true);
  } else {
    await runStreamed('tar', ['-xzf', archivePath, '-C', STEAMCMD_DIR], STEAMCMD_DIR, onLog);
  }
}

/** steamcmd always self-updates on its very first run, and that self-update can itself be flaky
 *  (real-world observed behavior: it can restart its own download from 0% several times before
 *  either succeeding or genuinely failing) — so this retries a few times rather than giving up
 *  after one non-zero exit, which on a fresh install is expected as part of the normal handoff,
 *  not a failure. */
async function selfUpdateSteamCmd(exePath: string, onLog?: LogFn): Promise<void> {
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(exePath, 0o755);
    } catch {
      // best-effort
    }
  }
  onLog?.('==> Running steamcmd once to let it self-update');
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await runSteamCmd(exePath, ['+quit'], STEAMCMD_DIR, onLog);
      return;
    } catch (err) {
      if (attempt === maxAttempts) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `steamcmd downloaded but failed to run (${message}). On Linux this usually means the 32-bit runtime ` +
            'libraries steamcmd needs are missing — see the README for the packages your distro needs, or re-run ' +
            'install.sh and accept the steamcmd dependencies prompt. If this is a transient network issue, try again.'
        );
      }
      onLog?.(`  (steamcmd self-update did not finish cleanly — retrying, attempt ${attempt + 1}/${maxAttempts})`);
    }
  }
}

/**
 * Resolves the shared steamcmd executable, bootstrapping it once if this is the first
 * Steam-platform server anyone has installed on this panel.
 *
 * Where it comes from is controlled by the admin-configurable "SteamCMD source" setting
 * (Settings page): left blank, it downloads the official Valve archive for this host's platform
 * (the default). Set to an http(s) URL, it downloads from that URL instead (e.g. an internal
 * mirror). Set to a local file path, it extracts that archive directly with no network access at
 * all ("manual tar"). Set to a local directory path, it uses the steamcmd executable already
 * inside that directory as-is, skipping download/extraction entirely.
 */
export async function ensureSteamCmd(onLog?: LogFn): Promise<string> {
  const source = getSetting(SETTING_STEAMCMD_SOURCE);
  const exePath = steamCmdExecutablePath();

  if (source && !isUrl(source)) {
    if (!fs.existsSync(source)) {
      throw new Error(`Configured SteamCMD source "${source}" does not exist — check Settings > SteamCMD.`);
    }
    if (fs.statSync(source).isDirectory()) {
      const localExe = path.join(source, process.platform === 'win32' ? 'steamcmd.exe' : 'steamcmd.sh');
      if (!fs.existsSync(localExe)) {
        throw new Error(
          `Configured SteamCMD directory "${source}" has no ${path.basename(localExe)} in it — check Settings > SteamCMD.`
        );
      }
      onLog?.(`==> Using the configured local SteamCMD install at ${source}`);
      return localExe;
    }
    // A local archive file: extract it once, no network access needed at all.
    if (fs.existsSync(exePath)) return exePath;
    fs.mkdirSync(STEAMCMD_DIR, { recursive: true });
    onLog?.(`==> Extracting the configured local SteamCMD archive: ${source}`);
    await extractSteamCmdArchive(source, onLog);
    if (!fs.existsSync(exePath)) {
      throw new Error(`Extracted "${source}" but ${path.basename(exePath)} was not found afterward`);
    }
    await selfUpdateSteamCmd(exePath, onLog);
    return exePath;
  }

  if (fs.existsSync(exePath)) return exePath;

  fs.mkdirSync(STEAMCMD_DIR, { recursive: true });
  const url = source ?? (process.platform === 'win32' ? STEAMCMD_WIN_URL : STEAMCMD_LINUX_URL);
  onLog?.(`==> steamcmd not found locally — downloading it once from ${url} (shared by all Steam-platform servers)`);
  const downloadPath = path.join(STEAMCMD_DIR, process.platform === 'win32' ? '_steamcmd.zip' : '_steamcmd.tar.gz');
  await downloadFile(url, downloadPath, undefined, onLog);
  await extractSteamCmdArchive(downloadPath, onLog);
  fs.rmSync(downloadPath, { force: true });

  if (!fs.existsSync(exePath)) {
    throw new Error(`steamcmd was downloaded but ${path.basename(exePath)} was not found after extracting it`);
  }
  await selfUpdateSteamCmd(exePath, onLog);
  return exePath;
}

/** Installs or updates a Steam app into instanceDir via `+app_update`. Safe to re-run — steamcmd
 *  only touches files tracked by the app's depot manifest, never save data living outside it.
 *  `login` is the raw value passed after `+login` (default "anonymous"; a real "user pass" is
 *  needed for games that require an owned license). `extraFlags` are additional raw steamcmd
 *  arguments spliced in before `+quit`, for advanced per-server customization.
 *
 *  A brand-new app's very first `+app_update` in a given install directory is commonly
 *  incomplete — steamcmd reports success but hasn't actually finished pulling every depot file,
 *  a long-documented quirk with no clean single-run fix. So the first time this app is installed
 *  into this directory (no appmanifest for it yet), the whole command is run twice; once the
 *  manifest exists, later calls (updates) only need the one, already-reliable pass. */
export async function steamAppUpdate(
  appId: string,
  instanceDir: string,
  onLog?: LogFn,
  validate = true,
  login = 'anonymous',
  extraFlags: string[] = [],
  beforeUpdate: string[] = []
): Promise<void> {
  const steamCmdPath = await ensureSteamCmd(onLog);
  fs.mkdirSync(instanceDir, { recursive: true });
  const loginArgs = login.trim() ? login.trim().split(/\s+/) : ['anonymous'];
  const args = [
    '+force_install_dir', instanceDir,
    '+login', ...loginArgs,
    ...beforeUpdate,
    '+app_update', appId,
    ...(validate ? ['validate'] : []),
    ...extraFlags,
    '+quit',
  ];
  const loginLog = loginArgs[0] === 'anonymous' ? 'anonymous' : `${loginArgs[0]} ***`;
  const commandLog =
    `steamcmd +force_install_dir <dir> +login ${loginLog}${beforeUpdate.length ? ' ' + beforeUpdate.join(' ') : ''} +app_update ${appId}${validate ? ' validate' : ''}` +
    `${extraFlags.length ? ' ' + extraFlags.join(' ') : ''} +quit`;

  const manifestPath = path.join(instanceDir, 'steamapps', `appmanifest_${appId}.acf`);
  const isFirstInstall = !fs.existsSync(manifestPath);

  onLog?.(`==> ${commandLog}`);
  await runSteamCmd(steamCmdPath, args, instanceDir, onLog);

  if (isFirstInstall) {
    onLog?.(
      "==> First-time install for this app — steamcmd's first pass at a new app commonly doesn't fully " +
        'finish, so running it again to make sure everything actually downloaded'
    );
    onLog?.(`==> ${commandLog}`);
    await runSteamCmd(steamCmdPath, args, instanceDir, onLog);
  }
}
