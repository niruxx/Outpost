import { registerVmConsole } from './services/vmConsoleService.js';
import express from 'express';
import { initPanelVersion } from './services/panelVersionService.js';
import { DATA_DIR } from './utils/paths.js';
import { notify } from './services/notificationService.js';
import { stopServer as stopServerForQuota } from './services/processManager.js';
import { appendLine } from './services/consoleLogService.js';
import { initDiskQuotas } from './services/limitsService.js';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { logger } from './utils/logger.js';
import { WEB_DIST_DIR } from './utils/paths.js';
import { authRouter } from './routes/auth.routes.js';
import { usersRouter } from './routes/users.routes.js';
import { serversRouter } from './routes/servers.routes.js';
import { filesRouter } from './routes/files.routes.js';
import { backupsRouter } from './routes/backups.routes.js';
import { systemRouter } from './routes/system.routes.js';
import { javaRouter } from './routes/java.routes.js';
import { whitelistRouter } from './routes/whitelist.routes.js';
import { pluginsRouter } from './routes/plugins.routes.js';
import { pluginRegistryRouter } from './routes/pluginRegistry.routes.js';
import { environmentRouter } from './routes/environment.routes.js';
import { mapRouter } from './routes/map.routes.js';
import { settingsRouter } from './routes/settings.routes.js';
import { nodesRouter } from './routes/nodes.routes.js';
import { upnpRouter } from './routes/upnp.routes.js';
import { dockerRouter } from './routes/docker.routes.js';
import { libvirtRouter } from './routes/libvirt.routes.js';
import { terminalRouter } from './routes/terminal.routes.js';
import { storageRouter } from './routes/storage.routes.js';
import { registerHostTerminal, stopHostTerminals } from './services/hostTerminalService.js';
import { catalogRouter } from './routes/catalog.routes.js';
import { nodeLinkRouter } from './routes/nodeLink.routes.js';
import { tasksRouter } from './routes/tasks.routes.js';
import { notificationsRouter } from './routes/notifications.routes.js';
import { auditRouter } from './routes/audit.routes.js';
import { firewallRouter } from './routes/firewall.routes.js';
import { workshopRouter } from './routes/workshop.routes.js';
import { rewindRouter } from './routes/rewind.routes.js';
import { wineRouter } from './routes/wine.routes.js';
import { initAutoUpdates } from './services/autoUpdateService.js';
import { initConsoleHistory } from './services/consoleHistoryService.js';
import { instanceTemplateRouter, templatesRouter } from './routes/templates.routes.js';
import { publicStatusRouter, statusPageSettingsRouter } from './routes/statusPage.routes.js';
import { instanceSftpRouter, sftpRouter } from './routes/sftp.routes.js';
import { instanceOffsiteRouter, offsiteRouter } from './routes/offsite.routes.js';
import { limitsRouter } from './routes/limits.routes.js';
import { keysRouter } from './routes/keys.routes.js';
import { cs2Router } from './routes/cs2.routes.js';
import { dbHostsRouter, serverDatabasesRouter } from './routes/databases.routes.js';
import { startSftp, stopSftp } from './services/sftpService.js';
import { consoleLogsRouter, consoleLogSettingsRouter } from './routes/consoleLogs.routes.js';
import { browserStatsRouter } from './routes/browserStats.routes.js';
import { startBrowserStats } from './services/browserStatsService.js';
import { gmodRouter } from './routes/gmod.routes.js';
import { proxyRouter } from './routes/proxy.routes.js';
import { rconRouter } from './routes/rcon.routes.js';
import { initRewind } from './services/rewindService.js';
import { requestContextMiddleware } from './utils/requestContext.js';
import { startAuditPruning } from './services/auditService.js';
import { recoverInterruptedTransfers } from './services/nodeService.js';
import { authenticate } from './auth/tokens.js';
import { userHasServerAccess } from './services/userService.js';
import { getServer, listServers } from './services/serverService.js';
import { getLogBuffer, getRuntimeInfo, isRunning, startServer, stopAllForShutdown } from './services/processManager.js';
import { consoleTopic, subscribe } from './services/wsHub.js';
import { initScheduler } from './services/schedulerService.js';
import './db/db.js'; // ensure the database + schema are initialized before anything else runs

const PORT = Number(process.env.PORT ?? 8642);

const app = express();
app.use(express.json({ limit: '5mb' }));
// Secrets stored on server records never leave the panel, whichever route sends the record.
app.set('json replacer', (key: string, value: unknown) => {
  if (key === 'rcon_config') return undefined;
  if (key === 'steam_login' && typeof value === 'string') return value.trim().split(/\s+/)[0] ?? '';
  if (key === 'workshop' && typeof value === 'string') {
    try {
      const ws = JSON.parse(value) as { login?: string | null };
      if (ws.login) ws.login = ws.login.split(/\s+/)[0];
      return JSON.stringify(ws);
    } catch {
      return null;
    }
  }
  return value;
});
// Lets the audit log record each request's address and browser.
app.use(requestContextMiddleware);

app.use((req, res, next) => {
  // Minimal request log; skip noisy polling endpoints.
  if (!req.path.includes('/console/history')) logger.debug(`${req.method} ${req.path}`);
  next();
});

app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/servers/:serverId/files', filesRouter);
app.use('/api/servers/:serverId/backups', backupsRouter);
app.use('/api/servers/:serverId/whitelist', whitelistRouter);
app.use('/api/servers/:serverId/plugins', pluginsRouter);
app.use('/api/servers/:serverId/map', mapRouter);
app.use('/api/servers/:serverId/upnp', upnpRouter);
app.use('/api/servers/:serverId/tasks', tasksRouter);
app.use('/api/servers/:serverId/workshop', workshopRouter);
app.use('/api/servers/:serverId/rewind', rewindRouter);
app.use('/api/servers/:serverId/wine', wineRouter);
app.use('/api/servers/:serverId/rcon', rconRouter);
app.use('/api/servers/:serverId/proxy', proxyRouter);
app.use('/api/servers/:serverId/gmod', gmodRouter);
app.use('/api/servers/:serverId/query', browserStatsRouter);
app.use('/api/servers/:serverId/console-logs', consoleLogsRouter);
app.use('/api/console-logs', consoleLogSettingsRouter);
app.use('/api/templates', templatesRouter);
app.use('/api/servers/:serverId/template', instanceTemplateRouter);
app.use('/api/servers/:serverId/status-page', statusPageSettingsRouter);
app.use('/api/sftp', sftpRouter);
app.use('/api/offsite', offsiteRouter);
app.use('/api/servers/:serverId/offsite', instanceOffsiteRouter);
app.use('/api/servers/:serverId/limits', limitsRouter);
app.use('/api/keys', keysRouter);
app.use('/api/servers/:serverId/cs2', cs2Router);
app.use('/api/database-hosts', dbHostsRouter);
app.use('/api/servers/:serverId/databases', serverDatabasesRouter);
app.use('/api/servers/:serverId/sftp', instanceSftpRouter);
app.use('/api/servers', serversRouter);
app.use('/api/plugins', pluginRegistryRouter);
app.use('/api/system', systemRouter);
app.use('/api/java', javaRouter);
app.use('/api/environment', environmentRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/nodes', nodesRouter);
app.use('/api/docker', dockerRouter);
app.use('/api/libvirt', libvirtRouter);
app.use('/api/terminal', terminalRouter);
app.use('/api/storage', storageRouter);
app.use('/api/catalog', catalogRouter);
app.use('/api/node-link', nodeLinkRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/audit', auditRouter);
app.use('/api/firewall', firewallRouter);

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/public/status', publicStatusRouter);

// Serve the built frontend, if present (production mode). In dev, Vite serves the UI separately.
if (fs.existsSync(WEB_DIST_DIR)) {
  app.use(express.static(WEB_DIST_DIR));
  app.get(/^\/(?!api|ws).*/, (_req, res) => {
    res.sendFile(path.join(WEB_DIST_DIR, 'index.html'));
  });
}

// Centralized error handler: HttpError carries a status code, anything else is a 500.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = (err as { status?: number })?.status ?? 500;
  const message = err instanceof Error ? err.message : 'Internal server error';
  if (status >= 500) logger.error('Unhandled error', err);
  res.status(status).json({ error: message });
});

const httpServer = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
registerHostTerminal(httpServer);
registerVmConsole(httpServer);

httpServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '', 'http://localhost');
  if (url.pathname === '/ws/host-terminal' || url.pathname === '/ws/vm-console') return; // handled by the host terminal upgrader
  const match = url.pathname.match(/^\/ws\/console\/([^/]+)$/);
  if (!match) {
    socket.destroy();
    return;
  }
  const serverId = match[1];
  const token = url.searchParams.get('token') ?? '';
  const payload = authenticate(token);
  if (!payload) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  const server = getServer(serverId);
  if (!server) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  if (payload.role !== 'admin' && (!userHasServerAccess(payload.sub, serverId) || server.suspended)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    subscribe(consoleTopic(serverId), ws);
    ws.send(
      JSON.stringify({
        type: 'hello',
        status: server.status,
        running: isRunning(serverId),
        runtime: getRuntimeInfo(serverId),
        history: getLogBuffer(serverId),
      })
    );
  });
});

async function bootstrap() {
  initScheduler();
  initAutoUpdates();
  initConsoleHistory();
  void startSftp();
  initPanelVersion();
  initDiskQuotas({
    log: (id, line) => appendLine(id, line, 'system'),
    stop: (id) => {
      try {
        stopServerForQuota(id);
      } catch {
        // already stopping
      }
    },
    isRunning,
    notify: (server, message) => notify('quota.exceeded', { id: server.id, name: server.name }, message),
  });
  if (process.platform === 'win32' && DATA_DIR.length > 90) {
    logger.warn(
      `The data folder path is ${DATA_DIR.length} characters long. Modded Minecraft (Forge, Mohist, Sponge) keeps libraries deep inside each instance and can hit Windows' 260-character path limit — use a shorter OUTPOST_DATA_DIR (e.g. C:\\Outpost\\data) or enable long paths in Windows.`
    );
  }
  startAuditPruning();
  startBrowserStats(isRunning);
  initRewind();
  recoverInterruptedTransfers();

  for (const server of listServers()) {
    if (server.auto_start && server.status !== 'installing' && !server.suspended) {
      logger.info(`Auto-starting server ${server.name} (${server.id})`);
      startServer(server.id).catch((err) => logger.error(`Auto-start failed for ${server.id}`, err));
    }
  }

  httpServer.listen(PORT, () => {
    logger.info(`Outpost panel listening on http://localhost:${PORT}`);
  });
}

bootstrap();

function shutdown(signal: string) {
  logger.info(`Received ${signal}, shutting down`);
  stopAllForShutdown();
  stopHostTerminals();
  void stopSftp();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Last-resort safety net: an uncaught error anywhere (a stray unhandled stream 'error' event,
// a rejected promise nobody awaited, etc.) would otherwise crash the whole panel — every
// managed server's process supervision included — with nothing but Node's raw stack trace on
// stderr, or nothing at all if stderr isn't being captured. Log it clearly, then exit; a process
// manager (systemd/pm2) restarting a fresh, logged crash beats a silent, undiagnosable one.
process.on('uncaughtException', (err) => {
  logger.error('FATAL: uncaught exception — the panel is exiting so a process manager can restart it', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.error('FATAL: unhandled promise rejection — the panel is exiting so a process manager can restart it', reason);
  process.exit(1);
});
