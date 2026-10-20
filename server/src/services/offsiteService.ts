import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import ssh2 from 'ssh2';
import { prep } from '../db/db.js';
import { HttpError } from '../utils/asyncHandler.js';
import { logger } from '../utils/logger.js';
import { backupDir } from '../utils/paths.js';

/**
 * Off-site backups: every new snapshot is copied to the enabled destinations — S3-compatible
 * storage (AWS, Backblaze B2, Wasabi, MinIO, Cloudflare R2…) or another SFTP host — under
 * <prefix>/<instance id>/<snapshot file>. Each destination keeps the newest N copies per instance.
 */

export type DestinationType = 's3' | 'sftp';

export interface S3Config {
  endpoint: string; // https://s3.us-east-1.amazonaws.com, https://s3.us-west-004.backblazeb2.com, http://minio:9000…
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
  /** Path-style URLs (endpoint/bucket/key) — what MinIO and most non-AWS services want. */
  pathStyle: boolean;
}

export interface SftpDestConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  privateKey: string;
  path: string;
}

export interface Destination {
  id: string;
  name: string;
  type: DestinationType;
  enabled: boolean;
  /** Copies kept per instance (0 = keep all). */
  keep: number;
  config: S3Config | SftpDestConfig;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Storage of destinations (secrets never leave the server)
// ---------------------------------------------------------------------------

interface DestRow {
  id: string;
  name: string;
  type: DestinationType;
  enabled: number;
  keep: number;
  config: string;
  created_at: string;
}

const fromRow = (r: DestRow): Destination => ({ id: r.id, name: r.name, type: r.type, enabled: !!r.enabled, keep: r.keep, config: JSON.parse(r.config), createdAt: r.created_at });

export function listDestinations(): Destination[] {
  return (prep('SELECT * FROM offsite_destinations ORDER BY created_at').all() as unknown as DestRow[]).map(fromRow);
}

export function getDestination(id: string): Destination | null {
  const r = prep('SELECT * FROM offsite_destinations WHERE id = ?').get(id) as DestRow | undefined;
  return r ? fromRow(r) : null;
}

/** What the browser sees: secrets replaced by whether they're set. */
export function publicDestination(d: Destination) {
  if (d.type === 's3') {
    const c = d.config as S3Config;
    return { ...d, config: { ...c, secretAccessKey: '', hasSecret: !!c.secretAccessKey } };
  }
  const c = d.config as SftpDestConfig;
  return { ...d, config: { ...c, password: '', privateKey: '', hasPassword: !!c.password, hasKey: !!c.privateKey } };
}

const str = (v: unknown, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function sanitize(type: DestinationType, input: Record<string, unknown>, prev?: Destination): S3Config | SftpDestConfig {
  if (type === 's3') {
    const p = prev?.config as S3Config | undefined;
    const endpoint = str(input.endpoint).replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/]+/.test(endpoint)) throw new HttpError(400, 'Endpoint must be a URL like https://s3.us-east-1.amazonaws.com');
    const bucket = str(input.bucket, 63);
    if (!/^[a-z0-9][a-z0-9.\-]{1,62}$/.test(bucket)) throw new HttpError(400, 'Bucket names are 3–63 lowercase letters, digits, dots and dashes');
    const accessKeyId = str(input.accessKeyId, 200);
    const secretAccessKey = str(input.secretAccessKey, 500) || p?.secretAccessKey || '';
    if (!accessKeyId || !secretAccessKey) throw new HttpError(400, 'Access key and secret are required');
    return {
      endpoint,
      region: str(input.region, 50) || 'us-east-1',
      bucket,
      accessKeyId,
      secretAccessKey,
      prefix: str(input.prefix, 200).replace(/^\/+|\/+$/g, '') || 'outpost',
      pathStyle: input.pathStyle !== false,
    };
  }
  const p = prev?.config as SftpDestConfig | undefined;
  const host = str(input.host, 253);
  if (!/^[A-Za-z0-9.\-:[\]]+$/.test(host)) throw new HttpError(400, 'Host must be a host name or IP');
  const port = Number(input.port ?? 22);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, 'Port must be 1–65535');
  const username = str(input.username, 100);
  if (!username) throw new HttpError(400, 'Username is required');
  const password = str(input.password, 500) || p?.password || '';
  const privateKey = typeof input.privateKey === 'string' && input.privateKey.trim() ? input.privateKey.trim() : p?.privateKey || '';
  if (!password && !privateKey) throw new HttpError(400, 'Give a password or a private key');
  return { host, port, username, password, privateKey, path: str(input.path, 300).replace(/\/+$/, '') || 'outpost-backups' };
}

export function saveDestination(input: Record<string, unknown>, id?: string): Destination {
  const prev = id ? getDestination(id) : null;
  if (id && !prev) throw new HttpError(404, 'Destination not found');
  const type: DestinationType = prev?.type ?? (input.type === 'sftp' ? 'sftp' : 's3');
  const name = str(input.name, 80) || prev?.name || (type === 's3' ? 'S3 storage' : 'SFTP host');
  const keep = input.keep === undefined ? prev?.keep ?? 7 : Number(input.keep);
  if (!Number.isInteger(keep) || keep < 0 || keep > 1000) throw new HttpError(400, 'Keep 0 (all) to 1000 copies');
  const enabled = input.enabled === undefined ? prev?.enabled ?? true : input.enabled === true;
  const config = input.config && typeof input.config === 'object' ? sanitize(type, input.config as Record<string, unknown>, prev ?? undefined) : prev?.config;
  if (!config) throw new HttpError(400, 'config is required');
  const newId = id ?? crypto.randomUUID();
  prep(
    `INSERT INTO offsite_destinations (id, name, type, enabled, keep, config, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, enabled = excluded.enabled, keep = excluded.keep, config = excluded.config`
  ).run(newId, name, type, enabled ? 1 : 0, keep, JSON.stringify(config), prev?.createdAt ?? new Date().toISOString());
  return getDestination(newId)!;
}

export function deleteDestination(id: string) {
  prep('DELETE FROM offsite_destinations WHERE id = ?').run(id);
  prep('DELETE FROM offsite_copies WHERE destination_id = ?').run(id);
}

// ---------------------------------------------------------------------------
// S3 (AWS Signature Version 4)
// ---------------------------------------------------------------------------

const PART_SIZE = 32 * 1024 * 1024;
const SINGLE_PUT_MAX = 64 * 1024 * 1024;
const sha256 = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key: crypto.BinaryLike, data: string) => crypto.createHmac('sha256', key).update(data).digest();
const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function s3Url(c: S3Config, key: string, query: Record<string, string> = {}): URL {
  const base = new URL(c.endpoint);
  const encodedKey = key.split('/').map(rfc3986).join('/');
  const url = c.pathStyle ? new URL(`${base.origin}${base.pathname.replace(/\/$/, '')}/${c.bucket}${key ? `/${encodedKey}` : ''}`) : new URL(`${base.protocol}//${c.bucket}.${base.host}/${encodedKey}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return url;
}

/** Signs and sends one S3 request. `body` is a Buffer (hashed) or a stream/undefined (UNSIGNED-PAYLOAD). */
async function s3Request(c: S3Config, method: string, key: string, opts: { query?: Record<string, string>; body?: Buffer | ReadableStream; headers?: Record<string, string> } = {}): Promise<Response> {
  const url = s3Url(c, key, opts.query);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const payloadHash = Buffer.isBuffer(opts.body) ? sha256(opts.body) : opts.body ? 'UNSIGNED-PAYLOAD' : sha256('');
  const headers: Record<string, string> = { ...(opts.headers ?? {}), host: url.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash };
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const canonicalQuery = [...url.searchParams.entries()]
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a < b ? -1 : 1))
    .map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`)
    .join('&');
  const canonical = [method, url.pathname, canonicalQuery, names.map((n) => `${n}:${String(lower[n]).trim()}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${date}/${c.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${c.secretAccessKey}`, date), c.region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex');
  const auth = `AWS4-HMAC-SHA256 Credential=${c.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
  const { host: _host, ...sendHeaders } = headers;
  const init: RequestInit & { duplex?: 'half' } = { method, headers: { ...sendHeaders, Authorization: auth }, body: opts.body as RequestInit['body'], signal: AbortSignal.timeout(10 * 60_000) };
  if (opts.body && !Buffer.isBuffer(opts.body)) init.duplex = 'half';
  return fetch(url, init);
}

async function s3Check(res: Response, what: string): Promise<Response> {
  if (res.ok) return res;
  const text = await res.text().catch(() => '');
  const code = text.match(/<Code>([^<]+)<\/Code>/)?.[1];
  const msg = text.match(/<Message>([^<]+)<\/Message>/)?.[1];
  throw new Error(`${what}: ${res.status}${code ? ` ${code}` : ''}${msg ? ` — ${msg}` : ''}`);
}

async function s3Upload(c: S3Config, file: string, key: string) {
  const size = fs.statSync(file).size;
  if (size <= SINGLE_PUT_MAX) {
    await s3Check(await s3Request(c, 'PUT', key, { body: fs.readFileSync(file), headers: { 'content-type': 'application/zip' } }), 'Upload');
    return;
  }
  const created = await s3Check(await s3Request(c, 'POST', key, { query: { uploads: '' }, headers: { 'content-type': 'application/zip' } }), 'Start upload');
  const uploadId = (await created.text()).match(/<UploadId>([^<]+)<\/UploadId>/)?.[1];
  if (!uploadId) throw new Error('Start upload: no UploadId in the reply');
  const parts: string[] = [];
  const fd = fs.openSync(file, 'r');
  try {
    for (let offset = 0, n = 1; offset < size; offset += PART_SIZE, n++) {
      const buf = Buffer.alloc(Math.min(PART_SIZE, size - offset));
      fs.readSync(fd, buf, 0, buf.length, offset);
      const res = await s3Check(await s3Request(c, 'PUT', key, { query: { partNumber: String(n), uploadId }, body: buf }), `Upload part ${n}`);
      parts.push(res.headers.get('etag') ?? '');
    }
    const xml = `<CompleteMultipartUpload>${parts.map((e, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${e}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
    const done = await s3Check(await s3Request(c, 'POST', key, { query: { uploadId }, body: Buffer.from(xml), headers: { 'content-type': 'application/xml' } }), 'Finish upload');
    const text = await done.text();
    if (/<Error>/.test(text)) throw new Error(`Finish upload: ${text.match(/<Message>([^<]+)/)?.[1] ?? 'failed'}`);
  } catch (err) {
    await s3Request(c, 'DELETE', key, { query: { uploadId } }).catch(() => {});
    throw err;
  } finally {
    fs.closeSync(fd);
  }
}

interface RemoteObject {
  name: string;
  sizeBytes: number;
  modifiedAt: string;
}

async function s3List(c: S3Config, prefix: string): Promise<RemoteObject[]> {
  const out: RemoteObject[] = [];
  let token: string | undefined;
  do {
    const query: Record<string, string> = { 'list-type': '2', prefix };
    if (token) query['continuation-token'] = token;
    const text = await (await s3Check(await s3Request(c, 'GET', '', { query }), 'List')).text();
    for (const m of text.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = m[1].match(/<Key>([^<]+)<\/Key>/)?.[1] ?? '';
      out.push({
        name: key.slice(prefix.length).replace(/&amp;/g, '&'),
        sizeBytes: Number(m[1].match(/<Size>(\d+)<\/Size>/)?.[1] ?? 0),
        modifiedAt: m[1].match(/<LastModified>([^<]+)<\/LastModified>/)?.[1] ?? '',
      });
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(text) ? text.match(/<NextContinuationToken>([^<]+)</)?.[1] : undefined;
  } while (token);
  return out;
}

async function s3Download(c: S3Config, key: string, file: string) {
  const res = await s3Check(await s3Request(c, 'GET', key), 'Download');
  await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(file));
}

async function s3Delete(c: S3Config, key: string) {
  await s3Check(await s3Request(c, 'DELETE', key), 'Delete');
}

// ---------------------------------------------------------------------------
// SFTP destinations
// ---------------------------------------------------------------------------

type Sftp = ssh2.SFTPWrapper;

function withSftp<T>(c: SftpDestConfig, fn: (sftp: Sftp) => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const client = new ssh2.Client();
    client.on('ready', () =>
      client.sftp((err, sftp) => {
        if (err) {
          client.end();
          return reject(err);
        }
        fn(sftp).then(
          (v) => {
            client.end();
            resolve(v);
          },
          (e) => {
            client.end();
            reject(e);
          }
        );
      })
    );
    client.on('error', (err) => reject(new Error(`SFTP ${c.host}: ${err.message}`)));
    client.connect({ host: c.host, port: c.port, username: c.username, password: c.password || undefined, privateKey: c.privateKey || undefined, readyTimeout: 15_000 });
  });
}

const sp = <T>(fn: (cb: (err: Error | null | undefined, v?: T) => void) => void) => new Promise<T>((res, rej) => fn((e, v) => (e ? rej(e) : res(v as T))));

async function sftpMkdirp(sftp: Sftp, dir: string) {
  let cur = dir.startsWith('/') ? '' : '.';
  for (const part of dir.split('/').filter(Boolean)) {
    cur = cur === '' ? `/${part}` : `${cur}/${part}`;
    await sp<void>((cb) => sftp.mkdir(cur, (e) => cb(e && (e as { code?: number }).code !== 4 ? e : null))).catch(async () => {
      // exists already (servers report it differently) — confirm it's a folder
      await sp((cb) => sftp.stat(cur, cb));
    });
  }
}

// ---------------------------------------------------------------------------
// Operations on any destination
// ---------------------------------------------------------------------------

const remoteDir = (d: Destination, serverId: string) => (d.type === 's3' ? `${(d.config as S3Config).prefix}/${serverId}/` : `${(d.config as SftpDestConfig).path}/${serverId}`);

export async function listRemote(d: Destination, serverId: string): Promise<RemoteObject[]> {
  if (d.type === 's3') return (await s3List(d.config as S3Config, remoteDir(d, serverId))).filter((o) => o.name.endsWith('.zip') && !o.name.includes('/'));
  return withSftp(d.config as SftpDestConfig, async (sftp) => {
    const list = await sp<ssh2.FileEntry[]>((cb) => sftp.readdir(remoteDir(d, serverId), cb as never)).catch(() => [] as ssh2.FileEntry[]);
    return list
      .filter((e) => e.filename.endsWith('.zip'))
      .map((e) => ({ name: e.filename, sizeBytes: e.attrs.size, modifiedAt: new Date(e.attrs.mtime * 1000).toISOString() }));
  });
}

async function uploadTo(d: Destination, serverId: string, fileName: string) {
  const local = path.join(backupDir(serverId), fileName);
  if (d.type === 's3') return s3Upload(d.config as S3Config, local, `${remoteDir(d, serverId)}${fileName}`);
  await withSftp(d.config as SftpDestConfig, async (sftp) => {
    await sftpMkdirp(sftp, remoteDir(d, serverId));
    await sp<void>((cb) => sftp.fastPut(local, `${remoteDir(d, serverId)}/${fileName}`, cb));
  });
}

async function deleteRemote(d: Destination, serverId: string, name: string) {
  if (d.type === 's3') return s3Delete(d.config as S3Config, `${remoteDir(d, serverId)}${name}`);
  await withSftp(d.config as SftpDestConfig, (sftp) => sp<void>((cb) => sftp.unlink(`${remoteDir(d, serverId)}/${name}`, cb)));
}

/** Copies a remote snapshot back into the instance's local snapshots (then it can be restored as usual). */
export async function fetchRemote(d: Destination, serverId: string, name: string): Promise<string> {
  if (!/^[\w.\-]+\.zip$/.test(name)) throw new HttpError(400, 'Invalid snapshot name');
  fs.mkdirSync(backupDir(serverId), { recursive: true });
  const local = path.join(backupDir(serverId), name);
  const partial = `${local}.partial`;
  try {
    if (d.type === 's3') await s3Download(d.config as S3Config, `${remoteDir(d, serverId)}${name}`, partial);
    else await withSftp(d.config as SftpDestConfig, (sftp) => sp<void>((cb) => sftp.fastGet(`${remoteDir(d, serverId)}/${name}`, partial, cb)));
    fs.renameSync(partial, local);
  } catch (err) {
    fs.rmSync(partial, { force: true });
    throw err;
  }
  return name;
}

/** Uploads and removes a small test file. */
export async function testDestination(d: Destination): Promise<void> {
  const name = `outpost-test-${Date.now()}.txt`;
  if (d.type === 's3') {
    const c = d.config as S3Config;
    const key = `${c.prefix}/${name}`;
    await s3Check(await s3Request(c, 'PUT', key, { body: Buffer.from('Outpost connection test\n') }), 'Upload test');
    await s3List(c, `${c.prefix}/`);
    await s3Delete(c, key);
    return;
  }
  const c = d.config as SftpDestConfig;
  await withSftp(c, async (sftp) => {
    await sftpMkdirp(sftp, c.path);
    await new Promise<void>((resolve, reject) => {
      const w = sftp.createWriteStream(`${c.path}/${name}`);
      w.on('close', () => resolve());
      w.on('error', reject);
      w.end('Outpost connection test\n');
    });
    await sp<void>((cb) => sftp.unlink(`${c.path}/${name}`, cb));
  });
}

// ---------------------------------------------------------------------------
// Copy queue + per-snapshot status
// ---------------------------------------------------------------------------

export interface CopyStatus {
  fileName: string;
  destinationId: string;
  status: 'pending' | 'uploading' | 'done' | 'failed';
  error: string | null;
  updatedAt: string;
}

function setCopy(serverId: string, fileName: string, destinationId: string, status: CopyStatus['status'], error: string | null = null) {
  prep(
    `INSERT INTO offsite_copies (server_id, file_name, destination_id, status, error, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(server_id, file_name, destination_id) DO UPDATE SET status = excluded.status, error = excluded.error, updated_at = excluded.updated_at`
  ).run(serverId, fileName, destinationId, status, error, new Date().toISOString());
}

export function copiesFor(serverId: string): CopyStatus[] {
  return (prep('SELECT file_name, destination_id, status, error, updated_at FROM offsite_copies WHERE server_id = ?').all(serverId) as any[]).map((r) => ({
    fileName: r.file_name,
    destinationId: r.destination_id,
    status: r.status,
    error: r.error,
    updatedAt: r.updated_at,
  }));
}

let queue: Promise<void> = Promise.resolve();

/** Queues copies of a snapshot to every enabled destination (or just one). Runs one upload at a time. */
export function enqueueCopy(serverId: string, fileName: string, onlyDestination?: string) {
  const targets = listDestinations().filter((d) => (onlyDestination ? d.id === onlyDestination : d.enabled));
  for (const d of targets) {
    setCopy(serverId, fileName, d.id, 'pending');
    queue = queue.then(async () => {
      if (!fs.existsSync(path.join(backupDir(serverId), fileName))) return setCopy(serverId, fileName, d.id, 'failed', 'The local snapshot was deleted before it was copied');
      setCopy(serverId, fileName, d.id, 'uploading');
      try {
        await uploadTo(d, serverId, fileName);
        setCopy(serverId, fileName, d.id, 'done');
        logger.info(`Off-site: copied ${serverId}/${fileName} to ${d.name}`);
        if (d.keep > 0) {
          const remote = (await listRemote(d, serverId)).sort((a, b) => b.name.localeCompare(a.name));
          for (const old of remote.slice(d.keep)) await deleteRemote(d, serverId, old.name).catch(() => {});
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setCopy(serverId, fileName, d.id, 'failed', msg.slice(0, 500));
        logger.warn(`Off-site copy of ${serverId}/${fileName} to ${d.name} failed: ${msg}`);
        const { notify } = await import('./notificationService.js');
        notify('backup.failed', null, `Off-site copy to ${d.name} failed: ${msg}`);
      }
    });
  }
  return targets.length;
}
