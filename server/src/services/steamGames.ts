import fs from 'node:fs';
import path from 'node:path';
import { instanceDir } from '../utils/paths.js';
import type { ServerRecord } from '../types/index.js';

export type StopStrategy =
  | { kind: 'stdin'; commands: string[]; delayMs: number }
  | { kind: 'signal'; signal: 'SIGINT' | 'SIGTERM' | 'SIGQUIT' | 'SIGHUP' }
  | { kind: 'none' };

export interface SteamGamePreset {
  id: string;
  label: string;
  appId: string;
  defaultPort: number;
  portProtocol: 'tcp' | 'udp';
  executable: { win32: string; linux: string };
  buildLaunchArgs(server: ServerRecord): string[];
  readyRegex?: RegExp;
  stopStrategy: StopStrategy;
  needsExecuteBit: boolean;
  /** steamcmd arguments that must come before `+app_update` (e.g. HLDS's `+app_set_config 90 mod cstrike`). */
  installFlags?: string[];
  /** Runs before each start (never for a preview) — e.g. to move data into a new location. Returns a log line, if any. */
  prepareInstance?(server: ServerRecord): string | null;
  notes?: string;
}

function extraArgs(server: ServerRecord): string[] {
  return server.extra_args ? server.extra_args.split(' ').filter(Boolean) : [];
}

/** Project Zomboid keeps its saves, server .ini files and logs in ~/Zomboid by default — shared by
 *  every instance and outside the instance folder. `-cachedir=` moves it into the instance. */
function zomboidCacheDir(server: ServerRecord): string {
  return path.join(instanceDir(server.id), 'Zomboid');
}

function zomboidLaunchArgs(server: ServerRecord): string[] {
  const extra = extraArgs(server);
  if (extra.some((a) => a.toLowerCase().startsWith('-cachedir='))) return extra;
  const dir = zomboidCacheDir(server);
  // StartServer64.bat runs through cmd.exe, which would split an unquoted path with spaces.
  const flag = process.platform === 'win32' && /\s/.test(dir) ? `"-cachedir=${dir}"` : `-cachedir=${dir}`;
  return [flag, ...extra];
}

/** Sandboxed instances used to write to <instance>/.home/Zomboid (HOME inside the sandbox) —
 *  move that into the new location so the existing world isn't left behind. */
function migrateZomboidCacheDir(server: ServerRecord): string | null {
  const target = zomboidCacheDir(server);
  const legacy = path.join(instanceDir(server.id), '.home', 'Zomboid');
  if (fs.existsSync(target) || !fs.existsSync(legacy)) return null;
  fs.renameSync(legacy, target);
  return `Moved Project Zomboid data from .home/Zomboid to Zomboid/ in this instance`;
}

export const STEAM_GAME_PRESETS: SteamGamePreset[] = [
  {
    id: 'palworld',
    label: 'Palworld',
    appId: '2394010',
    defaultPort: 8211,
    portProtocol: 'udp',
    executable: { win32: 'PalServer.exe', linux: 'PalServer.sh' },
    buildLaunchArgs: (server) => [
      `-port=${server.server_port}`,
      '-useperfthreads',
      '-NoAsyncLoadingThread',
      '-UseMultithreadForDS',
      ...extraArgs(server),
    ],
    stopStrategy: { kind: 'signal', signal: 'SIGTERM' },
    needsExecuteBit: true,
    notes:
      "Palworld's dedicated server does not reliably shut down cleanly on a stop signal — Outpost will " +
      'force-stop it after a short grace period if it does not exit on its own. Its own periodic autosave is ' +
      'what gets preserved, not a save-on-exit. Use in-game admin commands or an RCON tool if you need a ' +
      'guaranteed save immediately before stopping.',
  },
  {
    id: 'project_zomboid',
    label: 'Project Zomboid',
    appId: '380870',
    defaultPort: 16261,
    portProtocol: 'udp',
    executable: { win32: 'StartServer64.bat', linux: 'start-server.sh' },
    buildLaunchArgs: zomboidLaunchArgs,
    prepareInstance: migrateZomboidCacheDir,
    readyRegex: /SERVER STARTED/i,
    stopStrategy: { kind: 'stdin', commands: ['save', 'quit'], delayMs: 5000 },
    needsExecuteBit: true,
  },
  {
    id: 'valheim',
    label: 'Valheim',
    appId: '896660',
    defaultPort: 2456,
    portProtocol: 'udp',
    executable: { win32: 'valheim_server.exe', linux: 'valheim_server.x86_64' },
    buildLaunchArgs: (server) => [
      '-name', server.name,
      '-port', String(server.server_port),
      '-world', server.name,
      ...extraArgs(server),
    ],
    readyRegex: /Game server connected/i,
    // Valheim only saves the world on SIGINT, not SIGTERM — a well-documented gotcha in every
    // Valheim server wrapper.
    stopStrategy: { kind: 'signal', signal: 'SIGINT' },
    needsExecuteBit: true,
  },
  {
    id: 'terraria',
    label: 'Terraria',
    appId: '105600',
    defaultPort: 7777,
    portProtocol: 'tcp',
    executable: { win32: 'TerrariaServer.exe', linux: 'TerrariaServer.bin.x86_64' },
    buildLaunchArgs: (server) => [
      '-port', String(server.server_port),
      '-autocreate', '2',
      '-worldname', server.name,
      '-world', `worlds/${server.name}.wld`,
      ...extraArgs(server),
    ],
    readyRegex: /Server started/i,
    stopStrategy: { kind: 'stdin', commands: ['save', 'exit'], delayMs: 5000 },
    needsExecuteBit: true,
    notes:
      'Downloaded directly from terraria.org (not via steamcmd — Terraria has no separate free dedicated-server ' +
      'app, and anonymous steamcmd login cannot download the paid client depot). On Windows hosts, the server ' +
      'also needs the Microsoft XNA Framework 4.0 Redistributable installed separately — it is not bundled and ' +
      'the server will fail to start without it. Linux hosts need no extra runtime.',
  },
  // ---- Valve: Source 2, Source and GoldSrc dedicated servers ----
  {
    id: 'cs2',
    label: 'Counter-Strike 2',
    appId: '730',
    defaultPort: 27015,
    portProtocol: 'udp',
    executable: { win32: 'game/bin/win64/cs2.exe', linux: 'game/bin/linuxsteamrt64/cs2' },
    buildLaunchArgs: (server) => [
      '-dedicated',
      '-console',
      '-usercon',
      '-port', String(server.server_port),
      '+game_type', '0',
      '+game_mode', '1',
      '+map', 'de_dust2',
      ...extraArgs(server),
    ],
    readyRegex: /Host activate: Loading|Connection to Steam servers successful|GC Connection established/i,
    stopStrategy: { kind: 'stdin', commands: ['quit'], delayMs: 0 },
    needsExecuteBit: true,
    notes:
      'About 35 GB to download. Casual is the default — change mode with extra args, e.g. "+game_mode 1 +game_type 0" (competitive) or ' +
      '"+game_mode 2 +game_type 0" (wingman). To show up in the public server browser, add a Game Server Login Token: ' +
      '"+sv_setsteamaccount YOUR_TOKEN" (make one at steamcommunity.com/dev/managegameservers, app 730). Players connect on UDP 27015.',
  },
  {
    id: 'csgo',
    label: 'Counter-Strike: Global Offensive (legacy)',
    appId: '740',
    defaultPort: 27015,
    portProtocol: 'udp',
    executable: { win32: 'srcds.exe', linux: 'srcds_run' },
    buildLaunchArgs: (server) => [
      '-game', 'csgo',
      '-console',
      '-usercon',
      '-norestart',
      '-port', String(server.server_port),
      '+game_type', '0',
      '+game_mode', '0',
      '+map', 'de_dust2',
      ...extraArgs(server),
    ],
    readyRegex: /Connection to Steam servers successful|VAC secure mode is activated/i,
    stopStrategy: { kind: 'stdin', commands: ['quit'], delayMs: 0 },
    needsExecuteBit: true,
    notes:
      'The pre-CS2 game. Players can only join with the "csgo_legacy" beta of Counter-Strike 2 (Steam → CS2 → Properties → Betas). ' +
      'Public listing needs a Game Server Login Token for app 730: "+sv_setsteamaccount YOUR_TOKEN" in extra args.',
  },
  {
    id: 'css',
    label: 'Counter-Strike: Source',
    appId: '232330',
    defaultPort: 27015,
    portProtocol: 'udp',
    executable: { win32: 'srcds.exe', linux: 'srcds_run' },
    buildLaunchArgs: (server) => [
      '-game', 'cstrike',
      '-console',
      '-norestart',
      '-port', String(server.server_port),
      '+maxplayers', '24',
      '+map', 'de_dust2',
      ...extraArgs(server),
    ],
    readyRegex: /Connection to Steam servers successful|VAC secure mode is activated/i,
    stopStrategy: { kind: 'stdin', commands: ['quit'], delayMs: 0 },
    needsExecuteBit: true,
    notes: 'Server settings live in cstrike/cfg/server.cfg (create it in File Management). Players connect on UDP 27015.',
  },
  {
    id: 'cs16',
    label: 'Counter-Strike 1.6',
    appId: '90',
    defaultPort: 27015,
    portProtocol: 'udp',
    executable: { win32: 'hlds.exe', linux: 'hlds_run' },
    installFlags: ['+app_set_config', '90', 'mod', 'cstrike'],
    buildLaunchArgs: (server) => [
      '-game', 'cstrike',
      '-console',
      '-norestart',
      '-port', String(server.server_port),
      '+maxplayers', '16',
      '+map', 'de_dust2',
      ...extraArgs(server),
    ],
    readyRegex: /Connection to Steam servers successful|VAC secure mode is activated/i,
    stopStrategy: { kind: 'stdin', commands: ['quit'], delayMs: 0 },
    needsExecuteBit: true,
    notes:
      'Runs on the Half-Life Dedicated Server (app 90), whose steamcmd download is famously flaky — if the server won’t start after ' +
      'installing, run Update once or twice to finish it. Linux hosts need the 32-bit runtime libraries (the Outpost installer offers them). ' +
      'Settings live in cstrike/server.cfg.',
  },
  {
    id: 'cscz',
    label: 'Counter-Strike: Condition Zero',
    appId: '90',
    defaultPort: 27015,
    portProtocol: 'udp',
    executable: { win32: 'hlds.exe', linux: 'hlds_run' },
    installFlags: ['+app_set_config', '90', 'mod', 'czero'],
    buildLaunchArgs: (server) => [
      '-game', 'czero',
      '-console',
      '-norestart',
      '-port', String(server.server_port),
      '+maxplayers', '16',
      '+map', 'de_dust2_cz',
      ...extraArgs(server),
    ],
    readyRegex: /Connection to Steam servers successful|VAC secure mode is activated/i,
    stopStrategy: { kind: 'stdin', commands: ['quit'], delayMs: 0 },
    needsExecuteBit: true,
    notes:
      'Runs on the Half-Life Dedicated Server (app 90) with the czero mod. Its steamcmd download is flaky — if the server won’t start, ' +
      'run Update once or twice. Linux hosts need the 32-bit runtime libraries. Settings live in czero/server.cfg.',
  },
  {
    id: 'tf2',
    label: 'Team Fortress 2',
    appId: '232250',
    defaultPort: 27015,
    portProtocol: 'udp',
    executable: { win32: 'srcds.exe', linux: 'srcds_run' },
    buildLaunchArgs: (server) => [
      '-game', 'tf',
      '-console',
      '-norestart',
      '-port', String(server.server_port),
      '+maxplayers', '24',
      '+map', 'ctf_2fort',
      ...extraArgs(server),
    ],
    readyRegex: /Connection to Steam servers successful|VAC secure mode is activated/i,
    stopStrategy: { kind: 'stdin', commands: ['quit'], delayMs: 0 },
    needsExecuteBit: true,
    notes:
      'Settings live in tf/cfg/server.cfg (create it in File Management). To appear in the server browser, add a Game Server Login Token ' +
      'for app 440: "+sv_setsteamaccount YOUR_TOKEN" in extra args. Players connect on UDP 27015.',
  },
];

export function findPreset(appId: string | null | undefined): SteamGamePreset | undefined {
  if (!appId) return undefined;
  return STEAM_GAME_PRESETS.find((p) => p.appId === appId);
}

export function findPresetById(id: string | null | undefined): SteamGamePreset | undefined {
  return id ? STEAM_GAME_PRESETS.find((p) => p.id === id) : undefined;
}

/** The preset an instance was created from. Some games share an App ID (CS 1.6 and Condition Zero
 *  are both app 90), so the preset id wins; older instances fall back to the App ID. */
export function findPresetFor(server: Pick<ServerRecord, 'steam_app_id'> & { steam_preset?: string | null }): SteamGamePreset | undefined {
  return findPresetById(server.steam_preset) ?? findPreset(server.steam_app_id);
}
