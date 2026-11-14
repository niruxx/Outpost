import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import AdmZip from 'adm-zip';
import { prep } from '../db/db.js';
import { DATA_DIR, instanceDir, safeJoinReal } from '../utils/paths.js';
import { HttpError } from '../utils/asyncHandler.js';
import { getServer, createServerRecord, setServerStatus, deleteServerRecord, setServerVersion, setLaunchConfig, updateServerRecord } from './serverService.js';
import { isRunning, cancelAutoRestart } from './processManager.js';
import { createBackup, resolveBackupPath } from './backupService.js';
import { verifyZip, hashFile } from './verifiedBackupService.js';
import { getDiskUsage } from './diskUsageService.js';
import { scanIngestedPath } from './antivirusService.js';
import { reserveLocalCapacity, commitCapacity, validateCapacity, evaluateCapacity, type CapacityRequest } from './fleetCapacityService.js';
import { fleetInventory, remoteNode } from './fleetService.js';
import { getNode, localNodeInfo } from './nodeService.js';
import { readWorkflow, writeWorkflow } from './workflowStore.js';
import { constantEqual, seal, unseal, sha256, trustedTransport, requireFleetAdmin } from './fleetSecurity.js';
import { listUsers } from './userService.js';
import { writeServerProperties } from './propertiesService.js';
import { ALL_LOADERS } from '../types/index.js';
import { findPresetFor } from './steamGames.js';
import { saveLimits } from './limitsService.js';
import { beginJob, progressJob, finishJob } from './jobService.js';
interface Snapshot {
    ticketId: string;
    ticketKey: string;
    url: string;
    sha256: string;
    sizeBytes: number;
    logicalMb: number;
    os: string;
    arch: string;
    meta: {
        name: string;
        platform: 'java' | 'bedrock' | 'steam';
        loader: string;
        version: string;
        jar: string | null;
        gameSettings?: string | null;
        build: string | null;
        minMemoryMb: number;
        maxMemoryMb: number;
        steamAppId: string | null;
        steamPreset: string | null;
    };
    warnings: string[];
}
interface Recovery {
    id: string;
    owner: string;
    sourceNodeId: string;
    sourceServerId: string;
    destinationNodeId: string;
    destinationServerId?: string;
    mode: 'standby' | 'evacuate';
    state: string;
    request: CapacityRequest;
    sourcePublicUrl: string;
    snapshot?: Omit<Snapshot, 'ticketKey'> & {
        ticketKey: string;
    };
    logs: string[];
    at: number;
    error?: string;
    digest?: string;
}
function record(id: string) {
    const row = prep('SELECT data FROM fleet_recovery_runs WHERE id=?').get(id) as {
        data: string;
    } | undefined;
    if (!row)
        throw new HttpError(404, 'Recovery run not found');
    return JSON.parse(row.data) as Recovery;
}
function save(r: Recovery) { prep('INSERT INTO fleet_recovery_runs(id,owner,data,updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at').run(r.id, r.owner, JSON.stringify(r), Date.now()); }
export function recoveryRows() {
    return (prep("SELECT data FROM fleet_recovery_runs WHERE id NOT LIKE '%:destination' ORDER BY updated_at DESC LIMIT 100").all() as {
        data: string;
    }[]).map(r => { const v = JSON.parse(r.data) as Recovery; return { ...v, snapshot: v.snapshot ? { ...v.snapshot, ticketKey: undefined, meta: undefined } : undefined }; });
}
export function assertRecoveryIdle(id: string) {
    const fence = readWorkflow<{
        active: boolean;
        run: string;
        reason: string;
    } | null>('recovery-fence', id, null);
    if (fence?.active)
        throw new HttpError(423, `Recovery fence: ${fence.reason}; run ${fence.run}`);
}
export function recoveryFence(id: string) { return readWorkflow('recovery-fence', id, { active: false, run: '', reason: '' }); }
export function setRecoveryFence(id: string, run: string, active: boolean, reason: string) {
    if (!getServer(id))
        throw new HttpError(404, 'Instance not found');
    if (isRunning(id))
        throw new HttpError(409, 'Stop the instance before changing its recovery fence');
    const old = recoveryFence(id);
    if (old.active && old.run !== run)
        throw new HttpError(409, 'Another recovery run owns the source fence');
    writeWorkflow('recovery-fence', id, { active, run, reason, at: Date.now() });
    if (active) {
        cancelAutoRestart(id, 'Recovery fence');
        updateServerRecord(id, { autoStart: false, restartPolicy: 'never' });
    }
    return recoveryFence(id);
}
function uuid(id: string) {
    if (!/^[a-f0-9-]{36}$/i.test(id))
        throw new HttpError(400, 'Recovery UUID required');
}
export async function prepareRecoverySnapshot(run: string, serverId: string, publicUrl: string): Promise<Snapshot> {
    uuid(run);
    const server = getServer(serverId);
    if (!server || !['java', 'bedrock', 'steam'].includes(server.platform) || server.suspended)
        throw new HttpError(409, 'Only unsuspended managed Java/Bedrock/Steam instances can be recovered');
    if (prep("SELECT server_id FROM billing_services WHERE server_id=? AND state!='terminated'").get(serverId))
        throw new HttpError(409, 'Move/reconcile billing ownership before migrating a billing-managed service');
    if (isRunning(serverId) || ['installing', 'updating', 'transferring'].includes(server.status))
        throw new HttpError(409, 'Stop the source and finish other operations first');
    if (getDiskUsage(serverId).serverBytes > 1024 ** 3)
        throw new HttpError(413, 'Verified recovery v1 supports instance trees up to 1 GiB; use an externally verified large-world recovery procedure');
    const url = trustedTransport(publicUrl).origin;
    if (server.steam_preset === 'valheim') {
        const config = JSON.parse(server.game_settings ?? '{}');
        if (config.controls?.values?.worldStorage !== 'instance')
            throw new HttpError(409, 'Valheim recovery requires instance-local world storage; external home-directory worlds are not included');
    }
    setRecoveryFence(serverId, run, true, 'Source snapshot/handover in progress');
    const backup = await createBackup(serverId, 'fleet-recovery');
    await verifyZip(serverId, backup.fileName, true);
    const file = resolveBackupPath(serverId, backup.fileName), digest = await hashFile(file), sizeBytes = fs.statSync(file).size;
    if (sizeBytes > 1024 ** 3)
        throw new HttpError(413, 'Recovery archive exceeds 1 GiB');
    const id = crypto.randomUUID(), key = crypto.randomBytes(32).toString('base64url');
    prep('INSERT INTO fleet_snapshot_tickets(id,secret_hash,server_id,file_name,digest,expires) VALUES (?,?,?,?,?,?)').run(id, sha256(key), serverId, backup.fileName, digest, Date.now() + 3600000);
    return { ticketId: id, ticketKey: key, url: `${url}/api/fleet-recovery/download/${id}`, sha256: digest, sizeBytes, logicalMb: Math.ceil(getDiskUsage(serverId).serverBytes / 1048576), os: process.platform, arch: process.arch, meta: { name: server.name, platform: server.platform as Snapshot['meta']['platform'], loader: server.loader, version: server.version, jar: server.jar_file, gameSettings: portableSettings(server.game_settings), build: server.build, minMemoryMb: server.min_memory_mb, maxMemoryMb: server.max_memory_mb, steamAppId: server.steam_app_id, steamPreset: server.steam_preset }, warnings: ['Accounts, permissions, billing links, external databases/storage and source-host credentials are not migrated.', 'Destination remains stopped and fenced until an administrator reviews network ports, licenses and game dependencies.', ...(server.launch_config ? ['Custom source launch overrides are omitted; reconfigure them on the destination.'] : []), ...(server.platform === 'steam' ? ['Steam recovery requires matching OS/architecture; native auxiliary ports and licenses require review.'] : [])] };
}
export function resolveRecoveryDownload(id: string, key: string) {
    const row = prep('SELECT * FROM fleet_snapshot_tickets WHERE id=?').get(id) as {
        secret_hash: string;
        expires: number;
        server_id: string;
        file_name: string;
    } | undefined;
    if (!row || row.expires < Date.now() || !constantEqual(sha256(key), row.secret_hash))
        throw new HttpError(401, 'Snapshot download ticket is invalid or expired');
    return resolveBackupPath(row.server_id, row.file_name);
}
export async function importRecoverySnapshot(run: string, snapshot: Snapshot, input: unknown) {
    uuid(run);
    const workerId = `${run}:destination`, old = prep('SELECT data FROM fleet_recovery_runs WHERE id=?').get(workerId) as {
        data: string;
    } | undefined;
    if (old) {
        const stored = JSON.parse(old.data) as {
            state: string;
            destinationServerId?: string;
            digest?: string;
        };
        if (stored.digest !== snapshot.sha256)
            throw new HttpError(409, 'Recovery ID belongs to another snapshot');
        if (stored.state === 'standby')
            return { serverId: stored.destinationServerId, digest: stored.digest, fenced: true };
        throw new HttpError(409, 'Import is processing/interrupted; inspect the destination before retrying');
    }
    if (!snapshot || !snapshot.meta || typeof snapshot.meta.name !== 'string' || !snapshot.meta.name || snapshot.meta.name.length > 100 || !ALL_LOADERS.includes(snapshot.meta.loader as never) || typeof snapshot.meta.version !== 'string' || !snapshot.meta.version || snapshot.meta.version.length > 100 || !Number.isSafeInteger(snapshot.meta.minMemoryMb) || snapshot.meta.minMemoryMb < 128 || !Number.isSafeInteger(snapshot.meta.maxMemoryMb) || snapshot.meta.maxMemoryMb < snapshot.meta.minMemoryMb || !Number.isSafeInteger(snapshot.logicalMb) || snapshot.logicalMb < 0 || (snapshot.meta.jar !== null && (typeof snapshot.meta.jar !== 'string' || snapshot.meta.jar.startsWith('/') || /[\\:\x00-\x1f]/.test(snapshot.meta.jar) || snapshot.meta.jar.split('/').some(p => !p || p === '.' || p === '..'))))
        throw new HttpError(400, 'Invalid snapshot metadata');
    if (snapshot.meta.gameSettings !== undefined && snapshot.meta.gameSettings !== null) {
        if (typeof snapshot.meta.gameSettings !== 'string' || snapshot.meta.gameSettings.length > 1048576)
            throw new HttpError(400, 'Invalid portable game settings');
        JSON.parse(snapshot.meta.gameSettings);
    }
    const request = validateCapacity(input);
    if (snapshot.meta.platform !== request.platform || snapshot.meta.maxMemoryMb > request.memoryMb || snapshot.logicalMb > request.diskMb || !/^[a-f0-9]{64}$/.test(snapshot.sha256) || !Number.isSafeInteger(snapshot.sizeBytes) || snapshot.sizeBytes > 1024 ** 3 || snapshot.sizeBytes < 1)
        throw new HttpError(400, 'Snapshot metadata/resource request mismatch');
    if (request.platform === 'steam') {
        const sourcePreset = findPresetFor({ steam_preset: snapshot.meta.steamPreset, steam_app_id: snapshot.meta.steamAppId }), requestedPreset = findPresetFor({ steam_preset: request.steamPreset ?? null, steam_app_id: request.steamAppId ?? null });
        if (!sourcePreset || sourcePreset.id !== requestedPreset?.id || (snapshot.meta.steamAppId && snapshot.meta.steamAppId !== sourcePreset.appId))
            throw new HttpError(400, 'Requested Steam preset/App ID differs from snapshot or is unavailable on destination');
    }
    trustedTransport(snapshot.url);
    if (['steam', 'bedrock'].includes(snapshot.meta.platform) && (snapshot.os !== process.platform || snapshot.arch !== process.arch))
        throw new HttpError(409, 'Native server recovery requires matching OS and architecture');
    const owner = listUsers().find(u => u.role === 'admin' && !u.disabled);
    if (!owner)
        throw new HttpError(409, 'Complete owner setup on the destination');
    const lease = reserveLocalCapacity(run, request), state = { id: workerId, owner: owner.id, state: 'importing', digest: snapshot.sha256, at: Date.now(), logs: [] as string[] };
    save(state as unknown as Recovery);
    const job = beginJob('fleet-recovery-import', null), dir = await fsp.mkdtemp(path.join(DATA_DIR, 'recovery-')), archive = path.join(dir, 'snapshot.zip');
    let created: string | undefined;
    try {
        const response = await fetch(snapshot.url, { headers: { Authorization: `Bearer ${snapshot.ticketKey}` }, redirect: 'error', signal: AbortSignal.timeout(10 * 60000) });
        if (!response.ok || !response.body)
            throw new HttpError(502, 'Source snapshot download failed');
        let bytes = 0;
        const hash = crypto.createHash('sha256');
        await pipeline(Readable.fromWeb(response.body as never), new Transform({ transform(chunk, _enc, cb) {
                bytes += chunk.length;
                if (bytes > snapshot.sizeBytes || bytes > 1024 ** 3)
                    return cb(new Error('Snapshot download exceeds declared size'));
                hash.update(chunk);
                cb(null, chunk);
            } }), fs.createWriteStream(archive, { flags: 'wx', mode: 0o600 }));
        if (bytes !== snapshot.sizeBytes || hash.digest('hex') !== snapshot.sha256)
            throw new HttpError(422, 'Snapshot download checksum/length mismatch');
        await scanIngestedPath(archive);
        const record = createServerRecord({ name: `${snapshot.meta.name} (recovery)`, platform: snapshot.meta.platform, loader: snapshot.meta.loader as never, version: snapshot.meta.version, minMemoryMb: Math.min(snapshot.meta.minMemoryMb, request.memoryMb), maxMemoryMb: snapshot.meta.maxMemoryMb, serverPort: lease.ports.find(p => p.role.startsWith('game'))!.port, createdBy: owner.id, steamAppId: snapshot.meta.steamAppId, steamPreset: snapshot.meta.steamPreset, steamLogin: 'anonymous' });
        created = record.id;
        save({ ...state, destinationServerId: record.id } as unknown as Recovery);
        if (snapshot.meta.gameSettings)
            prep('UPDATE servers SET game_settings=? WHERE id=?').run(snapshot.meta.gameSettings, record.id);
        setRecoveryFence(record.id, run, true, 'Verified standby; activation review required');
        commitCapacity(run, record.id);
        saveLimits(record, { cpuPercent: request.cpuPercent || null, diskMb: Math.max(100, request.diskMb) });
        prep('UPDATE panel_jobs SET server_id=? WHERE id=?').run(record.id, job);
        const zip = new AdmZip(archive), entries = zip.getEntries();
        if (entries.length > 100000)
            throw new HttpError(413, 'Snapshot entry limit reached');
        let expanded = 0;
        const seen = new Set<string>();
        for (const entry of entries) {
            const rel = entry.entryName.replace(/\/$/, '');
            if (!rel || rel.startsWith('/') || /[\\:\x00-\x1f]/.test(rel) || rel.split('/').some(p => !p || p === '.' || p === '..') || ((entry.attr >>> 16) & 0xf000) === 0xa000 || seen.has(rel))
                throw new HttpError(400, 'Snapshot contains unsafe/duplicate paths or links');
            seen.add(rel);
            if (entry.isDirectory) {
                await fsp.mkdir(safeJoinReal(instanceDir(record.id), rel), { recursive: true });
                continue;
            }
            if (entry.header.size > 256 * 1048576 || (expanded += entry.header.size) > Math.min(20 * 1024 ** 3, request.diskMb * 1048576))
                throw new HttpError(413, 'Snapshot expansion limit reached');
            const target = safeJoinReal(instanceDir(record.id), rel);
            await fsp.mkdir(path.dirname(target), { recursive: true });
            await fsp.writeFile(target, entry.getData(), { flag: 'wx' });
            const mode = (entry.attr >>> 16) & 0o777;
            if (mode)
                await fsp.chmod(target, mode);
        }
        await scanIngestedPath(instanceDir(record.id), true);
        setServerVersion(record.id, snapshot.meta.version, snapshot.meta.jar, snapshot.meta.build);
        setLaunchConfig(record.id, null);
        if (['java', 'bedrock'].includes(record.platform))
            writeServerProperties(record.id, record.platform, { 'server-port': String(record.server_port), ...(record.platform === 'java' ? { 'server-ip': '127.0.0.1', 'enable-query': 'false', 'enable-rcon': 'false' } : { 'server-portv6': String(lease.ports.find(p => p.role === 'ipv6')?.port ?? record.server_port + 1) }) });
        setServerStatus(record.id, 'stopped');
        save({ ...state, state: 'standby', destinationServerId: record.id } as unknown as Recovery);
        finishJob(job);
        return { serverId: record.id, digest: snapshot.sha256, fenced: true };
    }
    catch (error) {
        if (created)
            deleteServerRecord(created);
        save({ ...state, state: 'failed', error: (error as Error).message } as unknown as Recovery);
        finishJob(job, error);
        throw error;
    }
    finally {
        await fsp.rm(dir, { recursive: true, force: true });
    }
}
export function destinationRecoveryStatus(run: string) { const r = record(`${run}:destination`); return { state: r.state, serverId: r.destinationServerId ?? null, digest: r.digest ?? null, fenced: r.destinationServerId ? recoveryFence(r.destinationServerId).active : true }; }
async function nodeCall<T>(node: string, endpoint: string, input?: unknown): Promise<T> {
    if (node !== 'local')
        return remoteNode<T>(node, endpoint, input);
    const body = input as Record<string, unknown>;
    if (endpoint === '/recovery/snapshot')
        return await prepareRecoverySnapshot(String(body.id), String(body.serverId), String(body.publicUrl)) as T;
    if (endpoint === '/recovery/import')
        return await importRecoverySnapshot(String(body.id), body.snapshot as Snapshot, body.request) as T;
    if (endpoint === '/recovery/fence')
        return setRecoveryFence(String(body.serverId), String(body.id), body.active === true, String(body.reason)) as T;
    if (endpoint.startsWith('/recovery/status/'))
        return destinationRecoveryStatus(endpoint.split('/').at(-1)!) as T;
    throw new HttpError(400, 'Unknown local recovery operation');
}
export async function startFleetRecovery(owner: string, input: Record<string, unknown>) {
    requireFleetAdmin(owner);
    const source = String(input.sourceNodeId ?? 'local'), destination = String(input.destinationNodeId ?? ''), serverId = String(input.serverId ?? '');
    if (source === destination || !['standby', 'evacuate'].includes(String(input.mode)))
        throw new HttpError(400, 'Choose different source/destination hosts and a recovery mode');
    const inventory = await fleetInventory(), from = inventory.find(n => n.id === source), to = inventory.find(n => n.id === destination);
    if (!from?.inventory || from.error || !to?.inventory || to.error || !from.inventory.servers.some(s => s.id === serverId))
        throw new HttpError(409, 'Both hosts and the source inventory must be reachable');
    if (source !== 'local')
        trustedTransport(getNode(source).url);
    if (destination !== 'local')
        trustedTransport(getNode(destination).url);
    const request = validateCapacity(input.request);
    if (!to.inventory.capacity)
        throw new HttpError(409, 'Update the destination to the capacity protocol before recovery');
    const placement = evaluateCapacity(request, to.inventory.capacity, to.policy, to.inventory.servers, to.inventory.pools, to.inventory.info.platform);
    if (!placement.eligible)
        throw new HttpError(409, placement.reasons.join('; '));
    requireFleetAdmin(owner);
    const r: Recovery = { id: crypto.randomUUID(), owner, sourceNodeId: source, sourceServerId: serverId, destinationNodeId: destination, mode: input.mode as Recovery['mode'], state: 'preparing', request, sourcePublicUrl: source === 'local' ? trustedTransport(input.sourcePublicUrl).origin : getNode(source).url, logs: [], at: Date.now() };
    save(r);
    const job = beginJob('fleet-recovery', source === 'local' ? serverId : null);
    void (async () => {
        try {
            requireFleetAdmin(owner);
            r.logs.push('Fencing source and preparing a verified restore-tested snapshot');
            save(r);
            const snapshot = await nodeCall<Snapshot>(source, '/recovery/snapshot', { id: r.id, serverId, publicUrl: r.sourcePublicUrl });
            requireFleetAdmin(owner);
            r.snapshot = { ...snapshot, ticketKey: seal(snapshot.ticketKey) };
            r.state = 'importing';
            save(r);
            progressJob(job, 'Downloading and verifying destination standby', null);
            const result = await nodeCall<{
                serverId: string;
                digest: string;
                fenced: boolean;
            }>(destination, '/recovery/import', { id: r.id, snapshot, request });
            if (!result.fenced || result.digest !== snapshot.sha256)
                throw new HttpError(422, 'Destination did not confirm a verified fenced standby');
            r.destinationServerId = result.serverId;
            r.digest = result.digest;
            r.state = 'standby';
            r.logs.push('Destination verified and fenced; activation needs operator review');
            save(r);
            if (r.mode === 'standby') {
                await nodeCall(source, '/recovery/fence', { id: r.id, serverId, active: false, reason: 'Verified standby held on destination' });
                r.logs.push('Source released; destination remains fenced');
                save(r);
            }
            finishJob(job);
        }
        catch (error) {
            r.state = 'uncertain';
            r.error = (error as Error).message;
            r.logs.push('Review both hosts. No automatic source release or blind import retry.');
            save(r);
            finishJob(job, error);
        }
    })();
    return { id: r.id, jobId: job, state: r.state };
}
async function reconcileRecoveryImpl(owner: string, id: string) {
    requireFleetAdmin(owner);
    const r = record(id), destination = await nodeCall<{
        state: string;
        serverId: string | null;
        digest: string | null;
        fenced: boolean;
    }>(r.destinationNodeId, `/recovery/status/${id}`);
    if (destination.state !== 'standby' || !destination.serverId || destination.digest !== r.snapshot?.sha256 || !destination.fenced)
        throw new HttpError(409, 'Destination is not a verified fenced standby');
    r.destinationServerId = destination.serverId;
    r.state = 'standby';
    r.error = undefined;
    save(r);
    return { id, state: r.state, destinationServerId: r.destinationServerId };
}
async function activateRecoveryImpl(owner: string, id: string, input: Record<string, unknown>) {
    requireFleetAdmin(owner);
    const r = record(id);
    if (r.state !== 'standby' || !r.destinationServerId || input.reviewedDependencies !== true)
        throw new HttpError(409, 'Review destination ports, paths, runtimes, licenses and dependencies first');
    const destination = await nodeCall<{
        state: string;
        digest: string;
        fenced: boolean;
    }>(r.destinationNodeId, `/recovery/status/${id}`);
    if (destination.state !== 'standby' || destination.digest !== r.snapshot?.sha256 || !destination.fenced)
        throw new HttpError(409, 'Destination verification/fence state changed');
    let externallyFenced = false;
    try {
        await nodeCall(r.sourceNodeId, '/recovery/fence', { id, serverId: r.sourceServerId, active: true, reason: 'Cutover completed; destination may be activated' });
    }
    catch (error) {
        if (r.sourceNodeId === 'local' || (error instanceof HttpError && ![502, 503, 504].includes(error.status)))
            throw error;
        if (input.externallyFenced !== true)
            throw new HttpError(409, 'Source fencing could not be confirmed. Fence it externally and explicitly acknowledge that before failover.');
        externallyFenced = true;
    }
    requireFleetAdmin(owner);
    await nodeCall(r.destinationNodeId, '/recovery/fence', { id, serverId: r.destinationServerId, active: false, reason: 'Administrator reviewed cutover' });
    r.state = 'activated-stopped';
    r.logs.push(externallyFenced ? 'Administrator attested external source fencing; destination released for a reviewed start.' : 'Source fenced; destination released for a reviewed start.');
    save(r);
    return { id, state: r.state, note: 'Destination remains stopped. Start it from its panel after completing game-level checks.' };
}
async function rollbackRecoveryImpl(owner: string, id: string) {
    requireFleetAdmin(owner);
    const r = record(id);
    if (['preparing', 'importing'].includes(r.state))
        throw new HttpError(409, 'Wait for the coordinator to finish before rollback');
    if (!r.destinationServerId) {
        try {
            const destination = await nodeCall<{
                state: string;
                serverId: string | null;
            }>(r.destinationNodeId, `/recovery/status/${id}`);
            if (destination.serverId)
                r.destinationServerId = destination.serverId;
            else if (destination.state !== 'failed')
                throw new HttpError(409, 'Destination import is incomplete; inspect it first');
        }
        catch (error) {
            if (!(error instanceof HttpError) || error.status !== 404)
                throw error;
        }
    }
    if (r.destinationServerId)
        await nodeCall(r.destinationNodeId, '/recovery/fence', { id, serverId: r.destinationServerId, active: true, reason: 'Rollback: destination must remain stopped' });
    requireFleetAdmin(owner);
    await nodeCall(r.sourceNodeId, '/recovery/fence', { id, serverId: r.sourceServerId, active: false, reason: 'Destination fenced or absent; source released by administrator' });
    r.state = 'rolled-back';
    r.logs.push('Original source released; destination remains fenced if present. Newer destination world data was not merged.');
    save(r);
    return { id, state: r.state };
}
const recoveryBusy = new Set<string>();
export function recoverFleetRecoveryJobs() {
    for (const item of prep('SELECT id,data FROM fleet_recovery_runs').all() as {
        id: string;
        data: string;
    }[]) {
        const r = JSON.parse(item.data) as Recovery;
        if (!['preparing', 'importing'].includes(r.state))
            continue;
        r.state = 'uncertain';
        r.error = 'Panel restarted before the handover was confirmed. Reconcile both hosts; fences remain in place.';
        save(r);
    }
}
async function recoveryOperation<T>(id: string, run: () => Promise<T>): Promise<T> { if (recoveryBusy.has(id))
    throw new HttpError(409, 'Another recovery action is running'); recoveryBusy.add(id); try {
    return await run();
}
finally {
    recoveryBusy.delete(id);
} }
export const reconcileRecovery = (owner: string, id: string) => recoveryOperation(id, () => reconcileRecoveryImpl(owner, id));
export const activateRecovery = (owner: string, id: string, input: Record<string, unknown>) => recoveryOperation(id, () => activateRecoveryImpl(owner, id, input));
export const rollbackRecovery = (owner: string, id: string) => recoveryOperation(id, () => rollbackRecoveryImpl(owner, id));
function portableSettings(raw: string | null) { if (!raw)
    return null; const scrub = (value: unknown): unknown => Array.isArray(value) ? value.map(scrub) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => !/password|secret|token|api.?key|credential|auth/i.test(key)).map(([key, v]) => [key, scrub(v)])) : value; return JSON.stringify(scrub(JSON.parse(raw))); }
