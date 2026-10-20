import { Router, type Request } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { requireAuth, requirePermission, requireRole, requireServerAccess } from '../auth/middleware.js';
import {
  createServerRecord,
  deleteServerRecord,
  getServer,
  listServers,
  setServerJar,
  setServerStatus,
  setDockerConfig,
  setIsolation,
  setLaunchConfig,
  setServerSuspension,
  setServerVersion,
  updateServerRecord,
} from '../services/serverService.js';
import { getPrimaryAddress, listHostAddresses } from '../services/networkService.js';
import { getTransferState, startTransfer } from '../services/nodeService.js';
import { installServer, listAvailableVersions } from '../services/downloadService.js';
import { checkForUpdate, runUpdate } from '../services/updateService.js';
import { forgetHistory } from '../services/consoleHistoryService.js';
import { dropAllForServer } from '../services/databaseService.js';
import { getTemplate, instantiate, resolveVariables, writeTemplateFiles, type OutpostTemplate, type TemplateInstance } from '../services/templateService.js';
import { saveRcon } from '../services/rconService.js';
import { resolveModpack, searchModpacks, type ModpackRef } from '../services/moddedService.js';
import { setModpack } from '../services/serverService.js';
import { autoUpdateBusy, autoUpdateOf, autoUpdateSupport, forgetAutoUpdate, runAutoUpdate, saveAutoUpdate, SCHEDULES } from '../services/autoUpdateService.js';
import { writeEula, readServerProperties, writeServerProperties } from '../services/propertiesService.js';
import {
  getRuntimeInfo,
  getLogBuffer,
  isRunning,
  sendCommand,
  startServer,
  stopServer,
  restartServer,
  buildLaunch,
  cancelAutoRestart,
  getAutoRestartState,
  launchSandboxed,
} from '../services/processManager.js';
import { getPlayerRoster } from '../services/playerService.js';
import {
  getEffectiveCreation,
  getServerPermissions,
  getUserById,
  getUserServerAccess,
  grantOwnerAccess,
  logAudit,
  setServerOwner,
  usernamesFor,
} from '../services/userService.js';
import { publish, consoleTopic } from '../services/wsHub.js';
import { appendLine } from '../services/consoleLogService.js';
import { findJava, getJavaVersion } from '../services/javaService.js';
import { getDiskUsage } from '../services/diskUsageService.js';
import { instanceDir, safeJoin } from '../utils/paths.js';
import { forgetServerSchedules } from '../services/schedulerService.js';
import { wantsWindowsBuild, wineStatus } from '../services/wineService.js';
import { instancePortProtocol } from '../services/portProtocol.js';
import { STEAM_GAME_PRESETS, findPreset, findPresetById, findPresetFor } from '../services/steamGames.js';
import { isMinecraftPlatform, type Loader, type Platform, type ServerRecord } from '../types/index.js';
import { sanitizeLaunchConfig, launchConfigOf, launchVariables, resolveExecutable, ensureExecutable } from '../services/launchConfig.js';
import { getOnlinePlayers } from '../services/playerService.js';
import { dockerConfigOf, enforceContainerPolicy, getEngineStatus, pullImage, sanitizeDockerConfig } from '../services/containerService.js';
import { findTemplate } from '../services/catalogService.js';

export const serversRouter = Router();
serversRouter.use(requireAuth);


/**
 * Runs (or re-runs) a server's install in the background, streaming verbose progress over the
 * console websocket topic the same way `npm install --verbose` streams to a terminal. Shared by
 * the initial create flow and the retry-install endpoint so both behave identically.
 *
 * For a custom (non-preset) Steam App ID, `jar_file` must already hold the intended relative
 * executable path *before* this runs (set at creation time) — installServer's steam branch has
 * no way to know it, so this only verifies the file actually exists afterward.
 */
async function runServerInstall(server: ServerRecord, afterInstall?: () => void): Promise<void> {
  if (server.platform === 'docker') {
    // "Installing" a Docker instance = pulling its image.
    try {
      publish(consoleTopic(server.id), { type: 'install_progress', pct: 5, message: `Pulling ${server.version}` });
      await pullImage(server.version, (line) => appendLine(server.id, line));
      appendLine(server.id, '[Outpost] Image ready — the instance can start');
      setServerStatus(server.id, 'stopped');
      publish(consoleTopic(server.id), { type: 'status', status: 'stopped' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendLine(server.id, `[Outpost] Image pull failed: ${message}`, 'stderr');
      setServerStatus(server.id, 'install_failed');
      publish(consoleTopic(server.id), { type: 'status', status: 'install_failed', error: message });
    }
    return;
  }
  try {
    const result = await installServer(
      server.platform,
      server.loader,
      server.version,
      instanceDir(server.id),
      (pct, message) => publish(consoleTopic(server.id), { type: 'install_progress', pct, message }),
      (line) => appendLine(server.id, line),
      server.platform === 'steam' ? server.steam_app_id ?? undefined : undefined,
      server.steam_login,
      server.steam_extra_flags,
      server.steam_preset,
      wantsWindowsBuild(server, launchConfigOf(server), !!findPresetFor(server)?.windowsOnly),
      { modpack: server.modpack ? (JSON.parse(server.modpack) as ModpackRef) : null }
    );

    const preset = server.platform === 'steam' ? findPresetFor(server) : undefined;
    if (server.platform === 'steam' && !preset) {
      if (!server.jar_file) throw new Error('No custom executable path is recorded for this server');
      const exePath = safeJoin(instanceDir(server.id), server.jar_file);
      if (!fs.existsSync(exePath)) {
        throw new Error(`Custom executable not found after install: ${server.jar_file}`);
      }
      if (process.platform !== 'win32') {
        try {
          fs.chmodSync(exePath, 0o755);
        } catch {
          // best-effort; startup will surface a clear error if the file truly can't be executed
        }
      }
    } else if (result.jarFile) {
      setServerJar(server.id, result.jarFile, result.build);
    } else if (result.executable) {
      setServerJar(server.id, result.executable, result.build);
    }

    if (afterInstall) {
      try {
        afterInstall();
      } catch (err) {
        appendLine(server.id, `[Outpost] Couldn’t apply the template’s files: ${err instanceof Error ? err.message : String(err)}`, 'stderr');
      }
    }
    appendLine(server.id, '[Outpost] Installation finished — server is ready to start');
    setServerStatus(server.id, 'stopped');
    publish(consoleTopic(server.id), { type: 'status', status: 'stopped' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendLine(server.id, `[Outpost] Installation failed: ${message}`, 'stderr');
    setServerStatus(server.id, 'install_failed');
    publish(consoleTopic(server.id), { type: 'status', status: 'install_failed', error: message });
  }
}

serversRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const allowed = req.auth!.role === 'admin' ? null : new Set(getUserServerAccess(req.auth!.sub));
    const visible = listServers().filter((s) => !allowed || allowed.has(s.id));
    // Light per-instance metrics for the instance list (suspended ones stay opaque to non-admins).
    const metrics = Object.fromEntries(
      visible
        .filter((s) => req.auth!.role === 'admin' || !s.suspended)
        .map((s) => [
          s.id,
          { runtime: getRuntimeInfo(s.id), playersOnline: isMinecraftPlatform(s.platform) ? getOnlinePlayers(s.id).length : null },
        ])
    );
    const owners = usernamesFor(visible.map((s) => s.created_by).filter((id): id is string => !!id));
    res.json({ servers: visible, metrics, owners });
  })
);

serversRouter.get(
  '/catalog/versions',
  asyncHandler(async (req, res) => {
    const loader = req.query.loader as Loader;
    if (!['vanilla', 'paper', 'purpur', 'spigot', 'fabric', 'quilt', 'forge', 'neoforge', 'mohist', 'spongeforge', 'bedrock', 'steam'].includes(loader)) {
      throw new HttpError(400, 'Unknown server type');
    }
    const versions = await listAvailableVersions(loader);
    res.json({ versions });
  })
);

serversRouter.get(
  '/catalog/steam-games',
  asyncHandler(async (_req, res) => {
    res.json({
      // Only games whose server runs on this host's OS.
      games: STEAM_GAME_PRESETS.filter((p) => !p.hosts || p.hosts.includes(process.platform)).map(({ id, label, appId, defaultPort, portProtocol, notes }) => ({
        id,
        label,
        appId,
        defaultPort,
        portProtocol,
        notes: notes ?? null,
      })),
    });
  })
);

/** Modrinth modpacks, for New instance → Modpack. */
serversRouter.get(
  '/catalog/modpacks',
  asyncHandler(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : '';
    try {
      res.json({ modpacks: await searchModpacks(q) });
    } catch (err) {
      throw new HttpError(502, err instanceof Error ? err.message : 'Modrinth search failed');
    }
  })
);

/** Whether Wine (and Xvfb) are available on this host — for the launch settings and Configuration. */
serversRouter.get(
  '/wine/status',
  asyncHandler(async (_req, res) => {
    res.json(wineStatus());
  })
);

serversRouter.get(
  '/catalog/java',
  asyncHandler(async (_req, res) => {
    const javaPath = await findJava();
    const version = await getJavaVersion();
    res.json({ available: !!javaPath, path: javaPath, version });
  })
);

serversRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    // Creating from a template: its settings (variables filled in) are the defaults; what the
    // person typed (name, port, memory, EULA, Steam login) wins. Everything below still applies.
    let fromTemplate: { tpl: OutpostTemplate; vars: Record<string, string>; inst: TemplateInstance } | null = null;
    if (typeof req.body?.templateId === 'string') {
      const tpl = getTemplate(req.body.templateId);
      if (!tpl) throw new HttpError(404, 'Template not found');
      const vars = resolveVariables(tpl, req.body.variables);
      const inst = instantiate(tpl, vars);
      const given = Object.fromEntries(
        ['name', 'serverPort', 'minMemoryMb', 'maxMemoryMb', 'acceptEula', 'steamLogin'].filter((k) => req.body[k] !== undefined && req.body[k] !== '').map((k) => [k, req.body[k]])
      );
      req.body = {
        platform: inst.platform,
        loader: inst.loader,
        version: inst.version,
        minMemoryMb: inst.minMemoryMb,
        maxMemoryMb: inst.maxMemoryMb,
        serverPort: inst.defaultPort,
        extraArgs: inst.extraArgs,
        extraJavaArgs: inst.extraJavaArgs,
        steamAppId: inst.steamAppId ?? undefined,
        steamPreset: inst.steamPreset ?? undefined,
        steamExtraFlags: inst.steamExtraFlags,
        customExecutable: inst.customExecutable ?? undefined,
        launch: inst.launch,
        docker: inst.docker ?? undefined,
        ...given,
      };
      fromTemplate = { tpl, vars, inst };
    }
    let modpackRef: ModpackRef | null = null;
    if (req.body?.modpack && typeof req.body.modpack === 'object') {
      let pack: Awaited<ReturnType<typeof resolveModpack>>;
      try {
        pack = await resolveModpack(String(req.body.modpack.projectId ?? ''), req.body.modpack.versionId ? String(req.body.modpack.versionId) : undefined);
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : 'Couldn’t read that modpack');
      }
      modpackRef = pack.ref;
      req.body = { ...req.body, platform: 'java', loader: pack.loader, version: pack.mc };
    }
    const {
      name,
      platform,
      loader,
      version,
      minMemoryMb,
      maxMemoryMb,
      serverPort,
      extraJavaArgs,
      extraArgs,
      acceptEula,
      steamPreset,
      customExecutable,
      steamLogin,
      steamExtraFlags,
    } = req.body ?? {};
    let { steamAppId } = req.body ?? {};
    // A curated game can be picked by preset id (needed when presets share an App ID).
    const chosenPreset = platform === 'steam' && typeof steamPreset === 'string' && steamPreset ? findPresetById(steamPreset) : undefined;
    if (platform === 'steam' && typeof steamPreset === 'string' && steamPreset && !chosenPreset) throw new HttpError(400, `Unknown game preset: ${steamPreset}`);
    if (chosenPreset) steamAppId = chosenPreset.appId;
    if (chosenPreset?.hosts && !chosenPreset.hosts.includes(process.platform)) {
      throw new HttpError(400, `${chosenPreset.label} servers only run on ${chosenPreset.hosts.join(' / ')} hosts`);
    }

    if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, 'Server name is required');

    // Account-level creation policy: may this user create instances, of this kind, this big, this many?
    const creation = getEffectiveCreation(req.auth!.sub, req.auth!.role);
    if (!creation.canCreate) throw new HttpError(403, "Your account can't create instances — ask an admin");
    if (typeof platform === 'string' && !creation.allowedPlatforms.includes(platform)) {
      throw new HttpError(
        403,
        platform === 'custom'
          ? 'Only admins can create custom instances'
          : platform === 'docker'
            ? "Your account can't create container instances — an admin can allow catalog apps or any image under Users"
            : `Your account can't create ${platform} instances`
      );
    }
    if (creation.maxInstances && creation.owned >= creation.maxInstances) {
      throw new HttpError(403, `You already own ${creation.owned} of your ${creation.maxInstances} allowed instances`);
    }
    if (creation.maxMemoryMb && (Number(maxMemoryMb) || 2048) > creation.maxMemoryMb) {
      throw new HttpError(400, `Max memory is limited to ${creation.maxMemoryMb} MB per instance for your account`);
    }
    if (!['java', 'bedrock', 'steam', 'custom', 'docker'].includes(platform)) throw new HttpError(400, 'Invalid platform');
    if (!['vanilla', 'paper', 'purpur', 'spigot', 'fabric', 'quilt', 'forge', 'neoforge', 'mohist', 'spongeforge', 'bedrock', 'steam', 'custom', 'docker'].includes(loader)) {
      throw new HttpError(400, 'Invalid loader');
    }
    if (platform !== 'docker' && (typeof version !== 'string' || !version)) throw new HttpError(400, 'Version is required');
    if (platform === 'java' && acceptEula !== true) {
      throw new HttpError(400, "You must accept Mojang's EULA to create a Java server");
    }

    // Custom instances run an arbitrary binary/script on this host, so only admins may create them.
    let launchConfig: string | null = null;
    if (platform === 'custom') {
      if (req.auth!.role !== 'admin') throw new HttpError(403, 'Only admins can create custom instances');
      launchConfig = JSON.stringify(sanitizeLaunchConfig(req.body?.launch ?? {}, { isAdmin: true, platform: 'custom' }));
    }

    // Container instances follow the user's container permission (none / catalog apps / any image,
    // plus engine-socket access for Portainer); admins can do anything.
    let dockerConfig: string | null = null;
    let dockerImage: string | null = null;
    if (platform === 'docker') {
      const engine = getEngineStatus(true);
      if (!engine.available) throw new HttpError(400, `${engine.error}${engine.hint ? ` — ${engine.hint}` : ''}`);
      const cfg = enforceContainerPolicy(sanitizeDockerConfig(req.body?.docker), creation, req.auth!.role === 'admin', findTemplate);
      dockerConfig = JSON.stringify(cfg);
      dockerImage = cfg.image;
    }

    let preset: ReturnType<typeof findPreset> | undefined;
    if (platform === 'steam') {
      if (typeof steamAppId !== 'string' || !/^\d+$/.test(steamAppId)) {
        throw new HttpError(400, 'steamAppId is required for Steam servers and must be a numeric Steam App ID');
      }
      preset = chosenPreset ?? findPreset(steamAppId);
      if (!preset && (typeof customExecutable !== 'string' || !customExecutable.trim())) {
        throw new HttpError(400, "customExecutable is required when steamAppId isn't one of the curated presets");
      }
      if (!preset) {
        // Traversal check only — the real instance directory doesn't exist yet, but safeJoin's
        // escape check is purely path math and works against any base.
        try {
          safeJoin(instanceDir('__validate__'), customExecutable.trim());
        } catch {
          throw new HttpError(400, 'customExecutable must be a relative path inside the server directory');
        }
      }
    }

    if (platform === 'steam' && req.body?.wine === true) {
      launchConfig = JSON.stringify({ wine: { mode: 'always' } });
    }
    if (fromTemplate?.inst.launch && platform !== 'custom' && platform !== 'docker') {
      const cfg = sanitizeLaunchConfig(fromTemplate.inst.launch, { isAdmin: req.auth!.role === 'admin', platform: platform as Platform });
      launchConfig = Object.keys(cfg).length ? JSON.stringify(cfg) : null;
    }

    const record = createServerRecord({
      name: name.trim(),
      platform: platform as Platform,
      loader: loader as Loader,
      version: dockerImage ?? version,
      minMemoryMb: Number(minMemoryMb) || 1024,
      maxMemoryMb: Number(maxMemoryMb) || 2048,
      serverPort:
        (dockerConfig ? JSON.parse(dockerConfig).ports[0].host : 0) || Number(serverPort) || preset?.defaultPort || (platform === 'bedrock' ? 19132 : 25565),
      extraJavaArgs: typeof extraJavaArgs === 'string' ? extraJavaArgs : '',
      extraArgs: typeof extraArgs === 'string' ? extraArgs : '',
      createdBy: req.auth!.sub,
      steamAppId: platform === 'steam' ? steamAppId : null,
      steamPreset: platform === 'steam' ? preset?.id ?? null : null,
      steamLogin: platform === 'steam' && typeof steamLogin === 'string' && steamLogin.trim() ? steamLogin.trim() : 'anonymous',
      steamExtraFlags: platform === 'steam' && typeof steamExtraFlags === 'string' ? steamExtraFlags.trim() : '',
      launchConfig,
      dockerConfig,
    });

    if (modpackRef) {
      setModpack(record.id, JSON.stringify(modpackRef));
      record.modpack = JSON.stringify(modpackRef);
      appendLine(record.id, `[Outpost] Modpack: ${modpackRef.title} ${modpackRef.versionNumber} (Modrinth)`);
    }

    if (platform === 'steam' && !preset && typeof customExecutable === 'string') {
      // Custom (non-preset) App ID: installServer has no way to know the intended launch
      // executable itself, so persist the user-supplied relative path now — before install even
      // runs — so it survives a failed install and any later retry, not just a successful one.
      setServerJar(record.id, customExecutable.trim(), null);
      record.jar_file = customExecutable.trim();
    }

    appendLine(record.id, `[Outpost] Creating server "${record.name}" (${loader} ${version}, ${platform})`);
    if (platform === 'java') {
      writeEula(record.id, true);
      appendLine(record.id, "[Outpost] Wrote eula.txt (eula=true, accepted by user at creation)");
    }

    // Tie the instance to its creator: non-admins can only see instances they're assigned to.
    if (req.auth!.role !== 'admin') grantOwnerAccess(req.auth!.sub, record.id);
    logAudit(req.auth!.sub, req.auth!.username, 'server.create', record.id, `${loader} ${version}${fromTemplate ? ` from template “${fromTemplate.tpl.name}”` : ''}`);

    let afterInstall: (() => void) | undefined;
    if (fromTemplate) {
      const { tpl, vars, inst } = fromTemplate;
      appendLine(record.id, `[Outpost] Using template “${tpl.name}”${tpl.author ? ` by ${tpl.author}` : ''}`);
      if (inst.autoUpdate) {
        try {
          saveAutoUpdate(record, inst.autoUpdate as Record<string, unknown>);
        } catch (err) {
          appendLine(record.id, `[Outpost] Template’s automatic updates skipped: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (inst.rcon?.enabled) {
        try {
          saveRcon(getServer(record.id)!, { ...inst.rcon, generatePassword: true });
          appendLine(record.id, '[Outpost] RCON turned on with a new password (Configuration → RCON console)');
        } catch (err) {
          appendLine(record.id, `[Outpost] Template’s RCON settings skipped: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (tpl.files.length) {
        // After the install, so the game's own files don't overwrite the template's configs.
        afterInstall = () => {
          writeTemplateFiles(record.id, tpl, vars);
          appendLine(record.id, `[Outpost] Wrote ${tpl.files.length} file(s) from the template: ${tpl.files.map((f) => f.path).join(', ')}`);
        };
      }
    }

    if (platform === 'custom') {
      // Nothing to download: the user brings the files (File Management) or points at a host binary.
      afterInstall?.();
      setServerStatus(record.id, 'stopped');
      appendLine(record.id, '[Outpost] Custom instance created — upload your server files in File Management, then start it.');
      return res.status(201).json({ server: getServer(record.id) });
    }

    res.status(201).json({ server: getServer(record.id) ?? record });
    void runServerInstall(getServer(record.id) ?? record, afterInstall);
  })
);

serversRouter.post(
  '/:serverId/retry-install',
  requireServerAccess(),
  asyncHandler(async (req, res) => {
    requirePermission(req, 'power');
    const server = getServer(req.params.serverId);
    if (!server) throw new HttpError(404, 'Server not found');
    if (server.status !== 'install_failed') {
      throw new HttpError(409, 'Retry is only available after a failed install');
    }
    if (server.platform === 'custom') throw new HttpError(409, 'Custom instances have no install step');

    setServerStatus(server.id, 'installing');
    publish(consoleTopic(server.id), { type: 'status', status: 'installing' });
    appendLine(server.id, `[Outpost] Retrying installation (requested by ${req.auth!.username})`);
    logAudit(req.auth!.sub, req.auth!.username, 'server.retry_install', server.id);
    res.status(202).json({ ok: true });

    void runServerInstall(server);
  })
);

serversRouter.get(
  '/:serverId',
  requireServerAccess(),
  asyncHandler(async (req, res) => {
    const server = getServer(req.params.serverId);
    if (!server) throw new HttpError(404, 'Server not found');
    res.json({
      server,
      runtime: getRuntimeInfo(server.id),
      running: isRunning(server.id),
      permissions: getServerPermissions(req.auth!.sub, req.auth!.role, server.id) ?? [],
      autoRestart: getAutoRestartState(server.id),
      owner: server.created_by ? { id: server.created_by, username: getUserById(server.created_by)?.username ?? 'unknown' } : null,
    });
  })
);

/** Where players connect: the bind address from server.properties if one is set, otherwise the
 *  host's primary LAN address (the server listens on every interface). */
serversRouter.get(
  '/:serverId/endpoint',
  requireServerAccess(),
  asyncHandler(async (req, res) => {
    const server = getServer(req.params.serverId);
    if (!server) throw new HttpError(404, 'Server not found');
    const props = isMinecraftPlatform(server.platform) ? readServerProperties(server.id, server.platform) : [];
    const bind = props.find((p) => p.key === 'server-ip')?.value.trim() ?? '';
    const wildcard = !bind || bind === '0.0.0.0' || bind === '::';
    const primary = await getPrimaryAddress();
    const protocol = instancePortProtocol(server);
    const host = wildcard ? primary ?? '127.0.0.1' : bind;
    const web = server.platform === 'docker' ? dockerConfigOf(server)?.webUi : server.platform === 'custom' ? launchConfigOf(server).webUi : undefined;
    res.json({
      webUrl: web ? `${web.scheme}://${host}:${web.port}${web.path}` : null,
      host: wildcard ? primary ?? '127.0.0.1' : bind,
      bindAddress: wildcard ? '0.0.0.0' : bind,
      port: server.server_port,
      protocol,
      hostname: os.hostname(),
      addresses: listHostAddresses(),
    });
  })
);

/** The instance's launch config plus a preview of the exact command it resolves to. */
serversRouter.get(
  '/:serverId/launch',
  requireServerAccess(),
  asyncHandler(async (req, res) => {
    const server = getServer(req.params.serverId);
    if (!server) throw new HttpError(404, 'Server not found');
    let preview: string | null = null;
    let previewError: string | null = null;
    try {
      preview = (await buildLaunch(server)).display;
    } catch (err) {
      previewError = err instanceof Error ? err.message : String(err);
    }
    res.json({ config: launchConfigOf(server), preview, previewError, variables: launchVariables(server), sandboxed: launchSandboxed(server) });
  })
);

serversRouter.put(
  '/:serverId/launch',
  requireServerAccess(),
  asyncHandler(async (req, res) => {
    requirePermission(req, 'launch');
    const server = getServer(req.params.serverId);
    if (!server) throw new HttpError(404, 'Server not found');
    const config = sanitizeLaunchConfig(req.body?.config ?? {}, { isAdmin: req.auth!.role === 'admin', platform: server.platform });
    setLaunchConfig(server.id, Object.keys(config).length ? JSON.stringify(config) : null);
    if (config.executable && !config.useShell) ensureExecutable(resolveExecutable(server, config.executable));
    appendLine(server.id, `[Outpost] Launch settings changed by ${req.auth!.username} — they apply on the next start`, 'system');
    logAudit(req.auth!.sub, req.auth!.username, 'server.launch.update', server.id, JSON.stringify(config).slice(0, 500));
    const updated = getServer(server.id)!;
    let preview: string | null = null;
    let previewError: string | null = null;
    try {
      preview = (await buildLaunch(updated)).display;
    } catch (err) {
      previewError = err instanceof Error ? err.message : String(err);
    }
    res.json({ config, preview, previewError, server: updated });
  })
);

/** Container settings for a Docker instance (admin-only to change: they decide what runs on the host). */
serversRouter.get(
  '/:serverId/docker',
  requireServerAccess(),
  asyncHandler(async (req, res) => {
    const server = getServer(req.params.serverId);
    if (!server) throw new HttpError(404, 'Server not found');
    if (server.platform !== 'docker') throw new HttpError(400, 'Not a Docker instance');
    res.json({ config: dockerConfigOf(server), engine: getEngineStatus() });
  })
);

serversRouter.put(
  '/:serverId/docker',
  requireServerAccess(),
  asyncHandler(async (req, res) => {
    const server = getServer(req.params.serverId);
    if (!server) throw new HttpError(404, 'Server not found');
    if (server.platform !== 'docker') throw new HttpError(400, 'Not a Docker instance');
    // Owners / users with Configuration rights may edit, within their container permission.
    if (req.auth!.role !== 'admin') requirePermission(req, 'settings');
    const policy = getEffectiveCreation(req.auth!.sub, req.auth!.role);
    const config = enforceContainerPolicy(sanitizeDockerConfig(req.body?.config), policy, req.auth!.role === 'admin', findTemplate);
    setDockerConfig(server.id, JSON.stringify(config), config.image);
    updateServerRecord(server.id, { serverPort: config.ports[0].host });
    appendLine(server.id, `[Outpost] Container settings changed by ${req.auth!.username} — they apply on the next start`, 'system');
    logAudit(req.auth!.sub, req.auth!.username, 'server.docker.update', server.id, config.image);
    res.json({ config, server: getServer(server.id) });
  })
);

/** Hands an instance to another user (or back to "no owner"); the new owner gets owner access. */
serversRouter.patch(
  '/:serverId/owner',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const server = getServer(req.params.serverId);
    if (!server) throw new HttpError(404, 'Server not found');
    const { userId } = req.body ?? {};
    if (userId !== null && typeof userId !== 'string') throw new HttpError(400, 'userId must be a user id or null');
    const user = userId ? getUserById(userId) : null;
    if (userId && !user) throw new HttpError(404, 'User not found');
    setServerOwner(server.id, user?.id ?? null);
    if (user && user.role !== 'admin') grantOwnerAccess(user.id, server.id);
    logAudit(req.auth!.sub, req.auth!.username, 'server.owner', server.id, user?.username ?? 'none');
    res.json({ owner: user ? { id: user.id, username: user.username } : null });
  })
);

/** Suspension: stops the instance and locks it to admins only (see requireServerAccess). */
serversRouter.post(
  '/:serverId/suspend',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const server = getServer(req.params.serverId);
    if (!server) throw new HttpError(404, 'Server not found');
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : '';
    setServerSuspension(server.id, true, reason || null, req.auth!.username);
    cancelAutoRestart(server.id, 'instance suspended');
    if (isRunning(server.id)) {
      appendLine(server.id, `[Outpost] Instance suspended by ${req.auth!.username} — stopping`, 'system');
      stopServer(server.id, { force: req.body?.force === true });
    }
    logAudit(req.auth!.sub, req.auth!.username, 'server.suspend', server.id, reason);
    res.json({ server: getServer(server.id) });
  })
);

serversRouter.post(
  '/:serverId/unsuspend',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const server = getServer(req.params.serverId);
    if (!server) throw new HttpError(404, 'Server not found');
    setServerSuspension(server.id, false, null, null);
    appendLine(server.id, `[Outpost] Suspension lifted by ${req.auth!.username}`, 'system');
    logAudit(req.auth!.sub, req.auth!.username, 'server.unsuspend', server.id);
    res.json({ server: getServer(server.id) });
  })
);

serversRouter.post(
  '/:serverId/transfer',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { nodeId, deleteSource } = req.body ?? {};
    if (typeof nodeId !== 'string') throw new HttpError(400, 'nodeId is required');
    const state = startTransfer(req.params.serverId, nodeId, deleteSource === true);
    logAudit(req.auth!.sub, req.auth!.username, 'server.transfer', req.params.serverId, `to node ${nodeId}`);
    res.status(202).json({ transfer: state });
  })
);

serversRouter.get(
  '/:serverId/transfer',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    res.json({ transfer: getTransferState(req.params.serverId) });
  })
);

serversRouter.patch(
  '/:serverId',
  requireServerAccess(),
  asyncHandler(async (req, res) => {
    requirePermission(req, 'settings');
    const server = getServer(req.params.serverId);
    if (!server) throw new HttpError(404, 'Server not found');
    const {
      name,
      minMemoryMb,
      maxMemoryMb,
      serverPort,
      extraJavaArgs,
      extraArgs,
      autoStart,
      steamLogin,
      steamExtraFlags,
      restartPolicy,
      restartDelaySec,
      restartMaxAttempts,
      isolation,
    } = req.body ?? {};
    if (isolation !== undefined) {
      if (isolation !== 'inherit' && isolation !== 'off') throw new HttpError(400, 'isolation must be inherit or off');
      if (isolation === 'off' && req.auth!.role !== 'admin') throw new HttpError(403, 'Only admins can turn off sandboxing for an instance');
      setIsolation(server.id, isolation);
    }
    if (restartPolicy !== undefined && !['never', 'on-crash', 'always'].includes(restartPolicy)) {
      throw new HttpError(400, 'restartPolicy must be never, on-crash or always');
    }
    const clampInt = (v: unknown, min: number, max: number) =>
      v === undefined || v === null || v === '' ? undefined : Math.min(Math.max(Math.round(Number(v)) || 0, min), max);
    updateServerRecord(server.id, {
      name,
      minMemoryMb: minMemoryMb !== undefined ? Number(minMemoryMb) : undefined,
      maxMemoryMb: maxMemoryMb !== undefined ? Number(maxMemoryMb) : undefined,
      serverPort: serverPort !== undefined ? Number(serverPort) : undefined,
      extraJavaArgs,
      extraArgs,
      autoStart,
      steamLogin: typeof steamLogin === 'string' ? steamLogin : undefined,
      steamExtraFlags: typeof steamExtraFlags === 'string' ? steamExtraFlags : undefined,
      restartPolicy,
      restartDelaySec: clampInt(restartDelaySec, 1, 3600),
      restartMaxAttempts: clampInt(restartMaxAttempts, 0, 10_000),
    });
    if (restartPolicy === 'never') cancelAutoRestart(server.id);
    logAudit(req.auth!.sub, req.auth!.username, 'server.update', server.id);
    res.json({ server: getServer(server.id) });
  })
);

serversRouter.delete(
  '/:serverId',
  requireServerAccess(),
  asyncHandler(async (req, res, next) => {
    // Admins and the instance's owner may delete it.
    const target = getServer(req.params.serverId);
    if (req.auth!.role !== 'admin' && target?.created_by !== req.auth!.sub) {
      throw new HttpError(403, 'Only admins and the instance’s owner can delete it');
    }
    next();
  }),
  asyncHandler(async (req, res) => {
    const server = getServer(req.params.serverId);
    if (!server) throw new HttpError(404, 'Server not found');
    if (isRunning(server.id)) throw new HttpError(409, 'Stop the server before deleting it');
    cancelAutoRestart(server.id);
    forgetServerSchedules(server.id);
    forgetAutoUpdate(server.id);
    forgetHistory(server.id);
    void dropAllForServer(server.id);
    deleteServerRecord(server.id);
    logAudit(req.auth!.sub, req.auth!.username, 'server.delete', server.id);
    res.status(204).end();
  })
);

serversRouter.post(
  '/:serverId/start',
  requireServerAccess(),
  asyncHandler(async (req, res) => {
    requirePermission(req, 'power');
    await startServer(req.params.serverId);
    logAudit(req.auth!.sub, req.auth!.username, 'server.start', req.params.serverId);
    res.status(202).json({ ok: true });
  })
);

serversRouter.post(
  '/:serverId/stop',
  requireServerAccess(),
  asyncHandler(async (req, res) => {
    requirePermission(req, 'power');
    stopServer(req.params.serverId, { force: req.body?.force === true });
    logAudit(req.auth!.sub, req.auth!.username, 'server.stop', req.params.serverId);
    res.status(202).json({ ok: true });
  })
);

serversRouter.post(
  '/:serverId/restart',
  requireServerAccess(),
  asyncHandler(async (req, res) => {
    requirePermission(req, 'power');
    const serverId = req.params.serverId;
    await restartServer(serverId);
    logAudit(req.auth!.sub, req.auth!.username, 'server.restart', serverId);
    res.status(202).json({ ok: true });
  })
);

serversRouter.post(
  '/:serverId/command',
  requireServerAccess(),
  asyncHandler(async (req, res) => {
    requirePermission(req, 'console');
    const { command } = req.body ?? {};
    if (typeof command !== 'string' || !command.trim()) throw new HttpError(400, 'Command is required');
    sendCommand(req.params.serverId, command);
    logAudit(req.auth!.sub, req.auth!.username, 'server.command', req.params.serverId, command.trim().slice(0, 500));
    res.status(202).json({ ok: true });
  })
);

serversRouter.get(
  '/:serverId/console/history',
  requireServerAccess(),
  asyncHandler(async (req, res) => {
    res.json({ lines: getLogBuffer(req.params.serverId) });
  })
);

serversRouter.get(
  '/:serverId/players',
  requireServerAccess(),
  asyncHandler(async (req, res) => {
    const server = getServer(req.params.serverId);
    if (!server) throw new HttpError(404, 'Server not found');
    if (!isMinecraftPlatform(server.platform)) throw new HttpError(400, 'Only Minecraft instances have a player roster');
    res.json({ players: getPlayerRoster(req.params.serverId) });
  })
);

const PLAYER_ACTIONS: Record<string, (name: string, arg?: string) => string> = {
  op: (name) => `op ${name}`,
  deop: (name) => `deop ${name}`,
  'whitelist-add': (name) => `whitelist add ${name}`,
  'whitelist-remove': (name) => `whitelist remove ${name}`,
  ban: (name, reason) => `ban ${name}${reason ? ' ' + reason : ''}`,
  pardon: (name) => `pardon ${name}`,
  kick: (name, reason) => `kick ${name}${reason ? ' ' + reason : ''}`,
};

serversRouter.post(
  '/:serverId/players/:name/:action',
  requireServerAccess(),
  asyncHandler(async (req, res) => {
    requirePermission(req, 'players');
    const { serverId, name, action } = req.params;
    const server = getServer(serverId);
    if (!server) throw new HttpError(404, 'Server not found');
    if (!isMinecraftPlatform(server.platform)) throw new HttpError(400, 'Only Minecraft instances have operator/player commands');
    const builder = PLAYER_ACTIONS[action];
    if (!builder) throw new HttpError(400, `Unknown player action: ${action}`);
    if (!isRunning(serverId)) {
      throw new HttpError(409, 'Start the server to manage players (actions are applied via the live console)');
    }
    sendCommand(serverId, builder(name, req.body?.reason));
    logAudit(req.auth!.sub, req.auth!.username, `player.${action}`, serverId, name);
    res.status(202).json({ ok: true });
  })
);

serversRouter.get(
  '/:serverId/properties',
  requireServerAccess(),
  asyncHandler(async (req, res) => {
    const server = getServer(req.params.serverId);
    if (!server) throw new HttpError(404, 'Server not found');
    res.json({ properties: readServerProperties(server.id, server.platform) });
  })
);

serversRouter.put(
  '/:serverId/properties',
  requireServerAccess(),
  asyncHandler(async (req, res) => {
    requirePermission(req, 'settings');
    const server = getServer(req.params.serverId);
    if (!server) throw new HttpError(404, 'Server not found');
    const { updates } = req.body ?? {};
    if (!updates || typeof updates !== 'object') throw new HttpError(400, 'updates object is required');
    writeServerProperties(server.id, server.platform, updates);
    logAudit(req.auth!.sub, req.auth!.username, 'server.properties.update', server.id);
    res.json({ properties: readServerProperties(server.id, server.platform) });
  })
);

serversRouter.get(
  '/:serverId/resources',
  requireServerAccess(),
  asyncHandler(async (req, res) => {
    const server = getServer(req.params.serverId);
    if (!server) throw new HttpError(404, 'Server not found');
    const disk = getDiskUsage(server.id);
    res.json({
      runtime: getRuntimeInfo(server.id),
      running: isRunning(server.id),
      disk,
      host: {
        totalMemMb: Math.round(os.totalmem() / (1024 * 1024)),
        freeMemMb: Math.round(os.freemem() / (1024 * 1024)),
        cpuCores: os.cpus().length,
        loadAvg: process.platform === 'win32' ? null : os.loadavg()[0],
      },
    });
  })
);

function autoUpdateView(server: ServerRecord) {
  return { config: autoUpdateOf(server), support: autoUpdateSupport(server), schedules: SCHEDULES, busy: autoUpdateBusy(server.id) };
}

serversRouter.get(
  '/:serverId/auto-update',
  requireServerAccess(),
  asyncHandler(async (req, res) => {
    const server = getServer(req.params.serverId);
    if (!server) throw new HttpError(404, 'Server not found');
    res.json(autoUpdateView(server));
  })
);

serversRouter.put(
  '/:serverId/auto-update',
  requireServerAccess(),
  asyncHandler(async (req, res) => {
    requirePermission(req, 'update');
    const server = getServer(req.params.serverId);
    if (!server) throw new HttpError(404, 'Server not found');
    const cfg = saveAutoUpdate(server, (req.body ?? {}) as Record<string, unknown>);
    logAudit(req.auth!.sub, req.auth!.username, 'server.auto_update', server.id, JSON.stringify({ enabled: cfg.enabled, schedule: cfg.schedule, notifyOnly: cfg.notifyOnly }));
    res.json(autoUpdateView(getServer(server.id)!));
  })
);

/** Checks now and, if there's an update, applies it the same way the schedule would. Runs in the background. */
serversRouter.post(
  '/:serverId/auto-update/run',
  requireServerAccess(),
  asyncHandler(async (req, res) => {
    requirePermission(req, 'update');
    const server = getServer(req.params.serverId);
    if (!server) throw new HttpError(404, 'Server not found');
    if (autoUpdateBusy(server.id)) throw new HttpError(409, 'Already checking or updating');
    logAudit(req.auth!.sub, req.auth!.username, 'server.auto_update.run', server.id);
    void runAutoUpdate(server.id, 'manual', req.auth!.username).catch(() => {});
    res.status(202).json(autoUpdateView(server));
  })
);

serversRouter.get(
  '/:serverId/update/check',
  requireServerAccess(),
  asyncHandler(async (req, res) => {
    const server = getServer(req.params.serverId);
    if (!server) throw new HttpError(404, 'Server not found');
    try {
      const result = await checkForUpdate(server);
      res.json(result);
    } catch (err) {
      throw new HttpError(502, err instanceof Error ? err.message : 'Failed to check for updates');
    }
  })
);

serversRouter.post(
  '/:serverId/update',
  requireServerAccess(),
  asyncHandler(async (req, res) => {
    requirePermission(req, 'update');
    const server = getServer(req.params.serverId);
    if (!server) throw new HttpError(404, 'Server not found');
    if (isRunning(server.id)) throw new HttpError(409, 'Stop the server before updating it');
    if (server.status === 'installing' || server.status === 'updating') {
      throw new HttpError(409, 'An install or update is already in progress');
    }

    const targetVersion = typeof req.body?.targetVersion === 'string' ? req.body.targetVersion : undefined;
    logAudit(req.auth!.sub, req.auth!.username, 'server.update', server.id, targetVersion ?? server.version);
    void runUpdate(server, targetVersion, req.auth!.username).catch(() => {});
    res.status(202).json({ ok: true });
  })
);
