import type { DatabaseSync } from 'node:sqlite';
import { logger } from '../utils/logger.js';

/**
 * Runs idempotent schema migrations against an already-open database (after SCHEMA_SQL has run).
 * `CREATE TABLE IF NOT EXISTS` never touches an existing table, so any change to an existing
 * table's shape needs an explicit, guarded migration step here. Each step checks whether it's
 * already been applied before doing anything, so this is safe to call on every startup.
 */
export function runMigrations(db: DatabaseSync): void {
  addSteamAppIdColumn(db);
  dropPlatformCheckConstraint(db);
  addSteamCmdColumns(db);
  addSuspensionColumns(db);
  addAccessPermissionsColumn(db);
  addLaunchConfigColumn(db);
  addRestartAndUpnpColumns(db);
  addIsolationColumn(db);
  addCreationPolicyColumn(db);
  grantCreatorsOwnerAccess(db);
  addTotpColumns(db);
  addFirewallColumn(db);
  addSteamPresetColumn(db);
  addUserThemeColumn(db);
  addWorkshopColumn(db);
  addAuditClientColumns(db);
  addRewindColumn(db);
  addRconAndAutoUpdateColumns(db);
}

function addRconAndAutoUpdateColumns(db: DatabaseSync): void {
  for (const col of ['rcon_config', 'auto_update', 'status_page', 'modpack', 'limits']) {
    if (db.prepare(`SELECT 1 FROM pragma_table_info('servers') WHERE name = '${col}'`).get()) continue;
    logger.info(`Migrating database: adding servers.${col} column`);
    db.exec(`ALTER TABLE servers ADD COLUMN ${col} TEXT`);
  }
}

function addRewindColumn(db: DatabaseSync): void {
  if (db.prepare("SELECT 1 FROM pragma_table_info('servers') WHERE name = 'rewind_config'").get()) return;
  logger.info('Migrating database: adding servers.rewind_config column');
  db.exec('ALTER TABLE servers ADD COLUMN rewind_config TEXT');
}

function addAuditClientColumns(db: DatabaseSync): void {
  if (db.prepare("SELECT 1 FROM pragma_table_info('audit_log') WHERE name = 'ip'").get()) return;
  logger.info('Migrating database: adding ip and user_agent to audit_log');
  db.exec('ALTER TABLE audit_log ADD COLUMN ip TEXT');
  db.exec('ALTER TABLE audit_log ADD COLUMN user_agent TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS audit_log_created_at ON audit_log (created_at)');
}

function addWorkshopColumn(db: DatabaseSync): void {
  if (db.prepare("SELECT 1 FROM pragma_table_info('servers') WHERE name = 'workshop'").get()) return;
  logger.info('Migrating database: adding servers.workshop column');
  db.exec('ALTER TABLE servers ADD COLUMN workshop TEXT');
}

function addUserThemeColumn(db: DatabaseSync): void {
  if (db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = 'theme'").get()) return;
  logger.info('Migrating database: adding users.theme column');
  db.exec('ALTER TABLE users ADD COLUMN theme TEXT');
}

function addSteamPresetColumn(db: DatabaseSync): void {
  if (db.prepare("SELECT 1 FROM pragma_table_info('servers') WHERE name = 'steam_preset'").get()) return;
  logger.info('Migrating database: adding servers.steam_preset column');
  db.exec('ALTER TABLE servers ADD COLUMN steam_preset TEXT');
}

function addFirewallColumn(db: DatabaseSync): void {
  if (db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = 'firewall'").get()) return;
  logger.info('Migrating database: adding users.firewall column');
  db.exec("ALTER TABLE users ADD COLUMN firewall TEXT NOT NULL DEFAULT 'none'");
}

function addTotpColumns(db: DatabaseSync): void {
  if (db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = 'totp_secret'").get()) return;
  logger.info('Migrating database: adding two-factor columns to users');
  db.exec('ALTER TABLE users ADD COLUMN totp_secret TEXT');
  db.exec('ALTER TABLE users ADD COLUMN totp_enabled BOOLEAN NOT NULL DEFAULT 0');
  db.exec('ALTER TABLE users ADD COLUMN totp_last_step INTEGER NOT NULL DEFAULT 0');
  db.exec('ALTER TABLE users ADD COLUMN totp_recovery TEXT');
}

/**
 * One-time: instances created by non-admins before ownership existed never gave their creator
 * access (they couldn't even see them). Give each creator owner access once; flagged so an admin
 * removing that access later isn't undone on the next start.
 */
function grantCreatorsOwnerAccess(db: DatabaseSync): void {
  const flag = 'migration_owner_access_v1';
  if (db.prepare('SELECT 1 FROM system_settings WHERE key = ?').get(flag)) return;
  const ownerPermissions = JSON.stringify([
    'power', 'console', 'files.read', 'files.write', 'backups.create', 'backups.restore', 'plugins', 'players', 'settings', 'update',
  ]);
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO user_server_access (user_id, server_id, permissions)
       SELECT s.created_by, s.id, ? FROM servers s JOIN users u ON u.id = s.created_by WHERE u.role != 'admin'`
    )
    .run(ownerPermissions);
  if (Number(result.changes) > 0) logger.info(`Migrating database: gave ${result.changes} instance creator(s) owner access`);
  db.prepare('INSERT INTO system_settings (key, value) VALUES (?, ?)').run(flag, new Date().toISOString());
}

function addCreationPolicyColumn(db: DatabaseSync): void {
  if (db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = 'creation'").get()) return;
  logger.info('Migrating database: adding users.creation column');
  db.exec('ALTER TABLE users ADD COLUMN creation TEXT');
}

function addIsolationColumn(db: DatabaseSync): void {
  const has = db.prepare("SELECT 1 FROM pragma_table_info('servers') WHERE name = 'isolation'").get();
  if (!has) {
    logger.info('Migrating database: adding servers.isolation column');
    db.exec("ALTER TABLE servers ADD COLUMN isolation TEXT NOT NULL DEFAULT 'inherit'");
  }
  if (!db.prepare("SELECT 1 FROM pragma_table_info('servers') WHERE name = 'docker_config'").get()) {
    logger.info('Migrating database: adding servers.docker_config column');
    db.exec('ALTER TABLE servers ADD COLUMN docker_config TEXT');
  }
}

function addRestartAndUpnpColumns(db: DatabaseSync): void {
  const has = (col: string) => db.prepare("SELECT 1 FROM pragma_table_info('servers') WHERE name = ?").get(col);
  if (!has('restart_policy')) {
    logger.info('Migrating database: adding auto-restart columns');
    db.exec("ALTER TABLE servers ADD COLUMN restart_policy TEXT NOT NULL DEFAULT 'never'");
    db.exec('ALTER TABLE servers ADD COLUMN restart_delay_sec INTEGER NOT NULL DEFAULT 10');
    db.exec('ALTER TABLE servers ADD COLUMN restart_max_attempts INTEGER NOT NULL DEFAULT 0');
  }
  if (!has('upnp_config')) {
    logger.info('Migrating database: adding servers.upnp_config column');
    db.exec('ALTER TABLE servers ADD COLUMN upnp_config TEXT');
  }
}

function addLaunchConfigColumn(db: DatabaseSync): void {
  const hasColumn = db.prepare("SELECT 1 FROM pragma_table_info('servers') WHERE name = 'launch_config'").get();
  if (hasColumn) return;
  logger.info('Migrating database: adding servers.launch_config column');
  db.exec('ALTER TABLE servers ADD COLUMN launch_config TEXT');
}

function addAccessPermissionsColumn(db: DatabaseSync): void {
  const hasColumn = db.prepare("SELECT 1 FROM pragma_table_info('user_server_access') WHERE name = 'permissions'").get();
  if (hasColumn) return;
  logger.info('Migrating database: adding user_server_access.permissions column');
  db.exec('ALTER TABLE user_server_access ADD COLUMN permissions TEXT');
}

function addSuspensionColumns(db: DatabaseSync): void {
  const hasColumn = db.prepare("SELECT 1 FROM pragma_table_info('servers') WHERE name = 'suspended'").get();
  if (hasColumn) return;
  logger.info('Migrating database: adding servers suspension columns');
  db.exec('ALTER TABLE servers ADD COLUMN suspended BOOLEAN NOT NULL DEFAULT 0');
  db.exec('ALTER TABLE servers ADD COLUMN suspended_reason TEXT');
  db.exec('ALTER TABLE servers ADD COLUMN suspended_at TEXT');
  db.exec('ALTER TABLE servers ADD COLUMN suspended_by TEXT');
}

function addSteamAppIdColumn(db: DatabaseSync): void {
  const hasColumn = db.prepare("SELECT 1 FROM pragma_table_info('servers') WHERE name = 'steam_app_id'").get();
  if (hasColumn) return;
  logger.info('Migrating database: adding servers.steam_app_id column');
  db.exec('ALTER TABLE servers ADD COLUMN steam_app_id TEXT');
}

function addSteamCmdColumns(db: DatabaseSync): void {
  const hasLogin = db.prepare("SELECT 1 FROM pragma_table_info('servers') WHERE name = 'steam_login'").get();
  if (!hasLogin) {
    logger.info("Migrating database: adding servers.steam_login column");
    db.exec("ALTER TABLE servers ADD COLUMN steam_login TEXT NOT NULL DEFAULT 'anonymous'");
  }
  const hasFlags = db.prepare("SELECT 1 FROM pragma_table_info('servers') WHERE name = 'steam_extra_flags'").get();
  if (!hasFlags) {
    logger.info('Migrating database: adding servers.steam_extra_flags column');
    db.exec("ALTER TABLE servers ADD COLUMN steam_extra_flags TEXT NOT NULL DEFAULT ''");
  }
}

// SQLite can't ALTER a CHECK constraint in place — the only way to loosen one is to rebuild the
// table. Older installs have `platform TEXT NOT NULL CHECK (platform IN ('java', 'bedrock'))`,
// which rejects the new 'steam' platform. Detect that by reading the table's live DDL text.
function dropPlatformCheckConstraint(db: DatabaseSync): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'servers'").get() as
    | { sql: string }
    | undefined;
  if (!row || !/CHECK\s*\(\s*platform\s+IN/i.test(row.sql)) return;

  logger.info('Migrating database: dropping the platform CHECK constraint on servers (rebuilding table)');
  // PRAGMA foreign_keys is a no-op inside a transaction, so it must be toggled outside one —
  // otherwise DROP TABLE servers_old would fail against user_server_access's FK reference.
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('ALTER TABLE servers RENAME TO servers_old');
      db.exec(`
        CREATE TABLE servers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          platform TEXT NOT NULL,
          loader TEXT NOT NULL,
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
          steam_app_id TEXT
        )
      `);
      db.exec(`
        INSERT INTO servers
          (id, name, platform, loader, version, build, jar_file, min_memory_mb, max_memory_mb,
           server_port, extra_java_args, extra_args, auto_start, status, created_at, created_by, steam_app_id)
        SELECT
          id, name, platform, loader, version, build, jar_file, min_memory_mb, max_memory_mb,
          server_port, extra_java_args, extra_args, auto_start, status, created_at, created_by, steam_app_id
        FROM servers_old
      `);
      db.exec('DROP TABLE servers_old');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  logger.info('Migration complete: servers.platform no longer restricted by a CHECK constraint');
}
