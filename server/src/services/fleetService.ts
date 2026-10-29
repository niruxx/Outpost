import crypto from 'node:crypto';
import { prep } from '../db/db.js';
import { listNodes, getNode, localNodeInfo, type NodeInfo } from './nodeService.js';
import { listServers } from './serverService.js';
import { allocationPools } from './allocationService.js';
import { getSetting, setSetting } from './systemSettingsService.js';
import { HttpError } from '../utils/asyncHandler.js';
import { findPresetFor } from './steamGames.js';

export interface NodeInventory { info: NodeInfo; servers: { id: string; name: string; platform: string; status: string; memoryMb: number; port: number }[]; pools: ReturnType<typeof allocationPools> }
export function localInventory(): NodeInventory {
  return { info: localNodeInfo(), pools: allocationPools(), servers: listServers().map(s => ({ id: s.id, name: s.name, platform: s.platform, status: s.status, memoryMb: s.max_memory_mb, port: s.server_port })) };
}
export interface NodePolicy { enabled: boolean; reserveMemoryMb: number; maxInstances: number; tags: string[] }
export function nodePolicy(id: string): NodePolicy {
  try { return JSON.parse(getSetting(`fleet_policy:${id}`) ?? 'null') ?? { enabled: true, reserveMemoryMb: 1024, maxInstances: 0, tags: [] }; } catch { return { enabled: false, reserveMemoryMb: 1024, maxInstances: 0, tags: [] }; }
}
export function saveNodePolicy(id: string, input: NodePolicy) {
  if (id !== 'local') getNode(id);
  if (!input || typeof input.enabled !== 'boolean' || !Number.isInteger(input.reserveMemoryMb) || input.reserveMemoryMb < 0 || input.reserveMemoryMb > 4_194_304 || !Number.isInteger(input.maxInstances) || input.maxInstances < 0 || input.maxInstances > 10000 || !Array.isArray(input.tags) || input.tags.length > 20 || !input.tags.every(t => typeof t === 'string' && /^[\w.-]{1,40}$/.test(t))) throw new HttpError(400, 'Invalid node policy');
  const policy = { enabled: input.enabled, reserveMemoryMb: input.reserveMemoryMb, maxInstances: input.maxInstances, tags: [...new Set(input.tags)] };
  setSetting(`fleet_policy:${id}`, JSON.stringify(policy)); return policy;
}
export async function remoteNode<T>(id: string, endpoint: string, input?: unknown, requestId?: string): Promise<T> {
  const node = getNode(id);
  const response = await fetch(`${node.url}/api/node-link${endpoint}`, { method: input === undefined ? 'GET' : 'POST', redirect: 'error', headers: { 'x-outpost-node-key': node.api_key, ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...(requestId ? { 'X-Outpost-Provision-Id': requestId } : {}) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(input === undefined ? 8000 : 180000) });
  const result = await response.json() as { error?: string };
  if (!response.ok) throw new HttpError(response.status === 409 ? 409 : 502, result.error ?? `Node request failed (${response.status})`);
  return result as T;
}
export async function fleetInventory() {
  const rows = [{ id: 'local', name: 'This host', url: '', policy: nodePolicy('local'), inventory: localInventory(), error: null as string | null }];
  const nodes = listNodes();
  for (let i = 0; i < nodes.length; i += 4) rows.push(...await Promise.all(nodes.slice(i, i + 4).map(async n => {
    try { return { id: n.id, name: n.name, url: n.url, policy: nodePolicy(n.id), inventory: await remoteNode<NodeInventory>(n.id, '/inventory'), error: null }; }
    catch (error) { return { id: n.id, name: n.name, url: n.url, policy: nodePolicy(n.id), inventory: null as unknown as NodeInventory, error: error instanceof Error ? error.message : 'Node unavailable' }; }
  })));
  return rows;
}
export async function planPlacement(requestId: string, definition: Record<string, unknown>, nodeId = 'auto', tags: string[] = []) {
  if (!/^[0-9a-f-]{36}$/i.test(requestId) || !definition || !['java', 'bedrock', 'steam'].includes(String(definition.platform)) || definition.steamLogin !== undefined) throw new HttpError(400, 'Use a UUID request ID and Java/Bedrock/Steam definition without Steam credentials (configure those on the destination)');
  const hash = crypto.createHash('sha256').update(JSON.stringify({ definition, nodeId, tags })).digest('hex');
  const old = prep('SELECT * FROM fleet_placements WHERE id=?').get(requestId) as { request_hash: string; node_id: string; server_id: string | null; status: string } | undefined;
  if (old) { if (old.request_hash !== hash) throw new HttpError(409, 'This provisioning ID belongs to another request'); return { nodeId: old.node_id, serverId: old.server_id, status: old.status }; }
  if (!Array.isArray(tags) || tags.length > 20 || !tags.every(t => /^[\w.-]{1,40}$/.test(t))) throw new HttpError(400, 'Invalid placement tags');
  const memory = Number(definition.maxMemoryMb ?? 2048);
  if (!Number.isInteger(memory) || memory < 128 || memory > 4_194_304) throw new HttpError(400, 'Invalid requested memory');
  const nodes = await fleetInventory();
  const preset = definition.platform === 'steam' ? findPresetFor({ steam_app_id: String(definition.steamAppId ?? ''), steam_preset: typeof definition.steamPreset === 'string' ? definition.steamPreset : null }) : undefined;
  const protocol = definition.platform === 'java' ? 'tcp' : preset?.portProtocol ?? 'udp';
  const hasPool = (inventory: NodeInventory) => !definition.allocationPoolId || inventory.pools.some(pool => {
    if ((definition.allocationPoolId !== 'auto' && pool.id !== definition.allocationPoolId) || (pool.protocol !== 'both' && pool.protocol !== protocol)) return false;
    const used = new Set([...inventory.servers.map(s => s.port), ...pool.allocations.map(a => a.port)]);
    for (let port = pool.first_port; port <= pool.last_port; port++) if (!used.has(port)) return true;
    return false;
  });
  const candidates = nodes.filter(n => (nodeId === 'auto' || n.id === nodeId) && n.inventory && !n.error && n.policy.enabled && tags.every(t => n.policy.tags.includes(t)) && hasPool(n.inventory) && (!preset?.hosts || preset.hosts.includes(n.inventory.info.platform as NodeJS.Platform)) && (!n.policy.maxInstances || n.inventory.info.instances < n.policy.maxInstances) && Number.isFinite(n.inventory.info.totalMemoryMb) && n.inventory.info.totalMemoryMb - n.inventory.info.reservedMemoryMb - n.policy.reserveMemoryMb >= memory && n.inventory.info.freeMemoryMb - n.policy.reserveMemoryMb >= memory);
  candidates.sort((a, b) => (b.inventory.info.totalMemoryMb - b.inventory.info.reservedMemoryMb - b.policy.reserveMemoryMb) - (a.inventory.info.totalMemoryMb - a.inventory.info.reservedMemoryMb - a.policy.reserveMemoryMb));
  if (!candidates[0]) throw new HttpError(409, 'No enabled, reachable host meets memory, instance, platform, allocation and tag requirements');
  const inserted = prep('INSERT OR IGNORE INTO fleet_placements(id,node_id,request_hash,status,at) VALUES (?,?,?,?,?)').run(requestId, candidates[0].id, hash, 'pending', Date.now());
  if (!inserted.changes) return planPlacement(requestId, definition, nodeId, tags);
  return { nodeId: candidates[0].id, serverId: null, status: 'pending' };
}
export function placementResult(id: string, serverId?: string, error?: string) { prep('UPDATE fleet_placements SET status=?,server_id=COALESCE(?,server_id),error=? WHERE id=?').run(error ? 'uncertain/failed' : 'created', serverId ?? null, error?.slice(0, 1000) ?? null, id); }
export function placements() { return prep('SELECT id,node_id,status,server_id,error,at FROM fleet_placements ORDER BY at DESC LIMIT 100').all(); }
