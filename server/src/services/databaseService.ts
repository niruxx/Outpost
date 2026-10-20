import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import { prep } from '../db/db.js';
import { HttpError } from '../utils/asyncHandler.js';
import { logger } from '../utils/logger.js';

/**
 * Per-server databases. Admins add MySQL/MariaDB "database hosts" (a server account that may create
 * databases and users); each instance can then create its own databases on them. Every database gets
 * its own user with rights on that database only. Deleting the database (or the instance) drops both.
 */

export interface DbHost {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
  /** Address shown to players/plugins when it differs from how the panel connects (e.g. a LAN IP). */
  publicHost: string;
  maxDatabases: number;
  createdAt: string;
}

export interface ServerDatabase {
  id: string;
  serverId: string;
  hostId: string;
  name: string;
  username: string;
  password: string;
  /** Where connections may come from ('%' = anywhere, or an IP / host). */
  remote: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------

const hostFromRow = (r: any): DbHost => ({ id: r.id, name: r.name, host: r.host, port: r.port, username: r.username, password: r.password, publicHost: r.public_host ?? '', maxDatabases: r.max_databases, createdAt: r.created_at });

export function listHosts(): DbHost[] {
  return (prep('SELECT * FROM db_hosts ORDER BY created_at').all() as any[]).map(hostFromRow);
}

export function getHost(id: string): DbHost | null {
  const r = prep('SELECT * FROM db_hosts WHERE id = ?').get(id);
  return r ? hostFromRow(r) : null;
}

export function publicHost(h: DbHost) {
  const count = (prep('SELECT COUNT(*) AS n FROM server_databases WHERE host_id = ?').get(h.id) as { n: number }).n;
  return { ...h, password: '', hasPassword: !!h.password, databases: count };
}

async function connect(h: Pick<DbHost, 'host' | 'port' | 'username' | 'password'>) {
  try {
    return await mysql.createConnection({ host: h.host, port: h.port, user: h.username, password: h.password, connectTimeout: 8000, multipleStatements: false });
  } catch (err) {
    const e = err as { code?: string; message?: string };
    throw new HttpError(
      502,
      e.code === 'ECONNREFUSED'
        ? `Nothing is listening on ${h.host}:${h.port}`
        : e.code === 'ER_ACCESS_DENIED_ERROR'
          ? 'The database server rejected that username or password'
          : `Couldn’t connect: ${e.message ?? String(err)}`
    );
  }
}

/** Connects and checks the account can create databases and users. */
export async function testHost(h: Pick<DbHost, 'host' | 'port' | 'username' | 'password'>): Promise<{ version: string }> {
  const conn = await connect(h);
  try {
    const [rows] = await conn.query('SELECT VERSION() AS v');
    const [grants] = await conn.query('SHOW GRANTS');
    const text = JSON.stringify(grants).toUpperCase();
    if (!/ALL PRIVILEGES ON \*\.\*|CREATE USER/.test(text)) throw new HttpError(400, 'This account can’t create users — give it ALL PRIVILEGES … WITH GRANT OPTION (or CREATE USER + CREATE + GRANT OPTION)');
    return { version: (rows as { v: string }[])[0].v };
  } finally {
    await conn.end().catch(() => {});
  }
}

const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export async function saveHost(input: Record<string, unknown>, id?: string): Promise<DbHost> {
  const prev = id ? getHost(id) : null;
  if (id && !prev) throw new HttpError(404, 'Database host not found');
  const host = str(input.host, 253) || prev?.host || '';
  if (!/^[A-Za-z0-9.\-:[\]]+$/.test(host)) throw new HttpError(400, 'Host must be a host name or IP');
  const port = Number(input.port ?? prev?.port ?? 3306);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, 'Port must be 1–65535');
  const username = str(input.username, 80) || prev?.username || '';
  const password = typeof input.password === 'string' && input.password ? input.password : prev?.password ?? '';
  if (!username) throw new HttpError(400, 'Username is required');
  const maxDatabases = Number(input.maxDatabases ?? prev?.maxDatabases ?? 0);
  if (!Number.isInteger(maxDatabases) || maxDatabases < 0) throw new HttpError(400, 'Max databases must be 0 (no limit) or more');
  const next: DbHost = {
    id: id ?? crypto.randomUUID(),
    name: str(input.name, 80) || prev?.name || host,
    host,
    port,
    username,
    password,
    publicHost: input.publicHost !== undefined ? str(input.publicHost, 253) : prev?.publicHost ?? '',
    maxDatabases,
    createdAt: prev?.createdAt ?? new Date().toISOString(),
  };
  await testHost(next);
  prep(
    `INSERT INTO db_hosts (id, name, host, port, username, password, public_host, max_databases, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, host = excluded.host, port = excluded.port, username = excluded.username, password = excluded.password, public_host = excluded.public_host, max_databases = excluded.max_databases`
  ).run(next.id, next.name, next.host, next.port, next.username, next.password, next.publicHost, next.maxDatabases, next.createdAt);
  return next;
}

export function deleteHost(id: string) {
  const n = (prep('SELECT COUNT(*) AS n FROM server_databases WHERE host_id = ?').get(id) as { n: number }).n;
  if (n) throw new HttpError(409, `${n} database(s) still live on this host — delete them from their instances first`);
  prep('DELETE FROM db_hosts WHERE id = ?').run(id);
}

// ---------------------------------------------------------------------------
// Per-server databases
// ---------------------------------------------------------------------------

const dbFromRow = (r: any): ServerDatabase => ({ id: r.id, serverId: r.server_id, hostId: r.host_id, name: r.name, username: r.username, password: r.password, remote: r.remote, createdAt: r.created_at });

export function listDatabases(serverId: string): ServerDatabase[] {
  return (prep('SELECT * FROM server_databases WHERE server_id = ? ORDER BY created_at').all(serverId) as any[]).map(dbFromRow);
}

const newPassword = () => crypto.randomBytes(18).toString('base64url');
const MAX_PER_SERVER = 10;

export async function createDatabase(serverId: string, input: { hostId?: unknown; name?: unknown; remote?: unknown }): Promise<ServerDatabase> {
  const hosts = listHosts();
  const host = typeof input.hostId === 'string' && input.hostId ? getHost(input.hostId) : hosts[0] ?? null;
  if (!host) throw new HttpError(400, 'No database host is set up — an admin adds one under Configuration → Databases');
  const suffix = str(input.name, 40).toLowerCase();
  if (!/^[a-z0-9_]{1,40}$/.test(suffix)) throw new HttpError(400, 'Database names use lowercase letters, digits and _');
  const remote = str(input.remote, 100) || '%';
  if (!/^[%A-Za-z0-9.\-:_]{1,100}$/.test(remote)) throw new HttpError(400, 'Allowed connections must be % (anywhere), an IP or a host name (wildcards with %)');
  if (listDatabases(serverId).length >= MAX_PER_SERVER) throw new HttpError(400, `At most ${MAX_PER_SERVER} databases per instance`);
  const onHost = (prep('SELECT COUNT(*) AS n FROM server_databases WHERE host_id = ?').get(host.id) as { n: number }).n;
  if (host.maxDatabases && onHost >= host.maxDatabases) throw new HttpError(400, `${host.name} is full (${host.maxDatabases} databases)`);

  const prefix = `s${serverId.replace(/-/g, '').slice(0, 8)}`;
  const name = `${prefix}_${suffix}`.slice(0, 64);
  if (listDatabases(serverId).some((d) => d.name === name)) throw new HttpError(409, 'This instance already has a database with that name');
  const username = `u${serverId.replace(/-/g, '').slice(0, 8)}_${crypto.randomBytes(3).toString('hex')}`;
  const password = newPassword();
  const conn = await connect(host);
  try {
    await conn.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    try {
      await conn.query('CREATE USER ?@? IDENTIFIED BY ?', [username, remote, password]);
      await conn.query(`GRANT ALL PRIVILEGES ON \`${name}\`.* TO ?@?`, [username, remote]);
    } catch (err) {
      await conn.query(`DROP DATABASE IF EXISTS \`${name}\``).catch(() => {});
      throw err;
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const e = err as { code?: string; message?: string };
    throw new HttpError(e.code === 'ER_DB_CREATE_EXISTS' ? 409 : 502, e.code === 'ER_DB_CREATE_EXISTS' ? `A database called ${name} already exists on ${host.name}` : `The database server said: ${e.message}`);
  } finally {
    await conn.end().catch(() => {});
  }
  const db: ServerDatabase = { id: crypto.randomUUID(), serverId, hostId: host.id, name, username, password, remote, createdAt: new Date().toISOString() };
  prep('INSERT INTO server_databases (id, server_id, host_id, name, username, password, remote, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    db.id,
    serverId,
    host.id,
    name,
    username,
    password,
    remote,
    db.createdAt
  );
  return db;
}

function getDatabase(serverId: string, id: string): ServerDatabase {
  const r = prep('SELECT * FROM server_databases WHERE id = ? AND server_id = ?').get(id, serverId);
  if (!r) throw new HttpError(404, 'Database not found');
  return dbFromRow(r);
}

export async function rotatePassword(serverId: string, id: string): Promise<ServerDatabase> {
  const db = getDatabase(serverId, id);
  const host = getHost(db.hostId);
  if (!host) throw new HttpError(409, 'Its database host was removed');
  const password = newPassword();
  const conn = await connect(host);
  try {
    await conn.query('ALTER USER ?@? IDENTIFIED BY ?', [db.username, db.remote, password]);
  } finally {
    await conn.end().catch(() => {});
  }
  prep('UPDATE server_databases SET password = ? WHERE id = ?').run(password, id);
  return { ...db, password };
}

export async function dropDatabase(serverId: string, id: string): Promise<ServerDatabase> {
  const db = getDatabase(serverId, id);
  const host = getHost(db.hostId);
  if (host) {
    const conn = await connect(host);
    try {
      await conn.query(`DROP DATABASE IF EXISTS \`${db.name}\``);
      await conn.query('DROP USER IF EXISTS ?@?', [db.username, db.remote]);
    } finally {
      await conn.end().catch(() => {});
    }
  }
  prep('DELETE FROM server_databases WHERE id = ?').run(id);
  return db;
}

/** When an instance is deleted: drop its databases (best effort — a host may be down). */
export async function dropAllForServer(serverId: string) {
  for (const db of listDatabases(serverId)) {
    await dropDatabase(serverId, db.id).catch((err) => {
      logger.warn(`Couldn’t drop database ${db.name} of deleted instance ${serverId}: ${err instanceof Error ? err.message : err}`);
      prep('DELETE FROM server_databases WHERE id = ?').run(db.id);
    });
  }
}

/** Connection details for the instance owner (JDBC URL included, for Minecraft plugins). */
export function connectionInfo(db: ServerDatabase) {
  const host = getHost(db.hostId);
  const address = host ? host.publicHost || host.host : 'unknown';
  const port = host?.port ?? 3306;
  return { ...db, host: address, port, hostName: host?.name ?? 'removed host', jdbc: `jdbc:mysql://${address}:${port}/${db.name}` };
}
