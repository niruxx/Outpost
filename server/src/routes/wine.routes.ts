import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { requireAuth, requirePermission, requireServerAccess } from '../auth/middleware.js';
import { getServer, setLaunchConfig } from '../services/serverService.js';
import { isRunning } from '../services/processManager.js';
import { launchConfigOf } from '../services/launchConfig.js';
import { appendLine } from '../services/consoleLogService.js';
import { logAudit } from '../services/userService.js';
import {
  ensurePrefix,
  ensureWinetricks,
  findWine,
  prefixInfo,
  resetPrefix,
  runWineTool,
  sanitizeWineConfig,
  VERB,
  WINDOWS_VERSIONS,
  WINETRICKS_VERBS,
  wineBusy,
  wineSettingsOf,
  wineStatus,
  withWineJob,
} from '../services/wineService.js';
import { DATA_DIR, instanceDir } from '../utils/paths.js';
import type { ServerRecord } from '../types/index.js';

/**
 * Per-instance Wine: how Windows servers are launched, and dependencies in the instance's prefix.
 * Viewing needs instance access; changing anything needs "launch" (it decides what runs).
 */
export const wineRouter = Router({ mergeParams: true });
wineRouter.use(requireAuth, requireServerAccess());

function requireServer(id: string): ServerRecord {
  const server = getServer(id);
  if (!server) throw new HttpError(404, 'Server not found');
  if (server.platform !== 'steam' && server.platform !== 'custom') throw new HttpError(400, 'Wine only applies to Steam and custom instances');
  return server;
}

function requireStopped(server: ServerRecord) {
  if (isRunning(server.id) || server.status === 'starting') throw new HttpError(409, 'Stop the server first');
  if (server.status === 'installing') throw new HttpError(409, 'The server is still installing');
}

function view(serverId: string) {
  const server = requireServer(serverId);
  const config = launchConfigOf(server);
  return {
    status: wineStatus(),
    config: config.wine ?? { mode: 'auto' },
    settings: wineSettingsOf(config),
    prefix: prefixInfo(instanceDir(server.id)),
    busy: wineBusy(server.id),
    running: isRunning(server.id),
    verbs: WINETRICKS_VERBS,
    windowsVersions: WINDOWS_VERSIONS,
  };
}

/** Starts a Wine job in the background; its output goes to the instance console. */
function background(server: ServerRecord, what: string, job: (log: (line: string) => void) => Promise<void>) {
  const log = (line: string) => appendLine(server.id, line, 'system');
  if (wineBusy(server.id)) throw new HttpError(409, `Wine is busy (${wineBusy(server.id)}) — wait for it to finish`);
  void withWineJob(server.id, what, async () => {
    try {
      await job(log);
      log(`[Outpost] Wine: ${what} — done.`);
    } catch (err) {
      log(`[Outpost] Wine: ${what} failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

wineRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(view(req.params.serverId));
  })
);

/** Saves the instance's Wine settings (the `wine` part of its launch config). */
wineRouter.put(
  '/',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'launch');
    const server = requireServer(req.params.serverId);
    const isAdmin = req.auth!.role === 'admin';
    const current = launchConfigOf(server);
    const body = { ...(req.body ?? {}) } as Record<string, unknown>;
    // A non-admin saving the other settings keeps an admin-chosen Wine build as it is.
    if (!isAdmin) body.binary = current.wine?.binary;
    const wine = sanitizeWineConfig(body, { isAdmin: isAdmin || body.binary === current.wine?.binary });
    const next = { ...current };
    if (wine) next.wine = wine;
    else delete next.wine;
    setLaunchConfig(server.id, Object.keys(next).length ? JSON.stringify(next) : null);
    appendLine(server.id, `[Outpost] Wine settings changed by ${req.auth!.username} — they apply on the next start`, 'system');
    logAudit(req.auth!.sub, req.auth!.username, 'server.wine.update', server.id, JSON.stringify(wine ?? { mode: 'auto' }).slice(0, 500));
    res.json(view(server.id));
  })
);

/** Creates the prefix now (and applies the Windows version), instead of on the next start. */
wineRouter.post(
  '/prefix',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'launch');
    const server = requireServer(req.params.serverId);
    requireStopped(server);
    const settings = wineSettingsOf(launchConfigOf(server));
    if (!findWine(settings.binary)) throw new HttpError(400, wineStatus().hint ?? 'Wine isn’t installed');
    background(server, 'setting up the prefix', (log) => ensurePrefix(server, settings, log));
    res.status(202).json(view(server.id));
  })
);

/** Deletes the prefix — the next start (or setup) makes a fresh one with the current settings. */
wineRouter.delete(
  '/prefix',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'launch');
    const server = requireServer(req.params.serverId);
    requireStopped(server);
    if (wineBusy(server.id)) throw new HttpError(409, 'Wine is busy — wait for it to finish');
    resetPrefix(instanceDir(server.id));
    appendLine(server.id, `[Outpost] Wine prefix reset by ${req.auth!.username}`, 'system');
    logAudit(req.auth!.sub, req.auth!.username, 'server.wine.reset', server.id);
    res.json(view(server.id));
  })
);

/** Installs winetricks verbs (VC++ runtimes, .NET, DirectX…) into the instance's prefix. */
wineRouter.post(
  '/winetricks',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'launch');
    const server = requireServer(req.params.serverId);
    requireStopped(server);
    const verbs = Array.isArray(req.body?.verbs) ? [...new Set((req.body.verbs as unknown[]).map(String).map((v) => v.trim()).filter(Boolean))] : [];
    if (!verbs.length) throw new HttpError(400, 'Pick at least one dependency');
    if (verbs.length > 20) throw new HttpError(400, 'At most 20 at a time');
    const badVerb = verbs.find((v) => !VERB.test(v));
    if (badVerb) throw new HttpError(400, `“${badVerb}” isn’t a winetricks verb`);
    const settings = wineSettingsOf(launchConfigOf(server));
    if (!findWine(settings.binary)) throw new HttpError(400, wineStatus().hint ?? 'Wine isn’t installed');
    const dir = instanceDir(server.id);
    background(server, `installing ${verbs.join(', ')}`, async (log) => {
      await ensurePrefix(server, settings, log);
      let script = await ensureWinetricks(log);
      // Outpost's own copy lives in its data folder, which a sandboxed instance can't see.
      if (script.startsWith(DATA_DIR)) {
        const copy = path.join(dir, '.wine', 'winetricks.sh');
        fs.copyFileSync(script, copy);
        fs.chmodSync(copy, 0o755);
        script = copy;
      }
      log(`[Outpost] winetricks -q ${verbs.join(' ')} (large ones like .NET can take a while)…`);
      await runWineTool(server, settings, script, ['-q', ...verbs], log, 60 * 60_000);
    });
    logAudit(req.auth!.sub, req.auth!.username, 'server.wine.winetricks', server.id, verbs.join(', '));
    res.status(202).json(view(server.id));
  })
);

/** Runs a Windows installer (.exe / .msi) from the instance folder inside its prefix. */
wineRouter.post(
  '/run',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'launch');
    const server = requireServer(req.params.serverId);
    requireStopped(server);
    const rel = typeof req.body?.path === 'string' ? req.body.path.trim().replace(/\\/g, '/') : '';
    const extra = typeof req.body?.args === 'string' ? req.body.args.trim() : '';
    if (!rel || rel.split('/').includes('..') || path.isAbsolute(rel)) throw new HttpError(400, 'Give a path inside the instance folder, e.g. redist/vc_redist.x64.exe');
    if (!/\.(exe|msi)$/i.test(rel)) throw new HttpError(400, 'Only .exe and .msi installers can be run');
    if (extra.length > 300) throw new HttpError(400, 'Arguments are too long');
    const dir = instanceDir(server.id);
    const file = path.resolve(dir, rel);
    if (!file.startsWith(dir + path.sep) || !fs.existsSync(file)) throw new HttpError(404, `${rel} isn’t in the instance folder`);
    const settings = wineSettingsOf(launchConfigOf(server));
    const wine = findWine(settings.binary);
    if (!wine) throw new HttpError(400, wineStatus().hint ?? 'Wine isn’t installed');
    const args = (extra.match(/"[^"]*"|\S+/g) ?? []).map((a: string) => a.replace(/^"|"$/g, ''));
    const argv = /\.msi$/i.test(rel) ? ['msiexec', '/i', file, ...(args.length ? args : ['/qn'])] : [file, ...args];
    background(server, `running ${rel}`, async (log) => {
      await ensurePrefix(server, settings, log);
      log(`[Outpost] wine ${argv.map((a) => (a === file ? rel : a)).join(' ')}`);
      await runWineTool(server, settings, wine, argv, log, 30 * 60_000);
    });
    logAudit(req.auth!.sub, req.auth!.username, 'server.wine.run', server.id, `${rel} ${extra}`.trim());
    res.status(202).json(view(server.id));
  })
);
