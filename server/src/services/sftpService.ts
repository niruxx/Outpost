import fs from 'node:fs';
import { protectionEnabled, stageFile, discardStage, scanUploadBuffers } from './antivirusService.js';
import { assertDiskRoom } from './limitsService.js';
import path from 'node:path';
import crypto from 'node:crypto';
import ssh2 from 'ssh2';
import type { Connection, AuthContext, SFTPWrapper, Attributes } from 'ssh2';
import { prep } from '../db/db.js';
import { DATA_DIR, instanceDir, safeJoinReal } from '../utils/paths.js';
import { HttpError } from '../utils/asyncHandler.js';
import { logger } from '../utils/logger.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { getSetting, setSetting } from './systemSettingsService.js';
import { getServerPermissions, getUserByUsername, logAudit } from './userService.js';
import { fileChange, renameChange, snapshotFile, type FileSnapshot } from './fileChangeService.js';
import { listServers } from './serverService.js';
import type { ServerRecord } from '../types/index.js';

const { Server, utils } = ssh2;
const STATUS = utils.sftp.STATUS_CODE;
const OPEN = utils.sftp.OPEN_MODE;

/**
 * Built-in SFTP: each login is scoped to one instance's folder.
 *
 *   username  <panel user>.<first 8 characters of the instance id>
 *   password  the user's SFTP password (separate from the panel one, so SFTP can't bypass 2FA)
 *   or a public key the user added
 *
 * Reading needs the "View files" permission on the instance; changing anything needs "Edit files"
 * (admins have both). Every path is resolved inside the instance folder (symlinks can't escape).
 */

export const SETTING_SFTP_ENABLED = 'sftp_enabled';
export const SETTING_SFTP_PORT = 'sftp_port';
const HOST_KEY = path.join(DATA_DIR, 'sftp_host_ed25519');

export interface SftpSettings {
  enabled: boolean;
  port: number;
}

export function sftpSettings(): SftpSettings {
  const port = Number(getSetting(SETTING_SFTP_PORT));
  return { enabled: getSetting(SETTING_SFTP_ENABLED) === 'on', port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 2022 };
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

interface CredRow {
  user_id: string;
  password_hash: string | null;
  password_salt: string | null;
  public_keys: string;
}

function credsOf(userId: string): CredRow | null {
  return (prep('SELECT * FROM sftp_credentials WHERE user_id = ?').get(userId) as CredRow | undefined) ?? null;
}

function saveCreds(row: CredRow) {
  prep(
    `INSERT INTO sftp_credentials (user_id, password_hash, password_salt, public_keys, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET password_hash = excluded.password_hash, password_salt = excluded.password_salt, public_keys = excluded.public_keys, updated_at = excluded.updated_at`
  ).run(row.user_id, row.password_hash, row.password_salt, row.public_keys, new Date().toISOString());
}

export interface PublicKeyInfo {
  type: string;
  fingerprint: string;
  comment: string;
}

function keysOf(row: CredRow | null): string[] {
  try {
    return row ? (JSON.parse(row.public_keys) as string[]) : [];
  } catch {
    return [];
  }
}

function describeKey(line: string): PublicKeyInfo | null {
  const parsed = utils.parseKey(line);
  if (parsed instanceof Error || Array.isArray(parsed)) return null;
  const fp = crypto.createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '');
  return { type: parsed.type, fingerprint: `SHA256:${fp}`, comment: parsed.comment || line.trim().split(/\s+/)[2] || '' };
}

export function myCredentials(userId: string): { hasPassword: boolean; keys: PublicKeyInfo[] } {
  const row = credsOf(userId);
  return { hasPassword: !!row?.password_hash, keys: keysOf(row).map(describeKey).filter((k): k is PublicKeyInfo => !!k) };
}

export function setSftpPassword(userId: string, password: string | null) {
  const row = credsOf(userId) ?? { user_id: userId, password_hash: null, password_salt: null, public_keys: '[]' };
  if (password === null) {
    row.password_hash = null;
    row.password_salt = null;
  } else {
    if (password.length < 10) throw new HttpError(400, 'Use at least 10 characters for the SFTP password');
    const { hash, salt } = hashPassword(password);
    row.password_hash = hash;
    row.password_salt = salt;
  }
  saveCreds(row);
}

export function addPublicKey(userId: string, line: string): PublicKeyInfo {
  const clean = line.trim().replace(/\s+/g, ' ');
  const info = clean.length < 4000 ? describeKey(clean) : null;
  if (!info) throw new HttpError(400, 'That isn’t an SSH public key (paste the one-line .pub file, e.g. "ssh-ed25519 AAAA… you@laptop")');
  const row = credsOf(userId) ?? { user_id: userId, password_hash: null, password_salt: null, public_keys: '[]' };
  const keys = keysOf(row);
  if (keys.some((k) => describeKey(k)?.fingerprint === info.fingerprint)) throw new HttpError(409, 'That key is already added');
  if (keys.length >= 10) throw new HttpError(400, 'At most 10 keys');
  row.public_keys = JSON.stringify([...keys, clean]);
  saveCreds(row);
  return info;
}

export function removePublicKey(userId: string, fingerprint: string) {
  const row = credsOf(userId);
  if (!row) return;
  row.public_keys = JSON.stringify(keysOf(row).filter((k) => describeKey(k)?.fingerprint !== fingerprint));
  saveCreds(row);
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

/** "<user>.<id prefix>" → the user and instance, when the user may at least read its files. */
function resolveLogin(username: string): { userId: string; name: string; role: 'admin' | 'moderator' | 'viewer'; server: ServerRecord; canWrite: boolean } | null {
  const dot = username.lastIndexOf('.');
  if (dot <= 0) return null;
  const user = getUserByUsername(username.slice(0, dot));
  const prefix = username.slice(dot + 1).toLowerCase();
  if (!user || prefix.length < 8) return null;
  const matches = listServers().filter((s) => s.id.toLowerCase().startsWith(prefix));
  if (matches.length !== 1) return null;
  const server = matches[0];
  if (server.suspended && user.role !== 'admin') return null;
  const perms = getServerPermissions(user.id, user.role as never, server.id);
  if (!perms?.includes('files.read')) return null;
  return { userId: user.id, name: user.username, role: user.role as never, server, canWrite: perms.includes('files.write') };
}

const failures = new Map<string, { count: number; until: number }>();
function tooManyFailures(ip: string): boolean {
  const f = failures.get(ip);
  return !!f && f.count >= 10 && f.until > Date.now();
}
function noteFailure(ip: string) {
  const f = failures.get(ip);
  if (!f || f.until < Date.now()) failures.set(ip, { count: 1, until: Date.now() + 5 * 60_000 });
  else f.count++;
}

// ---------------------------------------------------------------------------
// SFTP operations, rooted at the instance folder
// ---------------------------------------------------------------------------

type Handle = { kind: 'file'; fd: number; abs: string; rel: string; wrote: boolean; before?: FileSnapshot; stage?: { dir: string; file: string }; pending?: number; drain?: () => void; closing?: boolean; append?: boolean; protectedSize?: number; failed?: boolean } | { kind: 'dir'; abs: string; rel: string; done: boolean };

function toAttrs(st: fs.Stats): Attributes {
  return { mode: st.mode, uid: 0, gid: 0, size: st.size, atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000) };
}

function longname(name: string, st: fs.Stats): string {
  const type = st.isDirectory() ? 'd' : st.isSymbolicLink() ? 'l' : '-';
  const perm = (m: number) => ['r', 'w', 'x'].map((c, i) => (m & (4 >> i) ? c : '-')).join('');
  const mode = `${type}${perm((st.mode >> 6) & 7)}${perm((st.mode >> 3) & 7)}${perm(st.mode & 7)}`;
  const d = st.mtime;
  const date = `${d.toLocaleString('en-US', { month: 'short' })} ${String(d.getDate()).padStart(2, ' ')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${mode} 1 outpost outpost ${String(st.size).padStart(10, ' ')} ${date} ${name}`;
}

function serveSftp(sftp: SFTPWrapper, login: NonNullable<ReturnType<typeof resolveLogin>>) {
  const root = instanceDir(login.server.id);
  fs.mkdirSync(root, { recursive: true });
  const handles = new Map<string, Handle>();
  let next = 0;
  const newHandle = (h: Handle) => {
    const id = Buffer.alloc(4);
    id.writeUInt32BE(next++);
    handles.set(id.toString('hex'), h);
    return id;
  };
  const getHandle = (b: Buffer) => handles.get(b.toString('hex'));
  /** Client path → normalized virtual path ("/a/b") and real path inside the instance. */
  const resolve = (p: string): { virt: string; rel: string; abs: string } | null => {
    const virt = path.posix.normalize('/' + (p || '/')).replace(/\/+$/, '') || '/';
    const rel = virt.slice(1);
    try {
      return { virt, rel, abs: rel ? safeJoinReal(root, rel) : root };
    } catch {
      return null;
    }
  };
  const audit = (action: string, detail: string, change?: string) => logAudit(login.userId, login.name, action, login.server.id, `[sftp] ${detail}`, change);
  const fail = (reqid: number, err: unknown) => {
    const code = (err as NodeJS.ErrnoException)?.code;
    sftp.status(reqid, code === 'ENOENT' ? STATUS.NO_SUCH_FILE : code === 'EACCES' || code === 'EPERM' ? STATUS.PERMISSION_DENIED : STATUS.FAILURE, code ?? undefined);
  };
  const denyWrite = (reqid: number) => (login.canWrite ? false : (sftp.status(reqid, STATUS.PERMISSION_DENIED, 'Read-only: you need the "Edit files" permission'), true));

  sftp.on('REALPATH', (reqid, p) => {
    const r = resolve(p);
    if (!r) return sftp.status(reqid, STATUS.PERMISSION_DENIED);
    sftp.name(reqid, [{ filename: r.virt, longname: r.virt, attrs: {} as Attributes }]);
  });
  const statHandler = (follow: boolean) => (reqid: number, p: string) => {
    const r = resolve(p);
    if (!r) return sftp.status(reqid, STATUS.PERMISSION_DENIED);
    fs.promises[follow ? 'stat' : 'lstat'](r.abs).then((st) => sftp.attrs(reqid, toAttrs(st)), (e) => fail(reqid, e));
  };
  sftp.on('STAT', statHandler(true));
  sftp.on('LSTAT', statHandler(false));
  sftp.on('FSTAT', (reqid, handle) => {
    const h = getHandle(handle);
    if (!h || h.kind !== 'file') return sftp.status(reqid, STATUS.FAILURE);
    fs.fstat(h.fd, (e, st) => (e ? fail(reqid, e) : sftp.attrs(reqid, toAttrs(st))));
  });
  sftp.on('OPENDIR', (reqid, p) => {
    const r = resolve(p);
    if (!r) return sftp.status(reqid, STATUS.PERMISSION_DENIED);
    fs.promises.stat(r.abs).then(
      (st) => (st.isDirectory() ? sftp.handle(reqid, newHandle({ kind: 'dir', abs: r.abs, rel: r.rel, done: false })) : sftp.status(reqid, STATUS.FAILURE, 'Not a directory')),
      (e) => fail(reqid, e)
    );
  });
  sftp.on('READDIR', (reqid, handle) => {
    const h = getHandle(handle);
    if (!h || h.kind !== 'dir') return sftp.status(reqid, STATUS.FAILURE);
    if (h.done) return sftp.status(reqid, STATUS.EOF);
    h.done = true;
    fs.promises.readdir(h.abs).then(async (names) => {
      const list = [];
      for (const name of names) {
        try {
          const st = await fs.promises.lstat(path.join(h.abs, name));
          list.push({ filename: name, longname: longname(name, st), attrs: toAttrs(st) });
        } catch {
          // vanished
        }
      }
      sftp.name(reqid, list);
    }, (e) => fail(reqid, e));
  });
  sftp.on('OPEN', (reqid, p, flags) => {
    const r = resolve(p);
    if (!r || !r.rel) return sftp.status(reqid, STATUS.PERMISSION_DENIED);
    const writing = !!(flags & (OPEN.WRITE | OPEN.CREAT | OPEN.TRUNC | OPEN.APPEND));
    if (writing && denyWrite(reqid)) return;
    if (writing) {
      try {
        assertDiskRoom(login.server.id, 'write');
      } catch (err) {
        return sftp.status(reqid, STATUS.FAILURE, err instanceof Error ? err.message : 'Over the disk limit');
      }
    }
    const mode = utils.sftp.flagsToString(flags) ?? 'r';
    // Taken before opening: a truncating open would already have emptied the file.
    const before = writing ? snapshotFile(r.abs) : undefined;
    if (writing && protectionEnabled()) {
      let stage: { dir: string; file: string } | undefined;
      try {
        if ((flags & OPEN.EXCL) && fs.existsSync(r.abs)) throw new Error('File already exists');
        if (!(flags & OPEN.CREAT) && !fs.existsSync(r.abs)) throw new Error('File does not exist');
        if (fs.existsSync(r.abs) && (!fs.lstatSync(r.abs).isFile() || fs.lstatSync(r.abs).isSymbolicLink())) throw new Error('Protected uploads require regular files');
        stage = stageFile(Buffer.alloc(0));
        if (!(flags & OPEN.TRUNC) && fs.existsSync(r.abs)) {
          if (fs.statSync(r.abs).size > 1024 ** 3) throw new Error('Protected SFTP uploads must be under 1 GiB');
          fs.copyFileSync(r.abs, stage.file);
        }
        const fd = fs.openSync(stage.file, flags & OPEN.APPEND ? 'a+' : 'r+');
        sftp.handle(reqid, newHandle({ kind: 'file', fd, abs: r.abs, rel: r.rel, wrote: true, before, stage, pending: 0, append: !!(flags & OPEN.APPEND), protectedSize: fs.statSync(stage.file).size }));
      } catch (err) { if (stage) discardStage(stage.dir); sftp.status(reqid, STATUS.FAILURE, err instanceof Error ? err.message : 'Cannot stage protected upload'); }
      return;
    }
    fs.open(r.abs, mode, 0o644, (e, fd) => (e ? fail(reqid, e) : sftp.handle(reqid, newHandle({ kind: 'file', fd, abs: r.abs, rel: r.rel, wrote: false, before }))));
  });
  sftp.on('READ', (reqid, handle, offset, length) => {
    const h = getHandle(handle);
    if (!h || h.kind !== 'file') return sftp.status(reqid, STATUS.FAILURE);
    const buf = Buffer.alloc(Math.min(length, 256 * 1024));
    fs.read(h.fd, buf, 0, buf.length, offset, (e, n) => (e ? fail(reqid, e) : n === 0 ? sftp.status(reqid, STATUS.EOF) : sftp.data(reqid, buf.subarray(0, n))));
  });
  sftp.on('WRITE', (reqid, handle, offset, data) => {
    const h = getHandle(handle);
    if (!h || h.kind !== 'file') return sftp.status(reqid, STATUS.FAILURE);
    if (denyWrite(reqid)) return;
    if (h.closing) return sftp.status(reqid, STATUS.FAILURE, 'Handle is closing');
    if (protectionEnabled() && !h.stage) return sftp.status(reqid, STATUS.FAILURE, 'Upload protection changed; reopen this upload');
    if (h.stage && (!Number.isSafeInteger(offset) || offset < 0 || offset + data.length > 1024 ** 3 || (h.append && (h.protectedSize ?? 0) + data.length > 1024 ** 3))) { h.failed = true; return sftp.status(reqid, STATUS.FAILURE, 'Protected upload limit is 1 GiB'); }
    if (h.append) h.protectedSize = (h.protectedSize ?? 0) + data.length;
    h.pending = (h.pending ?? 0) + 1;
    fs.write(h.fd, data, 0, data.length, offset, (e) => {
      h.pending = (h.pending ?? 1) - 1; if (!h.pending) h.drain?.();
      if (e) { h.failed = true; return fail(reqid, e); }
      h.wrote = true;
      sftp.status(reqid, STATUS.OK);
    });
  });
  sftp.on('CLOSE', (reqid, handle) => {
    const key = handle.toString('hex');
    const h = handles.get(key);
    if (!h) return sftp.status(reqid, STATUS.FAILURE);
    handles.delete(key);
    if (h.kind === 'dir') return sftp.status(reqid, STATUS.OK);
    h.closing = true;
    if (h.stage) {
      void (async () => {
        if (h.pending) await new Promise<void>(resolve => { h.drain = resolve; });
        await new Promise<void>((resolve, reject) => fs.close(h.fd, err => err ? reject(err) : resolve())).catch(err => { discardStage(h.stage!.dir); throw err; });
        try {
          if (!protectionEnabled()) throw new Error('Upload protection changed; reopen this upload');
          if (h.failed || fs.statSync(h.stage!.file).size > 1024 ** 3) throw new Error('Upload had failed writes or exceeded the protected size limit');
          const buffer = fs.readFileSync(h.stage!.file);
          await scanUploadBuffers([{ name: h.rel, buffer }], login.server.id);
          const current = resolve(h.rel); if (!current || current.abs !== h.abs) throw new Error('Upload destination changed');
          const temp = safeJoinReal(root, `${h.rel}.av-${crypto.randomUUID()}.tmp`);
          try { fs.writeFileSync(temp, buffer, { mode: h.before?.exists && fs.existsSync(h.abs) ? fs.statSync(h.abs).mode & 0o777 : 0o644, flag: 'wx' }); fs.renameSync(temp, current.abs); }
          finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
          audit('file.write', h.rel, h.before ? fileChange(h.rel, h.before, snapshotFile(h.abs)) : undefined);
          sftp.status(reqid, STATUS.OK);
        } finally { discardStage(h.stage!.dir); }
      })().catch(err => sftp.status(reqid, STATUS.FAILURE, err instanceof Error ? err.message : 'Antivirus rejected upload'));
      return;
    }
    fs.close(h.fd, (e) => {
      if (h.wrote) audit('file.write', h.rel, h.before ? fileChange(h.rel, h.before, snapshotFile(h.abs)) : undefined);
      e ? fail(reqid, e) : sftp.status(reqid, STATUS.OK);
    });
  });
  const writeOp = (fn: (r: NonNullable<ReturnType<typeof resolve>>) => Promise<unknown>, auditAction: string) => (reqid: number, p: string) => {
    if (denyWrite(reqid)) return;
    const r = resolve(p);
    if (!r || !r.rel) return sftp.status(reqid, STATUS.PERMISSION_DENIED);
    const before = snapshotFile(r.abs);
    fn(r).then(
      () => {
        audit(auditAction, r.rel, fileChange(r.rel, before, snapshotFile(r.abs)));
        sftp.status(reqid, STATUS.OK);
      },
      (e) => fail(reqid, e)
    );
  };
  sftp.on('REMOVE', writeOp((r) => fs.promises.unlink(r.abs), 'file.delete'));
  sftp.on('RMDIR', writeOp((r) => fs.promises.rmdir(r.abs), 'file.delete'));
  sftp.on('MKDIR', writeOp((r) => fs.promises.mkdir(r.abs), 'file.mkdir'));
  sftp.on('RENAME', (reqid, from, to) => {
    if (denyWrite(reqid)) return;
    const a = resolve(from);
    const b = resolve(to);
    if (!a || !b || !a.rel || !b.rel) return sftp.status(reqid, STATUS.PERMISSION_DENIED);
    const directory = !!snapshotFile(a.abs).directory;
    fs.promises.rename(a.abs, b.abs).then(
      () => {
        audit('file.rename', `${a.rel} → ${b.rel}`, renameChange(a.rel, b.rel, directory));
        sftp.status(reqid, STATUS.OK);
      },
      (e) => fail(reqid, e)
    );
  });
  // Permissions/owners aren't changeable through SFTP; timestamps are, harmlessly.
  sftp.on('SETSTAT', (reqid, p, attrs) => {
    if (denyWrite(reqid)) return;
    const r = resolve(p);
    if (!r) return sftp.status(reqid, STATUS.PERMISSION_DENIED);
    if (attrs.atime !== undefined && attrs.mtime !== undefined) fs.utimes(r.abs, attrs.atime, attrs.mtime, () => sftp.status(reqid, STATUS.OK));
    else sftp.status(reqid, STATUS.OK);
  });
  sftp.on('FSETSTAT', (reqid) => sftp.status(reqid, STATUS.OK));
  sftp.on('READLINK', (reqid) => sftp.status(reqid, STATUS.OP_UNSUPPORTED));
  sftp.on('SYMLINK', (reqid) => sftp.status(reqid, STATUS.PERMISSION_DENIED, 'Symlinks aren’t allowed'));
  sftp.on('end', () => {
    for (const h of handles.values()) if (h.kind === 'file') fs.close(h.fd, () => { if (h.stage) discardStage(h.stage.dir); });
    handles.clear();
  });
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

function hostKey(): Buffer {
  if (!fs.existsSync(HOST_KEY)) {
    const pair = utils.generateKeyPairSync('ed25519');
    fs.writeFileSync(HOST_KEY, pair.private, { mode: 0o600 });
  }
  return fs.readFileSync(HOST_KEY);
}

export function hostKeyFingerprint(): string | null {
  try {
    const parsed = utils.parseKey(hostKey());
    if (parsed instanceof Error || Array.isArray(parsed)) return null;
    return `SHA256:${crypto.createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '')}`;
  } catch {
    return null;
  }
}

let server: InstanceType<typeof Server> | null = null;
let state: { running: boolean; port: number | null; error: string | null } = { running: false, port: null, error: null };
export const sftpState = () => state;

function onClient(client: Connection, info: { ip: string }) {
  let login: ReturnType<typeof resolveLogin> = null;
  client.on('authentication', (ctx: AuthContext) => {
    if (tooManyFailures(info.ip)) return ctx.reject();
    const candidate = resolveLogin(ctx.username);
    const creds = candidate ? credsOf(candidate.userId) : null;
    const reject = () => {
      noteFailure(info.ip);
      ctx.reject(['password', 'publickey']);
    };
    if (!candidate || !creds) return ctx.method === 'none' ? ctx.reject(['password', 'publickey']) : reject();
    if (ctx.method === 'password') {
      if (!creds.password_hash || !creds.password_salt || !verifyPassword(ctx.password, creds.password_hash, creds.password_salt)) return reject();
      login = candidate;
      return ctx.accept();
    }
    if (ctx.method === 'publickey') {
      const match = keysOf(creds)
        .map((k) => utils.parseKey(k))
        .find((k): k is ssh2.ParsedKey => !(k instanceof Error) && !Array.isArray(k) && k.type === ctx.key.algo && crypto.timingSafeEqual(k.getPublicSSH(), ctx.key.data));
      if (!match) return reject();
      if (ctx.signature && ctx.blob && match.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) return reject();
      login = candidate;
      return ctx.accept();
    }
    ctx.reject(['password', 'publickey']);
  });
  client.on('ready', () => {
    if (!login) return client.end();
    const l = login;
    logAudit(l.userId, l.name, 'sftp.login', l.server.id, `[sftp] signed in from ${info.ip}${l.canWrite ? '' : ' (read-only)'}`);
    client.on('session', (accept) => {
      const session = accept();
      session.on('sftp', (acceptSftp) => serveSftp(acceptSftp(), l));
      // No shells or commands — SFTP only.
      session.on('exec', (_a, reject) => reject?.());
      session.on('shell', (_a, reject) => reject?.());
      session.on('pty', (_a, reject) => reject?.());
    });
  });
  client.on('error', () => {});
}

export function stopSftp(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve();
    const s = server;
    server = null;
    state = { running: false, port: null, error: null };
    s.close(() => resolve());
    setTimeout(resolve, 2000).unref();
  });
}

export async function startSftp(): Promise<void> {
  await stopSftp();
  const cfg = sftpSettings();
  if (!cfg.enabled) return;
  try {
    const s = new Server({ hostKeys: [hostKey()], ident: 'Outpost-SFTP' }, onClient);
    await new Promise<void>((resolve, reject) => {
      s.once('error', reject);
      s.listen(cfg.port, '0.0.0.0', () => resolve());
    });
    s.on('error', (err: Error) => logger.warn('SFTP server error', err));
    server = s;
    state = { running: true, port: cfg.port, error: null };
    logger.info(`SFTP listening on port ${cfg.port}`);
  } catch (err) {
    state = { running: false, port: null, error: err instanceof Error ? err.message : String(err) };
    logger.warn(`SFTP couldn’t start: ${state.error}`);
  }
}

export async function saveSftpSettings(input: { enabled?: unknown; port?: unknown }) {
  if (input.port !== undefined) {
    const port = Number(input.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, 'Port must be 1–65535');
    setSetting(SETTING_SFTP_PORT, String(port));
  }
  if (input.enabled !== undefined) setSetting(SETTING_SFTP_ENABLED, input.enabled === true ? 'on' : 'off');
  await startSftp();
}

/** The login name for a user + instance. */
export function sftpUsername(username: string, serverId: string): string {
  return `${username}.${serverId.slice(0, 8)}`;
}

