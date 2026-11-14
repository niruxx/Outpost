import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { prep } from '../db/db.js';
import type { Request, Response } from 'express';
import { HttpError } from '../utils/asyncHandler.js';
import { DATA_DIR } from '../utils/paths.js';
import { seal, unseal, sha256, constantEqual, requireFleetAdmin, plainId } from './fleetSecurity.js';
import { createUser, getUserById, grantOwnerAccess, logAudit, setCreationPolicy } from './userService.js';
import { getTemplate } from './templateService.js';
import { getServer, setServerSuspension, deleteServerRecord, updateServerRecord } from './serverService.js';
import { createInstance } from '../routes/servers.routes.js';
import { isRunning, stopServer, startServer } from './processManager.js';
import { saveLimits } from './limitsService.js';
import { createBackup, resolveBackupPath } from './backupService.js';
import { verifyZip, hashFile } from './verifiedBackupService.js';
import { beginJob, finishJob } from './jobService.js';
import { reserveLocalCapacity } from './fleetCapacityService.js';
export interface BillingPlan {
    id: string;
    name: string;
    templateId: string;
    memoryMb: number;
    cpuPercent: number;
    diskMb: number;
    variables: Record<string, string>;
    acceptEula: boolean;
    createdBy: string;
    portPoolId: string;
}
interface Connection {
    id: string;
    name: string;
    secret: string;
    enabled: number;
    allow_termination: number;
}
interface Service {
    connection_id: string;
    external_id: string;
    user_id: string;
    server_id: string | null;
    plan_id: string;
    state: string;
    expires: number | null;
    data: string;
}
export function billingConnections() { return prep('SELECT id,name,enabled,allow_termination FROM billing_connections ORDER BY name').all(); }
export function billingPlans() {
    return (prep('SELECT data FROM billing_plans').all() as {
        data: string;
    }[]).map(r => JSON.parse(r.data) as BillingPlan);
}
export function billingServices() { return prep('SELECT connection_id,external_id,user_id,server_id,plan_id,state,expires FROM billing_services ORDER BY external_id').all(); }
export function billingEvents() { return prep('SELECT connection_id,event_id,state,result,at FROM billing_events ORDER BY at DESC LIMIT 100').all(); }
export function saveBillingConnection(input: Record<string, unknown>) {
    const name = String(input.name ?? '').trim();
    if (!name || name.length > 100)
        throw new HttpError(400, 'Connection name required');
    const id = input.id ? plainId(input.id) : crypto.randomUUID(), old = prep('SELECT id FROM billing_connections WHERE id=?').get(id);
    if (input.id && !old)
        throw new HttpError(404, 'Billing connection not found');
    const secret = crypto.randomBytes(32).toString('base64url');
    if (old)
        prep('UPDATE billing_connections SET name=?,enabled=?,allow_termination=? WHERE id=?').run(name, input.enabled === false ? 0 : 1, input.allowTermination === true ? 1 : 0, id);
    else
        prep('INSERT INTO billing_connections(id,name,secret,enabled,allow_termination) VALUES (?,?,?,?,?)').run(id, name, seal(secret), input.enabled === false ? 0 : 1, input.allowTermination === true ? 1 : 0);
    return { id, ...(!old ? { secret } : {}), note: 'Copy the new secret once. Termination is separately opt-in; shared secrets cannot call general admin APIs.' };
}
export function rotateBillingSecret(id: string) {
    const secret = crypto.randomBytes(32).toString('base64url');
    if (!prep('UPDATE billing_connections SET secret=? WHERE id=?').run(seal(secret), id).changes)
        throw new HttpError(404, 'Connection not found');
    return { id, secret };
}
export function saveBillingPlan(owner: string, input: Record<string, unknown>) {
    requireFleetAdmin(owner);
    const templateId = String(input.templateId ?? ''), template = getTemplate(templateId);
    if (!template || !['java', 'bedrock', 'steam'].includes(template.instance.platform))
        throw new HttpError(400, 'Select a managed Java/Bedrock/Steam template');
    const id = input.id ? plainId(input.id) : crypto.randomUUID();
    if (input.id && !billingPlans().some(p => p.id === id))
        throw new HttpError(404, 'Plan not found');
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100 || ![input.memoryMb, input.cpuPercent, input.diskMb].every(Number.isInteger) || Number(input.memoryMb) < 128 || Number(input.memoryMb) > 1048576 || Number(input.cpuPercent) < 10 || Number(input.cpuPercent) > 25600 || Number(input.diskMb) < 100 || Number(input.diskMb) > 100 * 1024 * 1024 || typeof input.portPoolId !== 'string')
        throw new HttpError(400, 'Provide a plan name, memory 128–1048576 MiB, CPU 10–25600%, disk 100–104857600 MiB and port pool');
    if (template.instance.platform === 'java' && input.acceptEula !== true)
        throw new HttpError(400, 'The plan administrator must accept the Minecraft EULA');
    const variables = input.variables ?? {};
    if (!variables || typeof variables !== 'object' || Array.isArray(variables) || Object.values(variables).some(v => typeof v !== 'string' || v.length > 1000))
        throw new HttpError(400, 'Invalid template variables');
    const plan: BillingPlan = { id, name: input.name.trim(), templateId, memoryMb: Number(input.memoryMb), cpuPercent: Number(input.cpuPercent), diskMb: Number(input.diskMb), variables: variables as Record<string, string>, acceptEula: input.acceptEula === true, createdBy: owner, portPoolId: input.portPoolId };
    prep('INSERT INTO billing_plans(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(id, JSON.stringify(plan));
    return plan;
}
export function verifyBillingSignature(connectionId: string, eventId: string, timestamp: string, signature: string, raw: Buffer) {
    const connection = prep('SELECT * FROM billing_connections WHERE id=?').get(connectionId) as unknown as Connection | undefined;
    if (!connection?.enabled || !/^[\w.:-]{1,128}$/.test(eventId) || !/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 || !/^[a-f0-9]{64}$/i.test(signature))
        throw new HttpError(401, 'Invalid billing authentication');
    const expected = crypto.createHmac('sha256', unseal(connection.secret)).update(timestamp + ':' + eventId + ':').update(raw).digest('hex');
    if (!constantEqual(expected, signature.toLowerCase()))
        throw new HttpError(401, 'Invalid billing signature');
    return connection;
}
function service(connection: string, id: string) { return prep('SELECT * FROM billing_services WHERE connection_id=? AND external_id=?').get(connection, id) as unknown as Service | undefined; }
async function stopForBilling(id: string) {
    if (!isRunning(id))
        return;
    stopServer(id);
    const end = Date.now() + 120000;
    while (isRunning(id)) {
        if (Date.now() > end)
            throw new HttpError(409, 'Game did not stop gracefully; inspect it before retrying billing action');
        await new Promise(r => setTimeout(r, 500));
    }
}
function expiry(value: unknown) {
    if (value === undefined || value === null || value === '')
        return null;
    const at = Date.parse(String(value));
    if (!Number.isFinite(at) || at < Date.now() - 86400000 || at > Date.now() + 10 * 365 * 86400000)
        throw new HttpError(400, 'Invalid billing period end');
    return at;
}
const busy = new Set<string>();
export async function acceptBillingEvent(req: Request, connection: Connection, eventId: string, raw: Buffer) {
    const input = JSON.parse(raw.toString('utf8')) as Record<string, unknown>, hash = sha256(raw), old = prep('SELECT * FROM billing_events WHERE connection_id=? AND event_id=?').get(connection.id, eventId) as {
        request_hash: string;
        state: string;
        result: string | null;
    } | undefined;
    if (old) {
        if (old.request_hash !== hash)
            throw new HttpError(409, 'Billing delivery ID was reused with another payload');
        if (old.result)
            return JSON.parse(old.result);
        throw new HttpError(409, 'This delivery is processing/interrupted; review service state before using another ID');
    }
    const action = String(input.action);
    if (!['ping', 'create', 'renew', 'suspend', 'unsuspend', 'changePlan', 'terminate'].includes(action))
        throw new HttpError(400, 'Unsupported billing action');
    if (action === 'ping')
        return { ok: true, apiVersion: 1 };
    const externalId = plainId(String(input.externalId ?? ''), 'external service ID'), customerId = plainId(String(input.customerId ?? ''), 'customer ID'), key = `${connection.id}:${externalId}`;
    if (busy.has(key))
        throw new HttpError(409, 'Another lifecycle event is processing this service');
    busy.add(key);
    const job = beginJob(`billing-${action}`, null);
    prep('INSERT INTO billing_events(connection_id,event_id,request_hash,state,at) VALUES (?,?,?,?,?)').run(connection.id, eventId, hash, 'processing', Date.now());
    try {
        let current = service(connection.id, externalId);
        if (current && JSON.parse(current.data).customerId !== customerId)
            throw new HttpError(409, 'Service belongs to another customer');
        let plan = billingPlans().find(p => p.id === (input.planId ?? current?.plan_id));
        if (!plan)
            throw new HttpError(404, 'Billing plan is unavailable');
        const actor = requireFleetAdmin(plan.createdBy);
        if (!prep('SELECT enabled FROM billing_connections WHERE id=?').get(connection.id)?.enabled)
            throw new HttpError(403, 'Billing connection disabled');
        const until = expiry(input.expiresAt);
        const reason = `billing:${connection.id}:${externalId}`;
        if (action === 'create') {
            if (current) {
                if (!current.server_id || !getServer(current.server_id))
                    throw new HttpError(409, 'Prior provisioning/termination requires operator review; refusing to create a duplicate');
                if (current.plan_id !== plan.id)
                    throw new HttpError(409, 'Use changePlan for an existing service');
            }
            else {
                const template = getTemplate(plan.templateId)!;
                const reservation = reserveLocalCapacity(crypto.randomUUID(), { memoryMb: plan.memoryMb, cpuPercent: plan.cpuPercent, diskMb: plan.diskMb, platform: template.instance.platform, steamPreset: template.instance.steamPreset, steamAppId: template.instance.steamAppId, poolId: plan.portPoolId, tags: [], roles: [{ role: 'game', offset: 0, protocol: template.instance.platform === 'java' ? 'tcp' : 'udp' }, ...(template.instance.platform === 'bedrock' ? [{ role: 'ipv6', offset: 1, protocol: 'udp' as const }] : [])] });
                const existing = prep('SELECT user_id FROM billing_services WHERE connection_id=? AND json_extract(data,\'$.customerId\')=? LIMIT 1').get(connection.id, customerId) as {
                    user_id: string;
                } | undefined;
                const owner = existing ? getUserById(existing.user_id) : createUser(`bill_${sha256(connection.id + ':' + customerId).slice(0, 24)}`, crypto.randomBytes(32).toString('base64url'), 'moderator');
                if (!owner || owner.disabled || owner.role === 'admin')
                    throw new HttpError(409, 'Billing customer account is unavailable');
                setCreationPolicy(owner.id, { canCreate: false, platforms: [], maxInstances: 0, maxMemoryMb: 0, containers: 'none', engineSocket: false });
                prep('INSERT INTO billing_services(connection_id,external_id,user_id,plan_id,state,expires,data) VALUES (?,?,?,?,?,?,?)').run(connection.id, externalId, owner.id, plan.id, 'provisioning', until, JSON.stringify({ customerId, createdAt: Date.now() }));
                const synthetic = Object.create(req) as Request;
                synthetic.auth = { sub: actor.id, username: actor.username, role: 'admin', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 };
                synthetic.headers = { ...req.headers, 'x-outpost-capacity-lease': reservation.id };
                synthetic.body = { templateId: plan.templateId, variables: plan.variables, name: `Billing ${externalId}`, minMemoryMb: Math.min(1024, plan.memoryMb), maxMemoryMb: plan.memoryMb, serverPort: reservation.ports[0].port, acceptEula: plan.acceptEula };
                let created: string | undefined;
                const capture = { locals: { onInstanceCreated: (record: {
                            id: string;
                        }) => { created = record.id; prep('UPDATE billing_services SET server_id=? WHERE connection_id=? AND external_id=?').run(record.id, connection.id, externalId); prep('UPDATE servers SET created_by=? WHERE id=?').run(owner.id, record.id); grantOwnerAccess(owner.id, record.id); prep('UPDATE panel_jobs SET server_id=? WHERE id=?').run(record.id, job); } }, status() { return this; }, json(body: {
                        server?: {
                            id: string;
                        };
                    }) { created = body.server?.id ?? created; return this; } };
                await createInstance(synthetic, capture as unknown as Response);
                if (!created)
                    throw new HttpError(500, 'Provisioning did not record an instance');
                current = service(connection.id, externalId)!;
            }
        }
        if (current?.state === 'terminated' && action === 'terminate') {
            const result = { ok: true, externalId, serverId: null, state: 'terminated', expires: current.expires };
            prep('UPDATE billing_events SET state=?,result=? WHERE connection_id=? AND event_id=?').run('completed', JSON.stringify(result), connection.id, eventId);
            finishJob(job);
            return result;
        }
        if (!current?.server_id)
            throw new HttpError(404, 'Billing service is not provisioned');
        const server = getServer(current.server_id);
        if (!server)
            throw new HttpError(410, 'Billing instance was deleted; operator review required');
        if (action === 'suspend') {
            await stopForBilling(server.id);
            requireFleetAdmin(actor.id);
            if (!server.suspended || server.suspended_reason === reason)
                setServerSuspension(server.id, true, reason, actor.id);
            current.state = 'suspended';
        }
        if (['renew', 'unsuspend', 'create'].includes(action)) {
            if (server.suspended && server.suspended_reason === reason)
                setServerSuspension(server.id, false, null, actor.id);
            current.state = 'active';
        }
        if (action === 'changePlan') {
            const priorPlan = billingPlans().find(p => p.id === current!.plan_id);
            if (!priorPlan || priorPlan.templateId !== plan.templateId)
                throw new HttpError(409, 'Plan changes must retain the same template; migrate the game separately');
            const wasRunning = isRunning(server.id);
            await stopForBilling(server.id);
            requireFleetAdmin(actor.id);
            const extra = plan.memoryMb - server.max_memory_mb;
            if (extra > 0) {
                const { localCapacity } = await import('./fleetCapacityService.js');
                const c = localCapacity();
                if (c.totalMemoryMb - c.assignedMemoryMb < extra)
                    throw new HttpError(409, 'Host lacks memory for this plan change');
            }
            updateServerRecord(server.id, { maxMemoryMb: plan.memoryMb, minMemoryMb: Math.min(server.min_memory_mb, plan.memoryMb) });
            saveLimits(getServer(server.id)!, { cpuPercent: plan.cpuPercent, diskMb: plan.diskMb });
            current.plan_id = plan.id;
            if (wasRunning && !server.suspended)
                await startServer(server.id);
        }
        if (action === 'terminate') {
            if (!connection.allow_termination)
                throw new HttpError(403, 'Termination is disabled for this billing connection');
            await stopForBilling(server.id);
            requireFleetAdmin(actor.id);
            const backup = await createBackup(server.id, 'billing-termination');
            await verifyZip(server.id, backup.fileName, false);
            const archive = crypto.randomUUID(), dir = path.join(DATA_DIR, 'billing-archives', archive);
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
            const target = path.join(dir, 'instance.zip');
            await fs.promises.copyFile(resolveBackupPath(server.id, backup.fileName), target);
            const digest = await hashFile(target);
            requireFleetAdmin(actor.id);
            if (!prep('SELECT enabled,allow_termination FROM billing_connections WHERE id=? AND enabled=1 AND allow_termination=1').get(connection.id))
                throw new HttpError(403, 'Termination authorization was revoked');
            fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ connection: connection.id, externalId, serverId: server.id, at: Date.now(), sha256: digest }), { mode: 0o600 });
            deleteServerRecord(server.id);
            current.state = 'terminated';
            current.server_id = null;
            current.data = JSON.stringify({ ...JSON.parse(current.data), terminationArchive: archive });
        }
        const expires = until === null ? current.expires : Math.max(current.expires ?? 0, until);
        prep('UPDATE billing_services SET server_id=?,plan_id=?,state=?,expires=?,data=? WHERE connection_id=? AND external_id=?').run(current.server_id, current.plan_id, current.state, expires, current.data, connection.id, externalId);
        const result = { ok: true, externalId, serverId: current.server_id, state: current.state, expires };
        prep('UPDATE billing_events SET state=?,result=? WHERE connection_id=? AND event_id=?').run('completed', JSON.stringify(result), connection.id, eventId);
        logAudit(actor.id, actor.username, `billing.${action}`, server.id, connection.id + ':' + externalId);
        finishJob(job);
        return result;
    }
    catch (error) {
        const result = { ok: false, error: error instanceof Error ? error.message : String(error) };
        prep('UPDATE billing_events SET state=?,result=? WHERE connection_id=? AND event_id=?').run('failed', JSON.stringify(result), connection.id, eventId);
        finishJob(job, error);
        throw error;
    }
    finally {
        busy.delete(key);
    }
}
export async function expireBillingServices() {
    const rows = prep("SELECT s.* FROM billing_services s JOIN billing_connections c ON c.id=s.connection_id WHERE c.enabled=1 AND s.state='active' AND s.expires IS NOT NULL AND s.expires<?").all(Date.now()) as unknown as Service[];
    for (const row of rows) {
        const key = row.connection_id + ':' + row.external_id;
        if (!row.server_id || busy.has(key))
            continue;
        busy.add(key);
        try {
            const plan = billingPlans().find(p => p.id === row.plan_id);
            if (!plan)
                continue;
            const actor = requireFleetAdmin(plan.createdBy), s = getServer(row.server_id);
            if (!s)
                continue;
            await stopForBilling(s.id);
            requireFleetAdmin(actor.id);
            const current = service(row.connection_id, row.external_id);
            if (!current || current.state !== 'active' || current.expires === null || current.expires > Date.now() || !prep('SELECT id FROM billing_connections WHERE id=? AND enabled=1').get(row.connection_id))
                continue;
            if (!s.suspended)
                setServerSuspension(s.id, true, 'billing:' + row.connection_id + ':' + row.external_id, actor.id);
            prep("UPDATE billing_services SET state='expired' WHERE connection_id=? AND external_id=?").run(row.connection_id, row.external_id);
        }
        catch { /* Leave pending for operator review. Expiry never deletes data. */ }
        finally {
            busy.delete(key);
        }
    }
}
