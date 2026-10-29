import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import { db, prep } from '../db/db.js';
import { HttpError } from '../utils/asyncHandler.js';
export interface Pool { id: string; name: string; address: string; protocol: 'tcp' | 'udp' | 'both'; first_port: number; last_port: number }
export function allocationPools() {
  return (prep('SELECT * FROM allocation_pools ORDER BY name').all() as unknown as Pool[]).map(p => ({ ...p, allocations: prep('SELECT port,server_id,expires FROM allocations WHERE pool_id=? AND (server_id IS NOT NULL OR expires>?)').all(p.id, Date.now()) }));
}
export function createAllocationPool(input: { name?: unknown; address?: unknown; protocol?: unknown; firstPort?: unknown; lastPort?: unknown }) {
  const { name, address, protocol, firstPort, lastPort } = input;
  if (typeof name !== 'string' || !name.trim() || name.length > 100 || typeof address !== 'string' || !net.isIPv4(address) || !['tcp', 'udp', 'both'].includes(String(protocol)) || !Number.isInteger(firstPort) || !Number.isInteger(lastPort) || Number(firstPort) < 1024 || Number(lastPort) > 65535 || Number(lastPort) < Number(firstPort) || Number(lastPort) - Number(firstPort) > 10000) throw new HttpError(400, 'Provide name, host IPv4, tcp/udp/both and a range of at most 10001 ports (1024-65535)');
  if (address !== '0.0.0.0' && !Object.values(os.networkInterfaces()).flat().some(i => i?.address === address)) throw new HttpError(400, 'The allocation address must exist on this host (or use 0.0.0.0)');
  if ((prep('SELECT * FROM allocation_pools').all() as unknown as Pool[]).some(p => p.first_port <= Number(lastPort) && p.last_port >= Number(firstPort))) throw new HttpError(409, 'Allocation pool port ranges cannot overlap on this host, including across IPs/protocols');
  const id = crypto.randomUUID(); prep('INSERT INTO allocation_pools(id,name,address,protocol,first_port,last_port) VALUES (?,?,?,?,?,?)').run(id, name.trim(), address, String(protocol), Number(firstPort), Number(lastPort)); return { id };
}
export function removeAllocationPool(id: string) {
  prep('DELETE FROM allocations WHERE server_id IS NULL AND expires<=?').run(Date.now());
  if (prep('SELECT port FROM allocations WHERE pool_id=? LIMIT 1').get(id)) throw new HttpError(409, 'Release this pool\'s assignments/reservations first');
  prep('DELETE FROM allocation_pools WHERE id=?').run(id);
}
export function instanceAllocation(id: string) { return prep('SELECT p.*, a.port FROM allocations a JOIN allocation_pools p ON p.id=a.pool_id WHERE a.server_id=?').get(id) as (Pool & { port: number }) | undefined; }
export function reserveAllocation(poolId: string, protocol: string) {
  db.exec('BEGIN IMMEDIATE');
  try {
    prep('DELETE FROM allocations WHERE server_id IS NULL AND expires<=?').run(Date.now());
    const pools = prep('SELECT * FROM allocation_pools ORDER BY name').all() as unknown as Pool[];
    const compatible = pools.filter(p => (poolId === 'auto' || p.id === poolId) && (p.protocol === 'both' || p.protocol === protocol));
    if (!compatible.length) throw new HttpError(409, 'No compatible allocation pool');
    const used = new Set((prep('SELECT server_port AS port FROM servers UNION SELECT port FROM allocations').all() as { port: number }[]).map(r => r.port));
    const pool = compatible.find(p => Array.from({ length: p.last_port - p.first_port + 1 }, (_, i) => p.first_port + i).some(port => !used.has(port)));
    const port = pool ? Array.from({ length: pool.last_port - pool.first_port + 1 }, (_, i) => pool.first_port + i).find(p => !used.has(p)) : undefined;
    if (!pool || !port) throw new HttpError(409, 'Allocation pool is full');
    const token = crypto.randomUUID(); prep('INSERT INTO allocations(pool_id,port,token,expires) VALUES (?,?,?,?)').run(pool.id, port, token, Date.now() + 120_000);
    db.exec('COMMIT'); return { token, port, address: pool.address, poolId: pool.id };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function commitAllocation(token: string, serverId: string) {
  const result = prep('UPDATE allocations SET server_id=?,token=NULL,expires=NULL WHERE token=? AND expires>? AND server_id IS NULL').run(serverId, token, Date.now());
  if (!result.changes) throw new HttpError(409, 'Allocation lease expired');
}
export function releaseAllocation(token: string) { prep('DELETE FROM allocations WHERE token=? AND server_id IS NULL').run(token); }
export function assertManualPort(port: number, serverId?: string) {
  const assigned = instanceAllocation(serverId ?? '');
  if (assigned && assigned.port !== port) throw new HttpError(409, 'This instance has an allocated port; release its assignment before changing ports');
  const conflict = prep('SELECT port FROM allocations WHERE port=? AND (server_id IS NOT NULL OR expires>?) AND (server_id IS NULL OR server_id<>?)').get(port, Date.now(), serverId ?? '');
  if (conflict) throw new HttpError(409, 'Port is reserved by an allocation pool assignment');
}
