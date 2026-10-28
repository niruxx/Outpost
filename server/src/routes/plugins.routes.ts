import { isRunning } from '../services/processManager.js';
import { listModVersions } from '../services/pluginRegistryService.js';
import { resolveModPlan } from '../services/modDependencyService.js';
import { Router } from 'express';
import type { CfTarget } from '../services/curseforgeService.js';
import multer from 'multer';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { requireAuth, requirePermission, requireServerAccess } from '../auth/middleware.js';
import { getServer } from '../services/serverService.js';
import {
  deletePlugin,
  getAddonSupport,
  installPluginFile,
  installUploadedAddon,
  listPlugins,
  requireAddonProfile,
  setPluginEnabled,
} from '../services/pluginService.js';
import { resolvePluginVersion } from '../services/pluginRegistryService.js';
import { curseforge } from '../services/curseforgeService.js';
import { appendLine } from '../services/consoleLogService.js';
import { logAudit } from '../services/userService.js';
import type { ServerRecord } from '../types/index.js';

export const pluginsRouter = Router({ mergeParams: true });
pluginsRouter.use(requireAuth, requireServerAccess());

const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_DOWNLOAD_BYTES } });

/** Downloads a catalog file into memory (Bedrock packs are unpacked from it), refusing anything huge. */
async function downloadToBuffer(url: string, maxBytes: number): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok || !res.body) throw new HttpError(502, `Download failed (${res.status})`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new HttpError(413, 'That file is too large');
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > maxBytes) throw new HttpError(413, 'That file is too large');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}


function requireServer(serverId: string): ServerRecord {
  const server = getServer(serverId);
  if (!server) throw new HttpError(404, 'Server not found');
  return server;
}

/** Always 200: unsupported instance types get `support.supported = false` plus the reason, so the
 *  UI can explain what (if anything) that game supports instead of showing an error. */
pluginsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const server = requireServer(req.params.serverId);
    const support = getAddonSupport(server);
    res.json({ support, plugins: support.supported ? listPlugins(server) : [] });
  })
);

pluginsRouter.post('/versions', asyncHandler(async (req, res) => {
  requirePermission(req, 'plugins');
  const server = requireServer(req.params.serverId);
  const profile = requireAddonProfile(server);
  if (!profile.catalog?.startsWith('mod:')) throw new HttpError(400, 'Version selection is available for Minecraft mods');
  const source = req.body?.source === 'curseforge' ? 'curseforge' : 'modrinth';
  let ref = String(req.body?.project ?? '').trim();
  if (!ref || ref.length > 2048) throw new HttpError(400, 'Enter a mod project slug or CurseForge project link');
  if (source === 'curseforge') {
    if (ref.startsWith('https://')) ref = String((await curseforge.resolveLink(ref)).id);
    if (!/^[1-9]\d*$/.test(ref)) throw new HttpError(400, 'Enter a CurseForge mod project link or project ID');
  }
  const versions = source === 'curseforge'
    ? await curseforge.versions(Number(ref), server.version, profile.catalog as CfTarget)
    : await listModVersions(ref, profile.catalog, server.version);
  res.json({ ref, versions });
}));

pluginsRouter.post(
  '/dependencies',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'plugins');
    const server = requireServer(req.params.serverId);
    const profile = requireAddonProfile(server);
    if (!profile.catalog?.startsWith('mod:')) throw new HttpError(400, 'Dependencies are available for Minecraft mods');
    const source = req.body?.source === 'curseforge' ? 'curseforge' : 'modrinth';
    const ref = source === 'curseforge' ? String(req.body?.modId ?? '') : req.body?.slug;
    if (typeof ref !== 'string' || !ref.trim() || (source === 'curseforge' && !/^[1-9]\d*$/.test(ref))) throw new HttpError(400, 'A valid mod reference is required');
    res.json(await resolveModPlan(source, ref, profile.catalog, server.version, typeof req.body?.versionId === 'string' ? req.body.versionId : undefined));
  })
);

pluginsRouter.post(
  '/install',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'plugins');
    const server = requireServer(req.params.serverId);
    const profile = requireAddonProfile(server);
    if (!profile.catalog) throw new HttpError(400, `${profile.label} for this instance can only be uploaded, not installed from a catalog`);

    if (profile.catalog.startsWith('mod:')) {
      const source = req.body?.source === 'curseforge' ? 'curseforge' : 'modrinth';
      const ref = source === 'curseforge' ? String(req.body?.modId ?? '') : req.body?.slug;
      if (typeof ref !== 'string' || !ref.trim() || (source === 'curseforge' && !/^[1-9]\d*$/.test(ref))) throw new HttpError(400, 'A valid mod reference is required');
      if (isRunning(server.id) || ['installing', 'updating'].includes(server.status)) throw new HttpError(409, 'Stop the server and wait for installation to finish before changing mods');
      const replaceFile = req.body?.replaceFile;
      const oldMod = typeof replaceFile === 'string' ? listPlugins(server).find(p => p.fileName === replaceFile && p.enabled) : undefined;
      if (replaceFile !== undefined && !oldMod) throw new HttpError(400, 'Select an installed, enabled mod to replace');
      const plan = await resolveModPlan(source, ref, profile.catalog, server.version, typeof req.body?.versionId === 'string' ? req.body.versionId : undefined);
      const required = plan.dependencies.filter(d => d.required);
      if (req.body?.includeDependencies === true && required.some(d => d.error || !d.resolved)) {
        throw new HttpError(409, 'Some required dependencies cannot be downloaded. Review the dependency list before installing.');
      }
      const files = req.body?.includeDependencies === true ? [...required.map(d => d.resolved!), plan.resolved] : [plan.resolved];
      const installed: string[] = [];
      for (const file of files) {
        if (installed.includes(file.fileName)) continue;
        await installPluginFile(server, file.downloadUrl, file.fileName, line => appendLine(server.id, line));
        installed.push(file.fileName);
      }
      if (oldMod && !installed.includes(oldMod.fileName)) setPluginEnabled(server, oldMod.fileName, false);
      appendLine(server.id, `[Outpost] Installed ${installed.join(', ')} - restart the server to apply`);
      logAudit(req.auth!.sub, req.auth!.username, 'plugin.install', server.id, installed.join(', '));
      return res.status(201).json({ plugins: listPlugins(server), installed, resolved: plan.resolved });
    }

    if (req.body?.source === 'curseforge') {
      if (profile.catalog.startsWith('proxy:')) throw new HttpError(400, 'Proxy plugins install from Modrinth or by upload');
      const modId = Number(req.body?.modId);
      if (!Number.isInteger(modId) || modId <= 0) throw new HttpError(400, 'modId is required');
      const javaVersion = profile.kind === 'bedrock' ? null : server.version;
      const file = await curseforge.resolveFile(modId, javaVersion, profile.catalog as CfTarget);
      if (file.versionMismatchWarning) {
        appendLine(server.id, `[Outpost] No CurseForge file is tagged for Minecraft ${server.version} — installing the newest one (${file.versionLabel}). Check it's compatible.`);
      }
      appendLine(server.id, `[Outpost] Downloading ${file.fileName} from CurseForge`);
      let installed: string[];
      if (profile.kind === 'bedrock') {
        // Bedrock packs go through the same installer as uploads (unpacks .mcaddon, activates for the world).
        const buffer = await downloadToBuffer(file.downloadUrl, MAX_DOWNLOAD_BYTES);
        installed = installUploadedAddon(server, file.fileName, buffer);
      } else {
        await installPluginFile(server, file.downloadUrl, file.fileName, (line) => appendLine(server.id, line));
        installed = [file.fileName];
      }
      appendLine(server.id, `[Outpost] Installed ${installed.join(', ')} — restart the server for it to load`);
      logAudit(req.auth!.sub, req.auth!.username, 'plugin.install', server.id, `CurseForge ${modId}: ${installed.join(', ')}`);
      return res.status(201).json({ plugins: listPlugins(server), installed, resolved: { versionNumber: file.versionLabel, fileName: file.fileName, versionMismatchWarning: file.versionMismatchWarning } });
    }

    if (profile.catalog === 'bedrock') throw new HttpError(400, 'Bedrock packs install from CurseForge');
    const { slug } = req.body ?? {};
    if (typeof slug !== 'string' || !slug.trim()) throw new HttpError(400, 'slug is required');

    appendLine(server.id, `[Outpost] Resolving ${profile.singular} "${slug}" for ${server.loader} ${server.version}`);
    const resolved = await resolvePluginVersion(slug.trim(), profile.catalog, server.version).catch((err) => {
      appendLine(server.id, `[Outpost] ${profile.singular} resolve failed: ${err.message}`, 'stderr');
      throw new HttpError(502, err instanceof Error ? err.message : 'Could not resolve version');
    });
    if (resolved.versionMismatchWarning) {
      appendLine(
        server.id,
        `[Outpost] No build listed for Minecraft ${server.version} — installing the latest available build (${resolved.versionNumber}) instead. Check it's compatible.`
      );
    }
    appendLine(server.id, `[Outpost] Downloading ${resolved.fileName} (${resolved.versionNumber})`);
    await installPluginFile(server, resolved.downloadUrl, resolved.fileName, (line) => appendLine(server.id, line));
    appendLine(server.id, `[Outpost] Installed ${resolved.fileName} — restart the server for it to load`);

    logAudit(req.auth!.sub, req.auth!.username, 'plugin.install', server.id, resolved.fileName);
    res.status(201).json({ plugins: listPlugins(server), resolved });
  })
);

pluginsRouter.post(
  '/upload',
  upload.array('files'),
  asyncHandler(async (req, res) => {
    requirePermission(req, 'plugins');
    const server = requireServer(req.params.serverId);
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (!files.length) throw new HttpError(400, 'No files uploaded');
    const installed: string[] = [];
    for (const file of files) {
      installed.push(...installUploadedAddon(server, file.originalname, file.buffer));
    }
    appendLine(server.id, `[Outpost] Installed ${installed.join(', ')} — restart the server for changes to apply`);
    logAudit(req.auth!.sub, req.auth!.username, 'plugin.upload', server.id, installed.join(', '));
    res.status(201).json({ installed, plugins: listPlugins(server) });
  })
);

pluginsRouter.post(
  '/:fileName/toggle',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'plugins');
    const server = requireServer(req.params.serverId);
    const { enabled } = req.body ?? {};
    if (typeof enabled !== 'boolean') throw new HttpError(400, 'enabled must be a boolean');
    setPluginEnabled(server, req.params.fileName, enabled);
    logAudit(req.auth!.sub, req.auth!.username, 'plugin.toggle', server.id, `${req.params.fileName}=${enabled}`);
    res.json({ plugins: listPlugins(server) });
  })
);

pluginsRouter.delete(
  '/:fileName',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'plugins');
    const server = requireServer(req.params.serverId);
    deletePlugin(server, req.params.fileName);
    logAudit(req.auth!.sub, req.auth!.username, 'plugin.delete', server.id, req.params.fileName);
    res.status(204).end();
  })
);
