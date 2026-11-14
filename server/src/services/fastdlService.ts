import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DATA_DIR } from '../utils/paths.js';
import { confined } from './fileWorkspaceService.js';
import { getServer } from './serverService.js';
import { HttpError } from '../utils/asyncHandler.js';
import { readWorkflow, writeWorkflow } from './workflowStore.js';
import { hashFile } from './verifiedBackupService.js';
import { scanIngestedPath } from './antivirusService.js';
import { beginJob, progressJob, finishJob } from './jobService.js';
const exec = promisify(execFile);
const folders: Record<string, string> = { tf2: 'tf', css: 'cstrike', csgo: 'csgo', gmod: 'garrysmod', hl2dm: 'hl2mp', dods: 'dod', l4d2: 'left4dead2' };
interface Asset {
    path: string;
    hash: string;
    size: number;
    compressed: boolean;
}
interface Publication {
    enabled: boolean;
    revision: string;
    at: number;
    url: string;
    assets: Asset[];
    compressed: boolean;
}
export function fastdlInfo(id: string) { return { supported: !!folders[getServer(id)?.steam_preset ?? ''], publication: readWorkflow<Publication | null>('fastdl', id, null), note: 'Source 1 asset downloads only; CS2 does not use this FastDL workflow. Optional bzip2 compression requires bzip2 on the host.' }; }
function publicationDir(id: string, revision: string) { if (!/^[\w-]+$/.test(id) || !/^[a-f0-9-]{36}$/.test(revision))
    throw new HttpError(400, 'Invalid publication'); return path.join(DATA_DIR, 'fastdl', id, revision); }
const publishing = new Set<string>();
export async function publishFastdl(id: string, input: Record<string, unknown>, authorize: () => void) {
    const folder = folders[getServer(id)?.steam_preset ?? ''];
    if (!folder)
        throw new HttpError(400, 'FastDL is available for supported Source 1 games');
    const paths = input.paths;
    if (!Array.isArray(paths) || !paths.length || paths.length > 1000 || !paths.every(p => typeof p === 'string' && /^(maps|materials|models|sound|particles)\/[\w ./()-]+\.(bsp|nav|ain|vtf|vmt|mdl|vtx|vvd|phy|wav|mp3|ogg|pcf)$/i.test(p) && !p.split('/').some(x => x === '..' || x === '.')))
        throw new HttpError(400, 'Select up to 1000 map/material/model/sound/particle asset paths');
    let url: URL;
    try {
        url = new URL(String(input.url));
    }
    catch {
        throw new HttpError(400, 'Provide the public FastDL HTTP(S) URL');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !url.pathname.endsWith(`/fastdl/${id}`))
        throw new HttpError(400, `URL must end with /fastdl/${id} and have no credentials, query or fragment`);
    if (publishing.has(id))
        throw new HttpError(409, 'FastDL publication already running');
    publishing.add(id);
    const job = beginJob('fastdl-publish', id), revision = crypto.randomUUID(), dir = publicationDir(id, revision);
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    try {
        const assets: Asset[] = [];
        let total = 0;
        for (const [index, p] of [...new Set(paths as string[])].entries()) {
            const source = confined(id, `${folder}/${p}`), stat = await fsp.stat(source);
            if (!stat.isFile() || stat.size > 128 * 1048576 || (total += stat.size) > 2 * 1024 ** 3)
                throw new HttpError(413, 'Asset limit: 128 MiB/file and 2 GiB/publication');
            const target = path.join(dir, p);
            await fsp.mkdir(path.dirname(target), { recursive: true });
            await fsp.copyFile(source, target, fs.constants.COPYFILE_EXCL);
            await scanIngestedPath(target);
            assets.push({ path: p, hash: await hashFile(target), size: stat.size, compressed: false });
            if (input.compress === true) {
                const result = await exec('bzip2', ['-c', '--', target], { encoding: 'buffer', maxBuffer: 160 * 1048576, timeout: 120000, windowsHide: true });
                await fsp.writeFile(target + '.bz2', result.stdout, { flag: 'wx' });
                assets.push({ path: p + '.bz2', hash: await hashFile(target + '.bz2'), size: result.stdout.length, compressed: true });
            }
            progressJob(job, `Published ${index + 1}/${paths.length} assets`, (index + 1) / paths.length * 100);
        }
        authorize();
        const publication: Publication = { enabled: true, revision, at: Date.now(), url: url.toString().replace(/\/$/, ''), assets, compressed: input.compress === true };
        writeWorkflow('fastdl', id, publication);
        finishJob(job);
        return publication;
    }
    catch (e) {
        finishJob(job, e);
        await fsp.rm(dir, { recursive: true, force: true });
        throw e;
    }
    finally {
        publishing.delete(id);
    }
}
export function disableFastdl(id: string) { const current = readWorkflow<Publication | null>('fastdl', id, null); if (current) {
    current.enabled = false;
    writeWorkflow('fastdl', id, current);
} }
export function resolveFastdl(id: string, relative: string) { const p = readWorkflow<Publication | null>('fastdl', id, null); if (!p?.enabled || !p.assets.some(a => a.path === relative))
    throw new HttpError(404, 'Asset unavailable'); const file = path.join(publicationDir(id, p.revision), relative); if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink())
    throw new HttpError(404, 'Asset unavailable'); return file; }
export async function verifyFastdl(id: string) {
    const p = readWorkflow<Publication | null>('fastdl', id, null);
    if (!p?.enabled)
        throw new HttpError(409, 'Publish assets first');
    const results = [];
    for (const asset of p.assets.slice(0, 20)) {
        try {
            const response = await fetch(`${p.url}/${asset.path.split('/').map(encodeURIComponent).join('/')}`, { signal: AbortSignal.timeout(15000), redirect: 'error' });
            if (!response.ok || !response.body)
                throw new Error(`HTTP ${response.status}`);
            const hash = crypto.createHash('sha256');
            let bytes = 0;
            for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
                bytes += chunk.length;
                if (bytes > 128 * 1048576 + 1048576)
                    throw new Error('Download exceeded size cap');
                hash.update(chunk);
            }
            results.push({ path: asset.path, ok: hash.digest('hex') === asset.hash && bytes === asset.size });
        }
        catch (e) {
            results.push({ path: asset.path, ok: false, error: (e as Error).message });
        }
    }
    const result = { at: Date.now(), results, sampled: p.assets.length > 20 };
    writeWorkflow('fastdl-verification', id, result);
    return result;
}
