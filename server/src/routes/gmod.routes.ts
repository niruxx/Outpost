import { Router } from 'express';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { requireAuth, requirePermission, requireServerAccess } from '../auth/middleware.js';
import { getServer } from '../services/serverService.js';
import { isRunning } from '../services/processManager.js';
import { appendLine } from '../services/consoleLogService.js';
import { logAudit } from '../services/userService.js';
import { steamAppUpdate } from '../services/steamCmdService.js';
import { CSS_CONTENT_APP_ID, cssContentDir, cssStatus, gmodContent, gmodSettingsOf, isGmod, saveGmodSettings, writeCssMount } from '../services/gmodService.js';
import type { ServerRecord } from '../types/index.js';

/** Garry's Mod tab: server settings and Counter-Strike: Source content. Changes need "settings". */
export const gmodRouter = Router({ mergeParams: true });
gmodRouter.use(requireAuth, requireServerAccess());

/** CS:S downloads in progress, by instance. */
const cssJobs = new Map<string, { startedAt: string; error: string | null; running: boolean }>();

function requireGmod(id: string): ServerRecord {
  const server = getServer(id);
  if (!server) throw new HttpError(404, 'Server not found');
  if (!isGmod(server)) throw new HttpError(400, 'This instance isn’t Garry’s Mod');
  return server;
}

function view(server: ServerRecord) {
  const { gslt, password, ...settings } = gmodSettingsOf(server);
  return {
    // Secrets are only reported as set / not set.
    settings: { ...settings, hasPassword: !!password, hasGslt: !!gslt },
    content: gmodContent(server),
    css: { ...cssStatus(server), job: cssJobs.get(server.id) ?? null },
    running: isRunning(server.id),
  };
}

gmodRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(view(requireGmod(req.params.serverId)));
  })
);

gmodRouter.put(
  '/',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'settings');
    const server = requireGmod(req.params.serverId);
    const body = { ...(req.body ?? {}) } as Record<string, unknown>;
    // Blank secret fields mean "keep"; clearPassword / clearGslt remove them.
    if (body.password === '' || body.password === undefined) delete body.password;
    if (body.gslt === '' || body.gslt === undefined) delete body.gslt;
    if (body.clearPassword === true) body.password = '';
    if (body.clearGslt === true) body.gslt = '';
    const s = saveGmodSettings(server, body);
    appendLine(server.id, `[Outpost] Garry's Mod settings changed by ${req.auth!.username}: ${s.gamemode} on ${s.map}, ${s.maxPlayers} slots${isRunning(server.id) ? ' — restart to apply' : ''}`, 'system');
    logAudit(req.auth!.sub, req.auth!.username, 'server.gmod.update', server.id, `${s.gamemode} ${s.map} ${s.maxPlayers}`);
    res.json(view(getServer(server.id)!));
  })
);

/** Downloads the Counter-Strike: Source dedicated server's content and mounts it. */
gmodRouter.post(
  '/css',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'settings');
    const server = requireGmod(req.params.serverId);
    if (cssJobs.get(server.id)?.running) throw new HttpError(409, 'Already downloading');
    const job = { startedAt: new Date().toISOString(), error: null as string | null, running: true };
    cssJobs.set(server.id, job);
    logAudit(req.auth!.sub, req.auth!.username, 'server.gmod.css', server.id, 'install');
    appendLine(server.id, `[Outpost] Downloading Counter-Strike: Source content for mounting (about 2 GB) — requested by ${req.auth!.username}`, 'system');
    void steamAppUpdate(CSS_CONTENT_APP_ID, cssContentDir(server), (line) => appendLine(server.id, line, 'system'), true)
      .then(() => {
        writeCssMount(server, true);
        appendLine(server.id, `[Outpost] CS:S content mounted (garrysmod/cfg/mount.cfg)${isRunning(server.id) ? ' — restart to load it' : ''}`, 'system');
      })
      .catch((err) => {
        job.error = err instanceof Error ? err.message : String(err);
        appendLine(server.id, `[Outpost] CS:S content download failed: ${job.error}`, 'stderr');
      })
      .finally(() => {
        job.running = false;
      });
    res.status(202).json(view(server));
  })
);

gmodRouter.put(
  '/css',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'settings');
    const server = requireGmod(req.params.serverId);
    const mount = req.body?.mounted === true;
    if (mount && !cssStatus(server).installed) throw new HttpError(400, 'Download the CS:S content first');
    writeCssMount(server, mount);
    logAudit(req.auth!.sub, req.auth!.username, 'server.gmod.css', server.id, mount ? 'mount' : 'unmount');
    res.json(view(server));
  })
);
