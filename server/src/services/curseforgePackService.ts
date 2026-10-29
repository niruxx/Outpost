import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import AdmZip from 'adm-zip';
import { DATA_DIR, safeJoin, safeJoinReal } from '../utils/paths.js';
import { HttpError } from '../utils/asyncHandler.js';
import { curseforge } from './curseforgeService.js';
import type { ModpackRef, ModdedLoader, Progress } from './moddedService.js';
import type { LogFn } from '../utils/download.js';

interface Manifest { name: string; minecraft: { version: string; modLoaders: { id: string; primary?: boolean }[] }; files: { projectID: number; fileID: number; required?: boolean }[]; overrides?: string }
export function inspectCurseForgePack(buffer: Buffer) {
  const zip = new AdmZip(buffer); validateArchive(zip);
  const entry = zip.getEntry('manifest.json');
  if (!entry || entry.header.size > 5 * 1024 * 1024) throw new HttpError(400, 'A CurseForge export with manifest.json is required');
  const manifest = JSON.parse(entry.getData().toString()) as Manifest;
  const loaders = manifest.minecraft?.modLoaders;
  const selected = loaders?.find(l => l.primary) ?? (loaders?.length === 1 ? loaders[0] : undefined);
  const match = selected?.id?.match(/^(forge|neoforge|fabric|quilt)-([\w.+-]{1,80})$/);
  if (!match || !/^[\w.+-]{1,80}$/.test(manifest.minecraft.version) || typeof manifest.name !== 'string' || !Array.isArray(manifest.files) || manifest.files.length > 5000 || !manifest.files.every(f => Number.isSafeInteger(f.projectID) && f.projectID > 0 && Number.isSafeInteger(f.fileID) && f.fileID > 0)) throw new HttpError(400, 'Unsupported or invalid CurseForge manifest (Forge/NeoForge/Fabric/Quilt required)');
  if (manifest.overrides && !/^[\w.-]{1,100}$/.test(manifest.overrides)) throw new HttpError(400, 'Invalid overrides directory');
  return { manifest, loader: match[1] as ModdedLoader, loaderVersion: match[2], mc: manifest.minecraft.version };
}
function validateArchive(zip: AdmZip) {
  const entries = zip.getEntries();
  if (entries.length > 20000 || entries.reduce((sum, e) => sum + e.header.size, 0) > 2 * 1024 ** 3) throw new HttpError(400, 'Archive exceeds 20000 files or 2 GiB expanded');
  for (const e of entries) {
    safeJoin(path.join(DATA_DIR, 'pack-validation'), e.entryName);
    if (((e.attr >>> 16) & 0xf000) === 0xa000) throw new HttpError(400, 'Symbolic links are not allowed in a modpack');
  }
}
export async function cfDownload(url: string, maximum = 256 * 1024 * 1024, hashes: { algo: number; value: string }[] = []): Promise<Buffer> {
  let next = url;
  for (let redirects = 0; redirects < 5; redirects++) {
    const address = new URL(next);
    if (address.protocol !== 'https:' || !(address.hostname === 'forgecdn.net' || address.hostname.endsWith('.forgecdn.net')) || address.username || address.password) throw new HttpError(400, 'CurseForge downloads must use HTTPS forgecdn.net URLs');
    const response = await fetch(next, { redirect: 'manual', signal: AbortSignal.timeout(120_000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) { await response.body?.cancel(); next = new URL(response.headers.get('location') ?? '', next).href; continue; }
    if (!response.ok || !response.body) throw new HttpError(502, `CurseForge download failed (${response.status})`);
    const chunks: Buffer[] = []; let size = 0;
    for await (const bytes of response.body) { size += bytes.length; if (size > maximum) { await response.body.cancel().catch(() => {}); throw new HttpError(400, 'CurseForge file exceeds its download size limit'); } chunks.push(Buffer.from(bytes)); }
    const buffer = Buffer.concat(chunks);
    const hash = hashes.find(h => h.algo === 1) ?? hashes.find(h => h.algo === 2);
    if (hash && crypto.createHash(hash.algo === 1 ? 'sha1' : 'md5').update(buffer).digest('hex').toLowerCase() !== hash.value.toLowerCase()) throw new HttpError(502, 'CurseForge file checksum mismatch');
    return buffer;
  }
  throw new HttpError(502, 'Too many CurseForge download redirects');
}
export async function resolveCurseForgePack(projectId: string, fileId: string) {
  const { mod, file } = await curseforge.packFile(Number(projectId), Number(fileId));
  if (file.isServerPack) throw new HttpError(400, 'Select the client/export file ID so Outpost can read its loader manifest');
  const bytes = await cfDownload(file.downloadUrl!, 256 * 1024 * 1024, file.hashes);
  const inspection = inspectCurseForgePack(bytes);
  return { ref: { source: 'curseforge' as const, projectId: String(mod.id), versionId: String(file.id), title: mod.name, versionNumber: file.displayName }, ...inspection };
}
export async function installCurseForgePack(ref: ModpackRef, dir: string, progress: Progress, log?: LogFn) {
  const { file } = await curseforge.packFile(Number(ref.projectId), Number(ref.versionId));
  const bytes = await cfDownload(file.downloadUrl!, 256 * 1024 * 1024, file.hashes);
  const { manifest, loader, mc, loaderVersion } = inspectCurseForgePack(bytes);
  let zip = new AdmZip(bytes), prefix = `${manifest.overrides ?? 'overrides'}/`;
  if (file.serverPackFileId) {
    const { file: serverFile } = await curseforge.packFile(Number(ref.projectId), file.serverPackFileId);
    zip = new AdmZip(await cfDownload(serverFile.downloadUrl!, 512 * 1024 * 1024, serverFile.hashes)); validateArchive(zip); prefix = '';
    const names = zip.getEntries().filter(e => !e.isDirectory).map(e => e.entryName);
    const roots = new Set(names.map(n => n.split('/')[0]));
    if (roots.size === 1 && names.every(n => n.includes('/'))) prefix = `${names[0].split('/')[0]}/`;
    log?.('==> Installing the author-provided CurseForge server pack (startup scripts are not executed)');
  } else {
    log?.('==> No author server pack; installing required manifest files. Client-only mods may need removal before first start.');
    let completed = 0;
    for (const fileRef of manifest.files.filter(f => f.required !== false)) {
      const resolved = await curseforge.resolveFile(fileRef.projectID, mc, undefined, fileRef.fileID);
      if (path.basename(resolved.fileName) !== resolved.fileName || !resolved.fileName.endsWith('.jar')) throw new HttpError(400, 'Manifest mod must be a plain JAR filename');
      const buffer = await cfDownload(resolved.downloadUrl);
      const target = safeJoinReal(dir, `mods/${resolved.fileName}`);
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, buffer);
      progress(5 + Math.round(++completed / Math.max(1, manifest.files.length) * 70), `Installing CurseForge mods (${completed})`);
    }
  }
  for (const e of zip.getEntries()) {
    if (e.isDirectory || !e.entryName.startsWith(prefix)) continue;
    const relative = e.entryName.slice(prefix.length);
    if (!relative || relative === 'eula.txt') continue;
    const target = safeJoinReal(dir, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, e.getData());
  }
  progress(100, 'CurseForge pack files installed'); return { loader, mc, loaderVersion };
}
