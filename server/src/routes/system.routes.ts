import os from 'node:os';
import { checkForPanelUpdate, panelVersion } from '../services/panelVersionService.js';
import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { findJava, getJavaVersion } from '../services/javaService.js';
import { getPrimaryAddress, listHostAddresses } from '../services/networkService.js';
import { getHostMetrics } from '../services/hostMetricsService.js';
import { listServers } from '../services/serverService.js';
import { getRuntimeInfo } from '../services/processManager.js';
import { getUserServerAccess } from '../services/userService.js';

export const systemRouter = Router();
systemRouter.use(requireAuth);

/** Lets the UI show a small "what host is this panel running on" indicator. */
systemRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const [javaPath, javaVersion, primaryAddress] = await Promise.all([findJava(), getJavaVersion(), getPrimaryAddress()]);
    res.json({
      platform: process.platform, // 'win32' | 'linux' | 'darwin'
      platformLabel: process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux',
      osRelease: os.release(),
      arch: process.arch,
      hostname: os.hostname(),
      nodeVersion: process.version,
      java: { available: !!javaPath, version: javaVersion },
      primaryAddress,
      addresses: listHostAddresses(),
      cpuCores: os.cpus().length,
      totalMemMb: Math.round(os.totalmem() / 1024 / 1024),
      uptimeSec: Math.round(os.uptime()),
      panel: { version: panelVersion().version, commit: panelVersion().commit, commitDate: panelVersion().commitDate },
    });
  })
);

/** The commit this panel runs and whether its Git remote has newer ones (admins). */
systemRouter.get(
  '/panel-version',
  requireRole('admin'),
  asyncHandler(async (_req, res) => {
    res.json(panelVersion());
  })
);

systemRouter.post(
  '/panel-version/check',
  requireRole('admin'),
  asyncHandler(async (_req, res) => {
    res.json(await checkForPanelUpdate());
  })
);

/** Live host metrics plus a roll-up of the instances this user can see. */
systemRouter.get(
  '/metrics',
  asyncHandler(async (req, res) => {
    const allowed = req.auth!.role === 'admin' ? null : new Set(getUserServerAccess(req.auth!.sub));
    const servers = listServers().filter((s) => !allowed || allowed.has(s.id));
    let memoryMb = 0;
    let cpuPercent = 0;
    for (const s of servers) {
      const stats = getRuntimeInfo(s.id)?.stats;
      memoryMb += stats?.memoryMb ?? 0;
      cpuPercent += stats?.cpuPercent ?? 0;
    }
    const count = (pred: (s: (typeof servers)[number]) => boolean) => servers.filter(pred).length;
    res.json({
      host: getHostMetrics(),
      instances: {
        total: servers.length,
        running: count((s) => s.status === 'running'),
        starting: count((s) => s.status === 'starting' || s.status === 'stopping'),
        stopped: count((s) => s.status === 'stopped'),
        crashed: count((s) => s.status === 'crashed' || s.status === 'install_failed'),
        installing: count((s) => s.status === 'installing' || s.status === 'updating' || s.status === 'transferring'),
        suspended: count((s) => !!s.suspended),
        memoryMb,
        cpuPercent: Math.round(cpuPercent * 10) / 10,
      },
    });
  })
);
