export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'moderator', 'viewer')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  creation TEXT, -- JSON CreationPolicy: may this user create instances, which kinds, how many; NULL = role default
  totp_secret TEXT, -- base32 TOTP secret; set (but not yet enabled) while 2FA is being set up
  totp_enabled BOOLEAN NOT NULL DEFAULT 0,
  totp_last_step INTEGER NOT NULL DEFAULT 0, -- last accepted time step, so a code can't be replayed
  totp_recovery TEXT, -- JSON array of SHA-256 hashes of unused recovery codes
  firewall TEXT NOT NULL DEFAULT 'none', -- host firewall access: none | view | instances | manage (admins: always manage)
  storage TEXT NOT NULL DEFAULT '[]', -- JSON host storage permissions; admins have all by default
  theme TEXT -- UI theme applied when this user signs in (an admin's choice); NULL = whatever their browser last used
);

-- Non-admin users can be restricted to specific servers. Admins always see everything.
CREATE TABLE IF NOT EXISTS user_server_access (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  config_access TEXT, -- JSON per-item allow/deny overrides; NULL = inherit
  permissions TEXT, -- JSON array of ServerPermission; NULL = the role's defaults
  PRIMARY KEY (user_id, server_id)
);

CREATE TABLE IF NOT EXISTS servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  backup_directory TEXT, -- custom backup base directory; NULL = default snapshots/rewind paths
  platform TEXT NOT NULL, -- java | bedrock | steam (validated at the application layer, like loader)
  loader TEXT NOT NULL, -- vanilla | paper | purpur | spigot | bedrock | steam
  version TEXT NOT NULL,
  build TEXT,
  jar_file TEXT,
  min_memory_mb INTEGER NOT NULL DEFAULT 1024,
  max_memory_mb INTEGER NOT NULL DEFAULT 2048,
  server_port INTEGER NOT NULL DEFAULT 25565,
  extra_java_args TEXT NOT NULL DEFAULT '',
  extra_args TEXT NOT NULL DEFAULT '',
  auto_start BOOLEAN NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'installing',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT REFERENCES users(id),
  steam_app_id TEXT, -- Steam App ID actually installed, for platform = 'steam' servers
  steam_preset TEXT, -- curated preset id (several presets can share an App ID, e.g. CS 1.6 / Condition Zero)
  workshop TEXT, -- JSON WorkshopState: Steam Workshop items, active mod/map, download login
  rewind_config TEXT, -- JSON RewindConfig: automatic Minecraft world restore points
  rcon_config TEXT, -- JSON RconConfig: RCON console settings (password included — never sent to browsers)
  auto_update TEXT, -- JSON AutoUpdateConfig: scheduled update checks
  status_page TEXT, -- JSON StatusPageConfig: public status page
  modpack TEXT, -- JSON ModpackRef: the Modrinth modpack it was made from
  limits TEXT, -- JSON Limits: CPU / memory / process / disk caps
  game_settings TEXT, -- JSON per-game settings (CS2 tab: mode, map, presets, cvars)
  steam_login TEXT NOT NULL DEFAULT 'anonymous', -- raw value passed after "+login" (e.g. "anonymous" or "user pass")
  steam_extra_flags TEXT NOT NULL DEFAULT '', -- extra steamcmd CLI flags spliced into the install/update invocation
  launch_config TEXT,
  restart_policy TEXT NOT NULL DEFAULT 'never', -- never | on-crash | always
  restart_delay_sec INTEGER NOT NULL DEFAULT 10,
  restart_max_attempts INTEGER NOT NULL DEFAULT 0, -- 0 = unlimited
  upnp_config TEXT, -- JSON UpnpConfig: router port-mapping rules
  isolation TEXT NOT NULL DEFAULT 'inherit', -- inherit | off (admin opt-out of the process sandbox)
  docker_config TEXT, -- JSON DockerConfig for platform = 'docker' -- JSON LaunchConfig: executable/args/env/stop/restart overrides (required for platform = 'custom')
  suspended BOOLEAN NOT NULL DEFAULT 0,
  suspended_reason TEXT,
  suspended_at TEXT,
  suspended_by TEXT
);

-- Other Outpost panels this one can transfer instances to. api_key is the remote panel's
-- node key (shown on its Configuration page) and has to be stored as-is to call that panel.
CREATE TABLE IF NOT EXISTS db_hosts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  username TEXT NOT NULL,
  password TEXT NOT NULL, -- never sent to browsers
  public_host TEXT,
  max_databases INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS server_databases (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  name TEXT NOT NULL,
  username TEXT NOT NULL,
  password TEXT NOT NULL,
  remote TEXT NOT NULL DEFAULT '%',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  hint TEXT NOT NULL, -- first characters, to recognise it
  hash TEXT NOT NULL UNIQUE, -- sha256 of the key; the key itself is never stored
  read_only INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS offsite_destinations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL, -- s3 | sftp
  enabled INTEGER NOT NULL DEFAULT 1,
  keep INTEGER NOT NULL DEFAULT 7, -- copies kept per instance (0 = all)
  config TEXT NOT NULL, -- JSON; holds credentials, never sent to browsers
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS offsite_copies (
  server_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (server_id, file_name, destination_id)
);

CREATE TABLE IF NOT EXISTS sftp_credentials (
  user_id TEXT PRIMARY KEY,
  password_hash TEXT, -- separate from the panel password, so SFTP can't sidestep 2FA
  password_salt TEXT,
  public_keys TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL,
  data TEXT NOT NULL, -- the full OutpostTemplate JSON
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Simple global key/value settings, admin-editable (e.g. where to source the SteamCMD tarball
-- from). Lives in the same SQLite file as everything else, so it's automatically included in the
-- existing "export the whole environment" backup/restore feature with no extra code.
CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backup_schedules (
  server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  cron_expression TEXT NOT NULL,
  retention_count INTEGER NOT NULL DEFAULT 5,
  enabled BOOLEAN NOT NULL DEFAULT 1
);

-- Per-instance scheduled tasks (console commands, restarts, starts, stops) on a cron schedule.
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  cron_expression TEXT NOT NULL,
  action TEXT NOT NULL, -- command | restart | start | stop
  command TEXT NOT NULL DEFAULT '', -- console command for action = 'command'
  warn_command TEXT NOT NULL DEFAULT '', -- restart/stop: console command sent first (e.g. a "say" warning)
  warn_seconds INTEGER NOT NULL DEFAULT 0, -- …and how long to wait after it
  enabled BOOLEAN NOT NULL DEFAULT 1,
  last_run_at TEXT,
  last_result TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Outgoing notifications (Discord or any JSON webhook) for instance and backup events.
CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  events TEXT NOT NULL, -- JSON array of NotifyEvent
  server_ids TEXT, -- JSON array of instance ids; NULL = every instance
  enabled BOOLEAN NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  username TEXT,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  ip TEXT, -- the client's address (and X-Forwarded-For, when a proxy sent one)
  user_agent TEXT -- the client's browser / tool
);
CREATE TABLE IF NOT EXISTS vm_access (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  uri TEXT NOT NULL,
  uuid TEXT NOT NULL,
  permissions TEXT NOT NULL,
  PRIMARY KEY (user_id, uri, uuid)
);
CREATE INDEX IF NOT EXISTS audit_log_created_at ON audit_log (created_at);

-- Server-browser (A2S) player counts, sampled once a minute while a Steam instance runs.
CREATE TABLE IF NOT EXISTS player_samples (
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  at INTEGER NOT NULL, -- unix ms
  players INTEGER NOT NULL,
  max_players INTEGER,
  bots INTEGER,
  PRIMARY KEY (server_id, at)
);
`;
