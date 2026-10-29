import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { Router } from 'express';
import { prep } from '../db/db.js';
import { requireAuth, requirePermission, requireServerAccess } from '../auth/middleware.js';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { getUserById, listUsers, logAudit } from '../services/userService.js';
import { getServer, updateServerRecord } from '../services/serverService.js';
import { createInstance } from './servers.routes.js';
import { allocationPools, createAllocationPool, removeAllocationPool, instanceAllocation, reserveAllocation, releaseAllocation, commitAllocation } from '../services/allocationService.js';
import { isRunning } from '../services/processManager.js';
import { instancePortProtocol } from '../services/portProtocol.js';
import { writeServerProperties } from '../services/propertiesService.js';
import { fleetInventory, localInventory, nodePolicy, planPlacement, placements, placementResult, remoteNode, saveNodePolicy } from '../services/fleetService.js';
import { acceptWebhook, deleteRule, listRules, rotateRuleSecret, saveRule } from '../services/automationService.js';
import { ownSteamAccount, removeSteamAccount, saveSteamAccount, setSteamGuard, steamAccounts } from '../services/steamAccountService.js';
import { curseforge } from '../services/curseforgeService.js';
import { resolveCurseForgePack } from '../services/curseforgePackService.js';

export const operationsRouter = Router();
operationsRouter.use(requireAuth);
function currentAccount(req: Request, _res: Response, next: (err?: unknown) => void) {
  const user = getUserById(req.auth!.sub);
  if (!user) return next(new HttpError(403, 'Current account required'));
  req.auth!.role = user.role;
  if (req.auth!.apiKey) return next(new HttpError(403, 'Sign in interactively to use these controls'));
  next();
}
operationsRouter.use(currentAccount);
const admin = (req: Request, _res: Response, next: (err?: unknown) => void) => { if (getUserById(req.auth!.sub)?.role !== 'admin') return next(new HttpError(403, 'Current administrator access required')); next(); };
operationsRouter.get('/fleet', admin, asyncHandler(async (_req, res) => res.json({ nodes: await fleetInventory(), placements: placements() })));
operationsRouter.put('/fleet/:id/policy', admin, (req, res, next) => { try { res.json(saveNodePolicy(req.params.id, req.body)); logAudit(req.auth!.sub, req.auth!.username, 'fleet.policy', req.params.id); } catch (err) { next(err); } });
let receiving = false;
export async function provisionOnNode(req: Request, res: Response) {
  const id = req.get('X-Outpost-Provision-Id') ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(400, 'X-Outpost-Provision-Id UUID is required');
  if (req.body?.steamLogin !== undefined || req.body?.steamAccountId !== undefined || req.body?.templateId !== undefined || !['java', 'bedrock', 'steam'].includes(req.body?.platform)) throw new HttpError(400, 'Node provisioning accepts Java/Bedrock/Steam definitions without credentials/templates');
  const hash = crypto.createHash('sha256').update(JSON.stringify(req.body)).digest('hex');
  const old = prep('SELECT * FROM fleet_requests WHERE id=?').get(id) as { request_hash: string; server_id: string | null } | undefined;
  if (old) {
    if (old.request_hash !== hash) throw new HttpError(409, 'Provisioning ID already used with another definition');
    if (old.server_id) { const server = getServer(old.server_id); if (!server) throw new HttpError(410, 'The previously provisioned instance was deleted; use a new request ID'); return res.status(200).json({ server: { id: server.id, name: server.name, status: server.status, server_port: server.server_port } }); }
    throw new HttpError(409, 'Provisioning is in progress or was interrupted before recording an instance; inspect this host before using a new request ID');
  }
  if (receiving) throw new HttpError(429, 'Another node provisioning request is in progress');
  const inventory = localInventory(), policy = nodePolicy('local'), memory = Number(req.body.maxMemoryMb ?? 2048);
  if (!policy.enabled || !Number.isInteger(memory) || memory < 128 || inventory.info.totalMemoryMb - inventory.info.reservedMemoryMb - policy.reserveMemoryMb < memory || inventory.info.freeMemoryMb - policy.reserveMemoryMb < memory || (policy.maxInstances && inventory.info.instances >= policy.maxInstances)) throw new HttpError(409, 'Destination admission limits reject this instance');
  receiving = true; prep('INSERT INTO fleet_requests(id,request_hash,at) VALUES (?,?,?)').run(id, hash, Date.now());
  res.locals.fleetRequestId = id;
  try { await createInstance(req, res); }
  catch (error) { const record = prep('SELECT server_id FROM fleet_requests WHERE id=?').get(id) as { server_id: string | null }; if (!record.server_id) prep('DELETE FROM fleet_requests WHERE id=?').run(id); throw error; }
  finally { receiving = false; }
}
export function nodeProvisionIdentity(req: Request) {
  const user = listUsers().find(u => u.role === 'admin');
  if (!user) throw new HttpError(409, 'Complete owner setup on this node first');
  req.auth = { sub: user.id, username: user.username, role: 'admin', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 };
}
operationsRouter.post('/provision', admin, asyncHandler(async (req, res) => {
  const { requestId, definition, nodeId, tags } = req.body ?? {};
  const plan = await planPlacement(requestId, definition, nodeId, tags);
  if (plan.serverId) return res.json({ nodeId: plan.nodeId, server: { id: plan.serverId }, duplicate: true });
  try {
    if (plan.nodeId === 'local') {
      req.body = definition; req.headers['x-outpost-provision-id'] = requestId;
      await provisionOnNode(req, res);
      const record = prep('SELECT server_id FROM fleet_requests WHERE id=?').get(requestId) as { server_id: string | null };
      placementResult(requestId, record.server_id ?? undefined);
    } else {
      const result = await remoteNode<{ server: { id: string } }>(plan.nodeId, '/provision', definition, requestId);
      placementResult(requestId, result.server.id); res.status(201).json({ nodeId: plan.nodeId, ...result });
    }
    logAudit(req.auth!.sub, req.auth!.username, 'fleet.provision', undefined, JSON.stringify({ requestId, nodeId: plan.nodeId }));
  } catch (error) { placementResult(requestId, undefined, error instanceof Error ? error.message : 'Provisioning failed'); throw error; }
}));
operationsRouter.get('/allocations', (_req, res) => res.json({ pools: allocationPools().map(p => ({ ...p, allocations: p.allocations.length })) }));
operationsRouter.get('/allocations/details', admin, (_req, res) => res.json({ pools: allocationPools() }));
operationsRouter.post('/allocations', admin, (req, res, next) => { try { const result = createAllocationPool(req.body); logAudit(req.auth!.sub, req.auth!.username, 'allocation.pool.create', result.id); res.status(201).json(result); } catch (err) { next(err); } });
operationsRouter.delete('/allocations/:id', admin, (req, res, next) => { try { removeAllocationPool(req.params.id); logAudit(req.auth!.sub, req.auth!.username, 'allocation.pool.delete', req.params.id); res.status(204).end(); } catch (err) { next(err); } });
operationsRouter.post('/allocations/servers/:id', admin, (req, res, next) => {
  try {
    const server = getServer(req.params.id);
    if (!server || !['java', 'bedrock', 'steam'].includes(server.platform)) throw new HttpError(400, 'Select a Java/Bedrock/Steam instance');
    if (isRunning(server.id) || !['stopped', 'crashed', 'install_failed'].includes(server.status)) throw new HttpError(409, 'Stop this instance first');
    if (req.body?.release === true) { prep('DELETE FROM allocations WHERE server_id=?').run(server.id); logAudit(req.auth!.sub, req.auth!.username, 'allocation.release', server.id); return res.json({ ok: true }); }
    if (instanceAllocation(server.id)) throw new HttpError(409, 'Release the existing assignment first');
    const allocation = reserveAllocation(String(req.body?.poolId ?? 'auto'), instancePortProtocol(server));
    try {
      commitAllocation(allocation.token, server.id); updateServerRecord(server.id, { serverPort: allocation.port });
      if (server.platform === 'java' || server.platform === 'bedrock') writeServerProperties(server.id, server.platform, { 'server-port': String(allocation.port), ...(server.platform === 'java' ? { 'server-ip': allocation.address === '0.0.0.0' ? '' : allocation.address } : {}) });
    } catch (error) { releaseAllocation(allocation.token); throw error; }
    logAudit(req.auth!.sub, req.auth!.username, 'allocation.assign', server.id); res.json({ allocation });
  } catch (err) { next(err); }
});
operationsRouter.get('/steam', (req, res) => res.json({ accounts: steamAccounts(req.auth!.sub) }));
operationsRouter.post('/steam', (req, res, next) => { try { res.status(201).json(saveSteamAccount(req.auth!.sub, req.body)); logAudit(req.auth!.sub, req.auth!.username, 'steam.account.save'); } catch (err) { next(err); } });
operationsRouter.post('/steam/:id/guard', (req, res, next) => { try { setSteamGuard(req.auth!.sub, req.params.id, req.body?.code); res.json({ ok: true, expiresInSeconds: 120 }); } catch (err) { next(err); } });
operationsRouter.delete('/steam/:id', (req, res, next) => { try { removeSteamAccount(req.auth!.sub, req.params.id); res.status(204).end(); logAudit(req.auth!.sub, req.auth!.username, 'steam.account.delete'); } catch (err) { next(err); } });
operationsRouter.get('/curseforge', asyncHandler(async (req, res) => res.json({ packs: await curseforge.search('modpack', String(req.query.q ?? '').slice(0, 100)) })));
operationsRouter.get('/curseforge/:id/files', asyncHandler(async (req, res) => res.json({ files: await curseforge.packVersions(Number(req.params.id)) })));
operationsRouter.get('/curseforge/resolve', asyncHandler(async (req, res) => { const pack = await resolveCurseForgePack(String(req.query.projectId), String(req.query.fileId)); res.json({ ref: pack.ref, loader: pack.loader, version: pack.mc, loaderVersion: pack.loaderVersion }); }));

export const automationRouter = Router({ mergeParams: true });
automationRouter.use(requireAuth, currentAccount, requireServerAccess());
automationRouter.use((req, _res, next) => { if (req.auth!.apiKey) return next(new HttpError(403, 'Sign in to manage automation rules')); next(); });
automationRouter.get('/', (req, res) => res.json({ rules: listRules((req.params as Record<string, string>).serverId, req.auth!.sub), allocation: instanceAllocation((req.params as Record<string, string>).serverId) ?? null }));
automationRouter.post('/', (req, res, next) => { try { const result = saveRule((req.params as Record<string, string>).serverId, req.auth!.sub, req.body); logAudit(req.auth!.sub, req.auth!.username, 'automation.create', (req.params as Record<string, string>).serverId, result.id); res.status(201).json(result); } catch (err) { next(err); } });
automationRouter.put('/:id', (req, res, next) => { try { res.json(saveRule((req.params as Record<string, string>).serverId, req.auth!.sub, req.body, req.params.id)); logAudit(req.auth!.sub, req.auth!.username, 'automation.update', (req.params as Record<string, string>).serverId, req.params.id); } catch (err) { next(err); } });
automationRouter.delete('/:id', (req, res, next) => { try { deleteRule((req.params as Record<string, string>).serverId, req.auth!.sub, req.params.id); res.status(204).end(); logAudit(req.auth!.sub, req.auth!.username, 'automation.delete', (req.params as Record<string, string>).serverId, req.params.id); } catch (err) { next(err); } });
automationRouter.post('/:id/rotate', (req, res, next) => { try { res.json(rotateRuleSecret((req.params as Record<string, string>).serverId, req.auth!.sub, req.params.id)); } catch (err) { next(err); } });
automationRouter.post('/steam/bind', (req, res, next) => {
  try { requirePermission(req, 'settings'); const server = getServer((req.params as Record<string, string>).serverId); if (server?.platform !== 'steam') throw new HttpError(400, 'Steam instance required'); const login = req.body?.accountId ? ownSteamAccount(req.auth!.sub, req.body.accountId) : 'anonymous'; updateServerRecord(server.id, { steamLogin: login }); logAudit(req.auth!.sub, req.auth!.username, 'steam.account.bind', server.id); res.json({ ok: true }); } catch (err) { next(err); }
});
export const hooksRouter = Router();
hooksRouter.post('/:id', asyncHandler(async (req, res) => { const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : ''; res.set('Cache-Control', 'no-store').json(await acceptWebhook(req.params.id, token, req.get('X-Outpost-Delivery') ?? '', req.get('X-Outpost-Timestamp') ?? '')); }));
