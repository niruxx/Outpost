import { Router } from 'express';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { requireAuth, requirePermission, requireServerAccess } from '../auth/middleware.js';
import { getServer } from '../services/serverService.js';
import {
  applyMappings,
  discoverGateway,
  getExternalIp,
  getMappingStates,
  listRouterMappings,
  removeMappings,
  sanitizeUpnpConfig,
  saveUpnpConfig,
  upnpConfigOf,
} from '../services/upnpService.js';
import { isRunning } from '../services/processManager.js';
import { logAudit } from '../services/userService.js';
import { testPort } from '../services/portTestService.js';

/** Per-instance UPnP port forwarding. Viewing needs instance access; changing needs "network". */
export const upnpRouter = Router({ mergeParams: true });
upnpRouter.use(requireAuth, requireServerAccess());

function requireServer(id: string) {
  const server = getServer(id);
  if (!server) throw new HttpError(404, 'Server not found');
  return server;
}

upnpRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const server = requireServer(req.params.serverId);
    const { config, configured } = upnpConfigOf(server);
    res.json({ config, configured, states: getMappingStates(server.id), running: isRunning(server.id) });
  })
);

/** Finds the router (cached ~10 min; ?refresh=1 forces a new search) and what it currently forwards here. */
upnpRouter.get(
  '/gateway',
  asyncHandler(async (req, res) => {
    requireServer(req.params.serverId);
    try {
      const gateway = await discoverGateway(req.query.refresh === '1');
      const [externalIp, mappings] = await Promise.all([getExternalIp(gateway), listRouterMappings(gateway)]);
      res.json({
        gateway,
        externalIp,
        routerMappings: mappings.filter((m) => m.internalClient === gateway.localAddress),
        error: null,
      });
    } catch (err) {
      res.json({ gateway: null, externalIp: null, routerMappings: [], error: err instanceof Error ? err.message : String(err) });
    }
  })
);

upnpRouter.put(
  '/',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'network');
    const server = requireServer(req.params.serverId);
    const config = sanitizeUpnpConfig(req.body?.config, { isAdmin: req.auth!.role === 'admin' });
    saveUpnpConfig(server.id, config);
    logAudit(req.auth!.sub, req.auth!.username, 'server.upnp.update', server.id, JSON.stringify(config.rules.map((r) => `${r.protocol} ${r.externalStart}-${r.externalEnd}`)));
    res.json({ config, configured: true });
  })
);

upnpRouter.post(
  '/apply',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'network');
    const server = requireServer(req.params.serverId);
    if (!upnpConfigOf(server).configured) throw new HttpError(400, 'Save the port rules first');
    const result = await applyMappings(server.id, `requested by ${req.auth!.username}`);
    logAudit(req.auth!.sub, req.auth!.username, 'server.upnp.apply', server.id);
    res.json(result);
  })
);

/**
 * Tests one forwarded port: router mapping, this machine, public address and — when `outside` is
 * set — a real connection from the internet via a public port checker. Anyone who can see the
 * instance may run the local checks; the outside check sends the public IP to a third party, so
 * it needs the "network" permission.
 */
upnpRouter.post(
  '/test',
  asyncHandler(async (req, res) => {
    const server = requireServer(req.params.serverId);
    const externalPort = Number(req.body?.externalPort);
    const internalPort = Number(req.body?.internalPort ?? externalPort);
    const protocol = req.body?.protocol === 'UDP' ? 'UDP' : 'TCP';
    const outside = req.body?.outside === true;
    for (const p of [externalPort, internalPort]) {
      if (!Number.isInteger(p) || p < 1 || p > 65535) throw new HttpError(400, 'Ports must be between 1 and 65535');
    }
    if (outside) requirePermission(req, 'network');
    const result = await testPort(server, { externalPort, internalPort, protocol, outside });
    if (outside) logAudit(req.auth!.sub, req.auth!.username, 'server.upnp.test_outside', server.id, `${protocol} ${externalPort}: ${result.summary}`);
    res.json(result);
  })
);

upnpRouter.post(
  '/remove',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'network');
    const server = requireServer(req.params.serverId);
    const removed = await removeMappings(server.id, `requested by ${req.auth!.username}`);
    logAudit(req.auth!.sub, req.auth!.username, 'server.upnp.remove', server.id);
    res.json({ removed });
  })
);
