import express from 'express';
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
import { whitelistRouter } from './routes/whitelist.routes.js';
import { pluginsRouter } from './routes/plugins.routes.js';
import { pluginRegistryRouter } from './routes/pluginRegistry.routes.js';
import { environmentRouter } from './routes/environment.routes.js';
import { mapRouter } from './routes/map.routes.js';
import { settingsRouter } from './routes/settings.routes.js';
import { nodesRouter } from './routes/nodes.routes.js';
import { upnpRouter } from './routes/upnp.routes.js';
import { dockerRouter } from './routes/docker.routes.js';
import { catalogRouter } from './routes/catalog.routes.js';
import { nodeLinkRouter } from './routes/nodeLink.routes.js';
import { tasksRouter } from './routes/tasks.routes.js';
import { notificationsRouter } from './routes/notifications.routes.js';
import { auditRouter } from './routes/audit.routes.js';
import { firewallRouter } from './routes/firewall.routes.js';
import { recoverInterruptedTransfers } from './services/nodeService.js';
import { verifyToken } from './auth/tokens.js';
import { userHasServerAccess } from './services/userService.js';
import { getServer, listServers } from './services/serverService.js';
import { getLogBuffer, getRuntimeInfo, isRunning, startServer, stopAllForShutdown } from './services/processManager.js';
import { consoleTopic, subscribe } from './services/wsHub.js';
import { initScheduler } from './services/schedulerService.js';
import './db/db.js'; // ensure the database + schema are initialized before anything else runs

const PORT = Number(process.env.PORT ?? 8642);

const app = express();
app.use(express.json({ limit: '5mb' }));

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
app.use('/api/servers', serversRouter);
app.use('/api/plugins', pluginRegistryRouter);
app.use('/api/system', systemRouter);
app.use('/api/environment', environmentRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/nodes', nodesRouter);
app.use('/api/docker', dockerRouter);
app.use('/api/catalog', catalogRouter);
app.use('/api/node-link', nodeLinkRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/audit', auditRouter);
app.use('/api/firewall', firewallRouter);

app.get('/api/health', (_req, res) => res.json({ ok: true }));

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

httpServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '', 'http://localhost');
  const match = url.pathname.match(/^\/ws\/console\/([^/]+)$/);
  if (!match) {
    socket.destroy();
    return;
  }
  const serverId = match[1];
  const token = url.searchParams.get('token') ?? '';
  const payload = verifyToken(token);
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
