import net from 'node:net';
import { HttpError } from '../utils/asyncHandler.js';
import { getServer, listServers } from './serverService.js';
import { isRunning, startServer, stopServer } from './processManager.js';
import { getOnlinePlayers } from './playerService.js';
import { authorizeWorkflowActor } from './reliabilityService.js';
import { readWorkflow, writeWorkflow, boundedNumber } from './workflowStore.js';
import { isProxyLoader } from '../types/index.js';
import { prep } from '../db/db.js';
interface Sleep {
    enabled: boolean;
    port: number;
    idleSeconds: number;
    owner: string;
}
interface Listener {
    server: net.Server;
    sockets: Set<net.Socket>;
    players: number;
    lastActivity: number;
    lastWake: number;
    waking: boolean;
    error: string | null;
}
const listeners = new Map<string, Listener>();
export const sleepConfig = (id: string) => readWorkflow<Sleep>('sleep', id, { enabled: false, port: 25566, idleSeconds: 600, owner: '' });
export function sleepStatus(id: string) { const l = listeners.get(id); return { config: sleepConfig(id), listening: !!l?.server.listening, connections: l?.players ?? 0, waking: l?.waking ?? false, state: l?.waking ? 'waking' : isRunning(id) ? 'running' : 'sleeping', error: l?.error ?? null }; }
export function encodeVarInt(value: number) { const parts: number[] = []; let n = value >>> 0; do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n)
        b |= 0x80;
    parts.push(b);
} while (n); return Buffer.from(parts); }
function varInt(buffer: Buffer, offset: number): {
    value: number;
    end: number;
} | null { let value = 0; for (let i = 0; i < 5; i++) {
    if (offset + i >= buffer.length)
        return null;
    const b = buffer[offset + i];
    value |= (b & 127) << (7 * i);
    if (!(b & 128))
        return { value: value >>> 0, end: offset + i + 1 };
} throw new Error('Invalid VarInt'); }
function packet(id: number, body: Buffer) { const payload = Buffer.concat([encodeVarInt(id), body]); return Buffer.concat([encodeVarInt(payload.length), payload]); }
function string(value: string) { const buffer = Buffer.from(value); return Buffer.concat([encodeVarInt(buffer.length), buffer]); }
export async function wakeMinecraft(id: string) { const c = sleepConfig(id), l = listeners.get(id); if (!c.enabled || !l)
    throw new HttpError(409, 'Enable the sleep proxy first'); authorizeWorkflowActor(c.owner, [id], ['power']); if (l.waking || isRunning(id))
    return sleepStatus(id); if (Date.now() - l.lastWake < 30000)
    throw new HttpError(429, 'Wake cooldown active; inspect the previous startup'); l.lastWake = Date.now(); l.waking = true; l.error = null; try {
    await startServer(id);
    l.lastActivity = Date.now();
}
catch (e) {
    l.error = (e as Error).message;
    throw e;
}
finally {
    l.waking = false;
} return sleepStatus(id); }
async function bind(id: string, c: Sleep) {
    const old = listeners.get(id);
    if (old) {
        old.server.close();
        old.sockets.forEach(s => s.destroy());
        listeners.delete(id);
    }
    if (!c.enabled)
        return;
    const s = getServer(id);
    if (!s || s.platform !== 'java' || isProxyLoader(s.loader))
        throw new HttpError(400, 'Sleep proxy supports standalone Minecraft Java game servers');
    const state: Listener = { server: net.createServer(), sockets: new Set(), players: 0, lastActivity: Date.now(), lastWake: 0, waking: false, error: null };
    state.server.on('connection', socket => {
        if (state.sockets.size >= 256) {
            socket.destroy();
            return;
        }
        state.sockets.add(socket);
        socket.setTimeout(15000, () => socket.destroy());
        socket.on('error', () => { });
        socket.on('close', () => state.sockets.delete(socket));
        let buffered: Buffer = Buffer.alloc(0), mode = 0;
        const onData = (chunk: Buffer) => {
            try {
                buffered = Buffer.concat([buffered, chunk]);
                if (buffered.length > 8192) {
                    socket.destroy();
                    return;
                }
                const length = varInt(buffered, 0);
                if (!length || buffered.length < length.end + length.value)
                    return;
                if (length.value > 4096)
                    throw new Error('Oversized handshake');
                const end = length.end + length.value, idField = varInt(buffered, length.end);
                if (!idField || idField.value !== 0)
                    throw new Error('Handshake required');
                const protocol = varInt(buffered, idField.end);
                if (!protocol)
                    return;
                const address = varInt(buffered, protocol.end);
                if (!address || address.value > 255)
                    throw new Error('Invalid server address');
                const next = varInt(buffered, address.end + address.value + 2);
                if (!next || next.end !== end || ![1, 2].includes(next.value))
                    throw new Error('Invalid next state');
                if (isRunning(id) && getServer(id)?.status === 'running') {
                    socket.off('data', onData);
                    socket.setTimeout(0);
                    const backend = net.connect({ host: '127.0.0.1', port: getServer(id)!.server_port });
                    state.players += next.value === 2 ? 1 : 0;
                    if (next.value === 2)
                        state.lastActivity = Date.now();
                    let counted = next.value === 2;
                    const close = () => { if (counted) {
                        state.players--;
                        state.lastActivity = Date.now();
                        counted = false;
                    } backend.destroy(); };
                    socket.once('close', close);
                    backend.on('error', () => socket.destroy());
                    backend.on('connect', () => { backend.write(buffered); socket.pipe(backend).pipe(socket); });
                    return;
                }
                if (next.value === 2) {
                    void wakeMinecraft(id).catch(() => { });
                    socket.end(packet(0, string(JSON.stringify({ text: 'Server waking. Please reconnect in a moment.' }))));
                    return;
                }
                if (mode === 0) {
                    const request = varInt(buffered, end);
                    if (!request || buffered.length < request.end + request.value)
                        return;
                    const requestId = varInt(buffered, request.end);
                    if (!requestId || requestId.value !== 0 || request.value !== 1)
                        throw new Error('Invalid status request');
                    mode = 1;
                    const description = { text: state.waking || getServer(id)?.status === 'starting' ? 'Outpost: waking — reconnect shortly' : 'Outpost: sleeping — join to wake' };
                    socket.write(packet(0, string(JSON.stringify({ version: { name: s.version, protocol: protocol.value }, players: { max: 0, online: 0 }, description }))));
                    socket.off('data', onData);
                    socket.on('data', ping => { if (ping.length === 10 && ping[0] === 9 && ping[1] === 1)
                        socket.end(ping);
                    else
                        socket.destroy(); });
                }
            }
            catch {
                socket.destroy();
            }
        };
        socket.on('data', onData);
    });
    state.server.on('error', error => { state.error = error.message; });
    await new Promise<void>((resolve, reject) => { state.server.once('error', reject); state.server.listen(c.port, '0.0.0.0', () => { state.server.off('error', reject); resolve(); }); });
    listeners.set(id, state);
}
export async function configureSleep(id: string, owner: string, input: Record<string, unknown>) {
    const port = boundedNumber(input.port, 1024, 65535, 'Public proxy port'), idleSeconds = boundedNumber(input.idleSeconds, 60, 86400, 'Idle seconds');
    if (!Number.isInteger(port) || !Number.isInteger(idleSeconds))
        throw new HttpError(400, 'Port and idle seconds must be integers');
    const current = sleepConfig(id);
    if (input.enabled === true && port !== current.port && listServers().some(s => sleepConfig(s.id).enabled && sleepConfig(s.id).port === port))
        throw new HttpError(409, 'Port belongs to another sleep proxy');
    if (input.enabled === true && prep('SELECT server_port FROM servers WHERE server_port=? UNION SELECT port FROM auxiliary_ports WHERE port=? AND NOT(server_id=? AND role=?) UNION SELECT port FROM allocations WHERE port=? AND (server_id IS NOT NULL OR expires>?)').get(port, port, id, 'sleep-proxy', port, Date.now()))
        throw new HttpError(409, 'Proxy port must be separate from game/reserved ports');
    const c: Sleep = { enabled: input.enabled === true, port, idleSeconds, owner };
    if (c.enabled && listeners.get(id)?.server.listening && current.port === port) {
        writeWorkflow('sleep', id, c);
        return sleepStatus(id);
    }
    const previousPort = prep('SELECT port FROM auxiliary_ports WHERE server_id=? AND role=?').get(id, 'sleep-proxy') as {
        port: number;
    } | undefined;
    if (c.enabled) {
        prep('DELETE FROM auxiliary_ports WHERE server_id=? AND role=?').run(id, 'sleep-proxy');
        try {
            prep('INSERT INTO auxiliary_ports(server_id,role,port,protocol) VALUES (?,?,?,?)').run(id, 'sleep-proxy', port, 'tcp');
        }
        catch (e) {
            if (previousPort)
                prep('INSERT INTO auxiliary_ports(server_id,role,port,protocol) VALUES (?,?,?,?)').run(id, 'sleep-proxy', previousPort.port, 'tcp');
            throw new HttpError(409, 'Proxy port is reserved');
        }
    }
    try {
        await bind(id, c);
        writeWorkflow('sleep', id, c);
        if (!c.enabled)
            prep('DELETE FROM auxiliary_ports WHERE server_id=? AND role=?').run(id, 'sleep-proxy');
        return sleepStatus(id);
    }
    catch (e) {
        prep('DELETE FROM auxiliary_ports WHERE server_id=? AND role=?').run(id, 'sleep-proxy');
        if (previousPort) {
            prep('INSERT INTO auxiliary_ports(server_id,role,port,protocol) VALUES (?,?,?,?)').run(id, 'sleep-proxy', previousPort.port, 'tcp');
            try {
                await bind(id, current);
            }
            catch { }
        }
        throw e;
    }
}
let timer: NodeJS.Timeout | undefined;
export async function initMinecraftSleep() {
    for (const s of listServers()) {
        const c = sleepConfig(s.id);
        if (c.enabled)
            try {
                await bind(s.id, c);
            }
            catch (e) {
                writeWorkflow('sleep-error', s.id, (e as Error).message);
            }
    }
    timer = setInterval(() => scanIdleMinecraft(), 15000);
    timer.unref();
}
export function stopMinecraftSleep() { if (timer)
    clearInterval(timer); listeners.forEach(l => { l.server.close(); l.sockets.forEach(s => s.destroy()); }); listeners.clear(); }
export function scanIdleMinecraft(now = Date.now()) { for (const [id, l] of listeners) {
    const c = sleepConfig(id);
    if (!isRunning(id) || getServer(id)?.status !== 'running' || l.players || getOnlinePlayers(id).length || now - l.lastActivity < c.idleSeconds * 1000)
        continue;
    try {
        authorizeWorkflowActor(c.owner, [id], ['power']);
        stopServer(id);
        l.lastActivity = now;
    }
    catch (e) {
        l.error = (e as Error).message;
    }
} }
