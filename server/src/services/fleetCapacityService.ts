import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { db, prep } from '../db/db.js';
import { DATA_DIR } from '../utils/paths.js';
import { HttpError } from '../utils/asyncHandler.js';
import { listServers, getServer } from './serverService.js';
import { limitsOf } from './limitsService.js';
import { allocationPools } from './allocationService.js';
import { nodePolicy, fleetInventory, remoteNode } from './fleetService.js';
import { readWorkflow, writeWorkflow, boundedNumber } from './workflowStore.js';
import { findPresetFor } from './steamGames.js';
import { sha256 } from './fleetSecurity.js';
export interface CapacityRequest {
    memoryMb: number;
    cpuPercent: number;
    diskMb: number;
    platform: 'java' | 'bedrock' | 'steam';
    steamPreset?: string;
    steamAppId?: string;
    poolId?: string;
    basePort?: number;
    tags: string[];
    roles: {
        role: string;
        offset: number;
        protocol: 'tcp' | 'udp' | 'both';
    }[];
}
export interface CapacityLease {
    id: string;
    resources: CapacityRequest;
    ports: {
        role: string;
        port: number;
        protocol: string;
    }[];
    expires: number;
    server_id: string | null;
}
export function capacityPolicy() { return readWorkflow('capacity-policy', 'local', { reserveDiskMb: 2048, reserveCpuPercent: 100 }); }
export function saveCapacityPolicy(input: Record<string, unknown>) { const p = { reserveDiskMb: boundedNumber(input.reserveDiskMb, 0, 10 ** 10, 'Disk reserve MiB'), reserveCpuPercent: boundedNumber(input.reserveCpuPercent, 0, 1000000, 'CPU reserve percent') }; writeWorkflow('capacity-policy', 'local', p); return p; }
export function activeCapacityLeases() {
    return (prep('SELECT * FROM fleet_capacity_leases WHERE server_id IS NULL AND expires>?').all(Date.now()) as {
        id: string;
        resources: string;
        ports: string;
        expires: number;
        server_id: null;
    }[]).map(r => ({ ...r, resources: JSON.parse(r.resources) as CapacityRequest, ports: JSON.parse(r.ports) as CapacityLease['ports'] }));
}
export function localCapacity() { const servers = listServers(), stat = fs.statfsSync(DATA_DIR), policy = capacityPolicy(); return { protocolVersion: 1, admissionPolicy: nodePolicy('local'), at: Date.now(), totalMemoryMb: Math.floor(os.totalmem() / 1048576), freeMemoryMb: Math.floor(os.freemem() / 1048576), assignedMemoryMb: servers.reduce((n, s) => n + s.max_memory_mb, 0), totalCpuPercent: os.cpus().length * 100, assignedCpuPercent: servers.reduce((n, s) => n + (limitsOf(s).cpuPercent ?? 0), 0), totalDiskMb: Math.floor(Number(stat.blocks) * Number(stat.bsize) / 1048576), freeDiskMb: Math.floor(Number(stat.bavail) * Number(stat.bsize) / 1048576), assignedDiskMb: servers.reduce((n, s) => n + (limitsOf(s).diskMb ?? 0), 0), unlimitedCpuInstances: servers.filter(s => limitsOf(s).cpuPercent === null).length, unlimitedDiskInstances: servers.filter(s => limitsOf(s).diskMb === null).length, policy, leases: activeCapacityLeases(), auxiliaryPorts: prep('SELECT server_id,role,port,protocol FROM auxiliary_ports').all() }; }
export function validateCapacity(input: unknown): CapacityRequest {
    const r = input as CapacityRequest;
    if (!r || !['java', 'bedrock', 'steam'].includes(r.platform))
        throw new HttpError(400, 'Choose Java, Bedrock or Steam');
    boundedNumber(r.memoryMb, 128, 4194304, 'Memory MiB');
    boundedNumber(r.cpuPercent, 0, 25600, 'CPU percent');
    if (r.cpuPercent > 0 && r.cpuPercent < 10)
        throw new HttpError(400, 'CPU must be zero (unlimited) or at least 10 percent');
    boundedNumber(r.diskMb, 100, 100 * 1024 * 1024, 'Disk MiB');
    if (![r.memoryMb, r.cpuPercent, r.diskMb].every(Number.isSafeInteger))
        throw new HttpError(400, 'Resource budgets must be whole numbers');
    if ((r.steamPreset != null && (typeof r.steamPreset !== 'string' || r.steamPreset.length > 100)) || (r.steamAppId != null && (typeof r.steamAppId !== 'string' || !/^[0-9]{1,12}$/.test(r.steamAppId))) || (r.poolId !== undefined && (typeof r.poolId !== 'string' || r.poolId.length > 100)))
        throw new HttpError(400, 'Invalid preset/App ID/port pool');
    if (!Array.isArray(r.tags) || r.tags.length > 20 || !r.tags.every(t => typeof t === 'string' && /^[\w.-]{1,40}$/.test(t)) || !Array.isArray(r.roles) || !r.roles.length || r.roles.length > 16 || !r.roles.every(p => p && typeof p.role === 'string' && /^[\w/-]{1,40}$/.test(p.role) && Number.isInteger(p.offset) && p.offset >= 0 && p.offset <= 64511 && ['tcp', 'udp', 'both'].includes(p.protocol)) || !r.roles.some(p => p.offset === 0 && p.role.startsWith('game')) || new Set(r.roles.map(p => p.offset)).size !== r.roles.length || new Set(r.roles.map(p => p.role)).size !== r.roles.length || r.roles.filter(p => p.role.startsWith('game')).length !== 1)
        throw new HttpError(400, 'Provide unique, valid port offsets including game offset zero');
    if (r.basePort !== undefined && (!Number.isInteger(r.basePort) || r.basePort < 1024 || r.basePort > 65535))
        throw new HttpError(400, 'Invalid base port');
    return { memoryMb: r.memoryMb, cpuPercent: r.cpuPercent, diskMb: r.diskMb, platform: r.platform, steamPreset: r.steamPreset ?? undefined, steamAppId: r.steamAppId ?? undefined, poolId: r.poolId ?? 'auto', basePort: r.basePort, tags: [...r.tags], roles: r.roles.map(p => ({ ...p })) };
}
export function evaluateCapacity(request: CapacityRequest, inventory: ReturnType<typeof localCapacity>, policy: ReturnType<typeof nodePolicy>, servers: {
    port: number;
}[], pools: ReturnType<typeof allocationPools>, hostPlatform: string) {
    const destination = inventory.admissionPolicy ?? policy;
    const instanceLimit = Math.min(...[policy.maxInstances, destination.maxInstances].filter(n => n > 0), Infinity);
    const leases = inventory.leases ?? [], held = { memoryMb: leases.reduce((n, l) => n + l.resources.memoryMb, 0), cpuPercent: leases.reduce((n, l) => n + l.resources.cpuPercent, 0), diskMb: leases.reduce((n, l) => n + l.resources.diskMb, 0) };
    const available = { memoryMb: Math.min(inventory.totalMemoryMb - inventory.assignedMemoryMb, inventory.freeMemoryMb) - Math.max(policy.reserveMemoryMb, destination.reserveMemoryMb) - held.memoryMb, cpuPercent: inventory.totalCpuPercent - inventory.assignedCpuPercent - inventory.policy.reserveCpuPercent - held.cpuPercent, diskMb: Math.min(inventory.totalDiskMb - inventory.assignedDiskMb, inventory.freeDiskMb) - inventory.policy.reserveDiskMb - held.diskMb };
    const reasons: string[] = [];
    if (!policy.enabled || !destination.enabled)
        reasons.push('Host admission is disabled');
    if (servers.length + leases.length >= instanceLimit)
        reasons.push('Instance/lease count reaches host policy limit');
    for (const key of ['memoryMb', 'cpuPercent', 'diskMb'] as const)
        if (request[key] > available[key])
            reasons.push(`${key}: needs ${request[key]}, available ${Math.max(0, Math.floor(available[key]))}`);
    if (!request.tags.every(t => policy.tags.includes(t)))
        reasons.push('Required controller placement tags are missing');
    if (!request.tags.every(t => destination.tags.includes(t)))
        reasons.push('Required destination admission tags are missing');
    const preset = request.platform === 'steam' ? findPresetFor({ steam_preset: request.steamPreset ?? null, steam_app_id: request.steamAppId ?? null }) : undefined;
    if (request.platform === 'steam' && !preset)
        reasons.push('A curated Steam preset/App ID is required');
    if (preset?.hosts && !preset.hosts.includes(hostPlatform as NodeJS.Platform))
        reasons.push(`Game does not support host OS ${hostPlatform}`);
    const used = new Set([...servers.map(s => s.port), ...pools.flatMap(p => p.allocations.map(a => a.port)), ...(inventory.auxiliaryPorts ?? []).map(p => Number(p.port)), ...leases.flatMap(l => l.ports.map(p => p.port))]);
    let ports: CapacityLease['ports'] = [];
    const ranges = request.basePort ? [{ first: request.basePort, last: request.basePort, protocol: 'both' }] : pools.filter(p => (request.poolId === 'auto' || p.id === request.poolId)).map(p => ({ first: p.first_port, last: p.last_port, protocol: p.protocol, maximum: p.last_port }));
    outer: for (const range of ranges)
        for (let base = range.first; base <= range.last; base++) {
            if (request.roles.every(r => base + r.offset <= 65535 && (!('maximum' in range) || base + r.offset <= Number(range.maximum)) && !used.has(base + r.offset) && (range.protocol === 'both' || r.protocol === range.protocol))) {
                ports = request.roles.map(r => ({ role: r.role, port: base + r.offset, protocol: r.protocol }));
                break outer;
            }
        }
    if (!ports.length)
        reasons.push('No collision-free complete port bundle fits the requested pool/base port');
    return { eligible: !reasons.length, reasons, available, held, ports, warnings: [...(inventory.unlimitedCpuInstances ? ['Existing instances without CPU limits can exceed planned CPU reservations.'] : []), ...(inventory.unlimitedDiskInstances ? ['Existing instances without disk quotas can grow beyond planned disk reservations.'] : []), 'Placement checks reservations, not OS listener availability, game licenses or every runtime dependency.'] };
}
export async function explainFleetCapacity(input: unknown, nodeId = 'auto') {
    const request = validateCapacity(input), nodes = await fleetInventory();
    return { request, hosts: nodes.filter(n => nodeId === 'auto' || n.id === nodeId).map(n => {
            const capacity = (n.inventory as unknown as {
                capacity?: ReturnType<typeof localCapacity>;
            })?.capacity;
            if (n.error || !capacity)
                return { id: n.id, name: n.name, eligible: false, reasons: [n.error ?? 'Host needs the capacity protocol update'], warnings: [], ports: [], available: null };
            return { id: n.id, name: n.name, reservations: capacity.leases, ...evaluateCapacity(request, capacity, n.policy, n.inventory.servers, n.inventory.pools, n.inventory.info.platform) };
        }).sort((a, b) => Number(b.eligible) - Number(a.eligible) || ((b.available?.memoryMb ?? 0) - (a.available?.memoryMb ?? 0))) };
}
export function reserveLocalCapacity(id: string, input: unknown): CapacityLease {
    if (!/^[a-f0-9-]{36}$/i.test(id))
        throw new HttpError(400, 'Reservation UUID required');
    const request = validateCapacity(input), hash = sha256(JSON.stringify(request));
    db.exec('BEGIN IMMEDIATE');
    try {
        const old = prep('SELECT * FROM fleet_capacity_leases WHERE id=?').get(id) as {
            request_hash: string;
            resources: string;
            ports: string;
            expires: number;
            server_id: string | null;
        } | undefined;
        if (old) {
            if (old.request_hash !== hash)
                throw new HttpError(409, 'Reservation ID belongs to another request');
            if (!old.server_id && old.expires < Date.now())
                throw new HttpError(409, 'Reservation expired; review capacity and use a new request ID');
            db.exec('COMMIT');
            return { id, ...old, resources: request, ports: JSON.parse(old.ports) };
        }
        const info = localCapacity(), result = evaluateCapacity(request, info, nodePolicy('local'), listServers().map(s => ({ port: s.server_port })), allocationPools(), process.platform);
        if (!result.eligible)
            throw new HttpError(409, result.reasons.join('; '));
        const expires = Date.now() + 10 * 60000;
        prep('INSERT INTO fleet_capacity_leases(id,request_hash,resources,ports,expires,created_at) VALUES (?,?,?,?,?,?)').run(id, hash, JSON.stringify(request), JSON.stringify(result.ports), expires, Date.now());
        db.exec('COMMIT');
        return { id, resources: request, ports: result.ports, expires, server_id: null };
    }
    catch (e) {
        db.exec('ROLLBACK');
        throw e;
    }
}
export function capacityLease(id: string): CapacityLease {
    const r = prep('SELECT * FROM fleet_capacity_leases WHERE id=?').get(id) as {
        resources: string;
        ports: string;
        expires: number;
        server_id: string | null;
    } | undefined;
    if (!r)
        throw new HttpError(404, 'Reservation not found');
    return { id, ...r, resources: JSON.parse(r.resources), ports: JSON.parse(r.ports) };
}
export function commitCapacity(id: string, serverId: string) {
    const lease = capacityLease(id), server = getServer(serverId);
    if (lease.server_id === serverId)
        return;
    if (lease.server_id || lease.expires < Date.now() || !server || server.max_memory_mb > lease.resources.memoryMb || server.server_port !== lease.ports.find(p => p.role.startsWith('game'))?.port)
        throw new HttpError(409, 'Reservation is expired, consumed or does not match the instance');
    db.exec('BEGIN IMMEDIATE');
    try {
        for (const p of lease.ports)
            prep('INSERT INTO auxiliary_ports(server_id,role,port,protocol) VALUES (?,?,?,?)').run(serverId, p.role, p.port, p.protocol);
        prep('UPDATE fleet_capacity_leases SET server_id=? WHERE id=? AND server_id IS NULL').run(serverId, id);
        db.exec('COMMIT');
    }
    catch (e) {
        db.exec('ROLLBACK');
        throw e;
    }
}
export function releaseCapacity(id: string) {
    const r = capacityLease(id);
    if (r.server_id)
        throw new HttpError(409, 'Consumed reservations belong to the created instance');
    prep('DELETE FROM fleet_capacity_leases WHERE id=?').run(id);
}
export async function reserveFleetCapacity(nodeId: string, id: string, input: unknown) { return nodeId === 'local' ? reserveLocalCapacity(id, input) : remoteNode<CapacityLease>(nodeId, '/capacity/reserve', { id, request: input }); }
export function capacityPortClaims() { return activeCapacityLeases().flatMap(l => l.ports.map(p => p.port)); }
export function assertCapacityAdmission(memoryMb: number, leaseId?: string, platform?: string, port?: number) {
    const leases = activeCapacityLeases(), own = leaseId ? capacityLease(leaseId) : null;
    if (own && (own.server_id || own.expires < Date.now() || memoryMb > own.resources.memoryMb || platform !== own.resources.platform || port !== own.ports.find(p => p.role.startsWith('game'))?.port))
        throw new HttpError(409, 'Capacity reservation does not match this instance request');
    if (leases.length) {
        const c = localCapacity(), held = leases.filter(l => l.id !== leaseId).reduce((n, l) => n + l.resources.memoryMb, 0), available = Math.min(c.totalMemoryMb - c.assignedMemoryMb, c.freeMemoryMb) - nodePolicy('local').reserveMemoryMb - held;
        if (memoryMb > available)
            throw new HttpError(409, 'Active fleet reservations leave insufficient memory for this creation');
    }
}
