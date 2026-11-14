import fs from 'node:fs';
import path from 'node:path';
import { prep } from '../db/db.js';
import { SERVER_ROOT } from '../utils/paths.js';
import { HttpError } from '../utils/asyncHandler.js';
import { GAME_PROFILES, type GameProfile } from './gameControlProfiles.js';
import { STEAM_GAME_PRESETS, type SteamGamePreset } from './steamGames.js';
import { getServer, listServers } from './serverService.js';
import { getUserById, userHasServerAccess } from './userService.js';
import { requirePermission } from '../auth/middleware.js';
import type { Request } from 'express';
import { readTextFile } from './fileService.js';
import { sendCommand } from './processManager.js';
import { fetchBounded, sha256, trustedTransport } from './fleetSecurity.js';
import { prepareGameControls, controlsOf } from './gameControlsService.js';
import { gameControlsLaunch } from './gameControlsLaunch.js';
import { envVar } from '../utils/env.js';
export const EXTENSION_API_VERSION = 1;
export const PANEL_VERSION = JSON.parse(fs.readFileSync(path.join(SERVER_ROOT, '../package.json'), 'utf8')).version as string;
const permissions = ['power', 'console', 'files.read', 'files.write', 'backups.create', 'backups.restore', 'plugins', 'players', 'settings', 'update', 'launch', 'network'];
export interface ExtensionManifest {
    format: 'outpost-extension';
    sdkVersion: 1;
    id: string;
    name: string;
    version: string;
    author: string;
    description: string;
    minPanelVersion: string;
    maxPanelVersion?: string;
    backend?: {
        url: string;
    };
    pages: {
        id: string;
        title: string;
        html: string;
        permissions: string[];
    }[];
    actions: {
        id: string;
        title: string;
        kind: 'instance.summary' | 'files.read' | 'console.command' | 'backend.request';
        permissions: string[];
        backendPath?: string;
    }[];
    gameAdapters: (GameProfile & {
        executable: {
            linux: string;
            win32: string;
        };
        launchArgs: string[];
        hosts: NodeJS.Platform[];
    })[];
}
const version = (v: string) => {
    if (!/^\d+\.\d+\.\d+$/.test(v))
        throw new HttpError(400, 'Use numeric major.minor.patch versions');
    return v.split('.').map(Number);
};
const compare = (a: string, b: string) => {
    const x = version(a), y = version(b);
    for (let i = 0; i < 3; i++)
        if (x[i] !== y[i])
            return x[i] - y[i];
    return 0;
};
function relative(p: unknown) { return typeof p === 'string' && p.length < 300 && !p.startsWith('/') && !/[\\:\x00-\x1f]/.test(p) && !p.split('/').some(v => !v || v === '.' || v === '..'); }
function declared(p: unknown) { return Array.isArray(p) && p.length <= permissions.length && p.every(x => permissions.includes(x)) && new Set(p).size === p.length; }
function keysOnly(input: unknown, keys: string[]) { if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key)))
    throw new HttpError(400, 'Unknown or malformed SDK manifest fields'); }
export function validateExtension(input: unknown): ExtensionManifest {
    keysOnly(input, ['format', 'sdkVersion', 'id', 'name', 'version', 'author', 'description', 'minPanelVersion', 'maxPanelVersion', 'backend', 'pages', 'actions', 'gameAdapters']);
    if (!input || typeof input !== 'object' || Buffer.byteLength(JSON.stringify(input)) > 2 * 1024 * 1024)
        throw new HttpError(400, 'Extension manifest must be under 2 MiB');
    const m = input as ExtensionManifest;
    if (m.format !== 'outpost-extension' || m.sdkVersion !== 1 || typeof m.id !== 'string' || !/^[a-z][a-z0-9-]{2,59}$/.test(m.id) || typeof m.name !== 'string' || !m.name || m.name.length > 80 || typeof m.author !== 'string' || m.author.length > 200 || typeof m.description !== 'string' || m.description.length > 2000)
        throw new HttpError(400, 'Invalid extension identity/SDK version');
    version(m.version);
    version(m.minPanelVersion);
    if (m.maxPanelVersion !== undefined)
        version(m.maxPanelVersion);
    if (compare(PANEL_VERSION, m.minPanelVersion) < 0 || (m.maxPanelVersion && compare(PANEL_VERSION, m.maxPanelVersion) > 0))
        throw new HttpError(409, `Extension is incompatible with Outpost ${PANEL_VERSION}`);
    if (!Array.isArray(m.pages) || m.pages.length > 16 || !Array.isArray(m.actions) || m.actions.length > 32 || !Array.isArray(m.gameAdapters) || m.gameAdapters.length > 8)
        throw new HttpError(400, 'Extension page/action/adapter limits exceeded');
    for (const p of m.pages)
        keysOnly(p, ['id', 'title', 'html', 'permissions']);
    for (const a of m.actions)
        keysOnly(a, ['id', 'title', 'kind', 'permissions', 'backendPath']);
    if (m.backend !== undefined)
        keysOnly(m.backend, ['url']);
    for (const p of m.pages)
        if (!p || typeof p.id !== 'string' || !/^[\w-]{1,60}$/.test(p.id) || typeof p.title !== 'string' || p.title.length > 80 || typeof p.html !== 'string' || p.html.length > 262144 || !declared(p.permissions))
            throw new HttpError(400, 'Invalid extension page');
    for (const a of m.actions) {
        if (!a || typeof a.id !== 'string' || !/^[\w-]{1,60}$/.test(a.id) || typeof a.title !== 'string' || a.title.length > 80 || !declared(a.permissions) || !['instance.summary', 'files.read', 'console.command', 'backend.request'].includes(a.kind))
            throw new HttpError(400, 'Invalid extension action');
        const required = ({ 'instance.summary': 'files.read', 'files.read': 'files.read', 'console.command': 'console' } as Record<string, string>)[a.kind];
        if (required && !a.permissions.includes(required))
            throw new HttpError(400, `${a.kind} must declare ${required}`);
        if (a.kind === 'backend.request' && (!m.backend || !a.backendPath || !/^\/[\w/-]{1,120}$/.test(a.backendPath) || a.backendPath.includes('..')))
            throw new HttpError(400, 'Backend actions need a fixed, bounded backend path');
    }
    if (new Set(m.pages.map(p => p.id)).size !== m.pages.length || new Set(m.actions.map(p => p.id)).size !== m.actions.length)
        throw new HttpError(400, 'Duplicate page/action IDs');
    if (m.backend)
        trustedTransport(m.backend.url);
    for (const g of m.gameAdapters) {
        keysOnly(g, ['id', 'appId', 'label', 'format', 'file', 'fields', 'notes', 'executable', 'launchArgs', 'hosts']);
        if (g.executable)
            keysOnly(g.executable, ['linux', 'win32']);
        if (Array.isArray(g.fields))
            for (const f of g.fields) {
                keysOnly(f, ['key', 'label', 'type', 'default', 'min', 'max', 'options', 'launch', 'help']);
                if ((f.min !== undefined && !Number.isFinite(f.min)) || (f.max !== undefined && !Number.isFinite(f.max)) || (f.min !== undefined && f.max !== undefined && f.min > f.max) || (f.launch !== undefined && typeof f.launch !== 'boolean') || (f.help !== undefined && (typeof f.help !== 'string' || f.help.length > 1000)) || /[\x00\r\n]/.test(f.default))
                    throw new HttpError(400, 'Invalid adapter field bounds/default');
            }
        if (!g || typeof g.id !== 'string' || !g.id.startsWith(`x-${m.id}-`) || !/^[\w-]{1,90}$/.test(g.id) || !/^\d{1,12}$/.test(g.appId) || typeof g.label !== 'string' || g.label.length > 100 || !['source', 'quake', 'kv', 'ini', 'xml', 'commands', 'arma'].includes(g.format) || !relative(g.file) || !Array.isArray(g.fields) || g.fields.length > 64 || !g.fields.every(f => f && typeof f.key === 'string' && /^[\w.-]{1,80}$/.test(f.key) && typeof f.label === 'string' && f.label.length < 160 && ['text', 'number', 'boolean', 'select', 'password'].includes(f.type) && typeof f.default === 'string' && f.default.length < 1000 && (!f.options || (Array.isArray(f.options) && f.options.length <= 100 && f.options.every(o => typeof o === 'string' && o.length < 200)))) || !g.executable || !relative(g.executable.linux) || !relative(g.executable.win32) || !Array.isArray(g.launchArgs) || g.launchArgs.length > 100 || !g.launchArgs.every(a => typeof a === 'string' && a.length < 1000 && !/[\x00\r\n]/.test(a)) || !Array.isArray(g.hosts) || !g.hosts.length || !g.hosts.every(h => ['linux', 'win32'].includes(h)) || !Array.isArray(g.notes) || g.notes.some(n => typeof n !== 'string' || n.length > 1000) || g.map)
            throw new HttpError(400, 'Game adapters need safe native configuration/launch definitions. SDK v1 does not accept custom executable code or map archive handlers.');
        if (new Set(g.fields.map(f => f.key)).size !== g.fields.length || g.launchArgs.some(a => [...a.matchAll(/\{setting\.([^}]+)\}/g)].some(m => !g.fields.some(f => f.key === m[1]))))
            throw new HttpError(400, 'Duplicate adapter fields or unknown launch setting');
    }
    if (new Set(m.gameAdapters.map(g => g.id)).size !== m.gameAdapters.length)
        throw new HttpError(400, 'Duplicate game adapter IDs');
    return JSON.parse(JSON.stringify(m));
}
interface Row {
    id: string;
    manifest: string;
    enabled: number;
    provenance: string;
    history: string;
}
export function extensionRows() {
    return (prep('SELECT * FROM panel_extensions ORDER BY id').all() as unknown as Row[]).map(r => ({ id: r.id, manifest: JSON.parse(r.manifest) as ExtensionManifest, enabled: !!r.enabled, provenance: JSON.parse(r.provenance), history: JSON.parse(r.history) as {
            manifest: ExtensionManifest;
            provenance: unknown;
        }[] }));
}
export function extensionReview(input: unknown) { const m = validateExtension(input), old = extensionRows().find(r => r.id === m.id); return { manifest: m, digest: sha256(JSON.stringify(m)), currentVersion: old?.manifest.version ?? null, permissions: [...new Set([...m.pages.flatMap(p => p.permissions), ...m.actions.flatMap(a => a.permissions)])], addedPermissions: [...new Set([...m.pages.flatMap(p => p.permissions), ...m.actions.flatMap(a => a.permissions)])].filter(p => !old || ![...old.manifest.pages.flatMap(p => p.permissions), ...old.manifest.actions.flatMap(a => a.permissions)].includes(p)), backend: m.backend?.url ?? null, gameAdapters: m.gameAdapters.map(g => g.id), boundary: 'Sandboxed inline UI, fixed backend endpoints and declarative native game settings. No panel-process JavaScript/module installation.' }; }
export function installExtension(input: unknown, digest: unknown, provenance: unknown) {
    const review = extensionReview(input);
    if (digest !== review.digest)
        throw new HttpError(409, 'Review digest changed');
    const old = extensionRows().find(r => r.id === review.manifest.id);
    if (old && old.manifest.gameAdapters.some(g => listServers().some(s => s.steam_preset === g.id)))
        throw new HttpError(409, 'Migrate/delete instances using this adapter before replacing its extension');
    const history = old ? [{ manifest: old.manifest, provenance: old.provenance }, ...old.history].slice(0, 5) : [];
    prep('INSERT INTO panel_extensions(id,manifest,enabled,provenance,history) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET manifest=excluded.manifest,enabled=0,provenance=excluded.provenance,history=excluded.history').run(review.manifest.id, JSON.stringify(review.manifest), 0, JSON.stringify(provenance), JSON.stringify(history));
    reloadExtensionAdapters();
    return { id: review.manifest.id, enabled: false };
}
const registered = new Set<string>();
export function reloadExtensionAdapters() {
    for (const id of registered) {
        const p = GAME_PROFILES.findIndex(g => g.id === id);
        if (p >= 0)
            GAME_PROFILES.splice(p, 1);
        const s = STEAM_GAME_PRESETS.findIndex(g => g.id === id);
        if (s >= 0)
            STEAM_GAME_PRESETS.splice(s, 1);
    }
    registered.clear();
    for (const row of extensionRows().filter(r => r.enabled)) {
        let m: ExtensionManifest;
        try {
            m = validateExtension(row.manifest);
        }
        catch {
            continue;
        }
        for (const g of m.gameAdapters) {
            if (GAME_PROFILES.some(p => p.id === g.id) || STEAM_GAME_PRESETS.some(p => p.id === g.id))
                continue;
            GAME_PROFILES.push({ ...g, notes: [...g.notes, `Extension adapter ${m.name} ${m.version}; live compatibility is publisher-provided.`] });
            const preset: SteamGamePreset = { id: g.id, label: g.label, appId: g.appId, defaultPort: 27015, portProtocol: 'udp', executable: g.executable, hosts: g.hosts, needsExecuteBit: true, stopStrategy: { kind: 'signal', signal: 'SIGTERM' }, prepareInstance: server => prepareGameControls(server, g.id), buildLaunchArgs: server => gameControlsLaunch(server, g.id, g.launchArgs.map(a => a.replace(/\{port\}/g, String(server.server_port)).replace(/\{name\}/g, server.name).replace(/\{setting\.([^}]+)\}/g, (_match, key: string) => controlsOf(server, g).values[key] ?? ''))) };
            STEAM_GAME_PRESETS.push(preset);
            registered.add(g.id);
        }
    }
}
export function toggleExtension(id: string, enabled: boolean) {
    const row = extensionRows().find(r => r.id === id);
    if (!row)
        throw new HttpError(404, 'Extension not found');
    validateExtension(row.manifest);
    if (!enabled && row.manifest.gameAdapters.some(g => listServers().some(s => s.steam_preset === g.id)))
        throw new HttpError(409, 'Instances depend on this game adapter; migrate/delete them first');
    prep('UPDATE panel_extensions SET enabled=? WHERE id=?').run(enabled ? 1 : 0, id);
    reloadExtensionAdapters();
}
export function rollbackExtension(id: string) {
    const row = extensionRows().find(r => r.id === id), prior = row?.history[0];
    if (!row || !prior)
        throw new HttpError(404, 'No previous extension version');
    const review = extensionReview(prior.manifest);
    return installExtension(prior.manifest, review.digest, prior.provenance);
}
export function authorizeExtension(req: Request, required: string[], serverId?: string) {
    const user = getUserById(req.auth!.sub);
    if (!user || user.disabled)
        throw new HttpError(403, 'Account unavailable');
    req.auth!.role = user.role;
    if (!required.length && user.role !== 'admin')
        throw new HttpError(403, 'This extension capability is administrator-only');
    if (!serverId) {
        if (user.role !== 'admin')
            throw new HttpError(403, 'Global extension pages/actions require administrator access');
        return;
    }
    const server = getServer(serverId);
    if (!server || (user.role !== 'admin' && (!userHasServerAccess(user.id, serverId) || server.suspended)))
        throw new HttpError(403, 'Instance access denied');
    for (const p of required)
        requirePermission(req, p as Parameters<typeof requirePermission>[1], serverId);
}
export function extensionPage(req: Request, id: string, pageId: string, serverId?: string) {
    const row = extensionRows().find(r => r.id === id && r.enabled), page = row?.manifest.pages.find(p => p.id === pageId);
    if (!row || !page)
        throw new HttpError(404, 'Extension page is not enabled');
    validateExtension(row.manifest);
    authorizeExtension(req, page.permissions, serverId);
    return { title: page.title, html: page.html, extension: { id, version: row.manifest.version }, actions: row.manifest.actions.map(a => ({ id: a.id, title: a.title, permissions: a.permissions })) };
}
export async function invokeExtension(req: Request, id: string, actionId: string, input: unknown, serverId?: string) {
    const row = extensionRows().find(r => r.id === id && r.enabled), action = row?.manifest.actions.find(a => a.id === actionId);
    if (!row || !action)
        throw new HttpError(404, 'Extension action is not enabled');
    validateExtension(row.manifest);
    authorizeExtension(req, action.permissions, serverId);
    if (Buffer.byteLength(JSON.stringify(input ?? {})) > 65536)
        throw new HttpError(413, 'Action input exceeds 64 KiB');
    const body = (input ?? {}) as Record<string, unknown>;
    if (action.kind === 'instance.summary') {
        if (!serverId)
            throw new HttpError(400, 'Select an instance');
        const s = getServer(serverId)!;
        return { id: s.id, name: s.name, platform: s.platform, status: s.status, version: s.version, port: s.server_port };
    }
    if (action.kind === 'files.read') {
        if (!serverId || typeof body.path !== 'string')
            throw new HttpError(400, 'Instance and relative file path required');
        return { content: await readTextFile(serverId, body.path) };
    }
    if (action.kind === 'console.command') {
        if (!serverId || typeof body.command !== 'string' || !body.command.trim() || body.command.length > 1000 || /[\r\n\x00]/.test(body.command))
            throw new HttpError(400, 'One bounded console command is required');
        sendCommand(serverId, body.command);
        return { dispatched: true };
    }
    const endpoint = trustedTransport(row.manifest.backend!.url);
    endpoint.pathname = endpoint.pathname.replace(/\/$/, '') + action.backendPath;
    const secret = envVar(`EXTENSION_SECRET_${id.toUpperCase().replace(/-/g, '_')}`);
    const result = await fetchBounded(endpoint.toString(), { method: 'POST', headers: { 'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) }, body: JSON.stringify({ sdkVersion: 1, extension: id, action: actionId, context: { userId: req.auth!.sub, serverId: serverId ?? null }, input: body }) }, 1024 * 1024);
    authorizeExtension(req, action.permissions, serverId);
    return JSON.parse(result.toString('utf8'));
}
