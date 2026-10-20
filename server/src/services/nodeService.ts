import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import type { Request } from 'express';
import { prep } from '../db/db.js';
import { HttpError } from '../utils/asyncHandler.js';
import { instanceDir } from '../utils/paths.js';
import { logger } from '../utils/logger.js';
import { getSetting, setSetting } from './systemSettingsService.js';
import {
  applyTransferredFields,
  createServerRecord,
  deleteServerRecord,
  getServer,
  listServers,
  setServerStatus,
  updateServerRecord,
} from './serverService.js';
import { isRunning } from './processManager.js';
import { forgetServerSchedules } from './schedulerService.js';
import { appendLine } from './consoleLogService.js';
import { publish, consoleTopic } from './wsHub.js';
import type { ServerRecord, ServerStatus } from '../types/index.js';

/**
 * Multi-node support: every Outpost panel has a node key. Adding another panel here (its URL
 * + its node key) lets this panel push an instance's files and settings to it. Transfers stream a
 * gzipped tar of the instance directory straight into the receiving panel — nothing is staged in
 * memory or on disk on the sending side.
 */

const NODE_KEY_SETTING = 'node_key';
const NODE_KEY_HEADER = 'x-outpost-node-key';
const SERVER_META_HEADER = 'x-outpost-server';
// Pre-rename header names: still sent and accepted so nodes on older versions keep talking.
const LEGACY_NODE_KEY_HEADER = 'x-multicraft-node-key';
const LEGACY_SERVER_META_HEADER = 'x-multicraft-server';

export interface NodeRecord {
  id: string;
  name: string;
  url: string;
  api_key: string;
  created_at: string;
}

export interface PublicNode {
  id: string;
  name: string;
  url: string;
  created_at: string;
  keyHint: string;
}

export interface NodeInfo {
  hostname: string;
  platform: string;
  arch: string;
  instances: number;
  running: number;
}

// ---------------------------------------------------------------------------
// This panel's own node key
// ---------------------------------------------------------------------------

export function getLocalNodeKey(): string {
  let key = getSetting(NODE_KEY_SETTING);
  if (!key) {
    key = `mcn_${crypto.randomBytes(24).toString('base64url')}`;
    setSetting(NODE_KEY_SETTING, key);
  }
  return key;
}

export function regenerateLocalNodeKey(): string {
  const key = `mcn_${crypto.randomBytes(24).toString('base64url')}`;
  setSetting(NODE_KEY_SETTING, key);
  return key;
}

/** Validates the node key on inbound node-to-node requests (constant-time compare). */
export function requireNodeKey(req: Request): void {
  const presented = req.headers[NODE_KEY_HEADER] ?? req.headers[LEGACY_NODE_KEY_HEADER];
  const expected = getLocalNodeKey();
  if (typeof presented !== 'string') throw new HttpError(401, 'Node key required');
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(401, 'Invalid node key');
}

export function localNodeInfo(): NodeInfo {
  const servers = listServers();
  return {
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    instances: servers.length,
    running: servers.filter((s) => isRunning(s.id)).length,
  };
}

// ---------------------------------------------------------------------------
// Registry of remote nodes
// ---------------------------------------------------------------------------

function toPublic(node: NodeRecord): PublicNode {
  return { id: node.id, name: node.name, url: node.url, created_at: node.created_at, keyHint: `…${node.api_key.slice(-4)}` };
}

export function listNodes(): PublicNode[] {
  return (prep('SELECT * FROM nodes ORDER BY created_at ASC').all() as unknown as NodeRecord[]).map(toPublic);
}

function getNode(id: string): NodeRecord {
  const node = prep('SELECT * FROM nodes WHERE id = ?').get(id) as NodeRecord | undefined;
  if (!node) throw new HttpError(404, 'Node not found');
  return node;
}

export function normalizeNodeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new HttpError(400, 'Node URL must be a full URL, e.g. http://10.0.0.5:8642');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new HttpError(400, 'Node URL must use http or https');
  return url.origin;
}

async function callNode<T>(url: string, apiKey: string, path: string, timeoutMs = 5000): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${url}/api/node-link${path}`, {
      headers: { [NODE_KEY_HEADER]: apiKey, [LEGACY_NODE_KEY_HEADER]: apiKey },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new HttpError(502, `Couldn't reach ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, `${url} answered ${res.status}: ${(body as { error?: string }).error ?? res.statusText}`);
  return body as T;
}

export async function addNode(name: string, rawUrl: string, apiKey: string): Promise<{ node: PublicNode; info: NodeInfo }> {
  const url = normalizeNodeUrl(rawUrl);
  if (!name.trim()) throw new HttpError(400, 'Name is required');
  if (!apiKey.trim()) throw new HttpError(400, 'Node key is required');
  // Verify before saving so a typo'd URL or key fails up front.
  const info = await callNode<NodeInfo>(url, apiKey.trim(), '/info');
  const id = crypto.randomUUID();
  prep('INSERT INTO nodes (id, name, url, api_key) VALUES (?, ?, ?, ?)').run(id, name.trim(), url, apiKey.trim());
  return { node: toPublic(getNode(id)), info };
}

export function removeNode(id: string): void {
  getNode(id);
  prep('DELETE FROM nodes WHERE id = ?').run(id);
}

export async function nodeStatus(id: string): Promise<{ online: boolean; info: NodeInfo | null; error: string | null }> {
  const node = getNode(id);
  try {
    return { online: true, info: await callNode<NodeInfo>(node.url, node.api_key, '/info', 3000), error: null };
  } catch (err) {
    return { online: false, info: null, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

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

const transfers = new Map<string, TransferState>();

export function getTransferState(serverId: string): TransferState | null {
  return transfers.get(serverId) ?? null;
}

type TransferMeta = Pick<
  ServerRecord,
  | 'name'
  | 'platform'
  | 'loader'
  | 'version'
  | 'build'
  | 'jar_file'
  | 'min_memory_mb'
  | 'max_memory_mb'
  | 'server_port'
  | 'extra_java_args'
  | 'extra_args'
  | 'steam_app_id'
  | 'steam_preset'
  | 'workshop'
  | 'steam_login'
  | 'steam_extra_flags'
  | 'launch_config'
  | 'docker_config'
>;

function setStatus(serverId: string, status: ServerStatus) {
  setServerStatus(serverId, status);
  publish(consoleTopic(serverId), { type: 'status', status });
}

/** Starts streaming an instance to another node. Returns immediately; poll getTransferState(). */
export function startTransfer(serverId: string, nodeId: string, deleteSource: boolean): TransferState {
  const server = getServer(serverId);
  if (!server) throw new HttpError(404, 'Server not found');
  if (isRunning(serverId)) throw new HttpError(409, 'Stop the instance before transferring it');
  if (server.status === 'installing' || server.status === 'updating' || server.status === 'transferring') {
    throw new HttpError(409, `Can't transfer while the instance is ${server.status}`);
  }
  const node = getNode(nodeId);
  const dir = instanceDir(serverId);
  if (!fs.existsSync(dir)) throw new HttpError(409, 'Instance has no files to transfer');

  const previousStatus = server.status;
  const state: TransferState = {
    state: 'running',
    nodeId,
    nodeName: node.name,
    bytesSent: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    remoteServerId: null,
    sourceDeleted: false,
    error: null,
  };
  transfers.set(serverId, state);
  setStatus(serverId, 'transferring');
  appendLine(serverId, `[Outpost] Transferring to node "${node.name}" (${node.url})…`);

  const meta: TransferMeta = {
    name: server.name,
    platform: server.platform,
    loader: server.loader,
    version: server.version,
    build: server.build,
    jar_file: server.jar_file,
    min_memory_mb: server.min_memory_mb,
    max_memory_mb: server.max_memory_mb,
    server_port: server.server_port,
    extra_java_args: server.extra_java_args,
    extra_args: server.extra_args,
    steam_app_id: server.steam_app_id,
    steam_preset: server.steam_preset,
    workshop: server.workshop,
    steam_login: server.steam_login,
    steam_extra_flags: server.steam_extra_flags,
    launch_config: server.launch_config,
    docker_config: server.docker_config,
  };

  void (async () => {
    // tar ships with Linux, macOS and Windows 10+; it streams, so multi-GB worlds never sit in memory.
    const tar = spawn('tar', ['-czf', '-', '-C', dir, '.'], { windowsHide: true });
    let tarError = '';
    tar.stderr.on('data', (chunk) => (tarError += chunk.toString()));
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        state.bytesSent += chunk.length;
        cb(null, chunk);
      },
    });
    tar.stdout.pipe(counter);

    try {
      const res = await fetch(`${node.url}/api/node-link/import`, {
        method: 'POST',
        headers: {
          [NODE_KEY_HEADER]: node.api_key,
          [LEGACY_NODE_KEY_HEADER]: node.api_key,
          [SERVER_META_HEADER]: Buffer.from(JSON.stringify(meta)).toString('base64url'),
          [LEGACY_SERVER_META_HEADER]: Buffer.from(JSON.stringify(meta)).toString('base64url'),
          'content-type': 'application/gzip',
        },
        body: Readable.toWeb(counter) as unknown as ReadableStream,
        // Required by Node's fetch for streaming request bodies.
        duplex: 'half',
      } as RequestInit & { duplex: 'half' });
      const body = (await res.json().catch(() => ({}))) as { serverId?: string; error?: string };
      const tarCode: number | null = tar.exitCode ?? (await new Promise((resolve) => tar.once('close', resolve)));
      if (tarCode !== 0) throw new Error(`tar failed (exit ${tarCode}): ${tarError.trim() || 'unknown error'}`);
      if (!res.ok || !body.serverId) throw new Error(body.error ?? `Remote node answered ${res.status}`);

      state.remoteServerId = body.serverId;
      appendLine(serverId, `[Outpost] Transfer complete — ${(state.bytesSent / 1024 / 1024).toFixed(1)} MB sent to "${node.name}"`);
      if (deleteSource) {
        forgetServerSchedules(serverId);
        deleteServerRecord(serverId);
        state.sourceDeleted = true;
      } else {
        setStatus(serverId, 'stopped');
        // Keep auto-start off on the local copy so the same world can't run on two nodes after a reboot.
        updateServerRecord(serverId, { autoStart: false });
      }
      state.state = 'done';
    } catch (err) {
      tar.kill();
      state.state = 'failed';
      state.error = err instanceof Error ? err.message : String(err);
      appendLine(serverId, `[Outpost] Transfer failed: ${state.error}`, 'stderr');
      logger.error(`Transfer of ${serverId} to node ${node.id} failed`, err);
      if (getServer(serverId)) setStatus(serverId, previousStatus);
    } finally {
      state.finishedAt = new Date().toISOString();
    }
  })();

  return state;
}

/** Receiving side: creates a new instance from the metadata header and unpacks the streamed tar into it. */
export async function receiveTransfer(req: Request): Promise<ServerRecord> {
  const header = req.headers[SERVER_META_HEADER] ?? req.headers[LEGACY_SERVER_META_HEADER];
  if (typeof header !== 'string') throw new HttpError(400, 'Missing instance metadata');
  let meta: TransferMeta;
  try {
    meta = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid instance metadata');
  }
  if (!meta?.name || !['java', 'bedrock', 'steam', 'custom', 'docker'].includes(meta.platform)) throw new HttpError(400, 'Invalid instance metadata');

  const record = createServerRecord({
    name: meta.name,
    platform: meta.platform,
    loader: meta.loader,
    version: meta.version,
    minMemoryMb: meta.min_memory_mb,
    maxMemoryMb: meta.max_memory_mb,
    serverPort: meta.server_port,
    extraJavaArgs: meta.extra_java_args,
    extraArgs: meta.extra_args,
    createdBy: null,
    steamAppId: meta.steam_app_id,
    steamPreset: meta.steam_preset ?? null,
    steamLogin: meta.steam_login,
    steamExtraFlags: meta.steam_extra_flags,
    launchConfig: meta.launch_config ?? null,
    dockerConfig: meta.docker_config ?? null,
  });
  setServerStatus(record.id, 'transferring');

  try {
    const dir = instanceDir(record.id);
    // tar refuses absolute paths and ".." members by default (GNU tar and bsdtar alike).
    const tar = spawn('tar', ['-xzf', '-', '--no-same-owner', '-C', dir], { windowsHide: true });
    let tarError = '';
    tar.stderr.on('data', (chunk) => (tarError += chunk.toString()));
    req.pipe(tar.stdin);
    const code: number | null = await new Promise((resolve, reject) => {
      tar.once('error', reject);
      tar.once('close', resolve);
      req.once('aborted', () => reject(new Error('Sender disconnected mid-transfer')));
    });
    if (code !== 0) throw new Error(`tar failed (exit ${code}): ${tarError.trim() || 'unknown error'}`);

    applyTransferredFields(record.id, meta);
    setServerStatus(record.id, 'stopped');
    appendLine(record.id, `[Outpost] Received "${meta.name}" from another node`);
    return getServer(record.id)!;
  } catch (err) {
    deleteServerRecord(record.id);
    throw new HttpError(500, err instanceof Error ? err.message : String(err));
  }
}

/** A transfer interrupted by a panel restart leaves its instance stuck in 'transferring'. */
export function recoverInterruptedTransfers(): void {
  for (const server of listServers()) {
    if (server.status === 'transferring') setServerStatus(server.id, 'stopped');
  }
}
