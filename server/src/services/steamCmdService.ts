import crypto from 'node:crypto';
import os from 'node:os';
import { resolveSteamAccount, steamAccountBusy } from './steamAccountService.js';
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
/** Runs steamcmd and resolves with everything it printed. Its input is closed, so a prompt it can't
 *  answer (a Steam Guard code, a password) fails instead of hanging forever. */
const accountBusy = steamAccountBusy;
export async function runSteamCmd(exePath: string, args: string[], cwd: string, onLog?: LogFn, runner: typeof runSteamProcess = runSteamProcess): Promise<string> {
  const index = args.indexOf('+login');
  if (index >= 0 && accountBusy.has((args[index + 1] ?? '').replace(/^account:/, ''))) throw new Error('This Steam account is already in use');
  const account = index >= 0 ? resolveSteamAccount(args[index + 1] ?? '') : null;
  if (!account) return runner(exePath, args, cwd, onLog);
  if (accountBusy.has(account.id)) throw new Error('This Steam account is already in use; wait for its download to finish');
  accountBusy.add(account.id);
  let script: string | undefined;
  let scriptDirectory: string | undefined;
  try {
    fs.mkdirSync(account.directory, { recursive: true, mode: 0o700 });
    const client = path.join(account.directory, 'client');
    if (!fs.existsSync(path.join(client, path.basename(exePath)))) {
      const source = path.dirname(exePath);
      // Copy runtime files, never another account's cached credentials/session/config.
      fs.cpSync(source, client, { recursive: true, filter: file => {
        const relative = path.relative(source, file), top = relative.split(path.sep)[0];
        return !relative || ['linux32', 'linux64', 'package', 'public', 'resource', 'bin'].includes(top) || (!relative.includes(path.sep) && /(?:\.(exe|dll|so|dylib)|^steamcmd\.sh)$/i.test(top));
      } });
    }
    exePath = path.join(client, path.basename(exePath));
    let loginEnd = index + 2;
    while (loginEnd < args.length && !args[loginEnd].startsWith('+')) loginEnd++;
    const suppliedGuard = args.slice(index + 2, loginEnd);
    if (suppliedGuard.length > 1 || (suppliedGuard.length && !/^[A-Za-z0-9]{5,8}$/.test(suppliedGuard[0]))) throw new Error('Saved-account login accepts only an optional Steam Guard code');
    const guard = account.guard ?? suppliedGuard[0];
    const expanded = [...args.slice(0, index + 1), account.username, account.password, ...(guard ? [guard] : []), ...args.slice(loginEnd)];
    const lines: string[] = ['@ShutdownOnFailedCommand 1', '@NoPromptForPassword 1'];
    let line: string[] = [];
    for (const token of expanded) {
      if (token.startsWith('+')) { if (line.length) lines.push(line.join(' ')); line = [token.slice(1)]; }
      else { if (/["\r\n\x00]/.test(token)) throw new Error('SteamCMD script values cannot contain quotes or line breaks'); line.push(`"${token}"`); }
    }
    if (line.length) lines.push(line.join(' '));
    // Outside DATA_DIR so an environment backup cannot capture a live login/Guard script.
    scriptDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-steam-login-'));
    script = path.join(scriptDirectory, `request-${crypto.randomUUID()}.txt`);
    fs.writeFileSync(script, lines.join('\n') + '\n', { mode: 0o600, flag: 'wx' });
    const redact = (text: string) => text.replaceAll(account.password, '[redacted]').replaceAll(guard ?? '\x00-never', '[redacted]');
    try { return redact(await runner(exePath, ['+runscript', script], cwd, text => onLog?.(redact(text)), { ...process.env, HOME: account.directory, USERPROFILE: account.directory })); }
    catch (error) { const clean = new Error(redact(error instanceof Error ? error.message : String(error))) as Error & { output?: string }; clean.output = redact((error as { output?: string }).output ?? ''); throw clean; }
  } finally { try { if (scriptDirectory) fs.rmSync(scriptDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } finally { accountBusy.delete(account.id); } }
}
function runSteamProcess(exePath: string, args: string[], cwd: string, onLog?: LogFn, env = process.env): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(exePath, args, { cwd, env, windowsHide: true });
    child.stdin.end();
    let captured = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const tails = { stdout: '', stderr: '' };
    const consume = (stream: 'stdout' | 'stderr', chunk: string) => {
      captured += chunk;
      const lines = (tails[stream] + chunk).split(/\r?\n/); tails[stream] = lines.pop() ?? '';
      for (const line of lines) if (line) onLog?.(`  ${line}`);
      if (captured.length > 8 * 1024 * 1024) captured = captured.slice(-4 * 1024 * 1024);
    };
    child.stdout.on('data', (chunk: string) => consume('stdout', chunk));
    child.stderr.on('data', (chunk: string) => consume('stderr', chunk));
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      for (const tail of Object.values(tails)) if (tail) onLog?.(`  ${tail}`);
      if (code === 0) return resolve(captured);
      if (STEAMCMD_SUCCESS_MARKER.test(captured)) {
        onLog?.(
          `  (steamcmd exited with code ${code} after reporting success — it likely self-updated itself mid-command; treating this as OK)`
        );
        return resolve(captured);
      }
      const err = new Error(`steamcmd exited with code ${code}`) as Error & { output?: string };
      err.output = captured;
      reject(err);
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
  const output = await runSteamCmd(steamCmdPath, args, instanceDir, onLog);
  if (!STEAMCMD_SUCCESS_MARKER.test(output)) throw new Error(explainLoginFailure(output) ?? 'SteamCMD did not confirm a successful app installation; inspect the install log');

  if (isFirstInstall) {
    onLog?.(
      "==> First-time install for this app — steamcmd's first pass at a new app commonly doesn't fully " +
        'finish, so running it again to make sure everything actually downloaded'
    );
    onLog?.(`==> ${commandLog}`);
    const second = await runSteamCmd(steamCmdPath, args, instanceDir, onLog);
    if (!STEAMCMD_SUCCESS_MARKER.test(second)) throw new Error(explainLoginFailure(second) ?? 'SteamCMD did not confirm the second installation pass');
  }
}

/** Turns steamcmd's login complaints into something a person can act on. */
function explainLoginFailure(output: string): string | null {
  if (/Two-factor code mismatch|Invalid Login Auth Code|Steam Guard code/i.test(output)) {
    return 'Steam Guard needs a code for this account — enter the current code from the Steam app (or the emailed one) and try again.';
  }
  if (/Invalid Password|password.*incorrect|FAILED \(Invalid/i.test(output)) return 'Steam rejected the username or password.';
  if (/Rate Limit|RateLimitExceeded/i.test(output)) return 'Steam is rate-limiting logins from this host — wait a few minutes and try again.';
  if (/No subscription|Access Denied|Failure \(.*\)|ERROR! Download item \d+ failed \(Access/i.test(output)) {
    return 'This Steam account can’t download this item — Workshop content for this game needs an account that owns the game.';
  }
  return null;
}

/**
 * Downloads one Workshop item with steamcmd into `<workDir>/steamapps/workshop/content/<appId>/<itemId>`
 * and returns that folder. `login` is "anonymous" or "user password"; a one-time Steam Guard code
 * can be added for the first login (steamcmd remembers the session afterwards).
 */
export async function steamWorkshopDownload(
  appId: string,
  itemId: string,
  workDir: string,
  opts: { login: string; guardCode?: string; onLog?: LogFn }
): Promise<string> {
  const steamCmdPath = await ensureSteamCmd(opts.onLog);
  fs.mkdirSync(workDir, { recursive: true });
  const loginArgs = opts.login.trim() ? opts.login.trim().split(/\s+/) : ['anonymous'];
  if (opts.guardCode && loginArgs[0] !== 'anonymous') loginArgs.push(opts.guardCode.trim());
  const who = loginArgs[0] === 'anonymous' ? 'anonymous' : `${loginArgs[0]} ***`;
  opts.onLog?.(`==> steamcmd +login ${who} +workshop_download_item ${appId} ${itemId} validate`);
  let output: string;
  try {
    output = await runSteamCmd(
      steamCmdPath,
      ['+force_install_dir', workDir, '+login', ...loginArgs, '+workshop_download_item', appId, itemId, 'validate', '+quit'],
      workDir,
      opts.onLog
    );
  } catch (err) {
    const why = explainLoginFailure((err as { output?: string }).output ?? '');
    throw new Error(why ?? (err instanceof Error ? err.message : String(err)));
  }
  // steamcmd can exit 0 after a failed download — trust only its success line.
  if (!new RegExp(`Success\\. Downloaded item ${itemId}\\b`).test(output)) {
    throw new Error(explainLoginFailure(output) ?? `steamcmd didn’t download item ${itemId} — see the log above`);
  }
  const folder = path.join(workDir, 'steamapps', 'workshop', 'content', appId, itemId);
  if (!fs.existsSync(folder)) throw new Error(`steamcmd reported success but ${folder} is missing`);
  return folder;
}

/** The build an instance has installed, from steamcmd's own manifest (steamapps/appmanifest_<id>.acf). */
export function installedBuildId(instanceDir: string, appId: string): string | null {
  try {
    const acf = fs.readFileSync(path.join(instanceDir, 'steamapps', `appmanifest_${appId}.acf`), 'utf8');
    return acf.match(/"buildid"\s+"(\d+)"/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Pulls the "public" branch's buildid out of `app_info_print` output (Valve's VDF text). */
export function parsePublicBuildId(output: string): string | null {
  const branches = output.indexOf('"branches"');
  if (branches < 0) return null;
  const pub = output.indexOf('"public"', branches);
  if (pub < 0) return null;
  return output.slice(pub, pub + 400).match(/"buildid"\s+"(\d+)"/)?.[1] ?? null;
}

const latestCache = new Map<string, { at: number; id: string | null }>();

/** The newest public build of an app, asked of Steam through steamcmd (anonymous). Cached 10 minutes. */
export async function latestBuildId(appId: string, onLog?: LogFn): Promise<string | null> {
  const hit = latestCache.get(appId);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.id;
  const exe = await ensureSteamCmd(onLog);
  let id: string | null = null;
  // The first app_info_print after a fresh login is sometimes empty; asking twice is the usual cure.
  const output = await runSteamCmd(exe, ['+login', 'anonymous', '+app_info_update', '1', '+app_info_print', appId, '+app_info_print', appId, '+quit'], STEAMCMD_DIR).catch(
    (err: { output?: string }) => err.output ?? ''
  );
  id = parsePublicBuildId(output);
  latestCache.set(appId, { at: Date.now(), id });
  return id;
}
