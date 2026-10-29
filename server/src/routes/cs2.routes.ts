import fs from 'node:fs';
import { rconCommand } from '../services/rconService.js';
import { matchPlan, saveMatch, matchCommands, demoName, demoDirectory, demoPath, demos, playerCommands, parseCs2Status, writeMatchFiles } from '../services/cs2MatchService.js';
import { Router } from 'express';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { requireAuth, requirePermission, requireServerAccess } from '../auth/middleware.js';
import { getServer } from '../services/serverService.js';
import { getServerPermissions, getUserById, logAudit } from '../services/userService.js';
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
import { CATALOG, checkUpdates, frameworkStatus, installFrameworks, installPlugin, listCs2Plugins, removePlugin, setPluginEnabled, setPluginsLoaded, pluginConfigFiles, readPluginConfig, writePluginConfig, revertPluginConfig, useExampleConfig } from '../services/cs2PluginService.js';
import type { Request } from 'express';
import { getPrimaryAddress } from '../services/networkService.js';
import type { ServerRecord } from '../types/index.js';

/** Counter-Strike 2 controls for one instance. Viewing needs access; changes need "settings"; live actions need "console". */
export const cs2Router = Router({ mergeParams: true });
cs2Router.use(requireAuth, (req, res, next) => {
  const user = getUserById(req.auth!.sub);
  if (!user) return res.status(403).json({ error: 'Current account required' });
  req.auth!.role = user.role; next();
}, requireServerAccess());

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

// Plugin configs can hold database passwords and webhooks, so even reading them needs "plugins".
cs2Router.get(
  '/plugins/:folder/configs',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'plugins');
    const server = requireCs2(req.params.serverId);
    res.json({ files: pluginConfigFiles(server, req.params.folder), running: isRunning(server.id) });
  }),
);

cs2Router.get(
  '/plugins/:folder/configs/file',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'plugins');
    res.json(readPluginConfig(requireCs2(req.params.serverId), req.params.folder, String(req.query.path ?? '')));
  }),
);

cs2Router.put(
  '/plugins/:folder/configs/file',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'plugins');
    const server = requireCs2(req.params.serverId);
    const rel = String(req.body?.path ?? '');
    if (typeof req.body?.content !== 'string') throw new HttpError(400, 'content is required');
    writePluginConfig(server, req.params.folder, rel, req.body.content);
    logAudit(req.auth!.sub, req.auth!.username, 'server.cs2.plugin_config', server.id, rel);
    appendLine(server.id, `[Outpost] ${rel} edited by ${req.auth!.username}${isRunning(server.id) ? ' — restart (or reload the plugin) to apply it' : ''}`, 'system');
    res.json(readPluginConfig(server, req.params.folder, rel));
  }),
);

cs2Router.post(
  '/plugins/:folder/configs/revert',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'plugins');
    const server = requireCs2(req.params.serverId);
    const rel = String(req.body?.path ?? '');
    revertPluginConfig(server, req.params.folder, rel);
    logAudit(req.auth!.sub, req.auth!.username, 'server.cs2.plugin_config_revert', server.id, rel);
    res.json(readPluginConfig(server, req.params.folder, rel));
  }),
);

cs2Router.post(
  '/plugins/:folder/configs/use-example',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'plugins');
    const server = requireCs2(req.params.serverId);
    const target = useExampleConfig(server, req.params.folder, String(req.body?.path ?? ''));
    logAudit(req.auth!.sub, req.auth!.username, 'server.cs2.plugin_config', server.id, `created ${target}`);
    res.status(201).json({ created: target, files: pluginConfigFiles(server, req.params.folder) });
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

cs2Router.get('/match', asyncHandler(async (req, res) => { const server = requireCs2(req.params.serverId); res.json({ plan: matchPlan(server.id) }); }));
cs2Router.put('/match', asyncHandler(async (req, res) => { requirePermission(req, 'settings'); const server = requireCs2(req.params.serverId); const plan = saveMatch(server.id, req.body); writeCs2Configs(getServer(server.id)!); logAudit(req.auth!.sub, req.auth!.username, 'cs2.match.save', server.id); res.json({ plan }); }));
cs2Router.post('/match/action', asyncHandler(async (req, res) => { requirePermission(req, 'console'); const server = requireCs2(req.params.serverId); const commands = matchCommands(req.body?.action); writeMatchFiles(server.id); const output = []; for (const command of commands) output.push(await rconCommand(server.id, command)); logAudit(req.auth!.sub, req.auth!.username, 'cs2.match.action', server.id, req.body?.action); res.json({ output }); }));
cs2Router.get('/demos', asyncHandler(async (req, res) => { requirePermission(req, 'files.read'); res.json({ demos: demos(requireCs2(req.params.serverId).id) }); }));
cs2Router.post('/demos/record', asyncHandler(async (req, res) => { requirePermission(req, 'console'); const server = requireCs2(req.params.serverId); const name = demoName(req.body?.name); demoDirectory(server.id); if (demos(server.id).some(d => d.name === `${name}.dem`)) throw new HttpError(409, 'Demo already exists'); const output = await rconCommand(server.id, `tv_record outpost_demos/${name}`); logAudit(req.auth!.sub, req.auth!.username, 'cs2.demo.record', server.id, name); res.json({ output }); }));
cs2Router.post('/demos/stop', asyncHandler(async (req, res) => { requirePermission(req, 'console'); const server = requireCs2(req.params.serverId); const output = await rconCommand(server.id, 'tv_stoprecord'); logAudit(req.auth!.sub, req.auth!.username, 'cs2.demo.stop', server.id); res.json({ output }); }));
cs2Router.get('/demos/:name/download', asyncHandler(async (req, res) => { requirePermission(req, 'files.read'); const server = requireCs2(req.params.serverId); res.download(demoPath(server.id, req.params.name), req.params.name); }));
cs2Router.delete('/demos/:name', asyncHandler(async (req, res) => { requirePermission(req, 'files.write'); const server = requireCs2(req.params.serverId); if (isRunning(server.id)) throw new HttpError(409, 'Stop the server before deleting demos'); fs.unlinkSync(demoPath(server.id, req.params.name)); logAudit(req.auth!.sub, req.auth!.username, 'cs2.demo.delete', server.id, req.params.name); res.status(204).end(); }));
cs2Router.get('/players/status', asyncHandler(async (req, res) => { requirePermission(req, 'players'); const server = requireCs2(req.params.serverId); const raw = await rconCommand(server.id, 'status'); res.json({ players: parseCs2Status(raw), raw }); }));
cs2Router.post('/players/action', asyncHandler(async (req, res) => { requirePermission(req, 'players'); const server = requireCs2(req.params.serverId); const commands = playerCommands(req.body); const output = []; for (const command of commands) output.push(await rconCommand(server.id, command)); logAudit(req.auth!.sub, req.auth!.username, 'cs2.player.action', server.id, JSON.stringify({ action: req.body?.action, userId: req.body?.userId, steamId: req.body?.steamId })); res.json({ output }); }));
