import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, prep } from '../db/db.js';
import { getServer, listServers } from './serverService.js';
import { isRunning, sendCommand, getLogBuffer, getRuntimeInfo } from './processManager.js';
import { instanceDir } from '../utils/paths.js';
import { confined, revision } from './fileWorkspaceService.js';
import { HttpError } from '../utils/asyncHandler.js';
import { readWorkflow, writeWorkflow, appendWorkflow, boundedNumber } from './workflowStore.js';
import { authorizeWorkflowActor } from './reliabilityService.js';
import { analyzeConfig } from './configEditorService.js';
import { scanUploadBuffers } from './antivirusService.js';
import { createBackup } from './backupService.js';
import { instancePortProtocol } from './portProtocol.js';
import { saveQuerySettings } from './browserStatsService.js';
import { getPlayerRoster } from './playerService.js';
import { capacityPortClaims } from './fleetCapacityService.js';
import { saveMatch, DEFAULT_MATCH } from './cs2MatchService.js';
export interface PortRole {
    role: string;
    offset: number;
    protocol: 'tcp' | 'udp' | 'both';
}
export const portBundle = (id: string) => prep('SELECT role,port,protocol FROM auxiliary_ports WHERE server_id=? ORDER BY port').all(id);
export function suggestedPorts(id: string): PortRole[] {
    const s = getServer(id)!;
    if (s.platform === 'java')
        return [{ role: 'game', offset: 0, protocol: 'tcp' }, { role: 'query', offset: 1, protocol: 'udp' }, { role: 'rcon', offset: 10, protocol: 'tcp' }];
    if (s.platform === 'bedrock')
        return [{ role: 'game', offset: 0, protocol: 'udp' }, { role: 'ipv6', offset: 1, protocol: 'udp' }];
    if (s.steam_preset === 'valheim')
        return [{ role: 'game', offset: 0, protocol: 'udp' }, { role: 'query', offset: 1, protocol: 'udp' }];
    if (s.steam_preset === 'ark')
        return [{ role: 'game', offset: 0, protocol: 'udp' }, { role: 'peer', offset: 1, protocol: 'udp' }, { role: 'query', offset: 19238, protocol: 'udp' }, { role: 'rcon', offset: 19243, protocol: 'tcp' }];
    return [{ role: 'game/query', offset: 0, protocol: instancePortProtocol(s) }, { role: 'rcon', offset: 1, protocol: 'tcp' }];
}
export function allocatePortBundle(id: string, base: unknown, input: unknown) {
    if (isRunning(id))
        throw new HttpError(409, 'Stop the instance before changing ports');
    boundedNumber(base, 1024, 65535, 'Base port');
    if (!Number.isInteger(base) || !Array.isArray(input) || !input.length || input.length > 16)
        throw new HttpError(400, 'Provide up to 16 port roles');
    const roles = input as PortRole[];
    if (!roles.every(r => typeof r.role === 'string' && /^[\w/-]{1,40}$/.test(r.role) && Number.isInteger(r.offset) && r.offset >= 0 && r.offset <= 64511 && ['tcp', 'udp', 'both'].includes(r.protocol)) || !roles.some(r => r.offset === 0 && r.role.startsWith('game')) || new Set(roles.map(r => r.offset)).size !== roles.length)
        throw new HttpError(400, 'Roles need unique offsets, valid protocols and a main game port at offset zero');
    const ports = roles.map(r => ({ ...r, port: Number(base) + r.offset }));
    if (ports.some(p => p.port > 65535))
        throw new HttpError(400, 'Bundle exceeds port 65535');
    db.exec('BEGIN IMMEDIATE');
    try {
        const used = new Set((prep('SELECT server_port AS port FROM servers WHERE id<>? UNION SELECT port FROM allocations WHERE (server_id IS NULL OR server_id<>?) AND (server_id IS NOT NULL OR expires>?) UNION SELECT port FROM auxiliary_ports WHERE server_id<>?').all(id, id, Date.now(), id) as {
            port: number;
        }[]).map(x => x.port));
        for(const port of capacityPortClaims()) used.add(port);
        if (ports.some(p => used.has(p.port)))
            throw new HttpError(409, 'A bundle port is allocated to another instance or reservation');
        const existing = prep('SELECT port FROM allocations WHERE server_id=?').get(id) as {
            port: number;
        } | undefined;
        if (existing && existing.port !== base)
            throw new HttpError(409, 'Release the existing pool assignment before moving the main port');
        if (prep("SELECT port FROM auxiliary_ports WHERE server_id=? AND role='sleep-proxy'").all(id).some(r => ports.some(p => p.port === r.port)))
            throw new HttpError(409, 'Bundle conflicts with the sleep proxy listener');
        prep("DELETE FROM auxiliary_ports WHERE server_id=? AND role<>'sleep-proxy'").run(id);
        for (const p of ports)
            prep('INSERT INTO auxiliary_ports(server_id,role,port,protocol) VALUES (?,?,?,?)').run(id, p.role, p.port, p.protocol);
        prep('UPDATE servers SET server_port=? WHERE id=?').run(Number(base), id);
        db.exec('COMMIT');
    }
    catch (e) {
        db.exec('ROLLBACK');
        throw e;
    }
    const s = getServer(id)!;
    const query = ports.find(p => p.role === 'query');
    if (query && s.platform === 'steam')
        saveQuerySettings(s, { port: query.port });
    return { ports, note: 'Ports are reserved together. The main game port and supported Steam query settings are applied; configure native RCON/voice/companion listeners to match. Pool/OS listeners outside Outpost may still occupy a port.' };
}
interface ProfileVersion {
    version: number;
    at: number;
    files: Record<string, string>;
    parent?: {
        id: string;
        version: number;
    };
}
interface Profile {
    id: string;
    owner: string;
    name: string;
    versions: ProfileVersion[];
}
export const configurationProfiles = (owner: string) => readWorkflow<Profile[]>('config-profiles', 'global', []).filter(p => p.owner === owner);
function profileFiles(owner: string, id: string, version: number, seen = new Set<string>()): Record<string, string> {
    if (seen.has(id) || seen.size > 16)
        throw new HttpError(400, 'Profile inheritance cycle/depth limit');
    seen.add(id);
    const p = configurationProfiles(owner).find(p => p.id === id), v = p?.versions.find(v => v.version === version);
    if (!v)
        throw new HttpError(404, 'Profile version unavailable');
    return { ...(v.parent ? profileFiles(owner, v.parent.id, v.parent.version, seen) : {}), ...v.files };
}
export function saveConfigurationProfile(owner: string, instance: string, input: Record<string, unknown>) {
    const name = String(input.name ?? '').trim();
    if (!name || name.length > 80 || !input.files || typeof input.files !== 'object' || Array.isArray(input.files))
        throw new HttpError(400, 'Provide a profile name and a map of file paths to text');
    const files = input.files as Record<string, string>;
    if (Object.keys(files).length > 32 || Object.values(files).some(v => typeof v !== 'string' || Buffer.byteLength(v) > 262144))
        throw new HttpError(400, 'Up to 32 text files of 256 KiB each are supported');
    for (const [p, c] of Object.entries(files)) {
        confined(instance, p);
        if (analyzeConfig(p, c).diagnostics.some(d => d.severity === 'error'))
            throw new HttpError(400, `Invalid configuration: ${p}`);
    }
    const all = readWorkflow<Profile[]>('config-profiles', 'global', []);
    let p = all.find(p => p.id === input.id && p.owner === owner);
    if (input.id && !p)
        throw new HttpError(404, 'Profile unavailable');
    if (!p) {
        p = { id: crypto.randomUUID(), owner, name, versions: [] };
        all.push(p);
    }
    p.name = name;
    const parent = input.parent as ProfileVersion['parent'];
    if (parent) {
        if (parent.id === p.id)
            throw new HttpError(400, 'A profile cannot inherit itself');
        profileFiles(owner, parent.id, parent.version);
    }
    p.versions.unshift({ version: (p.versions[0]?.version ?? 0) + 1, at: Date.now(), files, parent });
    if (p.versions.length > 50)
        throw new HttpError(409, 'Profile reached 50 retained versions; create a new profile');
    writeWorkflow('config-profiles', 'global', all);
    return p;
}
export function previewProfile(owner: string, instance: string, id: string, version: number, selected: unknown) {
    const files = profileFiles(owner, id, version);
    if (!Array.isArray(selected) || !selected.length || selected.length > 32 || !selected.every(p => typeof p === 'string' && Object.hasOwn(files, p)))
        throw new HttpError(400, 'Select files from this profile version');
    const changes = selected.map(p => { const target = confined(instance, p); const exists = fs.existsSync(target); if (exists && fs.statSync(target).size > 262144)
        throw new HttpError(413, 'A target configuration is too large'); const before = exists ? fs.readFileSync(target, 'utf8') : null; return { path: p, before, after: files[p], revision: revision(before ?? 'missing'), diagnostics: analyzeConfig(p, files[p]).diagnostics }; });
    return { profile: id, version, restartRequired: true, changes, revision: revision(JSON.stringify(changes)) };
}
export async function applyProfile(owner: string, instance: string, input: Record<string, unknown>, authorize: () => void) {
    if (isRunning(instance))
        throw new HttpError(409, 'Stop the instance before applying configuration profiles');
    const preview = previewProfile(owner, instance, String(input.profile), Number(input.version), input.selected);
    if (input.revision !== preview.revision)
        throw new HttpError(409, 'Configuration changed since preview');
    if (preview.changes.some(c => c.diagnostics.some(d => d.severity === 'error')))
        throw new HttpError(400, 'Profile validation failed');
    await scanUploadBuffers(preview.changes.map(c => ({ name: c.path, buffer: Buffer.from(c.after) })), instance);
    authorize();
    if (isRunning(instance) || previewProfile(owner, instance, String(input.profile), Number(input.version), input.selected).revision !== preview.revision)
        throw new HttpError(409, 'Instance changed during review');
    const backup = await createBackup(instance, 'before-profile');
    authorize();
    if (isRunning(instance) || previewProfile(owner, instance, String(input.profile), Number(input.version), input.selected).revision !== preview.revision)
        throw new HttpError(409, 'Instance changed during backup');
    for (const c of preview.changes) {
        const target = confined(instance, c.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, c.after);
    }
    appendWorkflow('profile-applications', instance, { at: Date.now(), profile: preview.profile, version: preview.version, paths: preview.changes.map(c => c.path), backup: backup.fileName });
    return { ok: true, backup: backup.fileName };
}
export function recordPlayerIdentity(instance: string, name: string, event: string, identity?: string) {
    const history = readWorkflow<{
        name: string;
        firstSeen: number;
        lastSeen: number;
        joins: number;
        identities?: string[];
        events: {
            at: number;
            event: string;
        }[];
    }[]>('player-history', instance, []);
    let row = history.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (!row) {
        row = { name, firstSeen: Date.now(), lastSeen: Date.now(), joins: 0, events: [] };
        history.unshift(row);
    }
    if (identity && /^[\w:_\[\]-]{1,80}$/.test(identity))
        row.identities = [...new Set([...(row.identities ?? []), identity])];
    row.lastSeen = Date.now();
    if (event === 'join')
        row.joins++;
    row.events.unshift({ at: Date.now(), event });
    row.events = row.events.slice(0, 50);
    writeWorkflow('player-history', instance, history.slice(0, 2000));
}
export function playerDirectory(instance: string, q: string) {
    const history = readWorkflow<{
        name: string;
    }[]>('player-history', instance, []), roster = getPlayerRoster(instance);
    return [...new Set([...history.map(h => h.name), ...roster.map(p => p.name)])].filter(n => n.toLowerCase().includes(q.toLowerCase())).map(name => ({ name, ...history.find(p => p.name === name), ...roster.find(p => p.name === name), notes: readWorkflow<{
            name: string;
            note: string;
            at: number;
            by: string;
        }[]>('moderation-notes', instance, []).filter(n => n.name.toLowerCase() === name.toLowerCase()) })).slice(0, 200);
}
export function addModerationNote(instance: string, owner: string, name: unknown, note: unknown) { if (typeof name !== 'string' || name.length > 64 || typeof note !== 'string' || !note.trim() || note.length > 2000)
    throw new HttpError(400, 'Provide a player name and a note under 2000 characters'); appendWorkflow('moderation-notes', instance, { name, note: note.trim(), at: Date.now(), by: owner }, 1000); }
interface TimedBan {
    id: string;
    owner: string;
    name: string;
    reason: string;
    expires: number;
    state: string;
    at: number;
}
export function timedBans(instance: string) { return readWorkflow<TimedBan[]>('timed-bans', instance, []); }
export function banPlayer(instance: string, owner: string, input: Record<string, unknown>) {
    const s = getServer(instance)!;
    if (s.platform !== 'java' || !['vanilla', 'paper', 'purpur', 'spigot', 'fabric', 'forge', 'neoforge', 'quilt', 'folia'].includes(s.loader))
        throw new HttpError(400, 'Timed player bans currently support Minecraft Java game servers');
    if (!isRunning(instance))
        throw new HttpError(409, 'Start the instance to apply a ban through its command interface');
    const name = String(input.name ?? ''), reason = String(input.reason ?? 'Panel moderation');
    if (!/^\w{1,16}$/.test(name) || !/^[-\w .,!?()]{1,200}$/.test(reason))
        throw new HttpError(400, 'Use a Java username and a plain-text reason');
    const minutes = boundedNumber(input.minutes, 1, 525600, 'Ban minutes');
    sendCommand(instance, `ban ${name} ${reason}`);
    const previous = timedBans(instance);
    for (const b of previous)
        if (b.state === 'active' && b.name.toLowerCase() === name.toLowerCase())
            b.state = 'superseded';
    writeWorkflow('timed-bans', instance, previous);
    const ban: TimedBan = { id: crypto.randomUUID(), owner, name, reason, expires: Date.now() + minutes * 60000, state: 'active', at: Date.now() };
    appendWorkflow('timed-bans', instance, ban, 1000);
    recordPlayerIdentity(instance, name, 'Timed ban applied');
    return ban;
}
export function expireTimedBans() { for (const s of listServers()) {
    const rows = timedBans(s.id);
    let changed = false;
    for (const row of rows)
        if (row.state === 'active' && row.expires <= Date.now()) {
            try {
                authorizeWorkflowActor(row.owner, [s.id], ['players']);
                if (!isRunning(s.id))
                    continue;
                sendCommand(s.id, `pardon ${row.name}`);
                row.state = 'expired';
                recordPlayerIdentity(s.id, row.name, 'Timed ban expired');
            }
            catch (e) {
                row.state = 'blocked';
            }
            changed = true;
        }
    if (changed)
        writeWorkflow('timed-bans', s.id, rows);
} }
export function sharedBans() { return readWorkflow<{
    name: string;
    reason: string;
}[]>('shared-bans', 'global', []); }
export function saveSharedBans(input: unknown) { if (!Array.isArray(input) || input.length > 1000 || !input.every(b => typeof b.name === 'string' && /^\w{1,16}$/.test(b.name) && typeof b.reason === 'string' && /^[-\w .,!?()]{1,200}$/.test(b.reason)))
    throw new HttpError(400, 'Use up to 1000 Java usernames and plain-text reasons'); writeWorkflow('shared-bans', 'global', input); return input; }
export function applySharedBans(instance: string) { const s = getServer(instance)!; if (s.platform !== 'java' || !isRunning(instance))
    throw new HttpError(409, 'Shared bans require a running Minecraft Java server'); const timers = timedBans(instance); for (const b of sharedBans()) {
    sendCommand(instance, `ban ${b.name} ${b.reason}`);
    for (const t of timers)
        if (t.state === 'active' && t.name.toLowerCase() === b.name.toLowerCase())
            t.state = 'superseded-shared';
} writeWorkflow('timed-bans', instance, timers); return { applied: sharedBans().length }; }
interface Match {
    id: string;
    at: number;
    teamA: string;
    teamB: string;
    rosterA: string[];
    rosterB: string[];
    maps: string[];
    vetoes: {
        map: string;
        team: string;
    }[];
    state: string;
    scoreA?: number;
    scoreB?: number;
    winner?: string;
}
export const matchHistory = (id: string) => readWorkflow<Match[]>('matches', id, []);
export function saveTournament(id: string, input: Record<string, unknown>) {
    const s = getServer(id)!;
    if (!['cs2', 'tf2'].includes(s.steam_preset ?? ''))
        throw new HttpError(400, 'Tournament workflows support CS2 and TF2');
    const teamA = String(input.teamA ?? ''), teamB = String(input.teamB ?? ''), rosterA = input.rosterA as string[], rosterB = input.rosterB as string[], maps = input.maps as string[];
    if (![teamA, teamB].every(t => /^[\w .()-]{1,48}$/.test(t)) || ![rosterA, rosterB].every(r => Array.isArray(r) && r.length <= 32 && r.every(n => typeof n === 'string' && /^[\w .()-]{1,64}$/.test(n))) || !Array.isArray(maps) || !maps.length || maps.length > 32 || !maps.every(m => /^[\w-]{1,80}$/.test(m)) || new Set(maps).size !== maps.length)
        throw new HttpError(400, 'Use plain team/player/map names and 1–32 unique maps');
    const m: Match = { id: crypto.randomUUID(), at: Date.now(), teamA, teamB, rosterA, rosterB, maps, vetoes: [], state: 'veto' };
    appendWorkflow('matches', id, m);
    return m;
}
export function vetoMap(id: string, matchId: string, map: string) { const rows = matchHistory(id), m = rows.find(m => m.id === matchId); if (!m || m.state !== 'veto')
    throw new HttpError(409, 'No active veto'); if (!m.maps.includes(map) || m.vetoes.some(v => v.map === map) || m.maps.length - m.vetoes.length <= 1)
    throw new HttpError(400, 'Choose a remaining map; keep at least one'); m.vetoes.push({ map, team: m.vetoes.length % 2 ? m.teamB : m.teamA }); writeWorkflow('matches', id, rows); return m; }
export function tournamentAction(id: string, matchId: string, input: Record<string, unknown>) {
    const rows = matchHistory(id), m = rows.find(m => m.id === matchId);
    if (!m)
        throw new HttpError(404, 'Match not found');
    const s = getServer(id)!;
    if (input.action === 'prepare') {
        if (isRunning(id))
            throw new HttpError(409, 'Stop the game before writing tournament presets');
        const maps = m.maps.filter(x => !m.vetoes.some(v => v.map === x));
        if (s.steam_preset === 'cs2')
            saveMatch(id, { ...DEFAULT_MATCH, team1: m.teamA, team2: m.teamB, rotation: maps });
        else if (s.steam_preset === 'tf2') {
            const target = confined(id, 'tf/cfg/outpost_tournament.cfg');
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, `// Outpost tournament preset\nmp_tournament 1\nmp_tournament_redteamname "${m.teamA}"\nmp_tournament_blueteamname "${m.teamB}"\nmp_timelimit 30\nmp_winlimit 5\n`);
        }
        m.state = 'prepared';
    }
    else if (input.action === 'result') {
        m.scoreA = boundedNumber(input.scoreA, 0, 10000, 'Team A score');
        m.scoreB = boundedNumber(input.scoreB, 0, 10000, 'Team B score');
        if (!Number.isInteger(m.scoreA) || !Number.isInteger(m.scoreB))
            throw new HttpError(400, 'Scores must be integers');
        m.state = 'completed';
        m.winner = m.scoreA === m.scoreB ? 'draw' : m.scoreA > m.scoreB ? m.teamA : m.teamB;
    }
    else
        throw new HttpError(400, 'Unknown match action');
    writeWorkflow('matches', id, rows);
    return m;
}
export function profilerAction(id: string, action: string, seconds: number) {
    const s = getServer(id)!;
    if (s.platform !== 'java' || ['velocity', 'bungeecord', 'waterfall'].includes(s.loader))
        throw new HttpError(400, 'Profiler commands support Minecraft Java game servers with spark installed');
    if (!isRunning(id))
        throw new HttpError(409, 'Start the instance first');
    const commands: Record<string, string> = { start: `spark profiler start --timeout ${boundedNumber(seconds, 10, 600, 'Profile duration')}`, stop: 'spark profiler stop', cancel: 'spark profiler cancel', health: 'spark health show', ticks: 'spark tps' };
    if (!commands[action])
        throw new HttpError(400, 'Unknown profiler action');
    sendCommand(id, commands[action]);
    appendWorkflow('profiler-runs', id, { at: Date.now(), action, seconds, resource: getRuntimeInfo(id)?.stats, note: 'Inspect spark output/viewer hotspots; reports can upload to the spark service.' });
    return profilerReport(id);
}
export function profilerReport(id: string) { const lines = getLogBuffer(id).slice(-500).filter(l => /spark|TPS|MSPT|tick.*(?:duration|time)|can't keep up/i.test(l)); const urls = [...new Set(lines.flatMap(l => l.match(/https:\/\/spark\.lucko\.me\/[A-Za-z0-9]+/g) ?? []))]; return { runs: readWorkflow('profiler-runs', id, []), lines: lines.slice(-100), urls, resource: getRuntimeInfo(id)?.stats ?? null, suggestions: ['Open the spark viewer and inspect Server thread hotspots by plugin/mod.', 'Compare tick time, CPU and memory at the time of the capture.', 'Reduce expensive world simulation or isolate a plugin/mod in staging before changing production.'] }; }
