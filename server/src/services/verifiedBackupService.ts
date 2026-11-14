import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import AdmZip from 'adm-zip';
import { backupDir, acquireBackupStorage } from './backupStorageService.js';
import { instanceDir, safeJoinReal } from '../utils/paths.js';
import { HttpError } from '../utils/asyncHandler.js';
import { isRunning } from './processManager.js';
import { beginJob, progressJob, finishJob } from './jobService.js';
import { scanIngestedPath } from './antivirusService.js';
import { readWorkflow, writeWorkflow, boundedNumber } from './workflowStore.js';
import { resolveBackupPath } from './backupService.js';
interface Entry {
    path: string;
    hash: string;
    size: number;
    mode: number;
}
export interface Manifest {
    id: string;
    at: number;
    files: Entry[];
    logicalBytes: number;
    addedBytes: number;
}
const active = new Set<string>();
export function assertBackupIdle(id: string) { if (active.has(id))
    throw new HttpError(423, 'A verified backup operation holds this instance stopped'); }
export async function hashFile(file: string) { const hash = crypto.createHash('sha256'); await pipeline(fs.createReadStream(file), hash); return hash.digest('hex'); }
function root(id: string) { const dir = safeJoinReal(backupDir(id), '.deduplicated'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir; }
function manifestPath(id: string, name: string) { if (!/^[a-f0-9-]{36}$/.test(name))
    throw new HttpError(400, 'Invalid backup ID'); return path.join(root(id), `${name}.json`); }
function blob(id: string, hash: string) { if (!/^[a-f0-9]{64}$/.test(hash))
    throw new HttpError(400, 'Invalid content hash'); return safeJoinReal(root(id), `blobs/${hash}`); }
function validateRelative(p: string) { if (!p || p.startsWith('/') || /[\\:\x00-\x1f]/.test(p) || p.split('/').some(x => !x || x === '.' || x === '..'))
    throw new HttpError(400, 'Unsafe archive entry'); return p; }
export function dedupList(id: string): Manifest[] {
    return fs.readdirSync(root(id)).filter(n => /^[a-f0-9-]{36}\.json$/.test(n)).map(n => JSON.parse(fs.readFileSync(path.join(root(id), n), 'utf8')) as Manifest).sort((a, b) => b.at - a.at);
}
export function backupPolicy(id: string) { return readWorkflow('backup-policy', id, { daily: 7, weekly: 4, monthly: 6 }); }
export function saveBackupPolicy(id: string, input: Record<string, unknown>) {
    const p = { daily: boundedNumber(input.daily, 1, 365, 'Daily retention'), weekly: boundedNumber(input.weekly, 0, 104, 'Weekly retention'), monthly: boundedNumber(input.monthly, 0, 120, 'Monthly retention') };
    if (!Object.values(p).every(Number.isInteger))
        throw new HttpError(400, 'Retention counts must be integers');
    writeWorkflow('backup-policy', id, p);
    return p;
}
export function backupEstimate(id: string) {
    const manifests = dedupList(id);
    let storedBytes = 0;
    const blobs = path.join(root(id), 'blobs');
    if (fs.existsSync(blobs))
        for (const name of fs.readdirSync(blobs))
            if (/^[a-f0-9]{64}$/.test(name))
                storedBytes += fs.statSync(blob(id, name)).size;
    const logicalBytes = manifests.reduce((n, m) => n + m.logicalBytes, 0);
    return { storedBytes, logicalBytes, savedBytes: Math.max(0, logicalBytes - storedBytes), snapshots: manifests.length, policy: backupPolicy(id), manifests: manifests.map(m => ({ ...m, files: undefined, fileCount: m.files.length })) };
}
function walk(dir: string, relative = '', files: string[] = []): string[] {
    if (files.length > 100000)
        throw new HttpError(413, 'Backup exceeds 100,000 files');
    for (const entry of fs.readdirSync(path.join(dir, relative), { withFileTypes: true })) {
        const p = relative ? `${relative}/${entry.name}` : entry.name;
        validateRelative(p);
        if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()))
            throw new HttpError(400, `Remove symbolic links/special files before a verified backup: ${p}`);
        if (entry.isDirectory())
            walk(dir, p, files);
        else
            files.push(p);
    }
    return files;
}
async function locked<T>(id: string, kind: string, work: (job: string) => Promise<T>) {
    if (isRunning(id))
        throw new HttpError(409, 'Stop the instance for a consistent backup operation');
    assertBackupIdle(id);
    const release = acquireBackupStorage(id);
    active.add(id);
    const job = beginJob(kind, id);
    try {
        const result = await work(job);
        finishJob(job);
        return result;
    }
    catch (error) {
        finishJob(job, error);
        throw error;
    }
    finally {
        active.delete(id);
        release();
    }
}
export async function createDedup(id: string) {
    return locked(id, 'deduplicated-backup', async (job) => {
        const source = instanceDir(id), files = walk(source), entries: Entry[] = [];
        let addedBytes = 0;
        fs.mkdirSync(path.join(root(id), 'blobs'), { recursive: true, mode: 0o700 });
        for (const [i, relative] of files.entries()) {
            const target = safeJoinReal(source, relative);
            const stat = await fsp.stat(target);
            const hash = await hashFile(target);
            const destination = blob(id, hash);
            if (!fs.existsSync(destination)) {
                const temp = `${destination}.${crypto.randomUUID()}.tmp`;
                try {
                    await fsp.copyFile(target, temp, fs.constants.COPYFILE_EXCL);
                    if (await hashFile(temp) !== hash)
                        throw new HttpError(409, `${relative} changed during backup`);
                    await fsp.rename(temp, destination);
                    addedBytes += stat.size;
                }
                finally {
                    await fsp.rm(temp, { force: true });
                }
            }
            const after = await fsp.stat(target);
            if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs)
                throw new HttpError(409, `${relative} changed during backup`);
            entries.push({ path: relative, hash, size: stat.size, mode: stat.mode & 0o777 });
            progressJob(job, `Stored ${i + 1}/${files.length} files`, (i + 1) / files.length * 100);
        }
        const m: Manifest = { id: crypto.randomUUID(), at: Date.now(), files: entries, addedBytes, logicalBytes: entries.reduce((n, e) => n + e.size, 0) };
        const target = manifestPath(id, m.id);
        await fsp.writeFile(`${target}.tmp`, JSON.stringify(m), { mode: 0o600 });
        await fsp.rename(`${target}.tmp`, target);
        enforceDedupRetention(id);
        return { ...m, files: undefined, fileCount: files.length };
    });
}
export function enforceDedupRetention(id: string) {
    assertBackupStoragePaths(id);
    const manifests = dedupList(id), policy = backupPolicy(id), keep = new Set<string>();
    for (const [period, count] of [[86400000, policy.daily], [7 * 86400000, policy.weekly], [0, policy.monthly]]) {
        const seen = new Set<string>();
        for (const m of manifests) {
            const d = new Date(m.at), key = period ? String(Math.floor(m.at / period)) : `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
            if (!seen.has(key) && seen.size < count) {
                keep.add(m.id);
                seen.add(key);
            }
        }
    }
    for (const m of manifests)
        if (!keep.has(m.id))
            fs.unlinkSync(manifestPath(id, m.id));
    const referenced = new Set(manifests.filter(m => keep.has(m.id)).flatMap(m => m.files.map(f => f.hash)));
    const blobs = path.join(root(id), 'blobs');
    if (fs.existsSync(blobs))
        for (const hash of fs.readdirSync(blobs))
            if (/^[a-f0-9]{64}$/.test(hash) && !referenced.has(hash))
                fs.unlinkSync(blob(id, hash));
}
function assertBackupStoragePaths(id: string) { root(id); }
async function materialize(id: string, manifest: Manifest, destination: string, job: string) {
    const seen = new Set<string>();
    for (const [i, entry] of manifest.files.entries()) {
        validateRelative(entry.path);
        if (seen.has(entry.path))
            throw new HttpError(400, 'Duplicate manifest entry');
        seen.add(entry.path);
        const source = blob(id, entry.hash);
        if (await hashFile(source) !== entry.hash || (await fsp.stat(source)).size !== entry.size)
            throw new HttpError(422, `Corrupt or missing backup blob: ${entry.path}`);
        const target = safeJoinReal(destination, entry.path);
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.copyFile(source, target, fs.constants.COPYFILE_EXCL);
        await fsp.chmod(target, entry.mode & 0o777);
        if (await hashFile(target) !== entry.hash)
            throw new HttpError(422, 'Restored copy failed checksum verification');
        progressJob(job, `Verified ${i + 1}/${manifest.files.length} files`, (i + 1) / manifest.files.length * 100);
    }
}
export async function verifyDedup(id: string, name: string, restoreTest: boolean) {
    assertBackupIdle(id);
    active.add(id);
    let release: () => void;
    try {
        release = acquireBackupStorage(id);
    }
    catch (e) {
        active.delete(id);
        throw e;
    }
    const job = beginJob('backup-verification', id);
    let scratch: string | undefined;
    try {
        const m = JSON.parse(await fsp.readFile(manifestPath(id, name), 'utf8')) as Manifest;
        if (restoreTest) {
            scratch = await fsp.mkdtemp(path.join(root(id), 'restore-test-'));
            await materialize(id, m, scratch, job);
        }
        else
            for (const entry of m.files) {
                validateRelative(entry.path);
                if (await hashFile(blob(id, entry.hash)) !== entry.hash)
                    throw new HttpError(422, `Checksum failed: ${entry.path}`);
            }
        const report = { at: Date.now(), name, ok: true, files: m.files.length, restoreTest, note: restoreTest ? 'Disposable restore directory verified; no game process executed.' : 'All content hashes verified.' };
        finishJob(job);
        return report;
    }
    catch (error) {
        finishJob(job, error);
        throw error;
    }
    finally {
        if (scratch)
            await fsp.rm(scratch, { recursive: true, force: true });
        active.delete(id);
        release();
    }
}
export async function restoreDedup(id: string, name: string, authorize: () => void) {
    return locked(id, 'deduplicated-restore', async (job) => {
        const m = JSON.parse(await fsp.readFile(manifestPath(id, name), 'utf8')) as Manifest;
        const live = instanceDir(id);
        const stage = await fsp.mkdtemp(path.join(path.dirname(live), `.outpost-restore-`));
        const previous = `${live}.recovery-${crypto.randomUUID()}`;
        try {
            await materialize(id, m, stage, job);
            await scanIngestedPath(stage, true);
            authorize();
            if (isRunning(id))
                throw new HttpError(409, 'Instance started during restore');
            await fsp.rename(live, previous);
            try {
                await fsp.rename(stage, live);
            }
            catch (e) {
                await fsp.rename(previous, live);
                throw e;
            }
            // Preserve the displaced instance for recovery instead of deleting it.
            writeWorkflow('restore-recovery', id, { at: Date.now(), directory: path.basename(previous), snapshot: name });
            return { ok: true, recoveryDirectory: path.basename(previous) };
        }
        finally {
            await fsp.rm(stage, { recursive: true, force: true });
        }
    });
}
export async function verifyZip(id: string, fileName: string, restoreTest: boolean) {
    assertBackupIdle(id);
    active.add(id);
    let release: () => void;
    try {
        release = acquireBackupStorage(id);
    }
    catch (e) {
        active.delete(id);
        throw e;
    }
    const job = beginJob('zip-verification', id);
    let scratch: string | undefined;
    try {
        const file = resolveBackupPath(id, fileName);
        if ((await fsp.stat(file)).size > 1024 ** 3)
            throw new HttpError(413, 'ZIP verification limit is 1 GiB compressed; use deduplicated backups for larger instances');
        const zip = new AdmZip(file);
        const entries = zip.getEntries();
        let total = 0;
        if (entries.length > 100000)
            throw new HttpError(413, 'Too many archive entries');
        if (restoreTest)
            scratch = await fsp.mkdtemp(path.join(root(id), 'restore-test-'));
        for (const entry of entries) {
            validateRelative(entry.entryName.replace(/\/$/, ''));
            if (((entry.attr >>> 16) & 0xf000) === 0xa000)
                throw new HttpError(400, 'Archive contains a symbolic link');
            if (entry.isDirectory)
                continue;
            if (entry.header.size > 256 * 1024 * 1024 || (total += entry.header.size) > 20 * 1024 ** 3)
                throw new HttpError(413, 'ZIP expansion limit reached; use deduplicated backups');
            const data = entry.getData(); // AdmZip checks the ZIP CRC when decoding.
            if (data.length !== entry.header.size)
                throw new HttpError(422, 'ZIP entry size mismatch');
            if (scratch) {
                const target = safeJoinReal(scratch, entry.entryName);
                await fsp.mkdir(path.dirname(target), { recursive: true });
                await fsp.writeFile(target, data, { flag: 'wx' });
                if (await hashFile(target) !== crypto.createHash('sha256').update(data).digest('hex'))
                    throw new HttpError(422, 'Restore-test copy mismatch');
            }
        }
        finishJob(job);
        return { ok: true, at: Date.now(), files: entries.filter(e => !e.isDirectory).length, restoreTest, note: 'ZIP CRC/integrity checked. Restore tests never launch the game.' };
    }
    catch (error) {
        finishJob(job, error);
        throw error;
    }
    finally {
        if (scratch)
            await fsp.rm(scratch, { recursive: true, force: true });
        active.delete(id);
        release();
    }
}
