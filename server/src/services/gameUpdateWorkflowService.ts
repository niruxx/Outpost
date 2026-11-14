import zlib from 'node:zlib';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import * as nbt from 'prismarine-nbt';
import { instanceDir } from '../utils/paths.js';
import { confined, revision } from './fileWorkspaceService.js';
import { HttpError } from '../utils/asyncHandler.js';
import { getServer, duplicateServerRecord, setServerStatus, setServerVersion } from './serverService.js';
import { isRunning } from './processManager.js';
import { readWorkflow, writeWorkflow, appendWorkflow } from './workflowStore.js';
import { resolveModPlan } from './modDependencyService.js';
import { requireAddonProfile } from './pluginService.js';
import { downloadScannedMod, scanIngestedPath } from './antivirusService.js';
import { hashFile } from './verifiedBackupService.js';
import { createBackup } from './backupService.js';
import { inspectLevel, inspectTerraria } from './worldHealthParsers.js';
import { prep } from '../db/db.js';
import { beginJob, progressJob, finishJob } from './jobService.js';
import { readServerProperties, writeServerProperties } from './propertiesService.js';
const locks = new Set<string>();
export function assertGameWorkflowIdle(id: string) { if (locks.has(id))
    throw new HttpError(423, 'A game workflow holds this instance stopped'); }
async function lock<T>(ids: string[], work: () => Promise<T>) { for (const id of ids) {
    assertGameWorkflowIdle(id);
    if (isRunning(id))
        throw new HttpError(409, 'Stop all involved instances first');
} ids.forEach(id => locks.add(id)); try {
    return await work();
}
finally {
    ids.forEach(id => locks.delete(id));
} }
function assertTree(dir: string) { if (!fs.existsSync(dir))
    return; let count = 0; const visit = (p: string) => { if (++count > 100000)
    throw new HttpError(413, 'Too many files'); const st = fs.lstatSync(p); if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile()))
    throw new HttpError(400, 'Symbolic links and special files are not supported'); if (st.isDirectory())
    for (const n of fs.readdirSync(p))
        visit(path.join(p, n)); }; visit(dir); }
interface Managed {
    file: string;
    version: string;
    project: string;
    hash: string;
}
interface ModPlan {
    id: string;
    owner: string;
    at: number;
    expires: number;
    revision: string;
    current: Managed[];
    files: {
        file: string;
        version: string;
        url: string;
        project: string;
    }[];
    warnings: string[];
    state: string;
}
export const managedMods = (id: string) => readWorkflow<Managed[]>('managed-mods', id, []);
async function addonRevision(id: string) { const s = getServer(id)!, p = requireAddonProfile(s), dir = confined(id, p.folder); assertTree(dir); const list = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []; return revision(JSON.stringify(await Promise.all(list.map(async (n) => { const target = confined(id, `${p.folder}/${n}`); const st = fs.statSync(target); return [n, st.size, st.mtimeMs, st.isFile() ? await hashFile(target) : 'directory']; })))); }
export async function planModUpdate(id: string, owner: string, refs: unknown) {
    const s = getServer(id)!, p = requireAddonProfile(s);
    if (!['mod', 'bukkit'].includes(p.kind) || !p.catalog)
        throw new HttpError(400, 'Managed update plans currently support Modrinth Java mods and Bukkit plugins');
    if (!Array.isArray(refs) || !refs.length || refs.length > 32 || !refs.every(r => typeof r === 'string' && /^[\w-]{1,100}$/.test(r)))
        throw new HttpError(400, 'Select 1–32 Modrinth project IDs/slugs');
    const files: ModPlan['files'] = [], warnings: string[] = [], incompatible: {
        projectId: string | null;
        versionId: string | null;
        source: string;
    }[] = [];
    for (const ref of refs) {
        const plan = await resolveModPlan('modrinth', ref, p.catalog, s.version);
        if (plan.resolved.versionMismatchWarning)
            warnings.push(`${ref}: no confirmed game-version compatibility`);
        const resolutions = [{ ref, resolved: plan.resolved }, ...plan.dependencies.filter(d => d.required).map(d => ({ ref: d.id, resolved: d.resolved }))];
        plan.dependencies.filter(d => d.error).forEach(d => warnings.push(`${d.title}: ${d.error}`));
        for (const { ref: project, resolved: r } of resolutions) {
            if (r?.incompatible)
                incompatible.push(...r.incompatible.map(c => ({ ...c, source: project })));
            if (!r) {
                warnings.push(`Missing required dependency ${project}`);
                continue;
            }
            if (!/^[\w .()-]+\.jar$/.test(r.fileName))
                throw new HttpError(400, 'Only plain JAR filenames are supported in managed sets');
            const old = files.find(f => f.project === project || f.file === r.fileName);
            if (old && old.url !== r.downloadUrl)
                warnings.push(`Conflicting versions/files for ${project}`);
            else if (!old)
                files.push({ file: r.fileName, version: r.versionNumber, url: r.downloadUrl, project: r.projectId ?? project });
        }
    }
    for (const conflict of incompatible) {
        if (conflict.projectId && files.some(f => f.project === conflict.projectId))
            warnings.push(`${conflict.source} declares incompatibility with ${conflict.projectId}`);
        else if (!conflict.projectId && conflict.versionId)
            warnings.push(`${conflict.source} declares incompatible version ${conflict.versionId}; review manually`);
    }
    const result: ModPlan = { id: crypto.randomUUID(), owner, at: Date.now(), expires: Date.now() + 3600000, revision: await addonRevision(id), current: managedMods(id), files, warnings, state: 'review' };
    writeWorkflow('mod-plan', id, result);
    return result;
}
export async function applyModUpdate(id: string, owner: string, planId: string, authorize: () => void) {
    return lock([id], async () => {
        const p = readWorkflow<ModPlan | null>('mod-plan', id, null);
        if (!p || p.owner !== owner || p.id !== planId || p.expires < Date.now() || p.state !== 'review')
            throw new HttpError(409, 'Update plan expired or already applied');
        if (p.warnings.length)
            throw new HttpError(400, 'Resolve dependency/compatibility warnings before applying');
        if (await addonRevision(id) !== p.revision)
            throw new HttpError(409, 'Installed add-ons changed; rebuild the plan');
        const s = getServer(id)!, profile = requireAddonProfile(s), folder = confined(id, profile.folder), parent = path.dirname(folder);
        await fsp.mkdir(parent, { recursive: true });
        const stage = await fsp.mkdtemp(path.join(parent, '.outpost-mod-stage-'));
        const previous = `${folder}.previous-${crypto.randomUUID()}`;
        const job = beginJob('managed-mod-update', id);
        try {
            if (fs.existsSync(folder))
                await fsp.cp(folder, stage, { recursive: true });
            for (const old of p.current)
                if (fs.existsSync(path.join(stage, old.file)))
                    await fsp.unlink(path.join(stage, old.file));
            const managed: Managed[] = [];
            for (const [i, file] of p.files.entries()) {
                if (fs.existsSync(path.join(stage, file.file)))
                    throw new HttpError(409, `Unmanaged file collision: ${file.file}`);
                progressJob(job, `Downloading ${file.file}`, i / p.files.length * 100);
                const target = path.join(stage, file.file);
                await downloadScannedMod(file.url, target, id);
                managed.push({ file: file.file, version: file.version, project: file.project, hash: await hashFile(target) });
            }
            await scanIngestedPath(stage, true);
            authorize();
            if (await addonRevision(id) !== p.revision || isRunning(id))
                throw new HttpError(409, 'Instance changed during staging');
            const backup = await createBackup(id, 'before-managed-mod-update');
            authorize();
            if (await addonRevision(id) !== p.revision || isRunning(id))
                throw new HttpError(409, 'Instance changed during backup');
            const had = fs.existsSync(folder);
            if (had)
                await fsp.rename(folder, previous);
            try {
                await fsp.rename(stage, folder);
            }
            catch (e) {
                if (had)
                    await fsp.rename(previous, folder);
                throw e;
            }
            writeWorkflow('managed-mod-rollback', id, { previous: path.relative(instanceDir(id), previous).split(path.sep).join('/'), folder: profile.folder, managed: p.current, backup: backup.fileName, revision: await addonRevision(id) });
            writeWorkflow('managed-mods', id, managed);
            p.state = 'applied';
            writeWorkflow('mod-plan', id, p);
            finishJob(job);
            return { ok: true, backup: backup.fileName, managed };
        }
        catch (e) {
            finishJob(job, e);
            throw e;
        }
        finally {
            await fsp.rm(stage, { recursive: true, force: true });
        }
    });
}
export async function rollbackModSet(id: string, authorize: () => void) {
    return lock([id], async () => {
        const r = readWorkflow<{
            previous: string;
            folder: string;
            managed: Managed[];
            revision: string;
        } | null>('managed-mod-rollback', id, null);
        if (!r)
            throw new HttpError(404, 'No previous managed set');
        const previous = confined(id, r.previous), folder = confined(id, r.folder);
        if (!fs.existsSync(previous))
            throw new HttpError(404, 'Previous directory is unavailable; restore the recorded backup');
        if (await addonRevision(id) !== r.revision)
            throw new HttpError(409, 'Add-ons changed after update; review before rollback');
        assertTree(previous);
        await scanIngestedPath(previous, true);
        authorize();
        if (isRunning(id) || await addonRevision(id) !== r.revision)
            throw new HttpError(409, 'Instance changed during scan');
        const displaced = `${folder}.rolled-back-${crypto.randomUUID()}`;
        await fsp.rename(folder, displaced);
        try {
            await fsp.rename(previous, folder);
        }
        catch (e) {
            await fsp.rename(displaced, folder);
            throw e;
        }
        writeWorkflow('managed-mods', id, r.managed);
        writeWorkflow('managed-mod-rollback', id, null);
        return { ok: true };
    });
}
export async function inspectWorldImport(id: string, relative: string, requirements: unknown) {
    const s = getServer(id)!, target = confined(id, relative);
    const findings: {
        severity: string;
        message: string;
    }[] = [];
    let edition = 'unknown', version: unknown = null;
    if (!Array.isArray(requirements) || requirements.length > 100 || !requirements.every(x => typeof x === 'string' && x.length <= 200))
        throw new HttpError(400, 'Requirements must be a list of mod/DLC labels');
    const required = requirements as string[];
    const installed = fs.existsSync(confined(id, 'mods')) ? fs.readdirSync(confined(id, 'mods')) : [];
    for (const item of required)
        if (!installed.some(n => n.toLowerCase().includes(item.toLowerCase())))
            findings.push({ severity: 'warning', message: `Required mod/DLC not confirmed: ${item}. Install and test compatible content before switching saves.` });
    if (fs.statSync(target).isDirectory()) {
        const level = confined(id, `${relative}/level.dat`), db = confined(id, `${relative}/db`);
        if (fs.existsSync(level)) {
            if (fs.statSync(level).size > 16 * 1048576)
                throw new HttpError(413, 'level.dat exceeds inspection limit');
            const data = fs.readFileSync(level);
            if (fs.existsSync(db) && data.length >= 8) {
                edition = 'bedrock';
                const headerVersion = data.readUInt32LE(0), size = data.readUInt32LE(4);
                version = headerVersion;
                if (size !== data.length - 8)
                    findings.push({ severity: 'error', message: 'Bedrock level.dat length header is invalid' });
                if (s.platform !== 'bedrock')
                    findings.push({ severity: 'error', message: 'Bedrock worlds cannot be loaded by a Java server without external conversion' });
                if (!fs.existsSync(confined(id, `${relative}/db/CURRENT`)))
                    findings.push({ severity: 'error', message: 'Missing LevelDB CURRENT companion file' });
            }
            else {
                edition = 'java';
                const check = inspectLevel(data, `${relative}/level.dat`);
                check.findings.forEach(f => findings.push({ severity: f.severity, message: f.message }));
                try {
                    const parsed = nbt.parseUncompressed(zlib.gunzipSync(data, { maxOutputLength: 16 * 1048576 }));
                    const plain = nbt.simplify(parsed) as {
                        Data?: {
                            DataVersion?: number;
                            Version?: {
                                Name?: string;
                            };
                        };
                    };
                    version = plain.Data?.Version?.Name ?? plain.Data?.DataVersion ?? null;
                }
                catch { }
                if (s.platform !== 'java')
                    findings.push({ severity: 'error', message: 'Java worlds cannot be loaded by a Bedrock server without external conversion' });
                if (!fs.existsSync(confined(id, `${relative}/region`)))
                    findings.push({ severity: 'warning', message: 'No region folder; this may be a new, empty or incomplete world' });
                if (typeof version === 'string' && version !== s.version)
                    findings.push({ severity: 'warning', message: `World reports ${version}; server is ${s.version}. Downgrades and cross-version loading can corrupt saves.` });
            }
        }
        else
            findings.push({ severity: 'error', message: 'No level.dat found at the selected world root' });
    }
    else if (/\.wld$/i.test(relative)) {
        edition = 'terraria';
        const st = fs.statSync(target);
        if (st.size > 256 * 1048576)
            throw new HttpError(413, 'World exceeds inspection limit');
        const report = inspectTerraria(fs.readFileSync(target), relative);
        version = report.version;
        report.findings.forEach(f => findings.push({ severity: f.severity, message: f.message }));
        if (!['terraria', 'tmodloader'].includes(s.steam_preset ?? ''))
            findings.push({ severity: 'error', message: 'A Terraria world requires a Terraria/tModLoader instance' });
        if (s.steam_preset === 'tmodloader' && !fs.existsSync(confined(id, relative.replace(/\.wld$/i, '.twld'))))
            findings.push({ severity: 'warning', message: 'Missing .twld modded-world companion; verify required tModLoader mods' });
    }
    else if (/\.(db|fwl)$/i.test(relative)) {
        edition = 'valheim';
        for (const ext of ['.db', '.fwl'])
            if (!fs.existsSync(confined(id, relative.replace(/\.(db|fwl)$/i, ext))))
                findings.push({ severity: 'error', message: `Missing ${ext} Valheim world companion` });
    }
    else
        findings.push({ severity: 'warning', message: 'No format-specific inspection for this save. Use the game-native import checks in Game Settings and test in staging.' });
    const report = { at: Date.now(), path: relative, edition, version, serverVersion: s.version, requirements: required, findings, ready: edition !== 'unknown' && !findings.some(f => f.severity === 'error'), note: 'Read-only preflight; does not certify every chunk, game version or mod/DLC dependency. Keep the original and test a copy in staging.' };
    appendWorkflow('world-import-checks', id, report);
    return report;
}
interface Staging {
    id: string;
    source: string;
    clone: string;
    at: number;
    state: string;
    baseline: string;
    backup?: string;
    review?: string;
    cloneRevision?: string;
}
export const stagingRows = (id: string) => readWorkflow<Staging[]>('staging', id, []);
async function treeRevision(id: string) { const root = instanceDir(id); assertTree(root); const files: string[] = []; const walk = (dir: string) => { for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory())
        walk(rel);
    else
        files.push(rel);
} }; walk(''); return revision(JSON.stringify(await Promise.all(files.sort().map(async (p) => [p, await hashFile(confined(id, p))])))); }
export async function cloneForStaging(id: string, owner: string, port: number, authorize: () => void) {
    return lock([id], async () => {
        const source = getServer(id)!;
        if (['docker', 'custom'].includes(source.platform))
            throw new HttpError(400, 'Staging clones support managed Java, Bedrock and Steam installations');
        if (!Number.isInteger(port) || port < 1024 || port > 65535 || prep('SELECT id FROM servers WHERE server_port=? UNION SELECT server_id AS id FROM auxiliary_ports WHERE port=? UNION SELECT server_id AS id FROM allocations WHERE port=? AND (server_id IS NOT NULL OR expires>?)').get(port, port, port, Date.now()))
            throw new HttpError(409, 'Choose an unused staging game port');
        const baseline = await treeRevision(id);
        authorize();
        const clone = duplicateServerRecord(source, { name: `${source.name} (staging)`, serverPort: port, createdBy: owner, keepIsolation: true });
        locks.add(clone.id);
        try {
            await fsp.cp(instanceDir(id), instanceDir(clone.id), { recursive: true });
            authorize();
            if (await treeRevision(id) !== baseline)
                throw new HttpError(409, 'Source files changed while cloning');
            if (source.platform === 'java' || source.platform === 'bedrock')
                writeServerProperties(clone.id, source.platform, { 'server-port': String(port), ...(source.platform === 'java' ? { 'enable-rcon': 'false', 'enable-query': 'false', 'server-ip': '127.0.0.1' } : { 'server-portv6': String(port + 1) }) });
            prep('UPDATE servers SET auto_start=0,auto_update=NULL,upnp_config=NULL,rcon_config=NULL,restart_policy=? WHERE id=?').run('never', clone.id);
            setServerStatus(clone.id, 'stopped');
            const row: Staging = { id: crypto.randomUUID(), source: id, clone: clone.id, at: Date.now(), state: 'testing', baseline };
            appendWorkflow('staging', id, row);
            return row;
        }
        catch (e) {
            setServerStatus(clone.id, 'install_failed');
            throw e;
        }
        finally {
            locks.delete(clone.id);
        }
    });
}
export async function reviewPromotion(id: string, runId: string, authorize: () => void) { const rows = stagingRows(id), run = rows.find(r => r.id === runId); if (!run || run.state !== 'testing')
    throw new HttpError(409, 'No staging run to review'); return lock([id, run.clone], async () => { authorize(); if (getServer(id)?.platform !== getServer(run.clone)?.platform)
    throw new HttpError(400, 'Staging promotion cannot change game platforms'); if (await treeRevision(id) !== run.baseline)
    throw new HttpError(409, 'Production changed since cloning; clone again before promotion'); run.cloneRevision = await treeRevision(run.clone); run.review = revision(JSON.stringify({ baseline: run.baseline, clone: run.cloneRevision, version: getServer(run.clone)?.version })); writeWorkflow('staging', id, rows); return { revision: run.review, sourceVersion: getServer(id)?.version, stagingVersion: getServer(run.clone)?.version, note: 'Promotion replaces production files with the tested stopped clone and retains a pre-promotion backup. Production identity, ports and access remain unchanged.' }; }); }
export async function promoteStaging(id: string, runId: string, review: string, authorize: () => void) {
    const rows = stagingRows(id), run = rows.find(r => r.id === runId);
    if (!run || run.state !== 'testing' || !run.review || run.review !== review)
        throw new HttpError(409, 'Review this promotion first');
    return lock([id, run.clone], async () => {
        authorize();
        if (getServer(id)?.platform !== getServer(run.clone)?.platform)
            throw new HttpError(400, 'Staging promotion cannot change game platforms');
        if (await treeRevision(id) !== run.baseline || await treeRevision(run.clone) !== run.cloneRevision)
            throw new HttpError(409, 'Production or staging changed since review');
        const backup = await createBackup(id, 'before-staging-promotion');
        const live = instanceDir(id), stage = await fsp.mkdtemp(path.join(path.dirname(live), '.outpost-promote-')), previous = `${live}.before-promotion-${crypto.randomUUID()}`;
        try {
            await fsp.cp(instanceDir(run.clone), stage, { recursive: true });
            const production = getServer(id)!;
            if (production.platform === 'java' || production.platform === 'bedrock') {
                const network = new Set(['server-port', 'server-portv6', 'server-ip', 'query.port', 'enable-query', 'enable-rcon', 'rcon.port', 'rcon.password']);
                const original = readServerProperties(id, production.platform).filter(p => network.has(p.key));
                const propFile = path.join(stage, 'server.properties');
                let content = fs.existsSync(propFile) ? fs.readFileSync(propFile, 'utf8') : '';
                for (const property of original) {
                    const escaped = property.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const re = new RegExp(`^${escaped}=.*$`, 'm');
                    content = re.test(content) ? content.replace(re, () => `${property.key}=${property.value}`) : content + `\n${property.key}=${property.value}`;
                }
                await fsp.writeFile(propFile, content);
            }
            await scanIngestedPath(stage, true);
            authorize();
            if (await treeRevision(id) !== run.baseline || await treeRevision(run.clone) !== run.cloneRevision || isRunning(id) || isRunning(run.clone))
                throw new HttpError(409, 'Instance changed during promotion');
            await fsp.rename(live, previous);
            try {
                await fsp.rename(stage, live);
            }
            catch (e) {
                await fsp.rename(previous, live);
                throw e;
            }
            // Rewrite only the main port on next native launch; keep production database settings/identity.
            const clone = getServer(run.clone)!;
            const original = getServer(id)!;
            setServerVersion(id, clone.version, clone.jar_file, clone.build);
            prep('UPDATE servers SET loader=?,modpack=? WHERE id=?').run(clone.loader, clone.modpack, id);
            run.state = 'promoted';
            run.backup = backup.fileName;
            writeWorkflow('staging', id, rows);
            writeWorkflow('staging-recovery', id, { run: run.id, previous: path.basename(previous), baselineVersion: original.version, baselineJar: original.jar_file, baselineBuild: original.build, baselineLoader: original.loader, baselineModpack: original.modpack, backup: backup.fileName, promotedRevision: await treeRevision(id) });
            return { ok: true, backup: backup.fileName };
        }
        finally {
            await fsp.rm(stage, { recursive: true, force: true });
        }
    });
}
export async function rollbackStaging(id: string, authorize: () => void) {
    return lock([id], async () => {
        const r = readWorkflow<{
            previous: string;
            baselineVersion: string;
            baselineJar: string | null;
            baselineBuild: string | null;
            baselineLoader?: string;
            baselineModpack?: string | null;
            promotedRevision: string;
        } | null>('staging-recovery', id, null);
        if (!r || !r.previous.startsWith(`${id}.before-promotion-`) || path.basename(r.previous) !== r.previous)
            throw new HttpError(404, 'No promotion recovery directory');
        if (await treeRevision(id) !== r.promotedRevision)
            throw new HttpError(409, 'Production files changed after promotion. Use the recorded full backup and review newer world data before restoring.');
        const live = instanceDir(id), previous = path.join(path.dirname(live), r.previous), displaced = `${live}.promotion-rollback-${crypto.randomUUID()}`;
        assertTree(previous);
        await scanIngestedPath(previous, true);
        authorize();
        if (await treeRevision(id) !== r.promotedRevision || isRunning(id))
            throw new HttpError(409, 'Production changed during rollback review');
        await fsp.rename(live, displaced);
        try {
            await fsp.rename(previous, live);
        }
        catch (e) {
            await fsp.rename(displaced, live);
            throw e;
        }
        setServerVersion(id, r.baselineVersion, r.baselineJar, r.baselineBuild);
        if (r.baselineLoader)
            prep('UPDATE servers SET loader=?,modpack=? WHERE id=?').run(r.baselineLoader, r.baselineModpack ?? null, id);
        writeWorkflow('staging-recovery', id, null);
        return { ok: true };
    });
}
