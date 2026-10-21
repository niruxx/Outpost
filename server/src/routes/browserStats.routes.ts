import { Router } from 'express';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { requireAuth, requirePermission, requireServerAccess } from '../auth/middleware.js';
import { getServer } from '../services/serverService.js';
import { isRunning, sendCommand } from '../services/processManager.js';
import { appendLine } from '../services/consoleLogService.js';
import { logAudit } from '../services/userService.js';
import { activeRcon } from '../services/rconService.js';
import { gameFamily, latestQuery, livePlayers, moderate, playerHistory, querySupport, queryServer, saveQuerySettings } from '../services/browserStatsService.js';
import type { ServerRecord } from '../types/index.js';

/** Server-browser (A2S) stats and the live player list for Steam instances. */
export const browserStatsRouter = Router({ mergeParams: true });
browserStatsRouter.use(requireAuth, requireServerAccess());

function requireServer(id: string): ServerRecord {
  const server = getServer(id);
  if (!server) throw new HttpError(404, 'Server not found');
  return server;
}

function moderation(server: ServerRecord) {
  const family = gameFamily(server);
  const rcon = !!activeRcon(server);
  return { kick: family !== 'other', ban: family === 'rust' || ((family === 'source' || family === 'goldsrc') && rcon), rcon };
}

/** Last known snapshot plus player-count history (`hours`, default 24, max 168). */
browserStatsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const server = requireServer(req.params.serverId);
    const support = querySupport(server);
    const hours = Number(req.query.hours) || 24;
    let snapshot = latestQuery(server.id);
    // First look after a start: don't make the user wait a minute for the poller.
    if (support.supported && isRunning(server.id) && (!snapshot || Date.now() - Date.parse(snapshot.at) > 90_000)) snapshot = await queryServer(server, true);
    res.json({ support, running: isRunning(server.id), snapshot: isRunning(server.id) ? snapshot : null, history: support.supported ? playerHistory(server.id, hours) : [], moderation: moderation(server) });
  })
);

browserStatsRouter.put(
  '/',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'settings');
    const server = requireServer(req.params.serverId);
    const settings = saveQuerySettings(server, (req.body ?? {}) as Record<string, unknown>);
    logAudit(req.auth!.sub, req.auth!.username, 'server.query.update', server.id, settings.port ? `port ${settings.port}` : 'automatic port');
    res.json({ support: querySupport(getServer(server.id)!) });
  })
);

/** A fresh query plus RCON `status` details where available. */
browserStatsRouter.get(
  '/players',
  asyncHandler(async (req, res) => {
    const server = requireServer(req.params.serverId);
    if (!querySupport(server).supported) throw new HttpError(400, querySupport(server).reason ?? 'Not queryable');
    if (!isRunning(server.id)) return res.json({ players: [], info: null, error: null, at: new Date().toISOString(), enriched: false, running: false, moderation: moderation(server) });
    res.json({ ...(await livePlayers(server)), running: true, moderation: moderation(server) });
  })
);

browserStatsRouter.post(
  '/players/:action(kick|ban)',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'console');
    const server = requireServer(req.params.serverId);
    const action = req.params.action as 'kick' | 'ban';
    const name = typeof req.body?.name === 'string' ? req.body.name : '';
    if (!name || name.length > 128) throw new HttpError(400, 'Player name is required');
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : '';
    const commands = await moderate(server.id, action, name, reason, (c) => sendCommand(server.id, c));
    appendLine(server.id, `[Outpost] ${req.auth!.username} ${action === 'kick' ? 'kicked' : 'banned'} ${name}${reason ? ` (${reason})` : ''}`, 'system');
    logAudit(req.auth!.sub, req.auth!.username, `server.player.${action}`, server.id, name);
    res.json({ ok: true, commands });
  })
);
