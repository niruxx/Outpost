import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import type { ServerRecord } from '../types/index.js';
import { HttpError } from '../utils/asyncHandler.js';
import type { LaunchConfig } from './launchConfig.js';
import { DATA_DIR, instanceDir } from '../utils/paths.js';
import { minimalEnv, sandboxApplies, sandboxHome, wrapInSandbox } from './sandboxService.js';

/**
 * Wine: runs Windows-only dedicated servers (Black Ops III and many others) on Linux.
 *
 * Each instance gets its own Wine prefix (<instance>/.wine), so games never share registry or
 * install state and everything moves/backs up with the instance. Per instance you can choose the
 * prefix's architecture and Windows version, DLL overrides, debug channels, esync/fsync, a virtual
 * screen, and install dependencies (winetricks verbs or a Windows installer from the instance folder).
 */

export type WineMode = 'auto' | 'always' | 'never';
export const WINDOWS_VERSIONS = ['win11', 'win10', 'win81', 'win8', 'win7', 'win2008r2', 'win2008', 'vista', 'win2003', 'winxp'] as const;
export type WindowsVersion = (typeof WINDOWS_VERSIONS)[number];

/** The `wine` part of an instance's launch config. */
export interface WineConfig {
  mode: WineMode;
  /** Run inside Xvfb, for servers that open a window. */
  virtualDisplay?: boolean;
  /** Xvfb screen, WIDTHxHEIGHTxDEPTH. */
  resolution?: string;
  /** Only takes effect when the prefix is created (reset the prefix to change it). */
  arch?: 'win64' | 'win32';
  windowsVersion?: WindowsVersion;
  /** WINEDLLOVERRIDES additions, e.g. "d3d9=n,b;xinput1_3=n". */
  dllOverrides?: string;
  /** WINEDEBUG; default "-all" (quiet). */
  debug?: string;
  esync?: boolean;
  fsync?: boolean;
  /** Admin only: a specific Wine build (e.g. /opt/wine-staging/bin/wine). */
  binary?: string;
}

export interface WineSettings {
  mode: WineMode;
  virtualDisplay: boolean;
  resolution: string;
  arch: 'win64' | 'win32';
  windowsVersion: WindowsVersion | null;
  dllOverrides: string;
  debug: string;
  esync: boolean;
  fsync: boolean;
  binary: string | null;
}

export const INSTALL_HINT = 'Install Wine with "./install.sh --wine" from the Outpost folder, or your package manager (e.g. "sudo apt install wine64 xvfb winetricks").';

function onPath(names: string[], extraDirs: string[] = []): string | null {
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), ...extraDirs];
  for (const name of names) {
    for (const d of dirs) {
      if (!d) continue;
      const candidate = path.join(d, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

/** wine64 first (older distro packages split it out); /opt covers WineHQ's own builds. */
export function findWine(binary?: string | null): string | null {
  if (binary) {
    try {
      fs.accessSync(binary, fs.constants.X_OK);
      return binary;
    } catch {
      return null;
    }
  }
  return onPath(['wine64', 'wine'], ['/usr/bin', '/usr/local/bin', '/opt/wine-staging/bin', '/opt/wine-stable/bin', '/opt/wine-devel/bin']);
}

export function findXvfbRun(): string | null {
  return onPath(['xvfb-run'], ['/usr/bin', '/usr/local/bin']);
}

/** Outpost's own copy, fetched on demand when the distro has no winetricks package. */
const WINETRICKS_LOCAL = path.join(DATA_DIR, 'tools', 'winetricks');
const WINETRICKS_URL = 'https://raw.githubusercontent.com/Winetricks/winetricks/master/src/winetricks';

export function findWinetricks(): string | null {
  return onPath(['winetricks'], ['/usr/bin', '/usr/local/bin']) ?? (fs.existsSync(WINETRICKS_LOCAL) ? WINETRICKS_LOCAL : null);
}

export async function ensureWinetricks(onLog: (line: string) => void): Promise<string> {
  const found = findWinetricks();
  if (found) return found;
  onLog('[Outpost] winetricks isn’t installed — downloading it…');
  const res = await fetch(WINETRICKS_URL, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Couldn’t download winetricks (${res.status}) — install it with your package manager instead`);
  const text = await res.text();
  if (!text.startsWith('#!')) throw new Error('The winetricks download doesn’t look like the script');
  fs.mkdirSync(path.dirname(WINETRICKS_LOCAL), { recursive: true });
  fs.writeFileSync(WINETRICKS_LOCAL, text, { mode: 0o755 });
  cached = null;
  return WINETRICKS_LOCAL;
}

let cached: { at: number; value: WineStatus } | null = null;
export interface WineStatus {
  supported: boolean; // false on Windows hosts, which run .exe servers directly
  available: boolean;
  path: string | null;
  version: string | null;
  xvfb: boolean;
  winetricks: boolean;
  hint: string | null;
}

export function wineStatus(): WineStatus {
  if (cached && Date.now() - cached.at < 60_000) return cached.value;
  let value: WineStatus;
  if (process.platform === 'win32') {
    value = { supported: false, available: false, path: null, version: null, xvfb: false, winetricks: false, hint: 'This host runs Windows, so Windows servers start directly — Wine isn’t needed.' };
  } else {
    const wine = findWine();
    const version = wine ? (spawnSync(wine, ['--version'], { encoding: 'utf8', timeout: 10_000 }).stdout ?? '').trim() || null : null;
    value = { supported: true, available: !!wine, path: wine, version, xvfb: !!findXvfbRun(), winetricks: !!findWinetricks(), hint: wine ? null : INSTALL_HINT };
  }
  cached = { at: Date.now(), value };
  return value;
}

const RESOLUTION = /^\d{3,5}x\d{3,5}x(8|16|24|32)$/;

export function wineSettingsOf(config: LaunchConfig): WineSettings {
  const w = (config.wine ?? {}) as Partial<WineConfig>;
  return {
    mode: w.mode === 'always' || w.mode === 'never' ? w.mode : 'auto',
    virtualDisplay: w.virtualDisplay === true,
    resolution: typeof w.resolution === 'string' && RESOLUTION.test(w.resolution) ? w.resolution : '1024x768x24',
    arch: w.arch === 'win32' ? 'win32' : 'win64',
    windowsVersion: w.windowsVersion && (WINDOWS_VERSIONS as readonly string[]).includes(w.windowsVersion) ? w.windowsVersion : null,
    dllOverrides: typeof w.dllOverrides === 'string' ? w.dllOverrides : '',
    debug: typeof w.debug === 'string' && w.debug ? w.debug : '-all',
    esync: w.esync === true,
    fsync: w.fsync === true,
    binary: typeof w.binary === 'string' && w.binary ? w.binary : null,
  };
}

const DLL_OVERRIDES = /^[A-Za-z0-9_.,*-]+=[nbd,]*(;[A-Za-z0-9_.,*-]+=[nbd,]*)*$/;
const DEBUG = /^[+\-A-Za-z0-9_,]{1,200}$/;

/** Validates the `wine` part of a launch config (throws on bad input). Returns undefined for "all defaults". */
export function sanitizeWineConfig(raw: unknown, opts: { isAdmin: boolean }): WineConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const w = raw as Record<string, unknown>;
  const bad = (msg: string): never => {
    throw new HttpError(400, msg);
  };
  const out: WineConfig = { mode: w.mode === 'always' || w.mode === 'never' ? w.mode : 'auto' };
  if (w.virtualDisplay === true) out.virtualDisplay = true;
  if (typeof w.resolution === 'string' && w.resolution && w.resolution !== '1024x768x24') {
    if (!RESOLUTION.test(w.resolution)) bad('Screen size must look like 1280x720x24');
    out.resolution = w.resolution;
  }
  if (w.arch === 'win32') out.arch = 'win32';
  if (typeof w.windowsVersion === 'string' && w.windowsVersion) {
    if (!(WINDOWS_VERSIONS as readonly string[]).includes(w.windowsVersion)) bad('Unknown Windows version');
    out.windowsVersion = w.windowsVersion as WindowsVersion;
  }
  if (typeof w.dllOverrides === 'string' && w.dllOverrides.trim()) {
    const v = w.dllOverrides.replace(/\s+/g, '');
    if (!DLL_OVERRIDES.test(v)) bad('DLL overrides look like "d3d9=n,b;xinput1_3=n"');
    out.dllOverrides = v;
  }
  if (typeof w.debug === 'string' && w.debug.trim() && w.debug.trim() !== '-all') {
    if (!DEBUG.test(w.debug.trim())) bad('WINEDEBUG looks like "-all" or "+seh,-fixme"');
    out.debug = w.debug.trim();
  }
  if (w.esync === true) out.esync = true;
  if (w.fsync === true) out.fsync = true;
  if (typeof w.binary === 'string' && w.binary.trim()) {
    if (!opts.isAdmin) throw new HttpError(403, 'A custom Wine build can only be set by an admin');
    if (!path.isAbsolute(w.binary.trim())) bad('The Wine binary must be an absolute path');
    out.binary = w.binary.trim();
  }
  const isDefault = out.mode === 'auto' && Object.keys(out).length === 1;
  return isDefault ? undefined : out;
}

const WINDOWS_PROGRAM = /\.(exe|bat|cmd|com)$/i;

/** Whether this launch goes through Wine. Never on Windows hosts. */
export function usesWine(config: LaunchConfig, executable: string, windowsOnlyPreset: boolean): boolean {
  if (process.platform === 'win32') return false;
  const { mode } = wineSettingsOf(config);
  if (mode === 'never') return false;
  if (mode === 'always') return true;
  return windowsOnlyPreset || WINDOWS_PROGRAM.test(executable);
}

/** steamcmd should fetch the Windows build when the instance will run under Wine. */
export function wantsWindowsBuild(server: Pick<ServerRecord, 'launch_config'>, config: LaunchConfig, windowsOnlyPreset: boolean): boolean {
  if (process.platform === 'win32') return false;
  return windowsOnlyPreset || wineSettingsOf(config).mode === 'always';
}

export function winePrefix(instanceDir: string): string {
  return path.join(instanceDir, '.wine');
}

/** Environment every Wine launch gets: its own prefix, the instance's settings, no Mono/Gecko install prompts. */
export function wineEnv(instanceDir: string, settings?: WineSettings): Record<string, string> {
  const s = settings ?? wineSettingsOf({});
  const overrides = ['mscoree,mshtml=', s.dllOverrides].filter(Boolean).join(';');
  return {
    WINEPREFIX: winePrefix(instanceDir),
    WINEDEBUG: s.debug,
    WINEDLLOVERRIDES: overrides,
    WINEARCH: s.arch,
    ...(s.esync ? { WINEESYNC: '1' } : {}),
    ...(s.fsync ? { WINEFSYNC: '1' } : {}),
  };
}

// ---------------------------------------------------------------------------
// The prefix
// ---------------------------------------------------------------------------

interface PrefixState {
  arch: 'win64' | 'win32';
  windowsVersion: string | null;
}

const stateFile = (dir: string) => path.join(winePrefix(dir), 'outpost-prefix.json');

function readPrefixState(dir: string): PrefixState | null {
  try {
    return JSON.parse(fs.readFileSync(stateFile(dir), 'utf8')) as PrefixState;
  } catch {
    return null;
  }
}

export interface PrefixInfo {
  exists: boolean;
  arch: string | null;
  windowsVersion: string | null;
  /** winetricks verbs installed into this prefix (from its winetricks.log). */
  verbs: string[];
}

export function prefixInfo(dir: string): PrefixInfo {
  const exists = fs.existsSync(path.join(winePrefix(dir), 'system.reg'));
  const st = readPrefixState(dir);
  let arch = st?.arch ?? null;
  if (exists && !arch) {
    // Prefixes made before Outpost tracked this: the registry says.
    try {
      const head = fs.readFileSync(path.join(winePrefix(dir), 'system.reg'), 'utf8').slice(0, 400);
      arch = /#arch=win32/.test(head) ? 'win32' : 'win64';
    } catch {
      // leave unknown
    }
  }
  let verbs: string[] = [];
  try {
    verbs = [...new Set(fs.readFileSync(path.join(winePrefix(dir), 'winetricks.log'), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[a-z0-9_.]+$/i.test(l)))];
  } catch {
    // none yet
  }
  return { exists, arch, windowsVersion: st?.windowsVersion ?? null, verbs };
}

/** Whether a start has to set up (or update) the prefix first. */
export function prefixNeedsWork(dir: string, settings: WineSettings): boolean {
  const info = prefixInfo(dir);
  if (!info.exists) return true;
  return !!settings.windowsVersion && settings.windowsVersion !== info.windowsVersion;
}

/** Instances with a Wine job running (prefix setup, winetricks, an installer). */
const busy = new Map<string, string>();
export const wineBusy = (serverId: string) => busy.get(serverId) ?? null;

/**
 * Runs a Wine-side tool for an instance (wineboot, winecfg, winetricks, an installer): inside the
 * instance's sandbox when sandboxing applies, under Xvfb when available (installers often open
 * windows), with the instance's Wine environment. Output goes to onLog.
 */
export function runWineTool(
  server: ServerRecord,
  settings: WineSettings,
  cmd: string,
  args: string[],
  onLog: (line: string) => void,
  timeoutMs = 30 * 60_000
): Promise<void> {
  const dir = instanceDir(server.id);
  const env: Record<string, string> = { ...minimalEnv(), ...wineEnv(dir, settings), DISPLAY: '' };
  if (settings.binary) env.WINE = settings.binary; // winetricks honours $WINE
  let command = cmd;
  let argv = args;
  const xvfb = findXvfbRun();
  if (xvfb) {
    argv = ['-a', '-s', `-screen 0 ${settings.resolution}`, command, ...argv];
    command = xvfb;
    delete env.DISPLAY;
  }
  if (sandboxApplies(server)) {
    env.HOME = sandboxHome(server);
    const wrapped = wrapInSandbox(server, { cmd: command, args: argv, cwd: dir, env });
    // No pid report wanted here — that needs an extra pipe the tool runner doesn't open.
    const a = [...wrapped.args];
    const i = a.indexOf('--info-fd');
    if (i >= 0) a.splice(i, 2);
    command = wrapped.cmd;
    argv = a;
  }
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, argv, { env, cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Took too long — stopped'));
    }, timeoutMs);
    const forward = (chunk: Buffer) => {
      for (const l of chunk.toString('utf8').split(/\r?\n/)) if (l.trim()) onLog(`[wine] ${l}`);
    };
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`exited with code ${code}`));
    });
  });
}

/** Runs one Wine job for an instance at a time. */
export async function withWineJob<T>(serverId: string, what: string, fn: () => Promise<T>): Promise<T> {
  if (busy.has(serverId)) throw new HttpError(409, `Wine is busy (${busy.get(serverId)}) — wait for it to finish`);
  busy.set(serverId, what);
  try {
    return await fn();
  } finally {
    busy.delete(serverId);
  }
}

/**
 * Creates the instance's Wine prefix on first use (wineboot --init) and applies its Windows version,
 * logging progress. Takes a minute or so the first time; later starts skip it.
 */
export async function ensurePrefix(server: ServerRecord, settings: WineSettings, onLog: (line: string) => void): Promise<void> {
  const dir = instanceDir(server.id);
  const wine = findWine(settings.binary);
  if (!wine) throw new Error(`Wine isn’t installed${settings.binary ? ` at ${settings.binary}` : ''}. ${INSTALL_HINT}`);
  const prefix = winePrefix(dir);
  const info = prefixInfo(dir);
  if (!info.exists) {
    fs.mkdirSync(prefix, { recursive: true });
    onLog(`[Outpost] Setting up Wine for this instance (${settings.arch}, first start only — this can take a minute)…`);
    await runWineTool(server, settings, wine, ['wineboot', '--init'], onLog, 180_000).catch((err) => {
      // wineboot sometimes exits non-zero after doing its job
      if (!fs.existsSync(path.join(prefix, 'system.reg'))) throw err;
    });
    fs.writeFileSync(stateFile(dir), JSON.stringify({ arch: settings.arch, windowsVersion: null } satisfies PrefixState));
  } else if (info.arch && info.arch !== settings.arch) {
    onLog(`[Outpost] This instance’s Wine prefix is ${info.arch}; the ${settings.arch} setting only applies after resetting the prefix (Wine tab).`);
  }
  if (settings.windowsVersion && settings.windowsVersion !== readPrefixState(dir)?.windowsVersion) {
    onLog(`[Outpost] Setting the Windows version to ${settings.windowsVersion}…`);
    await runWineTool(server, settings, wine, ['winecfg', '-v', settings.windowsVersion], onLog, 120_000);
    const st = readPrefixState(dir) ?? { arch: settings.arch, windowsVersion: null };
    fs.writeFileSync(stateFile(dir), JSON.stringify({ ...st, windowsVersion: settings.windowsVersion }));
  }
  onLog('[Outpost] Wine is ready.');
}

export function resetPrefix(dir: string) {
  fs.rmSync(winePrefix(dir), { recursive: true, force: true });
}

/** Common dependencies for Windows game servers, with what they're for. */
export const WINETRICKS_VERBS: { verb: string; label: string }[] = [
  { verb: 'vcrun2022', label: 'Visual C++ 2015–2022 runtime' },
  { verb: 'vcrun2019', label: 'Visual C++ 2015–2019 runtime' },
  { verb: 'vcrun2013', label: 'Visual C++ 2013 runtime' },
  { verb: 'vcrun2012', label: 'Visual C++ 2012 runtime' },
  { verb: 'vcrun2010', label: 'Visual C++ 2010 runtime' },
  { verb: 'vcrun2008', label: 'Visual C++ 2008 runtime' },
  { verb: 'vcrun2005', label: 'Visual C++ 2005 runtime' },
  { verb: 'dotnet48', label: '.NET Framework 4.8' },
  { verb: 'dotnet472', label: '.NET Framework 4.7.2' },
  { verb: 'dotnet40', label: '.NET Framework 4.0' },
  { verb: 'dotnetdesktop6', label: '.NET Desktop Runtime 6' },
  { verb: 'dotnetdesktop8', label: '.NET Desktop Runtime 8' },
  { verb: 'd3dx9', label: 'DirectX 9 (d3dx9)' },
  { verb: 'd3dx10', label: 'DirectX 10 (d3dx10)' },
  { verb: 'd3dx11_43', label: 'DirectX 11 (d3dx11)' },
  { verb: 'd3dcompiler_47', label: 'D3D shader compiler 47' },
  { verb: 'xact', label: 'XACT audio' },
  { verb: 'xinput', label: 'XInput' },
  { verb: 'directplay', label: 'DirectPlay (old multiplayer games)' },
  { verb: 'physx', label: 'NVIDIA PhysX' },
  { verb: 'mfc140', label: 'MFC 14 libraries' },
  { verb: 'msxml6', label: 'MS XML 6' },
  { verb: 'gdiplus', label: 'GDI+' },
  { verb: 'corefonts', label: 'Core fonts' },
  { verb: 'dxvk', label: 'DXVK (Vulkan Direct3D)' },
];

export const VERB = /^[a-z0-9_.]{2,40}$/;
