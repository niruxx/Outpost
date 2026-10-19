export type Role = 'admin' | 'moderator' | 'viewer';

export type ServerPermission =
  | 'power'
  | 'console'
  | 'files.read'
  | 'files.write'
  | 'backups.create'
  | 'backups.restore'
  | 'plugins'
  | 'players'
  | 'settings'
  | 'update'
  | 'launch'
  | 'network';

export interface PublicUser {
  id: string;
  username: string;
  role: Role;
  created_at: string;
  /** Two-factor sign-in is on for this account. */
  totp_enabled?: 0 | 1;
  /** Host firewall access (admins can always manage). */
  firewall?: FirewallAccess;
  /** Theme applied when this user signs in (an admin's choice); null = their own browser's choice. */
  theme?: string | null;
  serverAccess?: string[];
  /** serverId → explicit permission set, or null for the role's defaults */
  serverPermissions?: Record<string, ServerPermission[] | null>;
  /** This user's own creation policy, or null when it follows the role's default. */
  creationPolicy?: CreationPolicy | null;
  effectiveCreation?: EffectiveCreation;
  owned?: number;
}

export type CreatablePlatform = 'java' | 'bedrock' | 'steam';

export interface CreationPolicy {
  canCreate: boolean;
  platforms: CreatablePlatform[];
  /** 0 = no limit */
  maxInstances: number;
  /** 0 = no limit */
  maxMemoryMb: number;
  /** Container instances: none, catalog apps only, or any image. */
  containers: 'none' | 'catalog' | 'any';
  /** May mount the container engine socket (Portainer). */
  engineSocket: boolean;
}

export interface EffectiveCreation extends CreationPolicy {
  /** Every platform this user can create (admins also get custom + docker). */
  allowedPlatforms: string[];
  owned: number;
  fromRole: boolean;
}

export type Platform = 'java' | 'bedrock' | 'steam' | 'custom' | 'docker';
export type Loader = 'vanilla' | 'paper' | 'purpur' | 'spigot' | 'bedrock' | 'steam' | 'custom' | 'docker';

export const PLUGIN_CAPABLE_LOADERS: Loader[] = ['paper', 'purpur', 'spigot'];

/** Java/Bedrock instances have Minecraft features (players, ops, whitelist, maps, server.properties). */
export function isMinecraftPlatform(platform: Platform): boolean {
  return platform === 'java' || platform === 'bedrock';
}

/** Steam-platform servers have no Minecraft-specific players/operator/whitelist/map concept. */
export function isSteamPlatform(platform: Platform): boolean {
  return platform === 'steam';
}

export interface SteamGameOption {
  id: string;
  label: string;
  appId: string;
  defaultPort: number;
  portProtocol: 'tcp' | 'udp';
  notes: string | null;
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

export interface AutoRestartState {
  pendingAt: string | null;
  attempts: number;
}

export interface ServerRecord {
  id: string;
  name: string;
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
  steam_login: string;
  steam_extra_flags: string;
  /** JSON-encoded LaunchConfig; null = platform defaults. */
  launch_config: string | null;
  restart_policy: RestartPolicy;
  restart_delay_sec: number;
  restart_max_attempts: number;
  upnp_config: string | null;
  isolation: 'inherit' | 'off';
  docker_config: string | null;
  suspended: 0 | 1;
  suspended_reason: string | null;
  suspended_at: string | null;
  suspended_by: string | null;
}

export interface SystemSettings {
  steamcmdSource: string | null;
}

export interface ProcessStats {
  memoryMb: number | null;
  cpuPercent: number | null;
  diskReadBytes: number | null;
  diskWriteBytes: number | null;
  diskReadRate: number | null;
  diskWriteRate: number | null;
  /** Host-wide (all interfaces) — the kernel doesn't track network bytes per process. */
  netRxBytes: number | null;
  netTxBytes: number | null;
  netRxRate: number | null;
  netTxRate: number | null;
}

export interface RuntimeInfo {
  pid: number | null;
  uptimeMs: number;
  stats: ProcessStats;
}

export interface HostAddress {
  address: string;
  interface: string;
  family: 'IPv4' | 'IPv6';
}

export interface EndpointInfo {
  /** Link to the instance's web interface, for apps that have one. */
  webUrl: string | null;
  host: string;
  bindAddress: string;
  port: number;
  protocol: 'tcp' | 'udp';
  hostname: string;
  addresses: HostAddress[];
}

export interface PlayerInfo {
  name: string;
  online: boolean;
  op: boolean;
  whitelisted: boolean;
  banned: boolean;
}

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: string;
}

export interface BackupInfo {
  fileName: string;
  sizeBytes: number;
  createdAt: string;
}

export interface SnapshotEntry {
  path: string;
  size: number;
}

export interface SnapshotFileSide {
  exists: boolean;
  size: number;
  binary: boolean;
  text: string | null;
}

export interface BackupSchedule {
  server_id: string;
  cron_expression: string;
  retention_count: number;
  enabled: 0 | 1;
}

export interface VersionOption {
  version: string;
  build?: string;
  recommended?: boolean;
}

export interface PropertyEntry {
  key: string;
  value: string;
}

export interface SystemInfo {
  platform: string;
  platformLabel: string;
  arch: string;
  hostname: string;
  nodeVersion: string;
  java: { available: boolean; version: string | null };
  primaryAddress: string | null;
  osRelease?: string;
  addresses: HostAddress[];
  cpuCores: number;
  totalMemMb: number;
  uptimeSec: number;
}

export interface NodeInfo {
  hostname: string;
  platform: string;
  arch: string;
  instances: number;
  running: number;
}

export interface PanelNode {
  id: string;
  name: string;
  url: string;
  created_at: string;
  keyHint: string;
}

export interface TransferState {
  state: 'running' | 'done' | 'failed';
  nodeId: string;
  nodeName: string;
  bytesSent: number;
  startedAt: string;
  finishedAt: string | null;
  remoteServerId: string | null;
  sourceDeleted: boolean;
  error: string | null;
}

export interface WhitelistState {
  enabled: boolean;
  players: string[];
  running: boolean;
}

export interface InstalledPlugin {
  fileName: string;
  displayName: string;
  enabled: boolean;
  canToggle: boolean;
  sizeBytes: number;
  modifiedAt: string;
  detail: string | null;
}

export type AddonCatalog = 'plugin' | 'datapack' | 'bedrock';

export interface AddonProfile {
  kind: 'bukkit' | 'datapack' | 'bedrock' | 'bepinex' | 'pak';
  label: string;
  singular: string;
  folder: string;
  extensions: string[];
  catalog: AddonCatalog | null;
  notes: string[];
  warning: string | null;
}

export type AddonSupport = { supported: true; profile: AddonProfile } | { supported: false; reason: string };

export interface PluginSearchResult {
  slug: string;
  title: string;
  description: string;
  iconUrl: string | null;
  downloads: number;
  author: string;
  categories: string[];
  /** CurseForge results only */
  id?: number;
  className?: string | null;
  websiteUrl?: string | null;
  /** false when the author only allows downloads from CurseForge's own site */
  downloadable?: boolean;
}

export interface ResolvedPluginVersion {
  versionNumber: string;
  fileName: string;
  downloadUrl: string;
  sizeBytes: number;
  versionMismatchWarning: boolean;
}

export interface ResourcesInfo {
  runtime: RuntimeInfo | null;
  running: boolean;
  disk: { serverBytes: number; backupsBytes: number };
  host: { totalMemMb: number; freeMemMb: number; cpuCores: number; loadAvg: number | null };
}

export interface UpdateCheckResult {
  currentVersion: string;
  currentBuild: string | null;
  latestVersion: string | null;
  latestBuild: string | null;
  updateAvailable: boolean;
  note?: string;
}

export interface MapMeta {
  generatedAt: string;
  widthPx: number;
  heightPx: number;
  blocksPerPixel: number;
  minBlockX: number;
  minBlockZ: number;
  chunksRendered: number;
  regionsScanned: number;
}

export interface MapState {
  capable: boolean;
  meta: MapMeta | null;
}

export type StopSignal = 'SIGINT' | 'SIGTERM' | 'SIGQUIT' | 'SIGHUP';

export type StopConfig =
  | { kind: 'default' }
  | { kind: 'stdin'; commands: string[]; delayMs?: number }
  | { kind: 'signal'; signal: StopSignal }
  | { kind: 'script'; command: string };

export type RestartConfig = { kind: 'default' } | { kind: 'stdin'; commands: string[] } | { kind: 'script'; command: string };

export interface LaunchConfig {
  executable?: string;
  javaPath?: string;
  args?: string;
  useShell?: boolean;
  workingDir?: string;
  env?: { key: string; value: string }[];
  protocol?: 'tcp' | 'udp';
  readyPattern?: string;
  stop?: StopConfig;
  restart?: RestartConfig;
  stopTimeoutSec?: number;
  webUi?: WebUi;
}

export interface LaunchInfo {
  config: LaunchConfig;
  sandboxed?: boolean;
  preview: string | null;
  previewError: string | null;
  variables: Record<string, string>;
}

/** Light per-instance metrics returned alongside the instance list. */
export interface InstanceListMetrics {
  runtime: RuntimeInfo | null;
  playersOnline: number | null;
}

export interface HostMetrics {
  sampledAt: string;
  cpu: { percent: number | null; cores: number; model: string; loadAvg: [number, number, number] | null; perCore: number[] };
  memory: { totalMb: number; usedMb: number; availableMb: number; swapTotalMb: number | null; swapUsedMb: number | null };
  disk: { path: string; totalBytes: number | null; usedBytes: number | null; freeBytes: number | null; readRate: number | null; writeRate: number | null };
  network: { rxRate: number | null; txRate: number | null; rxTotal: number | null; txTotal: number | null };
  uptimeSec: number;
  panelUptimeSec: number;
}

export interface SystemMetrics {
  host: HostMetrics;
  instances: {
    total: number;
    running: number;
    starting: number;
    stopped: number;
    crashed: number;
    installing: number;
    suspended: number;
    memoryMb: number;
    cpuPercent: number;
  };
}

export type UpnpProtocol = 'TCP' | 'UDP' | 'BOTH';

export interface UpnpRule {
  id: string;
  label: string;
  protocol: UpnpProtocol;
  externalStart: number;
  externalEnd: number;
  internalStart: number;
  enabled: boolean;
}

export interface UpnpConfig {
  autoMap: boolean;
  leaseSeconds: number;
  rules: UpnpRule[];
}

export interface UpnpMappingState {
  externalPort: number;
  internalPort: number;
  protocol: 'TCP' | 'UDP';
  ok: boolean;
  error: string | null;
  at: string;
}

export interface UpnpGatewayInfo {
  gateway: {
    friendlyName: string;
    manufacturer: string | null;
    modelName: string | null;
    localAddress: string;
    controlUrl: string;
    discoveredAt: string;
  } | null;
  externalIp: string | null;
  routerMappings: { externalPort: number; internalPort: number; internalClient: string; protocol: string; description: string; enabled: boolean; leaseSeconds: number }[];
  error: string | null;
}

export interface PortMapping {
  host: number;
  container: number;
  protocol: 'tcp' | 'udp';
}

export interface DockerConfig {
  image: string;
  ports: PortMapping[];
  env: { key: string; value: string }[];
  dataPath: string;
  cpus: number | null;
  command: string;
  runAsPanelUser: boolean;
  volumes: { subdir: string; containerPath: string }[];
  webUi: WebUi | null;
  mountEngineSocket: boolean;
  category: 'game' | 'app' | 'container';
  icon: string | null;
  template: string | null;
}

export interface WebUi {
  port: number;
  scheme: 'http' | 'https';
  path: string;
}

export interface EngineStatus {
  available: boolean;
  engine: 'docker' | 'podman' | null;
  version: string | null;
  rootless: boolean;
  error: string | null;
  hint: string | null;
}

export interface DockerOverview {
  engine: EngineStatus;
  counts: { containers: number; running: number; images: number } | null;
  containers: { name: string; status: string; image: string; instanceId: string }[];
  socket: { path: string | null; hint: string | null } | null;
}

export interface SandboxStatus {
  available: boolean;
  version: string | null;
  reason: string | null;
  enabled: boolean;
}

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

export type NotifyEvent = 'server.started' | 'server.stopped' | 'server.crashed' | 'server.restart_gave_up' | 'backup.failed' | 'task.failed';

export interface Webhook {
  id: string;
  name: string;
  url: string;
  events: NotifyEvent[];
  /** null = every instance */
  serverIds: string[] | null;
  enabled: boolean;
  createdAt: string;
}

export interface AuditEntry {
  id: number;
  userId: string | null;
  username: string | null;
  action: string;
  target: string | null;
  targetLabel: string | null;
  targetKind: 'server' | 'user' | 'webhook' | null;
  detail: string | null;
  at: string;
}

export interface TwoFactorStatus {
  enabled: boolean;
  recoveryCodesLeft: number;
}

export type FirewallAccess = 'none' | 'view' | 'instances' | 'manage';

export interface FirewallRule {
  id: string;
  action: 'allow' | 'deny' | 'reject' | 'limit';
  port: string | null;
  protocol: 'tcp' | 'udp' | 'any';
  source: string | null;
  label: string | null;
  comment: string | null;
  direction: 'in' | 'out';
}

export interface FirewallStatus {
  available: boolean;
  backend: 'ufw' | 'firewalld' | null;
  reason: string | null;
  sudoersHint: string | null;
  active: boolean;
  defaults: string | null;
  zone: string | null;
  rules: FirewallRule[];
  protectedPorts: { port: number; protocol: 'tcp'; why: string }[];
  canToggle: boolean;
}

export interface FirewallInstancePort {
  serverId: string;
  name: string;
  port: number;
  protocol: 'tcp' | 'udp';
  open: boolean;
}
