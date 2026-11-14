import { logger } from '../utils/logger.js';
import { pickRuntime } from './javaRuntimeService.js';
import { launchConfigOf } from './launchConfig.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { prep } from '../db/db.js';
import { instanceDir } from '../utils/paths.js';
import { HttpError } from '../utils/asyncHandler.js';
import { getServer, listServers } from './serverService.js';
import { getRuntimeInfo, getLogBuffer, isRunning, sendCommand, startServer, stopServer } from './processManager.js';
import { getDiskUsage } from './diskUsageService.js';
import { latestQuery, querySupport } from './browserStatsService.js';
import { getUserById, userHasServerAccess, getServerPermissions, getConfigAccess } from './userService.js';
import { readWorkflow, writeWorkflow, appendWorkflow, boundedNumber } from './workflowStore.js';
import { notify } from './notificationService.js';
import { beginJob, progressJob, finishJob } from './jobService.js';
import { assertDiskRoom } from './limitsService.js';
export interface HealthConfig {
    enabled: boolean;
    cpu: number;
    memoryMb: number;
    diskGrowthMbHour: number;
    tickMs: number;
    startupSeconds: number;
    queryFailures: number;
    sustainedSeconds: number;
    cooldownSeconds: number;
    silencedUntil: number;
}
export const DEFAULT_HEALTH: HealthConfig = { enabled: false, cpu: 90, memoryMb: 4096, diskGrowthMbHour: 1024, tickMs: 100, startupSeconds: 180, queryFailures: 3, sustainedSeconds: 60, cooldownSeconds: 900, silencedUntil: 0 };
export const healthConfig = (id: string) => readWorkflow('health', id, DEFAULT_HEALTH);
export function saveHealth(id: string, input: Record<string, unknown>) {
    const c = { ...DEFAULT_HEALTH };
    for (const [key, min, max] of [['cpu', 1, 100000], ['memoryMb', 1, 1048576], ['diskGrowthMbHour', 1, 1048576], ['tickMs', 50, 60000], ['startupSeconds', 10, 86400], ['queryFailures', 1, 100], ['sustainedSeconds', 15, 3600], ['cooldownSeconds', 60, 86400], ['silencedUntil', 0, Date.now() + 30 * 86400000]] as const)
        c[key] = boundedNumber(input[key], min, max, key);
    c.enabled = input.enabled === true;
    writeWorkflow('health', id, c);
    return c;
}
const observations = new Map<string, {
    since: Map<string, number>;
    emitted: Map<string, number>;
    disk?: {
        at: number;
        bytes: number;
    };
    queryAt?: string;
    queryFailures: number;
}>();
export function evaluateHealth(id: string, values: Record<string, number | null>, now = Date.now()) {
    const c = healthConfig(id);
    if (!c.enabled)
        return;
    let state = observations.get(id);
    if (!state) {
        state = { since: new Map(), emitted: new Map(), queryFailures: 0 };
        observations.set(id, state);
    }
    const thresholds: Record<string, number> = { cpu: c.cpu, memoryMb: c.memoryMb, diskGrowthMbHour: c.diskGrowthMbHour, tickMs: c.tickMs, startupSeconds: c.startupSeconds, queryFailures: c.queryFailures };
    const silence = Math.max(c.silencedUntil, readWorkflow<number>('maintenance-silence', id, 0));
    for (const [key, threshold] of Object.entries(thresholds)) {
        const value = values[key];
        if (value == null || value < threshold || now < silence || maintenanceLocks.has(id)) {
            state.since.delete(key);
            continue;
        }
        if (!state.since.has(key))
            state.since.set(key, now);
        if (now - state.since.get(key)! < c.sustainedSeconds * 1000 || now - (state.emitted.get(key) ?? 0) < c.cooldownSeconds * 1000)
            continue;
        const report = { at: now, metric: key, value, threshold, sustainedSeconds: c.sustainedSeconds, suggestion: ({ cpu: 'Review profiler hotspots and reduce simulation/view distance or plugin workload.', memoryMb: 'Check heap usage and leaks before raising the memory limit.', diskGrowthMbHour: 'Inspect growing logs, worlds and backup retention.', tickMs: 'Capture a spark report and inspect the most expensive plugins/mods.', startupSeconds: 'Review startup logs, dependency failures and readiness patterns.', queryFailures: 'Check the game query port, firewall and query settings.' } as Record<string, string>)[key] };
        appendWorkflow('health-alerts', id, report);
        state.emitted.set(key, now);
        const server = getServer(id);
        if (server)
            notify('health.alert', server, `${key}: ${value.toFixed(1)} exceeds ${threshold}. ${report.suggestion}`);
    }
}
function sampleHealth() {
    for (const server of listServers()) {
        if (!healthConfig(server.id).enabled)
            continue;
        const id = server.id, now = Date.now(), runtime = getRuntimeInfo(id);
        let state = observations.get(id);
        if (!state) {
            state = { since: new Map(), emitted: new Map(), queryFailures: 0 };
            observations.set(id, state);
        }
        const bytes = getDiskUsage(id).serverBytes;
        const old = state.disk;
        const growth = old && now - old.at >= 300000 ? Math.max(0, (bytes - old.bytes) / 1048576 / ((now - old.at) / 3600000)) : null;
        if (!old || now - old.at >= 3600000)
            state.disk = { at: now, bytes };
        const query = latestQuery(id);
        if (!query || now - new Date(query.at).getTime() > 120000)
            state.queryFailures = 0;
        if (query && query.at !== state.queryAt) {
            state.queryAt = query.at;
            state.queryFailures = query.error ? state.queryFailures + 1 : 0;
        }
        const tick = readWorkflow<{
            at: number;
            mspt: number;
        } | null>('tick-sample', id, null);
        evaluateHealth(id, { cpu: runtime?.stats.cpuPercent ?? null, memoryMb: runtime?.stats.memoryMb ?? null, diskGrowthMbHour: growth, startupSeconds: server.status === 'starting' && runtime ? runtime.uptimeMs / 1000 : null, queryFailures: isRunning(id) && querySupport(server).supported ? state.queryFailures : null, tickMs: tick && now - tick.at < 120000 ? tick.mspt : null }, now);
    }
}
export function authorizeWorkflowActor(owner: string, ids: string[], permissions: string[]) {
    const user = getUserById(owner);
    if (!user || user.disabled)
        throw new HttpError(403, 'Workflow owner is unavailable');
    for (const id of ids) {
        const s = getServer(id);
        if (!s || (user.role !== 'admin' && (!userHasServerAccess(owner, id) || s.suspended)))
            throw new HttpError(403, 'Workflow instance access revoked');
        const allowed = getServerPermissions(owner, user.role, id) ?? [];
        if (!permissions.every(p => allowed.includes(p as never)) || Object.values(getConfigAccess(owner, user.role, id)).includes(false))
            throw new HttpError(403, 'Workflow permissions are restricted');
    }
}
interface Maintenance {
    id: string;
    owner: string;
    name: string;
    at: number;
    downtimeSeconds: number;
    warningSeconds: number;
    message: string;
    dependencies: {
        id: string;
        dependsOn: string[];
    }[];
    state: string;
    steps: string[];
    started?: number;
    finished?: number;
    error?: string;
}
const maintenanceLocks = new Map<string, string>();
export function assertMaintenanceIdle(id: string, token?: string) { const lock = maintenanceLocks.get(id); if (lock && lock !== token)
    throw new HttpError(423, 'Instance belongs to an active maintenance workflow'); }
export function maintenanceRows(id: string) { return readWorkflow<Maintenance[]>('maintenance', 'global', []).filter(m => m.dependencies.some(d => d.id === id)); }
function saveMaintenance(m: Maintenance) { const all = readWorkflow<Maintenance[]>('maintenance', 'global', []); writeWorkflow('maintenance', 'global', [m, ...all.filter(a => a.id !== m.id)].slice(0, 200)); }
function order(deps: Maintenance['dependencies']) {
    const result: string[] = [], visiting = new Set<string>(), visited = new Set<string>();
    const visit = (id: string) => { if (visiting.has(id))
        throw new HttpError(400, 'Dependency cycle'); if (visited.has(id))
        return; const node = deps.find(d => d.id === id); if (!node)
        throw new HttpError(400, 'Unknown dependency'); visiting.add(id); node.dependsOn.forEach(visit); visiting.delete(id); visited.add(id); result.push(id); };
    deps.forEach(d => visit(d.id));
    return result;
}
export function scheduleMaintenance(owner: string, input: Record<string, unknown>, instance: string) {
    const dependencies = input.dependencies as Maintenance['dependencies'];
    if (!Array.isArray(dependencies) || !dependencies.length || dependencies.length > 32 || !dependencies.some(d => d.id === instance) || !dependencies.every(d => typeof d.id === 'string' && Array.isArray(d.dependsOn) && d.dependsOn.every(p => typeof p === 'string')) || new Set(dependencies.map(d => d.id)).size !== dependencies.length)
        throw new HttpError(400, 'Provide up to 32 unique instances and dependency lists');
    order(dependencies);
    authorizeWorkflowActor(owner, dependencies.map(d => d.id), ['power', 'console']);
    const at = boundedNumber(input.at, Date.now() - 60000, Date.now() + 365 * 86400000, 'Scheduled time');
    const message = String(input.message ?? 'Scheduled maintenance').trim();
    if (!/^[\p{L}\p{N} .,!?()_-]{1,200}$/u.test(message))
        throw new HttpError(400, 'Use a plain-text warning without command punctuation');
    const m: Maintenance = { id: crypto.randomUUID(), owner, name: String(input.name ?? 'Maintenance').slice(0, 80), at, downtimeSeconds: boundedNumber(input.downtimeSeconds, 0, 86400, 'Downtime seconds'), warningSeconds: boundedNumber(input.warningSeconds, 0, 3600, 'Warning seconds'), message, dependencies, state: 'scheduled', steps: [] };
    saveMaintenance(m);
    return m;
}
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
async function waitUntil(check: () => boolean, seconds: number) { const end = Date.now() + seconds * 1000; while (!check()) {
    if (Date.now() > end)
        throw new HttpError(504, 'Timed out waiting for the process; inspect console and recover manually');
    await delay(500);
} }
async function executeMaintenance(m: Maintenance) {
    const ids = order(m.dependencies);
    if (ids.some(id => maintenanceLocks.has(id))) {
        m.state = 'failed';
        m.error = 'Another maintenance run holds an instance';
        saveMaintenance(m);
        return;
    }
    ids.forEach(id => maintenanceLocks.set(id, m.id));
    const job = beginJob('maintenance', ids[0]);
    m.state = 'running';
    m.started = Date.now();
    saveMaintenance(m);
    const step = (text: string) => { m.steps.push(`${new Date().toISOString()} ${text}`); saveMaintenance(m); progressJob(job, text); };
    const auth = () => authorizeWorkflowActor(m.owner, ids, ['power', 'console']);
    const running = ids.filter(isRunning);
    try {
        auth();
        for (const id of ids)
            writeWorkflow('maintenance-silence', id, Date.now() + (m.warningSeconds + m.downtimeSeconds + 300) * 1000);
        for (const id of running) {
            const s = getServer(id)!;
            if (s.platform === 'java' || s.platform === 'bedrock' || ['cs2', 'tf2', 'css', 'gmod', 'csgo'].includes(s.steam_preset ?? '')) {
                auth();
                sendCommand(id, `say ${m.message}`);
                step(`Warned ${s.name}`);
            }
            else
                step(`Warning unsupported for ${s.name}; notification only`);
        }
        if (m.warningSeconds)
            await delay(m.warningSeconds * 1000);
        for (const id of [...ids].reverse()) {
            auth();
            if (isRunning(id)) {
                stopServer(id);
                await waitUntil(() => !isRunning(id), 120);
                step(`Stopped ${getServer(id)!.name}`);
            }
        }
        step('Downtime started');
        if (m.downtimeSeconds)
            await delay(m.downtimeSeconds * 1000);
        for (const id of ids.filter(id => running.includes(id))) {
            auth();
            await startServer(id, { workflow: m.id });
            await waitUntil(() => getServer(id)?.status === 'running', 180);
            step(`Ready: ${getServer(id)!.name}`);
        }
        m.state = 'completed';
        finishJob(job);
    }
    catch (error) {
        m.state = 'failed';
        m.error = error instanceof Error ? error.message : String(error);
        step('Stopped workflow; inspect steps before manual recovery');
        finishJob(job, error);
    }
    finally {
        m.finished = Date.now();
        saveMaintenance(m);
        ids.forEach(id => maintenanceLocks.delete(id));
    }
}
export function cancelMaintenance(id: string, owner: string, instance: string) {
    const m = maintenanceRows(instance).find(m => m.id === id);
    if (!m)
        throw new HttpError(404, 'Maintenance not found');
    authorizeWorkflowActor(owner, m.dependencies.map(d => d.id), ['power']);
    if (m.state !== 'scheduled')
        throw new HttpError(409, 'Only pending maintenance can be cancelled');
    m.state = 'cancelled';
    saveMaintenance(m);
}
export async function updatePreflight(id: string, targetVersion?: string) {
    const server = getServer(id);
    if (!server)
        throw new HttpError(404, 'Instance not found');
    const checks: {
        name: string;
        ok: boolean;
        detail: string;
    }[] = [];
    try {
        const {assertRecoveryIdle}=await import('./fleetRecoveryService.js');
        assertRecoveryIdle(id);
        const { assertGameWorkflowIdle } = await import('./gameUpdateWorkflowService.js');
        const { assertBackupIdle } = await import('./verifiedBackupService.js');
        assertGameWorkflowIdle(id);
        assertBackupIdle(id);
        assertMaintenanceIdle(id);
        checks.push({ name: 'Workflow availability', ok: true, detail: 'No active recovery or maintenance lock' });
    }
    catch (e) {
        checks.push({ name: 'Workflow availability', ok: false, detail: (e as Error).message });
    }
    checks.push({ name: 'Stopped', ok: !isRunning(id) && !['starting', 'installing', 'updating'].includes(server.status), detail: 'Stop the game before updating; keep a verified recovery snapshot.' });
    try {
        assertDiskRoom(id, 'write');
        const stats = fs.statfsSync(instanceDir(id));
        const free = Number(stats.bavail) * Number(stats.bsize);
        const required = Math.max(512 * 1048576, getDiskUsage(id).serverBytes * 0.2);
        checks.push({ name: 'Free disk space', ok: free >= required, detail: `${Math.floor(free / 1048576)} MiB free; ${Math.ceil(required / 1048576)} MiB reserve required. Updates may need more for download/extraction.` });
    }
    catch (e) {
        checks.push({ name: 'Free disk space', ok: false, detail: (e as Error).message });
    }
    checks.push({ name: 'Game platform', ok: server.platform !== 'custom', detail: server.platform === 'custom' ? 'Custom executables must be updated manually.' : `${server.platform} / ${server.loader} ${server.version}` });
    const jar = server.jar_file;
    if (server.platform === 'java') {
        const config = launchConfigOf(server), runtime = config.javaPath ? { path: config.javaPath, note: 'Explicit Java path' } : await pickRuntime(targetVersion ?? server.version, config.javaVersion);
        checks.push({ name: 'Java runtime', ok: !!runtime.path && fs.existsSync(runtime.path), detail: runtime.note ?? 'Java runtime must match the target Minecraft release.' });
        const relative = jar?.replace(/^@/, '');
        checks.push({ name: 'Installed Java server', ok: !!relative && !relative.includes('..') && fs.existsSync(path.join(instanceDir(id), relative)), detail: 'Existing server JAR or loader argument file must be present. Target releases may have additional prerequisites.' });
    }
    const result = { at: Date.now(), checks, ready: checks.every(c => c.ok), recovery: ['Keep the instance stopped after a failed update.', 'Review the failed job and console logs; resolve disk/runtime/dependency errors.', 'Restore the pre-update snapshot if files changed, then start and verify the game query/player connection.'] };
    writeWorkflow('update-preflight', id, result);
    return result;
}
export function redactTroubleshooting(text: string) {
    return text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[redacted private key]')
        .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
        .replace(/(Bearer\s+)[\w.\/-]+/gi, '$1[redacted]')
        .replace(/(["']?[\w.-]*(?:pass(?:word)?|secret|token|api[_-]?key|credential|authorization)[\w.-]*["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,}\n]+)/gi, '$1[redacted]')
        .replace(/https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/[^\s"']+/gi, '[redacted webhook]');
}
export function redactDiagnosticValue(value: unknown): unknown {
    if (typeof value === 'string')
        return redactTroubleshooting(value);
    if (Array.isArray(value))
        return value.map(redactDiagnosticValue);
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, /password|secret|token|api[_-]?key|credential|authorization|private[_-]?key/i.test(key) ? '[redacted]' : redactDiagnosticValue(entry)]));
    return value;
}
export function troubleshootingBundle(id: string, includeHistory = false) {
    const s = getServer(id);
    if (!s)
        throw new HttpError(404, 'Instance not found');
    // Only allowlisted metadata. Raw environment, launch arguments, identity files and credentials are excluded.
    const configs: Record<string, string> = {};
    for (const relative of ['server.properties', 'eula.txt']) {
        const file = path.join(instanceDir(id), relative);
        try {
            if (!fs.lstatSync(file).isSymbolicLink() && fs.statSync(file).size <= 65536)
                configs[relative] = redactTroubleshooting(fs.readFileSync(file, 'utf8'));
        }
        catch { }
    }
    const configurationChanges = includeHistory ? prep("SELECT created_at,file_path,file_change FROM audit_log WHERE target=? AND file_change IS NOT NULL ORDER BY id DESC LIMIT 20").all(id).filter(r => /\.(?:properties|json|ya?ml|cfg|conf|ini|toml|xml)$/i.test(String(r.file_path))).map(r => { try {
        return { ...r, file_change: redactDiagnosticValue(JSON.parse(String(r.file_change))) };
    }
    catch {
        return { created_at: r.created_at, file_path: r.file_path, note: 'Change could not be decoded' };
    } }) : [];
    return { configurationChanges, format: 'outpost-troubleshooting-v1', at: new Date().toISOString(), panel: { node: process.version, os: process.platform, architecture: process.arch }, instance: { id, name: s.name, platform: s.platform, loader: s.loader, version: s.version, build: s.build, port: s.server_port, status: s.status }, logs: getLogBuffer(id).slice(-500).map(redactTroubleshooting), configs, alerts: readWorkflow('health-alerts', id, []), preflight: readWorkflow('update-preflight', id, null), failedJobs: prep("SELECT kind,status,stage,logs,updated_at FROM panel_jobs WHERE server_id=? AND status='failed' ORDER BY updated_at DESC LIMIT 20").all(id).map(redactDiagnosticValue) };
}
let timer: NodeJS.Timeout | undefined;
export function initReliability() {
    const all = readWorkflow<Maintenance[]>('maintenance', 'global', []);
    for (const m of all)
        if (m.state === 'running') {
            m.state = 'interrupted';
            m.error = 'Panel restarted during maintenance. Review completed steps before manual recovery.';
            saveMaintenance(m);
        }
    if (timer)
        return;
    timer = setInterval(() => { try {
        sampleHealth();
        void runDueMaintenance().catch(error => logger.error('Maintenance workflow failed', error));
    }
    catch { /* Retry monitoring next interval. */ } }, 15000);
    timer.unref();
}
export async function runDueMaintenance() { await Promise.all(readWorkflow<Maintenance[]>('maintenance', 'global', []).filter(m => m.state === 'scheduled' && m.at <= Date.now()).map(executeMaintenance)); }
export function stopReliability() { if (timer)
    clearInterval(timer); timer = undefined; }
