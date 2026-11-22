import { scanIncomingUploads } from './antivirus.routes.js';
import { scanUploadBuffers } from '../services/antivirusService.js';
import { isRunning } from '../services/processManager.js';
import { isCoreKeeper } from '../services/coreKeeper.js';
import { exportCoreKeeperMods, installCoreKeeperMods } from '../services/coreKeeperMods.js';
import { createBackup } from '../services/backupService.js';
import { listModVersions } from '../services/pluginRegistryService.js';
import { resolveModPlan } from '../services/modDependencyService.js';
import { Router, type Request, type Response } from 'express';
import * as addonInventory from '../services/installedAddonService.js';
import { withAddonOperation } from '../services/addonOperationService.js';
import type { CfTarget } from '../services/curseforgeService.js';
import multer from 'multer';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { requireAuth, requirePermission, requireServerAccess } from '../auth/middleware.js';
import { getServer } from '../services/serverService.js';
import {
  deletePlugin,
  getAddonSupport,
  installPluginFile,
  normalizeAddonFileName,
  installUploadedAddon,
  listPlugins,
  requireAddonProfile,
  setPluginEnabled,
} from '../services/pluginService.js';
import { resolvePluginVersion } from '../services/pluginRegistryService.js';
import { curseforge } from '../services/curseforgeService.js';
import { appendLine } from '../services/consoleLogService.js';
import { logAudit, getUserById } from '../services/userService.js';
import type { ServerRecord } from '../types/index.js';

export const pluginsRouter = Router({ mergeParams: true });
pluginsRouter.use(requireAuth,(req,_res,next)=>{const user=getUserById(req.auth!.sub);if(!user||user.disabled)return next(new HttpError(403,'Current account access required'));req.auth!.role=user.role;next();}, requireServerAccess());
const mutating=(work:(req:Request,res:Response)=>Promise<unknown>)=>asyncHandler(async(req,res)=>withAddonOperation(req.params.serverId,async()=>{addonInventory.authorizeAddonMutation(req.auth!.sub,req.params.serverId);addonInventory.assertAddonStopped(req.params.serverId);return work(req,res);}));

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
    res.json({ support, plugins: support.supported ? listPlugins(server) : [], inventory:await addonInventory.installedAddons(server) });
  })
);

pluginsRouter.get('/installed/:id',asyncHandler(async(req,res)=>res.json(await addonInventory.addonDetails(requireServer(req.params.serverId),req.params.id))));
pluginsRouter.get('/core-keeper-pack', asyncHandler(async (req, res) => {
  requirePermission(req, 'files.read');
  const server = requireServer(req.params.serverId);
  if (!isCoreKeeper(server)) throw new HttpError(404, 'This instance does not use Core Keeper mods.');
  res.attachment('core-keeper-mods.zip').send(exportCoreKeeperMods(server));
}));
pluginsRouter.post('/installed/:id/plan',asyncHandler(async(req,res)=>res.json(await addonInventory.planAddonAction(requireServer(req.params.serverId),req.auth!.sub,req.params.id,req.body??{}))));
pluginsRouter.post('/installed/actions/:id/apply',asyncHandler(async(req,res)=>{const result=await addonInventory.applyAddonAction(req.params.serverId,req.auth!.sub,req.params.id,req.body?.acknowledged===true);logAudit(req.auth!.sub,req.auth!.username,'addon.action',req.params.serverId,req.params.id);res.json(result);}));
pluginsRouter.post('/installed/:id/keep',mutating(async(req,res)=>{await addonInventory.pinAddon(requireServer(req.params.serverId),req.params.id);logAudit(req.auth!.sub,req.auth!.username,'addon.keep',req.params.serverId,req.params.id);res.json({ok:true});}));
pluginsRouter.post('/installed/recovery/:id/resolve',asyncHandler(async(req,res)=>{res.json(await addonInventory.resolveAddonRecovery(req.params.serverId,req.auth!.sub,req.params.id));logAudit(req.auth!.sub,req.auth!.username,'addon.recovery.resolve',req.params.serverId,req.params.id);}));

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
  mutating(async (req, res) => {
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
      const byFile=new Map<string,string>();for(const file of files){const name=normalizeAddonFileName(file.fileName),prior=byFile.get(name);if(prior&&prior!==file.downloadUrl)throw new HttpError(409,'Different resolved mods use the same filename; review the dependency versions');byFile.set(name,file.downloadUrl);}
      const before=await addonInventory.installedAddons(server);
      const installed: string[] = [];
      for (const file of files) {
        const name=normalizeAddonFileName(file.fileName);if (installed.includes(name)) continue;
        await installPluginFile(server, file.downloadUrl, name, line => appendLine(server.id, line),()=>{addonInventory.authorizeAddonMutation(req.auth!.sub,server.id);addonInventory.assertAddonStopped(server.id);});
        const previous=before.items.find(i=>i.fileName===name);
        await addonInventory.recordCatalogAddon(server,name,{source,project:file.projectId,versionId:file.versionId,version:file.versionNumber,title:file.title,dependencies:file.dependencies},file===plan.resolved,!!previous&&previous.installation!=='dependency');
        installed.push(name);
      }
      await addonInventory.recordCatalogAddon(server,normalizeAddonFileName(plan.resolved.fileName),{source,project:plan.resolved.projectId,versionId:plan.resolved.versionId,version:plan.resolved.versionNumber,title:plan.resolved.title,dependencies:plan.resolved.dependencies},true);
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
        await scanUploadBuffers([{ name: file.fileName, buffer }], server.id);
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
  (req, _res, next) => { try { requirePermission(req, 'plugins'); next(); } catch (err) { next(err); } },
  upload.array('files'), scanIncomingUploads,
  mutating(async (req, res) => {
    requirePermission(req, 'plugins');
    const server = requireServer(req.params.serverId);
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (!files.length) throw new HttpError(400, 'No files uploaded');
    const coreKeeper = isCoreKeeper(server);
    const replace = coreKeeper && req.body?.replace === 'true';
    if (replace) {
      await createBackup(server.id, 'before-core-keeper-mod-update');
      addonInventory.authorizeAddonMutation(req.auth!.sub, server.id);
      addonInventory.assertAddonStopped(server.id);
    }
    const installed: string[] = [];
    if (coreKeeper) {
      installed.push(...installCoreKeeperMods(server, files, replace));
    } else {
      for (const file of files) {
        const added = installUploadedAddon(server, file.originalname, file.buffer);
        for (const name of added) await addonInventory.recordUploadedAddon(server, name);
        installed.push(...added);
      }
    }
    appendLine(server.id, `[Outpost] Installed ${installed.join(', ')} — restart the server for changes to apply`);
    logAudit(req.auth!.sub, req.auth!.username, 'plugin.upload', server.id, installed.join(', '));
    res.status(201).json({ installed, plugins: listPlugins(server) });
  })
);

pluginsRouter.post('/:fileName/toggle',asyncHandler(async(req,res)=>{
  requirePermission(req,'plugins');const server=requireServer(req.params.serverId);if(typeof req.body?.enabled!=='boolean')throw new HttpError(400,'enabled must be boolean');
  const inventory=await addonInventory.installedAddons(server),item=inventory.items.find(i=>i.fileName===req.params.fileName);if(!item)throw new HttpError(404,'Installed add-on not found');
  const plan=await addonInventory.planAddonAction(server,req.auth!.sub,item.id,{action:req.body.enabled?'enable':'disable'});
  await addonInventory.applyAddonAction(server.id,req.auth!.sub,plan.id,req.body?.acknowledged===true);
  logAudit(req.auth!.sub,req.auth!.username,'plugin.toggle',server.id,item.fileName);res.json({plugins:listPlugins(server)});
}));
pluginsRouter.delete('/:fileName',asyncHandler(async(req,res)=>{
  requirePermission(req,'plugins');const server=requireServer(req.params.serverId),inventory=await addonInventory.installedAddons(server),item=inventory.items.find(i=>i.fileName===req.params.fileName);if(!item)throw new HttpError(404,'Installed add-on not found');
  const plan=await addonInventory.planAddonAction(server,req.auth!.sub,item.id,{action:'remove',cleanup:false});await addonInventory.applyAddonAction(server.id,req.auth!.sub,plan.id,false);
  logAudit(req.auth!.sub,req.auth!.username,'plugin.delete',server.id,item.fileName);res.status(204).end();
}));
