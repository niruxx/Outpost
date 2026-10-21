import { Router } from 'express';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { requireAuth, requirePermission, requireServerAccess } from '../auth/middleware.js';
import { getServer, listServers } from '../services/serverService.js';
import { appendLine } from '../services/consoleLogService.js';
import { getServerPermissions, logAudit } from '../services/userService.js';
import { backendAddress, getProxyNetwork, linkBackend, saveProxyNetwork } from '../services/proxyService.js';
import { isProxyLoader, type Role, type ServerRecord } from '../types/index.js';

/** Velocity / BungeeCord / Waterfall network settings. Reading needs access; changing needs "settings". */
export const proxyRouter = Router({ mergeParams: true });
proxyRouter.use(requireAuth, requireServerAccess());

function requireProxyServer(id: string): ServerRecord {
  const server = getServer(id);
  if (!server) throw new HttpError(404, 'Server not found');
  if (!isProxyLoader(server.loader)) throw new HttpError(400, 'This instance isn’t a Minecraft proxy');
  return server;
}

/** Java game servers this user may rewire to sit behind the proxy. */
function candidates(userId: string, role: Role, proxy: ServerRecord) {
  return listServers()
    .filter((s) => s.platform === 'java' && !isProxyLoader(s.loader) && s.id !== proxy.id && s.status !== 'installing')
    .filter((s) => role === 'admin' || (!s.suspended && getServerPermissions(userId, role, s.id)?.includes('settings')))
    .map((s) => ({ id: s.id, name: s.name, loader: s.loader, version: s.version, address: backendAddress(s) }));
}

proxyRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const server = requireProxyServer(req.params.serverId);
    res.json({ network: getProxyNetwork(server), candidates: candidates(req.auth!.sub, req.auth!.role, server) });
  })
);

proxyRouter.put(
  '/',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'settings');
    const server = requireProxyServer(req.params.serverId);
    const network = saveProxyNetwork(server, req.body);
    appendLine(server.id, `[Outpost] Network updated by ${req.auth!.username}: ${network.backends.length} backend server(s), forwarding ${network.forwarding} — restart the proxy to apply`, 'system');
    logAudit(req.auth!.sub, req.auth!.username, 'server.proxy.update', server.id, network.backends.map((b) => `${b.name}=${b.address}`).join(', '));
    res.json({ network });
  })
);

/** Puts another Outpost Java instance behind this proxy and configures both sides. */
proxyRouter.post(
  '/link',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'settings');
    const proxy = requireProxyServer(req.params.serverId);
    const backendId = String(req.body?.backendId ?? '');
    const backend = getServer(backendId);
    if (!backend) throw new HttpError(404, 'Backend instance not found');
    if (req.auth!.role !== 'admin' && backend.suspended) throw new HttpError(423, 'That instance is suspended');
    requirePermission(req, 'settings', backend.id);
    const name = String(req.body?.name ?? '').trim() || backend.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'server';
    const result = linkBackend(proxy, backend, name);
    for (const line of result.changes) appendLine(proxy.id, `[Outpost] ${line}`, 'system');
    appendLine(backend.id, `[Outpost] Linked behind proxy “${proxy.name}” by ${req.auth!.username} — restart this server to apply`, 'system');
    logAudit(req.auth!.sub, req.auth!.username, 'server.proxy.link', proxy.id, `${backend.id} as ${name}`);
    res.json(result);
  })
);
