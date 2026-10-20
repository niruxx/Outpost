import fs from 'node:fs';
import path from 'node:path';
import { instanceDir, STEAMCMD_DIR } from '../utils/paths.js';
import { HttpError } from '../utils/asyncHandler.js';
import { installQuake3 } from './directInstallers.js';
import { workshopStateOf } from './workshopState.js';
import type { LogFn } from '../utils/download.js';
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
  /** Installs without steamcmd (files published elsewhere). `appId` then only identifies the game. */
  install?: (instanceDir: string, onLog?: LogFn) => Promise<void>;
  /** Host OSes the server runs on; omitted = all. */
  hosts?: NodeJS.Platform[];
  /** Extra folders (relative to the instance) the game's own libraries live in, added to LD_LIBRARY_PATH on Linux. */
  libraryPaths?: string[];
  /** The server only ships for Windows: on Linux it's started through Wine. */
  windowsOnly?: boolean;
  /** Folder (relative to the instance) the server runs in, when it isn't the instance root. */
  workingDir?: string;
  /** Steam Workshop support (services/workshopService.ts). */
  workshop?: WorkshopSupport;
  /** RCON: the protocol and usual port, and how to switch it on from the command line (if the game allows). */
  rcon?: {
    protocol: 'source' | 'webrcon';
    port(server: ServerRecord): number;
    launchArgs?(cfg: { port: number; password: string }): string[];
    /** RCON goes into the launch arguments some other way (e.g. ARK's ?options) — still automatic. */
    automatic?: boolean;
    note?: string;
  };
  /** Runs before each start (never for a preview) — e.g. to move data into a new location. Returns a log line, if any. */
  prepareInstance?(server: ServerRecord): string | null;
  notes?: string;
}

export interface WorkshopSupport {
  /** The game's App ID — the one Workshop items are published under. */
  appId: string;
  /**
   * zomboid — the server downloads items itself; Outpost writes WorkshopItems=/Mods= into its .ini.
   * bo3     — Outpost downloads items with steamcmd and installs them as usermaps/ or mods/.
   * gmod    — Outpost downloads items and unpacks them into garrysmod/addons, plus a resource.AddWorkshop
   *           list so joining players download the same items.
   * ark     — the server downloads mods itself (-automanagedmods); Outpost passes ?GameModIds=.
   * arma    — Outpost downloads mods into @<id> folders, copies their keys, and loads them with -mod=.
   */
  mode: 'zomboid' | 'bo3' | 'gmod' | 'ark' | 'arma';
  /** Downloads need a Steam account that owns the game. */
  needsLogin: boolean;
}

/** The instance's RCON settings when switched on (parsed here, not via rconService, to avoid an import cycle). */
function rconOn(server: ServerRecord): { port: number; password: string } | null {
  if (!server.rcon_config) return null;
  try {
    const c = JSON.parse(server.rcon_config) as { enabled?: boolean; port?: number; password?: string };
    return c.enabled && typeof c.port === 'number' && c.password ? { port: c.port, password: c.password } : null;
  } catch {
    return null;
  }
}

function extraArgs(server: ServerRecord): string[] {
  return server.extra_args ? server.extra_args.split(' ').filter(Boolean) : [];
}

/** Workshop items that are installed (or, for games that download them themselves, saved), in list order. */
function activeWorkshopItems(server: ServerRecord) {
  return workshopStateOf(server).items.filter((i) => i.status === 'installed');
}

/** ARK's -automanagedmods runs steamcmd from inside the game's folder — give it a copy of Outpost's. */
function prepareArkMods(server: ServerRecord): string | null {
  if (!activeWorkshopItems(server).length) return null;
  const sub = process.platform === 'win32' ? 'Win64' : 'Linux';
  const target = path.join(instanceDir(server.id), 'Engine', 'Binaries', 'ThirdParty', 'SteamCMD', sub);
  const exe = process.platform === 'win32' ? 'steamcmd.exe' : 'steamcmd.sh';
  if (fs.existsSync(path.join(target, exe))) return null;
  if (!fs.existsSync(path.join(STEAMCMD_DIR, exe))) return 'ARK mods need steamcmd in Engine/Binaries/ThirdParty/SteamCMD — install or update the server once so Outpost downloads it';
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(STEAMCMD_DIR, target, { recursive: true });
  return 'Copied steamcmd into the game folder so ARK can download its mods';
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
    workshop: { appId: '108600', mode: 'zomboid', needsLogin: false },
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
    // What Valve's cs2.sh puts on LD_LIBRARY_PATH: the engine's own libraries (libv8.so, libtier0.so…)
    // live next to the binary, and libserver.so can't load without them.
    libraryPaths: ['game/bin/linuxsteamrt64', 'game/csgo/bin/linuxsteamrt64'],
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
  // ---- Quake ----
  {
    id: 'quake3',
    label: 'Quake III Arena (ioquake3)',
    appId: '2200',
    defaultPort: 27960,
    portProtocol: 'udp',
    executable: { win32: 'ioq3ded.x86_64.exe', linux: 'ioq3ded.x86_64' },
    install: installQuake3,
    buildLaunchArgs: (server) => [
      '+set', 'dedicated', '2',
      '+set', 'net_port', String(server.server_port),
      // Keep configs, logs and downloads in the instance instead of ~/.q3a.
      '+set', 'fs_homepath', instanceDir(server.id),
      '+exec', 'server.cfg',
      '+map', 'q3dm17',
      ...extraArgs(server),
    ],
    readyRegex: /Hunk_Clear: reset the hunk ok/i,
    stopStrategy: { kind: 'stdin', commands: ['quit'], delayMs: 0 },
    needsExecuteBit: true,
    prepareInstance: (server) => {
      if (!fs.existsSync(path.join(instanceDir(server.id), 'baseq3', 'pak0.pk3'))) {
        throw new HttpError(
          409,
          'Quake III needs its main game data first: upload baseq3/pak0.pk3 from your own copy of the game (Steam: steamapps/common/Quake 3 Arena/baseq3) in File Management.'
        );
      }
      return null;
    },
    notes:
      'Runs the open-source ioquake3 engine with id’s free point-release data. The main game data (baseq3/pak0.pk3) isn’t free — ' +
      'after installing, upload it from your own copy (Steam or GOG) to baseq3/ in File Management. Settings and map rotation are in baseq3/server.cfg.',
  },
  {
    id: 'quakelive',
    label: 'Quake Live',
    appId: '349090',
    defaultPort: 27960,
    portProtocol: 'udp',
    hosts: ['linux'],
    executable: { win32: 'qzeroded.exe', linux: 'run_server_x64.sh' },
    buildLaunchArgs: (server) => [
      '+set', 'net_strict', '1',
      '+set', 'net_port', String(server.server_port),
      '+set', 'sv_hostname', server.name,
      '+set', 'fs_homepath', path.join(instanceDir(server.id), 'home'),
      '+exec', 'server.cfg',
      '+map', 'campgrounds', 'ffa',
      ...extraArgs(server),
    ],
    stopStrategy: { kind: 'stdin', commands: ['quit'], delayMs: 0 },
    needsExecuteBit: true,
    notes:
      'Linux hosts only (id publishes no Windows server). Configs go in home/baseq3/server.cfg; change the starting map and factory ' +
      'with extra args, e.g. "+map bloodrun duel". Workshop items go in home/baseq3/workshop.txt.',
  },
  // ---- Source / GoldSrc ----
  {
    id: 'gmod',
    label: "Garry's Mod",
    appId: '4020',
    defaultPort: 27015,
    portProtocol: 'udp',
    executable: { win32: 'srcds.exe', linux: 'srcds_run' },
    buildLaunchArgs: (server) => [
      '-game', 'garrysmod',
      '-console',
      '-norestart',
      '-port', String(server.server_port),
      '+maxplayers', '16',
      '+gamemode', 'sandbox',
      '+map', 'gm_construct',
      ...extraArgs(server),
    ],
    readyRegex: /Connection to Steam servers successful|VAC secure mode is activated/i,
    stopStrategy: { kind: 'stdin', commands: ['quit'], delayMs: 0 },
    needsExecuteBit: true,
    workshop: { appId: '4000', mode: 'gmod', needsLogin: false },
    notes: 'Change the gamemode with extra args (e.g. "+gamemode terrortown"); addons go in garrysmod/addons, or add them from the Workshop tab. Settings live in garrysmod/cfg/server.cfg.',
  },
  {
    id: 'l4d2',
    label: 'Left 4 Dead 2',
    appId: '222860',
    defaultPort: 27015,
    portProtocol: 'udp',
    executable: { win32: 'srcds.exe', linux: 'srcds_run' },
    buildLaunchArgs: (server) => [
      '-game', 'left4dead2',
      '-console',
      '-norestart',
      '-port', String(server.server_port),
      '+maxplayers', '8',
      '+map', 'c1m1_hotel',
      ...extraArgs(server),
    ],
    readyRegex: /Connection to Steam servers successful|VAC secure mode is activated/i,
    stopStrategy: { kind: 'stdin', commands: ['quit'], delayMs: 0 },
    needsExecuteBit: true,
    notes: 'Settings live in left4dead2/cfg/server.cfg. Lobbies can reserve the server with "sv_allow_lobby_connect_only 0" off for direct connects.',
  },
  {
    id: 'hl2dm',
    label: 'Half-Life 2: Deathmatch',
    appId: '232370',
    defaultPort: 27015,
    portProtocol: 'udp',
    executable: { win32: 'srcds.exe', linux: 'srcds_run' },
    buildLaunchArgs: (server) => [
      '-game', 'hl2mp',
      '-console',
      '-norestart',
      '-port', String(server.server_port),
      '+maxplayers', '16',
      '+map', 'dm_lockdown',
      ...extraArgs(server),
    ],
    readyRegex: /Connection to Steam servers successful|VAC secure mode is activated/i,
    stopStrategy: { kind: 'stdin', commands: ['quit'], delayMs: 0 },
    needsExecuteBit: true,
    notes: 'Settings live in hl2mp/cfg/server.cfg.',
  },
  {
    id: 'dods',
    label: 'Day of Defeat: Source',
    appId: '232290',
    defaultPort: 27015,
    portProtocol: 'udp',
    executable: { win32: 'srcds.exe', linux: 'srcds_run' },
    buildLaunchArgs: (server) => [
      '-game', 'dod',
      '-console',
      '-norestart',
      '-port', String(server.server_port),
      '+maxplayers', '24',
      '+map', 'dod_anzio',
      ...extraArgs(server),
    ],
    readyRegex: /Connection to Steam servers successful|VAC secure mode is activated/i,
    stopStrategy: { kind: 'stdin', commands: ['quit'], delayMs: 0 },
    needsExecuteBit: true,
    notes: 'Settings live in dod/cfg/server.cfg.',
  },
  {
    id: 'hldm',
    label: 'Half-Life Deathmatch',
    appId: '90',
    defaultPort: 27015,
    portProtocol: 'udp',
    executable: { win32: 'hlds.exe', linux: 'hlds_run' },
    installFlags: ['+app_set_config', '90', 'mod', 'valve'],
    buildLaunchArgs: (server) => [
      '-game', 'valve',
      '-console',
      '-norestart',
      '-port', String(server.server_port),
      '+maxplayers', '16',
      '+map', 'crossfire',
      ...extraArgs(server),
    ],
    readyRegex: /Connection to Steam servers successful|VAC secure mode is activated/i,
    stopStrategy: { kind: 'stdin', commands: ['quit'], delayMs: 0 },
    needsExecuteBit: true,
    notes: 'Half-Life Dedicated Server (app 90). Its steamcmd download is flaky — run Update again if the server won’t start. Linux needs the 32-bit libraries.',
  },
  {
    id: 'tfc',
    label: 'Team Fortress Classic',
    appId: '90',
    defaultPort: 27015,
    portProtocol: 'udp',
    executable: { win32: 'hlds.exe', linux: 'hlds_run' },
    installFlags: ['+app_set_config', '90', 'mod', 'tfc'],
    buildLaunchArgs: (server) => [
      '-game', 'tfc',
      '-console',
      '-norestart',
      '-port', String(server.server_port),
      '+maxplayers', '16',
      '+map', '2fort',
      ...extraArgs(server),
    ],
    readyRegex: /Connection to Steam servers successful|VAC secure mode is activated/i,
    stopStrategy: { kind: 'stdin', commands: ['quit'], delayMs: 0 },
    needsExecuteBit: true,
    notes: 'Half-Life Dedicated Server (app 90) with the tfc mod. Run Update again if the first download is incomplete. Linux needs the 32-bit libraries.',
  },
  // ---- Survival / sandbox ----
  {
    id: 'rust',
    label: 'Rust',
    appId: '258550',
    defaultPort: 28015,
    portProtocol: 'udp',
    executable: { win32: 'RustDedicated.exe', linux: 'RustDedicated' },
    libraryPaths: ['RustDedicated_Data/Plugins/x86_64'],
    buildLaunchArgs: (server) => [
      '-batchmode',
      '-nographics',
      '+server.port', String(server.server_port),
      '+server.identity', 'outpost',
      '+server.hostname', server.name,
      '+server.level', 'Procedural Map',
      '+server.seed', '12345',
      '+server.worldsize', '3500',
      '+server.maxplayers', '50',
      ...extraArgs(server),
    ],
    readyRegex: /Server startup complete/i,
    stopStrategy: { kind: 'stdin', commands: ['quit'], delayMs: 0 },
    needsExecuteBit: true,
    notes:
      'About 10 GB, and wants 8–12 GB of RAM. Change the map with extra args, e.g. "+server.seed 9876 +server.worldsize 4000". ' +
      'Saves live in server/outpost. Players connect on UDP 28015.',
  },
  {
    id: 'ark',
    label: 'ARK: Survival Evolved',
    appId: '376030',
    defaultPort: 7777,
    portProtocol: 'udp',
    executable: { win32: 'ShooterGame/Binaries/Win64/ShooterGameServer.exe', linux: 'ShooterGame/Binaries/Linux/ShooterGameServer' },
    buildLaunchArgs: (server) => {
      const mods = activeWorkshopItems(server).map((i) => i.id);
      const rcon = rconOn(server);
      return [
        `TheIsland?listen?SessionName=${server.name.replace(/[?\s]+/g, '_')}?Port=${server.server_port}?QueryPort=27015?MaxPlayers=20` +
          (mods.length ? `?GameModIds=${mods.join(',')}` : '') +
          (rcon ? `?RCONEnabled=True?RCONPort=${rcon.port}?ServerAdminPassword=${rcon.password}` : ''),
        '-server',
        '-log',
        ...(mods.length ? ['-automanagedmods'] : []),
        ...extraArgs(server),
      ];
    },
    workshop: { appId: '346110', mode: 'ark', needsLogin: false },
    rcon: { protocol: 'source', port: () => 27020, automatic: true, note: 'The RCON password is also ARK’s admin password (ServerAdminPassword).' },
    prepareInstance: prepareArkMods,
    stopStrategy: { kind: 'signal', signal: 'SIGINT' },
    needsExecuteBit: true,
    notes:
      'About 20 GB, and wants 8+ GB of RAM. Players also need UDP 27015 (query) forwarded. Server settings live in ' +
      'ShooterGame/Saved/Config/*/GameUserSettings.ini. Change the map in the first extra arg or by editing the preset’s launch command.',
  },
  {
    id: '7dtd',
    label: '7 Days to Die',
    appId: '294420',
    defaultPort: 26900,
    portProtocol: 'udp',
    executable: { win32: '7DaysToDieServer.exe', linux: '7DaysToDieServer.x86_64' },
    buildLaunchArgs: (server) => ['-quit', '-batchmode', '-nographics', '-configfile=serverconfig.xml', '-dedicated', ...extraArgs(server)],
    stopStrategy: { kind: 'signal', signal: 'SIGINT' },
    needsExecuteBit: true,
    notes:
      'Everything is set in serverconfig.xml (File Management) — including ServerPort, which must match the port here. ' +
      'It also uses UDP 26901–26903. The world autosaves; stopping sends Ctrl+C.',
  },
  {
    id: 'satisfactory',
    label: 'Satisfactory',
    appId: '1690800',
    defaultPort: 7777,
    portProtocol: 'udp',
    executable: { win32: 'FactoryServer.exe', linux: 'FactoryServer.sh' },
    buildLaunchArgs: (server) => [`-Port=${server.server_port}`, '-log', '-unattended', ...extraArgs(server)],
    stopStrategy: { kind: 'signal', signal: 'SIGINT' },
    needsExecuteBit: true,
    notes:
      'Claim and configure the server from the game: Server Manager → Add Server → this host’s address. Uses UDP and TCP 7777. ' +
      'Saves autosave every few minutes.',
  },
  {
    id: 'unturned',
    label: 'Unturned',
    appId: '1110390',
    defaultPort: 27015,
    portProtocol: 'udp',
    executable: { win32: 'Unturned.exe', linux: 'ServerHelper.sh' },
    buildLaunchArgs: (server) => [
      ...(process.platform === 'win32' ? ['-batchmode', '-nographics'] : []),
      '+InternetServer/outpost',
      ...extraArgs(server),
    ],
    stopStrategy: { kind: 'stdin', commands: ['shutdown'], delayMs: 0 },
    needsExecuteBit: true,
    prepareInstance: (server) => {
      // Unturned reads its port from Servers/<name>/Server/Commands.dat — seed it from the instance's port once.
      const file = path.join(instanceDir(server.id), 'Servers', 'outpost', 'Server', 'Commands.dat');
      if (fs.existsSync(file)) return null;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `Port ${server.server_port}\nName ${server.name}\nMaxplayers 24\nPerspective Both\n`);
      return 'Wrote Servers/outpost/Server/Commands.dat (port, name, max players) — edit it in File Management.';
    },
    notes: 'Settings live in Servers/outpost/Server/Commands.dat (created on first start). Players connect on UDP 27015–27016.',
  },
  // ---- Arma ----
  {
    id: 'arma3',
    label: 'Arma 3',
    appId: '233780',
    defaultPort: 2302,
    portProtocol: 'udp',
    executable: { win32: 'arma3server_x64.exe', linux: 'arma3server_x64' },
    buildLaunchArgs: (server) => {
      const mods = activeWorkshopItems(server).filter((i) => i.folder).map((i) => i.folder!);
      return [
        `-port=${server.server_port}`,
        '-config=server.cfg',
        '-name=server',
        '-profiles=profiles',
        ...(mods.length ? [`-mod=${mods.join(';')}`] : []),
        ...extraArgs(server),
      ];
    },
    readyRegex: /Host identity created|Connected to Steam servers/i,
    stopStrategy: { kind: 'signal', signal: 'SIGINT' },
    needsExecuteBit: true,
    workshop: { appId: '107410', mode: 'arma', needsLogin: true },
    prepareInstance: (server) => {
      const cfg = path.join(instanceDir(server.id), 'server.cfg');
      if (fs.existsSync(cfg)) return null;
      fs.writeFileSync(
        cfg,
        [
          '// Outpost starter config — edit freely (File Management → server.cfg).',
          `hostname = "${server.name.replace(/"/g, "'")}";`,
          'password = "";            // set to make the server private',
          'passwordAdmin = "";       // #login <this> in chat to administer',
          'maxPlayers = 32;',
          'persistent = 1;',
          'verifySignatures = 2;     // only clients with matching mod keys (keys/) may join',
          'BattlEye = 1;',
          '',
        ].join('\n')
      );
      return 'Wrote a starter server.cfg';
    },
    notes:
      'Installing needs a Steam login (any account — anonymous downloads are refused for Arma 3). Workshop mods need an account that owns ' +
      'Arma 3. Players connect on UDP 2302–2306. Missions (.pbo) go in mpmissions/ and are picked in server.cfg.',
  },
  // ---- Call of Duty ----
  {
    id: 'bo3',
    label: 'Call of Duty: Black Ops III',
    appId: '545990',
    defaultPort: 27017,
    portProtocol: 'udp',
    windowsOnly: true,
    workingDir: 'UnrankedServer',
    executable: {
      win32: 'UnrankedServer/BlackOps3_UnrankedDedicatedServer.exe',
      linux: 'UnrankedServer/BlackOps3_UnrankedDedicatedServer.exe',
    },
    // The server only ships for Windows; on Linux steamcmd has to be told to fetch that build anyway.
    installFlags: ['+@sSteamCmdForcePlatformType', 'windows'],
    buildLaunchArgs: (server) => {
      const ws = workshopStateOf(server);
      const mod = ws.items.find((i) => i.kind === 'mod' && i.id === ws.activeMod && i.status === 'installed' && i.folder);
      const map = ws.items.find((i) => i.kind === 'map' && i.folder === ws.startMap && i.status === 'installed');
      return [
        '+set', 'net_port', String(server.server_port),
        '+set', 'live_steam_server_name', server.name,
        // Workshop maps live under usermaps/; a mod in mods/<folder> is loaded by its folder name instead.
        '+set', 'fs_game', mod ? mod.folder! : 'usermaps',
        '+set', 'logfile', '2',
        '+exec', 'server.cfg',
        ...(map ? ['+map', map.folder!] : []),
        ...extraArgs(server),
      ];
    },
    stopStrategy: { kind: 'stdin', commands: ['quit'], delayMs: 0 },
    needsExecuteBit: false,
    workshop: { appId: '311210', mode: 'bo3', needsLogin: true },
    prepareInstance: (server) => {
      const cfg = path.join(instanceDir(server.id), 'UnrankedServer', 'zone', 'server.cfg');
      if (fs.existsSync(cfg)) return null;
      fs.mkdirSync(path.dirname(cfg), { recursive: true });
      fs.writeFileSync(
        cfg,
        [
          '// Outpost starter config — edit freely (File Management → UnrankedServer/zone/server.cfg).',
          `set live_steam_server_description "Hosted with Outpost"`,
          'set com_maxclients "18"',
          'set g_password ""              // set to make the server private',
          'set rcon_password ""           // empty = RCON off',
          'set sv_skip_lobby "1"          // load the map straight away (needed for custom maps)',
          'set sv_maprotation "gametype tdm map mp_biodome map mp_spire map mp_sector map mp_apartments map mp_chinatown map mp_metro"',
          '',
        ].join('\n')
      );
      return 'Wrote a starter UnrankedServer/zone/server.cfg — edit it in File Management.';
    },
    notes:
      'The official unranked server: multiplayer only (Valve’s build can’t host Zombies). It’s a Windows program — on Linux, Outpost runs it ' +
      'with Wine, so install Wine first (e.g. "sudo apt install wine64"). Forward UDP and TCP 27017. Workshop maps and mods need a Steam ' +
      'account that owns Black Ops III — add them from the Workshop tab.',
  },
];

// RCON for games that take it on the command line. Source engine games use the game port over TCP.
const SRCDS_GAMES = new Set(['cs2', 'csgo', 'css', 'tf2', 'gmod', 'l4d2', 'hl2dm', 'dods']);
for (const p of STEAM_GAME_PRESETS) {
  if (SRCDS_GAMES.has(p.id)) {
    p.rcon ??= {
      protocol: 'source',
      port: (server) => server.server_port,
      launchArgs: (cfg) => ['+rcon_password', cfg.password],
      note: 'Source games answer RCON on the game port over TCP — keep the port the same as the server’s.',
    };
  }
  if (p.id === 'rust') {
    p.rcon = {
      protocol: 'webrcon',
      port: (server) => server.server_port + 1,
      launchArgs: (cfg) => ['+rcon.port', String(cfg.port), '+rcon.password', cfg.password, '+rcon.web', '1'],
    };
  }
  if (p.id === 'palworld') {
    p.rcon = {
      protocol: 'source',
      port: () => 25575,
      note: 'Also set RCONEnabled=True, RCONPort and AdminPassword (= this password) in Pal/Saved/Config/LinuxServer/PalWorldSettings.ini.',
    };
  }
}


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
