import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { prep } from '../db/db.js';
import { instanceDir } from '../utils/paths.js';
import { HttpError } from '../utils/asyncHandler.js';
import { getServer } from './serverService.js';
import { getUserById, getServerPermissions, userHasServerAccess } from './userService.js';
import { listPlugins, getAddonSupport, addonArtifactFile, deletePlugin, setPluginEnabled } from './pluginService.js';
import { inspectAddonMetadata, text, type AddonMetadata, type AddonDependency } from './addonMetadataService.js';
import { inspectCoreKeeperMod } from './coreKeeperMods.js';
import { confined, recycleBatch } from './fileWorkspaceService.js';
import { hashFile } from './verifiedBackupService.js';
import { isRunning } from './processManager.js';
import { withAddonOperation } from './addonOperationService.js';
import { readWorkflow } from './workflowStore.js';
import { createBackup } from './backupService.js';
import { assertGameWorkflowIdle } from './gameUpdateWorkflowService.js';
import { assertWorldHealthIdle } from './worldHealthService.js';
import { assertRecoveryIdle } from './fleetRecoveryService.js';
import { assertBackupIdle } from './verifiedBackupService.js';
import type { ServerRecord } from '../types/index.js';
interface Provenance {
    source: 'modrinth' | 'curseforge' | 'upload' | 'untracked';
    project?: string;
    versionId?: string;
    version?: string;
    title?: string;
    hash: string;
    explicit: boolean;
    at: number;
    dependencies: AddonDependency[];
    aliases: string[];
    complete: boolean;
}
export interface InstalledAddon {
    id: string;
    fileName: string;
    name: string;
    enabled: boolean;
    canToggle: boolean;
    sizeBytes: number;
    modifiedAt: string;
    relativePath: string | null;
    hash: string | null;
    metadata: AddonMetadata;
    provenance: Provenance | null;
    installation: 'explicit' | 'dependency' | 'untracked';
    coverage: 'manifest' | 'catalog' | 'incomplete';
    provides: string[];
    dependencies: AddonDependency[];
    requiredBy: {
        id: string;
        name: string;
        enabled: boolean;
    }[];
    optionalBy: {
        id: string;
        name: string;
    }[];
}
export interface AddonInventory {
    serverId: string;
    revision: string;
    items: InstalledAddon[];
    warnings: string[];
    dependencyCleanup: boolean;
    interrupted?: {
        id: string;
        action: string;
        state: string;
    }[];
}
interface ActionPlan {
    id: string;
    serverId: string;
    owner: string;
    rootId: string;
    action: 'remove' | 'disable' | 'enable';
    expires: number;
    revision: string;
    cleanup: boolean;
    includeUntracked: boolean;
    remove: string[];
    keep: {
        id: string;
        name: string;
        reason: string;
    }[];
    blockers: string[];
    warnings: string[];
    requiresAcknowledgement: boolean;
    state: 'review' | 'applying' | 'recovery-required' | 'applied';
    recovery?: {
        backup: string | null;
        paths: string[];
    };
    result?: unknown;
}
const base = (file: string) => file.replace(/\.disabled$/, '');
const idOf = (file: string) => crypto.createHash('sha256').update(file).digest('hex').slice(0, 32);
const digest = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const cache = new Map<string, {
    stamp: string;
    hash: string;
    metadata: AddonMetadata;
}>();
const hashes = new Map<string, {
    stamp: string;
    hash: string;
}>();
const runtime = new Set(['mod:minecraft', 'mod:java', 'mod:fabricloader', 'mod:quilt_loader', 'mod:forge', 'mod:neoforge']);
const empty = (): AddonMetadata => ({ name: null, version: null, description: '', authors: [], licenses: [], links: [], provides: [], dependencies: [], format: 'unknown', complete: false, warnings: [], bundled: [] });
export function authorizeAddonMutation(owner: string, id: string) { const user = getUserById(owner), s = getServer(id); if (!user || user.disabled || !s || (user.role !== 'admin' && (!userHasServerAccess(owner, id) || s.suspended)) || !getServerPermissions(owner, user.role, id)?.includes('plugins'))
    throw new HttpError(403, 'Current plugins permission is required'); }
export function assertAddonStopped(id: string) { const s = getServer(id); if (!s)
    throw new HttpError(404, 'Instance not found'); if (isRunning(id) || !['stopped', 'crashed', 'install_failed'].includes(s.status))
    throw new HttpError(409, 'Stop the instance and finish background jobs before changing installed add-ons'); assertGameWorkflowIdle(id); assertWorldHealthIdle(id); assertRecoveryIdle(id); assertBackupIdle(id); }
async function treeHash(id: string, relative: string, budget: {
    bytes: number;
    files: number;
}, force: boolean): Promise<{
    hash: string;
    metadata: AddonMetadata;
}> {
    const file = confined(id, relative), st = fs.lstatSync(file);
    if (!st.isFile() && !st.isDirectory())
        throw new HttpError(400, 'Special add-on files are not supported');
    if (++budget.files > 16384 || (budget.bytes += st.isFile() ? st.size : 0) > 4 * 1024 ** 3)
        throw new HttpError(413, 'Add-on inventory exceeds the 4 GiB / 16,384 file inspection limit');
    if (st.isDirectory()) {
        const entries = fs.readdirSync(file).sort();
        if (entries.length > 4096)
            throw new HttpError(413, 'Add-on folder exceeds inspection limits');
        const hashes = [];
        for (const n of entries) {
            if (relative.split('/').length > 40)
                throw new HttpError(413, 'Add-on folder depth limit');
            hashes.push([n, (await treeHash(id, `${relative}/${n}`, budget, force)).hash]);
        }
        return { hash: digest(hashes), metadata: empty() };
    }
    const stamp = [st.size, st.mtimeMs, st.ctimeMs, st.ino].join(':'), old = hashes.get(file);
    if (!force && old?.stamp === stamp)
        return { ...old, metadata: empty() };
    const hash = await hashFile(file);
    if (hashes.size >= 4096)
        hashes.clear();
    hashes.set(file, { stamp, hash });
    return { hash, metadata: empty() };
}
function provenance(id: string, file: string, hash: string): Provenance | null {
    const managed = readWorkflow<{
        file: string;
        project: string;
        version: string;
        hash: string;
        explicit?: boolean;
    }[]>('managed-mods', id, []).find(r => r.file === base(file) && r.hash === hash);
    const row = prep('SELECT data FROM addon_installations WHERE server_id=? AND file=?').get(id, base(file)) as {
        data: string;
    } | undefined;
    if (row) {
        const data = JSON.parse(row.data) as Provenance;
        if (data.hash === hash)
            return { ...data, explicit: data.explicit || managed?.explicit === true };
    }
    return managed ? { source: 'modrinth', project: managed.project, version: managed.version, hash, explicit: managed.explicit !== false, at: 0, dependencies: [], aliases: ['modrinth:' + managed.project], complete: false } : null;
}
function packMetadata(folder: string): AddonMetadata {
    const m = empty(), p = path.join(folder, 'manifest.json');
    try {
        if (fs.statSync(p).size > 1048576)
            throw Error('Manifest too large');
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (typeof data.header?.uuid !== 'string')
            throw Error('Missing identity');
        m.name = text(data.header.name);
        m.version = Array.isArray(data.header.version) ? data.header.version.join('.') : null;
        m.description = text(data.header.description, 4000);
        m.authors = Array.isArray(data.metadata?.authors) ? data.metadata.authors.map((x: unknown) => text(x)).slice(0, 64) : [];
        m.provides = [`bedrock:${data.header.uuid.toLowerCase()}`];
        m.format = 'manifest.json';
        m.complete = true;
        for (const d of data.dependencies ?? []) {
            if (d.uuid)
                m.dependencies.push({ key: `bedrock:${String(d.uuid).toLowerCase()}`, name: text(d.uuid), required: true, constraint: JSON.stringify(d.version ?? '*'), source: 'manifest.json' });
        }
    }
    catch {
        m.warnings.push('Pack dependencies could not be fully inspected.');
    }
    return m;
}
export async function installedAddons(server: ServerRecord, force = false): Promise<AddonInventory> {
    const support = getAddonSupport(server);
    if (!support.supported)
        return { serverId: server.id, revision: digest([]), items: [], warnings: [support.reason], dependencyCleanup: false };
    const rows = listPlugins(server);
    if (rows.length > 1024)
        throw new HttpError(413, 'Add-on inventory is limited to 1,024 artifacts');
    const warnings: string[] = [], items: InstalledAddon[] = [], budget = { bytes: 0, files: 0 };
    for (const row of rows) {
        let relative: string | null = null, hash: string | null = null, metadata = empty(), record: Provenance | null = null;
        try {
            const target = addonArtifactFile(server, row.fileName);
            relative = path.relative(instanceDir(server.id), target).split(path.sep).join('/');
            confined(server.id, relative);
            const st = fs.lstatSync(target), stamp = [st.size, st.mtimeMs, st.ctimeMs, st.ino, server.loader].join(':'), old = cache.get(target);
            const hashed = await treeHash(server.id, relative, budget, force);
            hash = hashed.hash;
            if (!force && old?.stamp === stamp && old.hash === hash)
                metadata = old.metadata;
            else {
                if (st.isFile() && /\.jar(\.disabled)?$/i.test(row.fileName) && server.platform === 'java')
                    metadata = inspectAddonMetadata(target, server.loader);
                else if (support.profile.kind === 'bedrock')
                    metadata = packMetadata(target);
                else if (support.profile.kind === 'core_keeper')
                    metadata = inspectCoreKeeperMod(target, metadata);
                if (st.isFile()) {
                    if (cache.size >= 4096)
                        cache.clear();
                    cache.set(target, { stamp, hash, metadata });
                }
            }
            record = provenance(server.id, row.fileName, hash);
        }
        catch (error) {
            if (error instanceof HttpError && error.status === 413)
                throw error;
            metadata.warnings.push('This artifact is not a readable, confined regular file/folder. Manage it through File Management.');
        }
        const merged = [...metadata.dependencies, ...(record?.dependencies ?? [])], dependencies = [...new Map(merged.map(d => [`${d.key}:${d.required}`, d])).values()];
        const coverage = dependencies.some(d => d.key.startsWith('unresolved:')) ? 'incomplete' : metadata.complete ? 'manifest' : record?.complete && metadata.format === 'unknown' ? 'catalog' : 'incomplete';
        const provides = [...new Set([...metadata.provides, ...(record?.aliases ?? [])])];
        items.push({ id: idOf(row.fileName), fileName: row.fileName, name: metadata.name || record?.title || row.displayName, enabled: row.enabled, canToggle: row.canToggle, sizeBytes: row.sizeBytes, modifiedAt: row.modifiedAt, relativePath: relative, hash, metadata, provenance: record, installation: record ? (record.explicit ? 'explicit' : 'dependency') : 'untracked', coverage, provides, dependencies, requiredBy: [], optionalBy: [] });
    }
    const providers = new Map<string, InstalledAddon[]>();
    for (const n of items)
        for (const key of n.provides) {
            const rows = providers.get(key) ?? [];
            rows.push(n);
            providers.set(key, rows);
        }
    for (const n of items)
        for (const dep of n.dependencies)
            for (const target of providers.get(dep.key) ?? []) {
                if (target.id === n.id)
                    continue;
                if (dep.required) {
                    if (!target.requiredBy.some(x => x.id === n.id))
                        target.requiredBy.push({ id: n.id, name: n.name, enabled: n.enabled });
                }
                else if (!target.optionalBy.some(x => x.id === n.id))
                    target.optionalBy.push({ id: n.id, name: n.name });
            }
    if (items.some(i => i.coverage === 'incomplete'))
        warnings.push('Some installed artifacts have incomplete dependency metadata. Automatic dependency pruning is disabled while those artifacts remain.');
    for (const [identity, files] of providers)
        if (files.length > 1)
            warnings.push(`Multiple providers declare ${identity}; all references are protected conservatively.`);
    const revision = digest([server.loader, server.version, items.map(i => [i.id, i.hash, i.enabled, i.provenance, i.metadata, i.relativePath])]);
    const interrupted = (prep("SELECT id,data FROM addon_action_plans WHERE server_id=? AND json_extract(data,'$.state') IN ('applying','recovery-required')").all(server.id) as {
        id: string;
        data: string;
    }[]).map(r => { const p = JSON.parse(r.data); return { id: r.id, action: p.action, state: p.state, ...(p.recovery?.backup ? { backup: p.recovery.backup } : {}) }; });
    return { serverId: server.id, revision, items, warnings, dependencyCleanup: server.platform === 'java' && ['mod', 'bukkit'].includes(support.profile.kind), interrupted };
}
export function addonDependencies(inventory: AddonInventory, item: InstalledAddon) { return item.dependencies.map(d => ({ ...d, runtime: runtime.has(d.key), installed: inventory.items.filter(i => i.provides.includes(d.key)).map(i => ({ id: i.id, name: i.name, enabled: i.enabled, version: i.metadata.version ?? i.provenance?.version ?? null })) })); }
export async function addonDetails(server: ServerRecord, id: string) { const inventory = await installedAddons(server); const item = inventory.items.find(i => i.id === id); if (!item)
    throw new HttpError(404, 'Installed add-on not found'); return { serverId: server.id, item, dependencies: addonDependencies(inventory, item), revision: inventory.revision, warnings: inventory.warnings, dependencyCleanup: inventory.dependencyCleanup }; }
export async function recordCatalogAddon(server: ServerRecord, file: string, input: {
    source: 'modrinth' | 'curseforge';
    project?: string;
    versionId?: string;
    version: string;
    title?: string;
    dependencies?: {
        projectId: string | null;
        versionId: string | null;
        required: boolean;
    }[];
}, explicit: boolean, previouslyPresent = false) {
    const target = addonArtifactFile(server, file), hash = await hashFile(target), old = provenance(server.id, file, hash);
    const aliases = [...(input.project ? [`${input.source}:${input.project}`] : []), ...(input.versionId ? [`${input.source}-version:${input.versionId}`] : [])];
    const record: Provenance = { source: input.source, project: input.project, version: input.version, versionId: input.versionId, title: input.title, hash, explicit: explicit || (old?.explicit ?? (previouslyPresent && !old)), at: Date.now(), aliases, complete: Array.isArray(input.dependencies), dependencies: (input.dependencies ?? []).map(d => ({ key: d.projectId ? `${input.source}:${d.projectId}` : d.versionId ? `${input.source}-version:${d.versionId}` : `unresolved:${input.source}`, name: d.projectId ?? d.versionId ?? 'external dependency', required: d.required, constraint: d.versionId ?? '*', source: input.source })) };
    prep('INSERT INTO addon_installations(server_id,file,data) VALUES (?,?,?) ON CONFLICT(server_id,file) DO UPDATE SET data=excluded.data').run(server.id, base(file), JSON.stringify(record));
}
export async function pinAddon(server: ServerRecord, id: string) { const inv = await installedAddons(server, true), item = inv.items.find(i => i.id === id); if (!item?.hash)
    throw new HttpError(404, 'Installed artifact not found'); const data: Provenance = item.provenance ? { ...item.provenance, explicit: true } : { source: 'untracked', hash: item.hash, explicit: true, at: Date.now(), dependencies: [], aliases: [], complete: false }; prep('INSERT INTO addon_installations(server_id,file,data) VALUES (?,?,?) ON CONFLICT(server_id,file) DO UPDATE SET data=excluded.data').run(server.id, base(item.fileName), JSON.stringify(data)); }
export async function recordUploadedAddon(server: ServerRecord, file: string) { const support = getAddonSupport(server); if (!support.supported || !['mod', 'bukkit'].includes(support.profile.kind))
    return; const hash = await hashFile(addonArtifactFile(server, file)); const data: Provenance = { source: 'upload', hash, explicit: true, at: Date.now(), dependencies: [], aliases: [], complete: false }; prep('INSERT INTO addon_installations(server_id,file,data) VALUES (?,?,?) ON CONFLICT(server_id,file) DO UPDATE SET data=excluded.data').run(server.id, base(file), JSON.stringify(data)); }
export async function resolveAddonRecovery(serverId: string, owner: string, id: string) { authorizeAddonMutation(owner, serverId); assertAddonStopped(serverId); const row = prep('SELECT data FROM addon_action_plans WHERE id=? AND server_id=?').get(id, serverId) as {
    data: string;
} | undefined; if (!row)
    throw new HttpError(404, 'Recovery record not found'); const p = JSON.parse(row.data) as ActionPlan; if (!['applying', 'recovery-required'].includes(p.state))
    throw new HttpError(409, 'This action does not need recovery'); if ((await installedAddons(getServer(serverId)!, true)).revision !== p.revision)
    throw new HttpError(409, 'The original add-on set has not been restored exactly; restore all affected artifacts first'); authorizeAddonMutation(owner, serverId); assertAddonStopped(serverId); p.state = 'review'; p.expires = 0; prep('UPDATE addon_action_plans SET data=? WHERE id=?').run(JSON.stringify(p), id); return { ok: true }; }
export async function planAddonAction(server: ServerRecord, owner: string, rootId: string, input: Record<string, unknown>) {
    authorizeAddonMutation(owner, server.id);
    const inventory = await installedAddons(server, true), root = inventory.items.find(i => i.id === rootId);
    if (!root)
        throw new HttpError(404, 'Installed add-on not found');
    const action = input.action ?? 'remove';
    if (!['remove', 'disable', 'enable'].includes(String(action)))
        throw new HttpError(400, 'Unknown add-on action');
    const plan: ActionPlan = { id: crypto.randomUUID(), serverId: server.id, owner, rootId, action: action as ActionPlan['action'], expires: Date.now() + 10 * 60000, revision: inventory.revision, cleanup: input.cleanup === true, includeUntracked: input.includeUntracked === true, remove: [rootId], keep: [], blockers: [], warnings: [], requiresAcknowledgement: false, state: 'review' };
    try {
        assertAddonStopped(server.id);
    }
    catch (e) {
        plan.blockers.push((e as Error).message);
    }
    if (!root.hash || !root.relativePath)
        plan.blockers.push('The selected artifact cannot be safely inspected.');
    if (action !== 'remove' && !root.canToggle)
        plan.blockers.push('This artifact cannot be toggled by the panel.');
    const requiredEdges = (node: InstalledAddon, optional = false) => inventory.items.filter(target => target.id !== node.id && node.dependencies.some(d => (optional || d.required) && target.provides.includes(d.key)));
    const candidates = new Set<string>(), closure = new Set<string>();
    const visit = (node: InstalledAddon) => { if (closure.has(node.id))
        return; closure.add(node.id); for (const next of requiredEdges(node))
        visit(next); };
    visit(root);
    const unknown = inventory.items.filter(i => i.coverage === 'incomplete');
    const hybrid = ['mohist', 'spongeforge'].includes(server.loader);
    if (hybrid) {
        plan.requiresAcknowledgement = true;
        plan.warnings.push('Hybrid server plugins outside this add-on folder are not inspected. Dependencies are retained; review cross-loader requirements before changing this artifact.');
    }
    if (action === 'remove' && plan.cleanup && inventory.dependencyCleanup && !unknown.length && !hybrid) {
        for (const id of closure) {
            const node = inventory.items.find(n => n.id === id)!;
            if (id !== rootId && (node.installation === 'dependency' || (plan.includeUntracked && node.installation === 'untracked')))
                candidates.add(id);
        }
        const keep = new Set<string>(), follow = (node: InstalledAddon) => { if (keep.has(node.id) || node.id === rootId)
            return; keep.add(node.id); for (const child of requiredEdges(node, true))
            follow(child); };
        for (const node of inventory.items)
            if (node.id !== rootId && !candidates.has(node.id))
                follow(node);
        for (const id of candidates)
            if (!keep.has(id))
                plan.remove.push(id);
    }
    for (const id of closure) {
        if (id === rootId || plan.remove.includes(id))
            continue;
        const node = inventory.items.find(n => n.id === id)!;
        plan.keep.push({ id, name: node.name, reason: node.installation === 'explicit' ? 'Explicitly installed / kept by the user' : node.installation === 'untracked' && !plan.includeUntracked ? 'Untracked installation ownership: kept by default' : unknown.length ? 'Incomplete metadata prevents automatic pruning' : hybrid ? 'Hybrid cross-loader requirements need review' : 'Still referenced by another installed artifact (including disabled and optional consumers)' });
    }
    if (action !== 'enable')
        for (const node of inventory.items.filter(i => !plan.remove.includes(i.id)))
            for (const dep of node.dependencies.filter(d => d.required && !runtime.has(d.key)))
                if (inventory.items.some(i => plan.remove.includes(i.id) && i.provides.includes(dep.key)))
                    plan.blockers.push(`${node.name} requires ${dep.name}; remove or update that dependent separately first.`);
    if (action === 'enable')
        for (const dep of root.dependencies.filter(d => d.required && !runtime.has(d.key)))
            if (!inventory.items.some(i => i.id !== root.id && i.enabled && i.provides.includes(dep.key)))
                plan.blockers.push(`Required dependency ${dep.name} is missing or disabled.`);
    if (unknown.length) {
        plan.requiresAcknowledgement = true;
        plan.warnings.push(`${unknown.length} artifact(s) have incomplete dependency metadata. Only the selected artifact will change; no dependency pruning is performed. Undeclared relationships cannot be guaranteed.`);
        plan.remove = [rootId];
    }
    if (!inventory.dependencyCleanup && plan.cleanup)
        plan.warnings.push('Automatic dependency pruning is implemented for Minecraft Java JAR mods/plugins. Native game/pack formats retain their dependencies.');
    if (root.optionalBy.some(n => !plan.remove.includes(n.id)))
        plan.warnings.push('Other artifacts optionally integrate with this add-on; those optional features may change.');
    if (action === 'remove')
        plan.warnings.push(inventory.dependencyCleanup ? 'Removed artifacts go to the 30-day File Management recycle bin. Configurations and worlds are kept.' : 'A full instance backup is created before the existing native uninstall handler runs. Configurations outside the selected artifact are kept.');
    plan.blockers = [...new Set(plan.blockers)];
    prep("DELETE FROM addon_action_plans WHERE expires<? AND json_extract(data,'$.state') NOT IN ('applying','recovery-required')").run(Date.now() - 86400000);
    prep('INSERT INTO addon_action_plans(id,server_id,owner,expires,data) VALUES (?,?,?,?,?)').run(plan.id, server.id, owner, plan.expires, JSON.stringify(plan));
    prep("DELETE FROM addon_action_plans WHERE server_id=? AND owner=? AND json_extract(data,'$.state')='review' AND id NOT IN (SELECT id FROM addon_action_plans WHERE server_id=? AND owner=? AND json_extract(data,'$.state')='review' ORDER BY rowid DESC LIMIT 32)").run(server.id, owner, server.id, owner);
    return { ...plan, remove: plan.remove.map(id => inventory.items.find(n => n.id === id)!).map(i => ({ id: i.id, name: i.name, fileName: i.fileName, installation: i.installation })), root: { id: root.id, name: root.name }, canApply: !plan.blockers.length };
}
export async function applyAddonAction(serverId: string, owner: string, planId: string, acknowledged = false) {
    return withAddonOperation(serverId, async () => {
        authorizeAddonMutation(owner, serverId);
        assertAddonStopped(serverId);
        const row = prep('SELECT data FROM addon_action_plans WHERE id=? AND server_id=? AND owner=?').get(planId, serverId, owner) as {
            data: string;
        } | undefined;
        if (!row)
            throw new HttpError(404, 'Add-on action review not found');
        const p = JSON.parse(row.data) as ActionPlan;
        if (p.state === 'applied')
            return p.result;
        if (p.state !== 'review')
            throw new HttpError(409, 'Recover the interrupted action first');
        if (p.expires < Date.now())
            throw new HttpError(409, 'Review expired; preview the action again');
        if (p.blockers.length)
            throw new HttpError(409, p.blockers.join(' '));
        if (p.requiresAcknowledgement && !acknowledged)
            throw new HttpError(409, 'Acknowledge incomplete dependency metadata before continuing');
        const server = getServer(serverId)!, inventory = await installedAddons(server, true);
        if (inventory.revision !== p.revision)
            throw new HttpError(409, 'Installed add-ons changed since review; preview again');
        const selected = p.remove.map(id => inventory.items.find(n => n.id === id)!);
        let backup: string | undefined;
        if (p.action === 'remove' && !inventory.dependencyCleanup) {
            backup = (await createBackup(serverId, 'before-addon-uninstall')).fileName;
            if ((await installedAddons(getServer(serverId)!, true)).revision !== p.revision)
                throw new HttpError(409, 'Add-ons changed during backup; preview again');
        }
        authorizeAddonMutation(owner, serverId);
        assertAddonStopped(serverId);
        let batch: ReturnType<typeof recycleBatch> | undefined;
        p.recovery = { backup: backup ?? null, paths: selected.map(i => i.relativePath!) };
        p.state = 'applying';
        prep('UPDATE addon_action_plans SET data=? WHERE id=?').run(JSON.stringify(p), p.id);
        try {
            if (p.action === 'remove') {
                if (inventory.dependencyCleanup)
                    batch = recycleBatch(serverId, selected.map(i => i.relativePath!));
                else
                    deletePlugin(server, selected[0].fileName);
            }
            else {
                const target = selected[0];
                if (!target.canToggle)
                    throw new HttpError(409, 'Artifact cannot be toggled');
                setPluginEnabled(server, target.fileName, p.action === 'enable');
            }
            const root = selected[0], kind = getAddonSupport(server), stable = kind.supported && (kind.profile.kind === 'bedrock' || (kind.profile.kind === 'gmod' && root.fileName.startsWith('folder:'))), file = stable ? root.fileName : p.action === 'enable' ? base(root.fileName) : p.action === 'disable' && !root.fileName.endsWith('.disabled') ? root.fileName + '.disabled' : root.fileName;
            const result = { ok: true, action: p.action, removed: p.action === 'remove' ? selected.map(i => ({ id: i.id, name: i.name, fileName: i.fileName })) : [], recycled: batch?.items ?? [], backup: backup ?? null, focusId: p.action === 'remove' ? null : idOf(file) };
            p.state = 'applied';
            p.result = result;
            prep('UPDATE addon_action_plans SET data=? WHERE id=?').run(JSON.stringify(p), p.id);
            return result;
        }
        catch (error) {
            try {
                if (batch)
                    batch.undo();
                p.state = ((error as {
                    recoveryRequired?: boolean;
                })?.recoveryRequired || (p.action === 'remove' && !inventory.dependencyCleanup)) ? 'recovery-required' : 'review';
            }
            catch {
                p.state = 'recovery-required';
            }
            prep('UPDATE addon_action_plans SET data=? WHERE id=?').run(JSON.stringify(p), p.id);
            throw error;
        }
    });
}
