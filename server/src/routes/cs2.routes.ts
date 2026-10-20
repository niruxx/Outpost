import { Router } from 'express';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { requireAuth, requirePermission, requireServerAccess } from '../auth/middleware.js';
import { getServer } from '../services/serverService.js';
import { getServerPermissions, logAudit } from '../services/userService.js';
import { isRunning, sendCommand } from '../services/processManager.js';
import { appendLine } from '../services/consoleLogService.js';
import { rconConfigOf, saveRcon } from '../services/rconService.js';
import {
  applyPreset,
  COMMANDS,
  cs2SettingsOf,
  hasCounterStrikeSharp,
  installedMaps,
  isCs2,
  liveCommands,
  MODES,
  PRESETS,
  saveCs2Settings,
  writeCs2Configs,
} from '../services/cs2Service.js';
import type { Request } from 'express';
import { getPrimaryAddress } from '../services/networkService.js';
import type { ServerRecord } from '../types/index.js';

/** Counter-Strike 2 controls for one instance. Viewing needs access; changes need "settings"; live actions need "console". */
export const cs2Router = Router({ mergeParams: true });
cs2Router.use(requireAuth, requireServerAccess());

function requireCs2(id: string): ServerRecord {
  const server = getServer(id);
  if (!server) throw new HttpError(404, 'Server not found');
  if (!isCs2(server)) throw new HttpError(400, 'This isn’t a Counter-Strike 2 instance');
  return server;
}

async function view(req: Request, server: ServerRecord) {
  const s = cs2SettingsOf(server);
  const perms = getServerPermissions(req.auth!.sub, req.auth!.role, server.id) ?? [];
  const canSeeSecrets = perms.includes('settings');
  const rcon = rconConfigOf(server);
  return {
    settings: canSeeSecrets ? s : { ...s, password: s.password ? '••••••' : '', gslt: s.gslt ? '••••••' : '' },
    modes: Object.entries(MODES).map(([id, m]) => ({ id, label: m.label, maxPlayers: m.maxPlayers })),
    presets: PRESETS.map(({ id, label, description, mode, tip }) => ({ id, label, description, mode, tip: tip ?? null })),
    maps: installedMaps(server),
    running: isRunning(server.id),
    counterStrikeSharp: hasCounterStrikeSharp(server),
    commands: COMMANDS,
    admin: {
      rconEnabled: !!rcon?.enabled,
      // Only people who may edit settings see the RCON password (it's what makes someone admin in vanilla CS2).
      rconPassword: canSeeSecrets && rcon?.enabled ? rcon.password : null,
      port: server.server_port,
      address: (await getPrimaryAddress().catch(() => null)) ?? null,
    },
  };
}

cs2Router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await view(req, requireCs2(req.params.serverId)));
  })
);

cs2Router.put(
  '/',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'settings');
    const server = requireCs2(req.params.serverId);
    const body = { ...(req.body ?? {}) } as Record<string, unknown>;
    // The masked placeholders come back unchanged when someone without them saves.
    if (body.password === '••••••') delete body.password;
    if (body.gslt === '••••••') delete body.gslt;
    const settings = saveCs2Settings(server, body);
    writeCs2Configs(getServer(server.id)!);
    logAudit(req.auth!.sub, req.auth!.username, 'server.cs2.update', server.id, `${settings.mode}, ${settings.workshopMap ?? settings.map}`);
    res.json(await view(req, getServer(server.id)!));
  })
);

cs2Router.post(
  '/preset',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'settings');
    const server = requireCs2(req.params.serverId);
    const { preset } = applyPreset(server, String(req.body?.preset ?? ''));
    writeCs2Configs(getServer(server.id)!);
    appendLine(server.id, `[Outpost] CS2 preset “${preset.label}” applied by ${req.auth!.username}${isRunning(server.id) ? ' — use “Apply now” or restart to load it' : ''}`, 'system');
    logAudit(req.auth!.sub, req.auth!.username, 'server.cs2.preset', server.id, preset.id);
    res.json({ ...(await view(req, getServer(server.id)!)), tip: preset.tip ?? null });
  })
);

/** Live controls: apply settings now, change map, restart round, bots. */
cs2Router.post(
  '/action',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'console');
    const server = requireCs2(req.params.serverId);
    if (!isRunning(server.id)) throw new HttpError(409, 'Start the server first');
    if (req.body?.action === 'apply') writeCs2Configs(server);
    const commands = liveCommands(server, String(req.body?.action ?? ''), req.body?.value);
    for (const c of commands) sendCommand(server.id, c);
    logAudit(req.auth!.sub, req.auth!.username, 'server.command', server.id, `[cs2] ${commands.join('; ')}`.slice(0, 500));
    res.json({ sent: commands });
  })
);

/** "Make me admin" for vanilla CS2: turn RCON on (generated password) so it can be used from the in-game console. */
cs2Router.post(
  '/enable-rcon',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'launch');
    const server = requireCs2(req.params.serverId);
    const cur = rconConfigOf(server);
    saveRcon(server, { enabled: true, protocol: 'source', port: server.server_port, generatePassword: !cur?.password });
    appendLine(server.id, `[Outpost] RCON turned on by ${req.auth!.username} — restart the server to use it`, 'system');
    logAudit(req.auth!.sub, req.auth!.username, 'server.rcon.update', server.id, 'enabled from the CS2 tab');
    res.json(await view(req, getServer(server.id)!));
  })
);
