export type Role = 'admin' | 'moderator' | 'viewer';

export interface User {
  id: string;
  username: string;
  password_hash: string;
  password_salt: string;
  role: Role;
  created_at: string;
  /** JSON CreationPolicy (services/userService.ts); NULL = the role's default. */
  creation: string | null;
  totp_secret: string | null;
  totp_enabled: 0 | 1;
  totp_last_step: number;
  totp_recovery: string | null;
  firewall: FirewallAccess;
  storage: string;
  /** UI theme applied at sign-in (set by an admin); null = the browser's own choice. */
  theme: string | null;
}

/** What a user may do with the host firewall. Admins can always do everything. */
export type FirewallAccess = 'none' | 'view' | 'instances' | 'manage';

export type StoragePermission = 'view' | 'mount' | 'automount' | 'format' | 'wipe' | 'partition' | 'encrypt' | 'lvm' | 'resize' | 'raid' | 'migrate' | 'crypttab' | 'health' | 'erase';
export type PublicUser = Omit<User, 'password_hash' | 'password_salt' | 'totp_secret' | 'totp_last_step' | 'totp_recovery' | 'storage'> & { storagePermissions: StoragePermission[]; vmAccess: import('../services/vmAccessService.js').VmGrant[] };

export type TaskAction = 'command' | 'restart' | 'start' | 'stop';

export interface ScheduledTask {
  id: string;
  server_id: string;
  name: string;
  cron_expression: string;
  action: TaskAction;
  command: string;
  warn_command: string;
  warn_seconds: number;
  enabled: 0 | 1;
  last_run_at: string | null;
  last_result: string | null;
  created_at: string;
}

export type Platform = 'java' | 'bedrock' | 'steam' | 'custom' | 'docker';
export type Loader =
  | 'vanilla'
  | 'paper'
  | 'purpur'
  | 'spigot'
  | 'fabric'
  | 'quilt'
  | 'forge'
  | 'neoforge'
  | 'mohist'
  | 'spongeforge'
  | 'velocity'
  | 'waterfall'
  | 'bungeecord'
  | 'bedrock'
  | 'steam'
  | 'custom'
  | 'docker';

/** Loaders that support the Bukkit plugin API (a /plugins directory of jars). */
export const PLUGIN_CAPABLE_LOADERS: Loader[] = ['paper', 'purpur', 'spigot'];

/** Minecraft proxies: they sit in front of other Java servers and have no world of their own. */
export const PROXY_LOADERS: Loader[] = ['velocity', 'waterfall', 'bungeecord'];
export const isProxyLoader = (loader: string): boolean => (PROXY_LOADERS as string[]).includes(loader);

/** Every loader the API accepts when creating an instance. */
export const ALL_LOADERS: Loader[] = [
  'vanilla', 'paper', 'purpur', 'spigot', 'fabric', 'quilt', 'forge', 'neoforge', 'mohist', 'spongeforge',
  'velocity', 'waterfall', 'bungeecord', 'bedrock', 'steam', 'custom', 'docker',
];

/** Steam-platform servers (Palworld, Valheim, etc.) have no Minecraft-specific concept of
 *  players/operators/whitelist/world maps — those tabs and routes are hidden/rejected for them. */
/** Java/Bedrock instances have Minecraft features (players, ops, whitelist, maps, server.properties). */
export function isMinecraftPlatform(platform: Platform): boolean {
  return platform === 'java' || platform === 'bedrock';
}

export function isSteamPlatform(platform: Platform): boolean {
  return platform === 'steam';
}

export type ServerStatus =
  | 'installing'
  | 'install_failed'
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'crashed'
  | 'updating'
  | 'transferring';

export type RestartPolicy = 'never' | 'on-crash' | 'always';

export interface ServerRecord {
  id: string;
  name: string;
  backup_directory: string | null;
  platform: Platform;
  loader: Loader;
  version: string;
  build: string | null;
  jar_file: string | null;
  min_memory_mb: number;
  max_memory_mb: number;
  server_port: number;
  extra_java_args: string;
  extra_args: string;
  auto_start: 0 | 1;
  status: ServerStatus;
  created_at: string;
  created_by: string | null;
  steam_app_id: string | null;
  /** Curated preset id (STEAM_GAME_PRESETS); null for custom App IDs and older instances. */
  steam_preset: string | null;
  /** JSON WorkshopState (services/workshopState.ts) — Steam Workshop items and settings. */
  workshop: string | null;
  /** JSON RewindConfig (services/rewindService.ts) — automatic world restore points. */
  rewind_config: string | null;
  /** JSON RconConfig (services/rconService.ts). Holds the RCON password — never send raw to browsers. */
  rcon_config: string | null;
  /** JSON AutoUpdateConfig (services/autoUpdateService.ts). */
  auto_update: string | null;
  /** JSON StatusPageConfig (services/statusPageService.ts). */
  status_page: string | null;
  /** JSON ModpackRef (services/moddedService.ts) when the instance was made from a Modrinth modpack. */
  modpack: string | null;
  /** JSON Limits (services/limitsService.ts). */
  limits: string | null;
  /** JSON per-game settings (services/cs2Service.ts for Counter-Strike 2). */
  game_settings: string | null;
  steam_login: string;
  steam_extra_flags: string;
  /** Admin-imposed lock (non-payment, TOS violation, …): stopped, can't be started, and only
   *  admins can see or manage it through the panel/API until it's lifted. */
  /** JSON-encoded LaunchConfig (see services/launchConfig.ts); null = platform defaults. */
  launch_config: string | null;
  /** Restart automatically when the process exits on its own: never, only after a crash, or always. */
  restart_policy: RestartPolicy;
  restart_delay_sec: number;
  /** 0 = keep trying forever. */
  restart_max_attempts: number;
  /** JSON-encoded UpnpConfig (see services/upnpService.ts); null = not configured. */
  upnp_config: string | null;
  /** 'inherit' = sandboxed when the panel's sandbox is on; 'off' = admin opt-out for this instance. */
  isolation: 'inherit' | 'off';
  /** JSON-encoded DockerConfig (services/containerService.ts) for platform = 'docker'. */
  docker_config: string | null;
  suspended: 0 | 1;
  suspended_reason: string | null;
  suspended_at: string | null;
  suspended_by: string | null;
}

export interface BackupSchedule {
  server_id: string;
  cron_expression: string;
  retention_count: number;
  enabled: 0 | 1;
}

export interface AuthTokenPayload {
  sub: string; // user id
  username: string;
  role: Role;
  iat: number;
  exp: number;
  /** Set when the request was made with a personal API key instead of a sign-in. */
  apiKey?: { id: string; name: string; readOnly: boolean };
}

export interface PlayerInfo {
  name: string;
  online: boolean;
  op: boolean;
  whitelisted: boolean;
  banned: boolean;
}
