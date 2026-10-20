import { Router } from 'express';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { requireAuth, requirePermission, requireServerAccess } from '../auth/middleware.js';
import { getServer } from '../services/serverService.js';
import { isRunning } from '../services/processManager.js';
import { appendLine } from '../services/consoleLogService.js';
import { logAudit } from '../services/userService.js';
import { probeCommand, publicRcon, rconConfigOf, rconDefaults, rconSend, saveRcon } from '../services/rconService.js';
import type { ServerRecord } from '../types/index.js';

/** RCON console settings for one instance. Changing them needs "launch"; sending commands needs "console". */
export const rconRouter = Router({ mergeParams: true });
rconRouter.use(requireAuth, requireServerAccess());

function requireServer(id: string): ServerRecord {
  const server = getServer(id);
  if (!server) throw new HttpError(404, 'Server not found');
  return server;
}

function view(server: ServerRecord) {
  return { config: publicRcon(rconConfigOf(server)), defaults: rconDefaults(server), running: isRunning(server.id) };
}

rconRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(view(requireServer(req.params.serverId)));
  })
);

rconRouter.put(
  '/',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'launch');
    const server = requireServer(req.params.serverId);
    const { config, configured } = saveRcon(server, (req.body ?? {}) as Record<string, unknown>);
    appendLine(server.id, `[Outpost] RCON ${config.enabled ? `on (${config.protocol}, port ${config.port})` : 'off'} — changed by ${req.auth!.username}`, 'system');
    logAudit(req.auth!.sub, req.auth!.username, 'server.rcon.update', server.id, JSON.stringify({ ...config, password: undefined }));
    res.json({ ...view(getServer(server.id)!), configured });
  })
);

/** Connects with the saved settings and runs a harmless command. */
rconRouter.post(
  '/test',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'console');
    const server = requireServer(req.params.serverId);
    const cfg = rconConfigOf(server);
    if (!cfg?.password) throw new HttpError(400, 'Save RCON settings with a password first');
    const command = probeCommand(server, cfg);
    try {
      const reply = await rconSend(cfg, command);
      res.json({ ok: true, command, reply });
    } catch (err) {
      res.json({ ok: false, command, error: err instanceof Error ? err.message : String(err) });
    }
  })
);

/** Runs one command over RCON and returns the reply (also echoed into the console). */
rconRouter.post(
  '/command',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'console');
    const server = requireServer(req.params.serverId);
    const command = typeof req.body?.command === 'string' ? req.body.command.trim() : '';
    if (!command || command.length > 1000) throw new HttpError(400, 'Command is required');
    const cfg = rconConfigOf(server);
    if (!cfg?.enabled) throw new HttpError(400, 'RCON isn’t turned on for this instance');
    appendLine(server.id, `> ${command} (RCON)`, 'system');
    let reply: string;
    try {
      reply = await rconSend(cfg, command);
    } catch (err) {
      throw new HttpError(502, err instanceof Error ? err.message : String(err));
    }
    for (const line of reply.split(/\r?\n/)) if (line.trim()) appendLine(server.id, line, 'stdout');
    logAudit(req.auth!.sub, req.auth!.username, 'server.command', server.id, `[rcon] ${command.slice(0, 500)}`);
    res.json({ reply });
  })
);
