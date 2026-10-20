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
  downloadedWorkshopMaps,
  ensureWorkshopLibrary,
  importMaps,
  removeFromLibrary,
  hasCounterStrikeSharp,
  installedMaps,
  isCs2,
  liveCommands,
  MODES,
  PRESETS,
  saveCs2Settings,
  writeCs2Configs,
} from '../services/cs2Service.js';
import { CATALOG, checkUpdates, frameworkStatus, installFrameworks, installPlugin, listCs2Plugins, removePlugin, setPluginEnabled, setPluginsLoaded } from '../services/cs2PluginService.js';
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
    workshopMaps: await downloadedWorkshopMaps(server),
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

/** Just the map lists — polled by the tab so uploads and new Workshop downloads appear without a reload. */
cs2Router.get(
  '/maps',
  asyncHandler(async (req, res) => {
    const server = requireCs2(req.params.serverId);
    res.json({ maps: installedMaps(server), workshopMaps: await downloadedWorkshopMaps(server) });
  }),
);

cs2Router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await view(req, requireCs2(req.params.serverId)));
  }),
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
  }),
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
  }),
);

/** Live controls: apply settings now, change map, restart round, bots. */
cs2Router.post(
  '/action',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'console');
    const server = requireCs2(req.params.serverId);
    if (!isRunning(server.id)) throw new HttpError(409, 'Start the server first');
    if (req.body?.action === 'apply') writeCs2Configs(server);
    // host_workshop_map / changelevel to a Workshop map needs the library folders ("Staging library folder not found").
    if (req.body?.action === 'changelevel' || req.body?.action === 'apply') ensureWorkshopLibrary(server);
    const commands = liveCommands(server, String(req.body?.action ?? ''), req.body?.value);
    for (const c of commands) sendCommand(server.id, c);
    logAudit(req.auth!.sub, req.auth!.username, 'server.command', server.id, `[cs2] ${commands.join('; ')}`.slice(0, 500));
    res.json({ sent: commands });
  }),
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
  }),
);

/** Map library: import Workshop maps by link / ID / collection link. */
cs2Router.post(
  '/library',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'settings');
    const server = requireCs2(req.params.serverId);
    const r = await importMaps(server, typeof req.body?.input === 'string' ? req.body.input : '');
    if (r.added.length)
      logAudit(
        req.auth!.sub,
        req.auth!.username,
        'server.cs2.import_maps',
        server.id,
        r.added
          .map((m) => `${m.title} (${m.id})`)
          .join(', ')
          .slice(0, 500),
      );
    res.status(r.added.length ? 201 : 200).json({ ...(await view(req, getServer(server.id)!)), added: r.added, skipped: r.skipped });
  }),
);

cs2Router.delete(
  '/library/:mapId',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'settings');
    const server = requireCs2(req.params.serverId);
    removeFromLibrary(server, req.params.mapId);
    res.json(await view(req, getServer(server.id)!));
  }),
);

// ---------------------------------------------------------------------------
// Plugins (Metamod:Source + CounterStrikeSharp)
// ---------------------------------------------------------------------------

/** Framework installs are ~55 MB, so they run in the background; the tab polls GET /plugins. */
const frameworkJobs = new Map<string, { state: 'running' | 'failed'; error?: string }>();

function pluginView(server: ServerRecord) {
  const job = frameworkJobs.get(server.id) ?? null;
  return { frameworks: frameworkStatus(server), frameworkJob: job, installed: listCs2Plugins(server), catalog: CATALOG.map(({ avoidAssets: _a, ...c }) => c), running: isRunning(server.id) };
}

cs2Router.get(
  '/plugins',
  asyncHandler(async (req, res) => {
    res.json(pluginView(requireCs2(req.params.serverId)));
  }),
);

cs2Router.post(
  '/plugins/frameworks',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'plugins');
    const server = requireCs2(req.params.serverId);
    if (frameworkJobs.get(server.id)?.state === 'running') throw new HttpError(409, 'Already installing');
    frameworkJobs.set(server.id, { state: 'running' });
    logAudit(req.auth!.sub, req.auth!.username, 'server.cs2.install_frameworks', server.id, 'Metamod:Source + CounterStrikeSharp');
    appendLine(server.id, `[Outpost] Installing Metamod:Source + CounterStrikeSharp (requested by ${req.auth!.username})`, 'system');
    installFrameworks(server, (line) => appendLine(server.id, line))
      .then(() => {
        frameworkJobs.delete(server.id);
        // Admins from the "Becoming an admin" list now have somewhere to go.
        writeCs2Configs(getServer(server.id)!);
      })
      .catch((err: Error) => {
        frameworkJobs.set(server.id, { state: 'failed', error: err.message });
        appendLine(server.id, `[Outpost] Plugin framework install failed: ${err.message}`, 'stderr');
      });
    res.status(202).json(pluginView(server));
  }),
);

cs2Router.post(
  '/plugins',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'plugins');
    const server = requireCs2(req.params.serverId);
    const body = req.body ?? {};
    const input = { catalogId: typeof body.catalogId === 'string' ? body.catalogId : undefined, repo: typeof body.repo === 'string' ? body.repo : undefined };
    if (!input.catalogId && !input.repo) throw new HttpError(400, 'Pick a plugin or paste a GitHub link');
    try {
      const r = await installPlugin(server, input, (line) => appendLine(server.id, line));
      logAudit(req.auth!.sub, req.auth!.username, 'server.cs2.install_plugin', server.id, `${r.repo} ${r.version}`);
      appendLine(server.id, `[Outpost] ${r.folders.join(', ')} ${r.version} installed by ${req.auth!.username}${isRunning(server.id) ? ' — restart (or css_plugins load) to use it' : ''}`, 'system');
      res.status(201).json({ ...pluginView(getServer(server.id)!), result: r });
    } catch (err) {
      appendLine(server.id, `[Outpost] Plugin install failed: ${(err as Error).message}`, 'stderr');
      throw err;
    }
  }),
);

/** The "Load plugins" switch: off starts CS2 without Metamod — to rule plugins out when a start hangs. */
cs2Router.post(
  '/plugins/loading',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'plugins');
    const server = requireCs2(req.params.serverId);
    const on = !!req.body?.enabled;
    setPluginsLoaded(server, on);
    logAudit(req.auth!.sub, req.auth!.username, on ? 'server.cs2.plugins_on' : 'server.cs2.plugins_off', server.id, '');
    appendLine(server.id, `[Outpost] Plugins switched ${on ? 'on' : 'off'} by ${req.auth!.username} — applies on the next start`, 'system');
    res.json(pluginView(getServer(server.id)!));
  }),
);

cs2Router.get(
  '/plugins/updates',
  asyncHandler(async (req, res) => {
    res.json({ updates: await checkUpdates(requireCs2(req.params.serverId)) });
  }),
);

cs2Router.post(
  '/plugins/:folder/toggle',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'plugins');
    const server = requireCs2(req.params.serverId);
    const enabled = !!req.body?.enabled;
    setPluginEnabled(server, req.params.folder, enabled);
    logAudit(req.auth!.sub, req.auth!.username, enabled ? 'server.cs2.enable_plugin' : 'server.cs2.disable_plugin', server.id, req.params.folder);
    res.json(pluginView(server));
  }),
);

cs2Router.delete(
  '/plugins/:folder',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'plugins');
    const server = requireCs2(req.params.serverId);
    removePlugin(server, req.params.folder);
    logAudit(req.auth!.sub, req.auth!.username, 'server.cs2.remove_plugin', server.id, req.params.folder);
    res.json(pluginView(getServer(server.id)!));
  }),
);
