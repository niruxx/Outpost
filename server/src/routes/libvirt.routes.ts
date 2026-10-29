import crypto from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler as handleAsync, HttpError } from '../utils/asyncHandler.js';
import { libvirtClient, LibvirtClient, libvirtSettings, saveLibvirtSettings, validateLibvirtSettings, VM_ACTIONS, type VmAction } from '../services/libvirtService.js';
import { getUserById, logAudit } from '../services/userService.js';

import { vmGrants, vmPermissions, requireVmPermission, type VmPermission } from '../services/vmAccessService.js';
import { createVmConsoleTicket } from '../services/vmConsoleService.js';
export const libvirtRouter = Router();
const asyncHandler = (fn: Parameters<typeof handleAsync>[0]) => handleAsync(async (req, res, next) => {
  let lock: { uuid: string; owner: symbol } | undefined;
  if (req.params.uuid && !['GET', 'HEAD'].includes(req.method)) {
    const uuid = req.params.uuid.toLowerCase();
    if (changing.has(uuid) || [...migrations.values()].some(j => j.uuid.toLowerCase() === uuid && j.status === 'running')) throw new HttpError(409, 'Another VM change is in progress');
    lock = { uuid, owner: Symbol(uuid) };
    changing.set(uuid, lock.owner);
  }
  try { await fn(req, res, next); } finally { releaseVmLock(lock); }
});
const admin: RequestHandler = (req, res, next) => {
  if (getUserById(req.auth!.sub)?.role !== 'admin') return res.status(403).json({ error: 'Current administrator access required' });
  next();
};
const permission = (key: VmPermission): RequestHandler => (req, _res, next) => {
  try { requireVmPermission(req.auth!.sub, req.params.uuid, key); next(); } catch (error) { next(error); }
};
libvirtRouter.use(requireAuth);
libvirtRouter.use((req, res, next) => {
  if (!getUserById(req.auth!.sub)) return res.status(403).json({ error: 'Account no longer exists' });
  if (req.auth!.apiKey && !['GET', 'HEAD'].includes(req.method)) return res.status(403).json({ error: 'Sign in interactively to manage virtual machines' });
  next();
});
const changing = new Map<string, symbol>();
function releaseVmLock(lock?: { uuid: string; owner: symbol }) {
  if (lock && changing.get(lock.uuid) === lock.owner) changing.delete(lock.uuid);
}
libvirtRouter.get('/settings', admin, (_req, res) => res.json(libvirtSettings()));
libvirtRouter.put('/settings', admin, (req, res, next) => {
  try {
    const settings = saveLibvirtSettings(req.body);
    logAudit(req.auth!.sub, req.auth!.username, 'libvirt.settings', undefined, JSON.stringify(settings));
    res.json(settings);
  } catch (error) { next(error); }
});
libvirtRouter.post('/test', admin, asyncHandler(async (req, res) => {
  const settings = validateLibvirtSettings(req.body);
  const machines = await new LibvirtClient(settings.uri).list();
  res.json({ ok: true, count: machines.length });
}));
libvirtRouter.get('/vms', asyncHandler(async (req, res) => {
  const client = libvirtClient();
  const isAdmin = getUserById(req.auth!.sub)?.role === 'admin';
  // Delegates query only their assigned domains, avoiding unrelated inventory disclosure.
  const machines: Awaited<ReturnType<LibvirtClient['list']>> = [];
  if (isAdmin) machines.push(...await client.list());
  else {
    const grants = vmGrants(req.auth!.sub).filter(g => g.uri === client.uri);
    for (let i = 0; i < grants.length; i += 4) {
      const batch = await Promise.all(grants.slice(i, i + 4).map(async g => {
        try { return await client.info(g.uuid); } catch (error) { if (/domain not found|failed to get domain/i.test(String(error))) return null; throw error; }
      }));
      for (const vm of batch) if (vm) machines.push(vm);
    }
  }
  res.set('Cache-Control', 'no-store').json({ machines: machines.map(vm => ({ ...vm, permissions: vmPermissions(req.auth!.sub, vm.uuid) })).filter(vm => vm.permissions.includes('view')), connection: getUserById(req.auth!.sub)?.role === 'admin' ? libvirtSettings().uri : '' });
}));
libvirtRouter.post('/vms/:uuid/persistent', admin, asyncHandler(async (req, res) => {
  await libvirtClient().makePersistent(req.params.uuid);
  logAudit(req.auth!.sub, req.auth!.username, 'libvirt.persist', req.params.uuid);
  res.json({ ok: true });
}));
libvirtRouter.delete('/vms/:uuid', admin, asyncHandler(async (req, res) => {
  const client = libvirtClient();
  await client.removeEntry(req.params.uuid, req.body);
  // Remove grants only for this connection and UUID, keeping grants on other hosts intact.
  const { prep } = await import('../db/db.js');
  prep('DELETE FROM vm_access WHERE uri=? AND lower(uuid)=lower(?)').run(client.uri, req.params.uuid);
  logAudit(req.auth!.sub, req.auth!.username, 'libvirt.undefine', req.params.uuid, 'Definition removed; disk volumes and NVRAM retained');
  res.json({ ok: true });
}));
libvirtRouter.post('/vms', admin, asyncHandler(async (req, res) => {
  await libvirtClient().define(req.body?.xml);
  logAudit(req.auth!.sub, req.auth!.username, 'libvirt.define');
  res.status(201).json({ ok: true });
}));
let creatingVm = false;
libvirtRouter.post('/vms/create', admin, asyncHandler(async (req, res) => {
  if (creatingVm) throw new HttpError(409, 'Another VM creation is in progress');
  creatingVm = true;
  try {
    const result = await libvirtClient().create(req.body);
    logAudit(req.auth!.sub, req.auth!.username, 'libvirt.create', result.uuid, JSON.stringify(result));
    res.status(201).json(result);
  } finally { creatingVm = false; }
}));
libvirtRouter.get('/vms/:uuid/xml', admin, asyncHandler(async (req, res) => {
  res.json({ xml: await libvirtClient().xml(req.params.uuid) });
}));
libvirtRouter.put('/vms/:uuid/xml', admin, asyncHandler(async (req, res) => {
  await libvirtClient().define(req.body?.xml, req.params.uuid);
  logAudit(req.auth!.sub, req.auth!.username, 'libvirt.xml', req.params.uuid);
  res.json({ ok: true });
}));
libvirtRouter.put('/vms/:uuid/config', permission('configure'), asyncHandler(async (req, res) => {
  await libvirtClient().configure(req.params.uuid, req.body);
  logAudit(req.auth!.sub, req.auth!.username, 'libvirt.configure', req.params.uuid, JSON.stringify(req.body));
  res.json({ ok: true });
}));
libvirtRouter.post('/vms/:uuid/action', permission('power'), asyncHandler(async (req, res) => {
  const action = req.body?.action;
  if (!VM_ACTIONS.includes(action)) throw new HttpError(400, 'Unknown VM action');
  await libvirtClient().action(req.params.uuid, action as VmAction);
  logAudit(req.auth!.sub, req.auth!.username, `libvirt.${action}`, req.params.uuid);
  res.json({ ok: true });
}));
const previews = new Set<string>();
libvirtRouter.get('/vms/:uuid/preview', permission('view'), asyncHandler(async (req, res) => {
  const uuid = req.params.uuid;
  if (previews.has(uuid) || previews.size >= 4) throw new HttpError(429, 'A preview is already being captured. Try again shortly.');
  previews.add(uuid);
  try {
    res.set('Cache-Control', 'no-store').type('png').send(await libvirtClient().screenshot(uuid));
  } finally { previews.delete(uuid); }
}));

libvirtRouter.post('/vms/:uuid/console-ticket', permission('console'), (req, res, next) => {
  try { res.json(createVmConsoleTicket(req.headers.authorization?.slice(7) ?? '', req.params.uuid, req.body?.protocol)); } catch (error) { next(error); }
});
libvirtRouter.get('/vms/:uuid/snapshots', permission('snapshots'), asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store').json({ snapshots: await libvirtClient().snapshots(req.params.uuid) });
}));
libvirtRouter.post('/vms/:uuid/snapshots', permission('snapshots'), asyncHandler(async (req, res) => {
  await libvirtClient().snapshot(req.params.uuid, req.body?.action, req.body?.name);
  logAudit(req.auth!.sub, req.auth!.username, 'libvirt.snapshot', req.params.uuid, JSON.stringify({ action: req.body?.action, name: req.body?.name }));
  res.json({ ok: true });
}));
libvirtRouter.get('/infrastructure', admin, asyncHandler(async (_req, res) => res.set('Cache-Control', 'no-store').json(await libvirtClient().infrastructure())));
libvirtRouter.get('/images', admin, asyncHandler(async (_req, res) => res.set('Cache-Control', 'no-store').json(await libvirtClient().images())));
libvirtRouter.put('/images', admin, asyncHandler(async (req, res) => {
  if (typeof req.body?.directory !== 'string') throw new HttpError(400, 'Images directory is required');
  const result = await libvirtClient().images(req.body.directory);
  logAudit(req.auth!.sub, req.auth!.username, 'libvirt.images', undefined, result.directory); res.json(result);
}));
libvirtRouter.get('/vms/:uuid/devices', admin, asyncHandler(async (req, res) => res.set('Cache-Control', 'no-store').json(await libvirtClient().devices(req.params.uuid))));
for (const operation of ['boot', 'media', 'detach-disk', 'interface'] as const) {
  libvirtRouter.post(`/vms/:uuid/${operation}`, admin, asyncHandler(async (req, res) => {
    const client = libvirtClient();
    if (operation === 'boot') await client.bootDevice(req.params.uuid, req.body);
    if (operation === 'media') await client.media(req.params.uuid, req.body);
    if (operation === 'detach-disk') await client.detachDisk(req.params.uuid, req.body?.target);
    if (operation === 'interface') await client.editInterface(req.params.uuid, req.body);
    logAudit(req.auth!.sub, req.auth!.username, `libvirt.${operation}`, req.params.uuid, JSON.stringify(req.body)); res.json({ ok: true });
  }));
}
libvirtRouter.post('/pools', admin, asyncHandler(async (req, res) => {
  await libvirtClient().createPool(req.body); logAudit(req.auth!.sub, req.auth!.username, 'libvirt.pool.create', undefined, JSON.stringify(req.body)); res.status(201).json({ ok: true });
}));
libvirtRouter.post('/pools/:name/action', admin, asyncHandler(async (req, res) => {
  await libvirtClient().poolAction(req.params.name, req.body?.action, req.body?.enabled); logAudit(req.auth!.sub, req.auth!.username, 'libvirt.pool.action', undefined, JSON.stringify({ name: req.params.name, ...req.body })); res.json({ ok: true });
}));
libvirtRouter.post('/pools/:name/disks', admin, asyncHandler(async (req, res) => {
  await libvirtClient().createDisk(req.params.name, req.body); logAudit(req.auth!.sub, req.auth!.username, 'libvirt.disk.create', undefined, JSON.stringify({ pool: req.params.name, ...req.body })); res.status(201).json({ ok: true });
}));
libvirtRouter.post('/vms/:uuid/disks', admin, asyncHandler(async (req, res) => {
  await libvirtClient().attachDisk(req.params.uuid, req.body); logAudit(req.auth!.sub, req.auth!.username, 'libvirt.disk.attach', req.params.uuid, JSON.stringify(req.body)); res.json({ ok: true });
}));
libvirtRouter.post('/vms/:uuid/create-disk', admin, asyncHandler(async (req, res) => {
  await libvirtClient().createAttachedDisk(req.params.uuid, req.body);
  logAudit(req.auth!.sub, req.auth!.username, 'libvirt.disk.create-attach', req.params.uuid, JSON.stringify(req.body)); res.status(201).json({ ok: true });
}));
libvirtRouter.post('/networks', admin, asyncHandler(async (req, res) => {
  await libvirtClient().createNetwork(req.body); logAudit(req.auth!.sub, req.auth!.username, 'libvirt.network.create', undefined, JSON.stringify(req.body)); res.status(201).json({ ok: true });
}));
libvirtRouter.post('/vms/:uuid/networks', admin, asyncHandler(async (req, res) => {
  await libvirtClient().attachNetwork(req.params.uuid, req.body?.network, req.body); logAudit(req.auth!.sub, req.auth!.username, 'libvirt.network.attach', req.params.uuid, String(req.body?.network)); res.json({ ok: true });
}));
libvirtRouter.post('/networks/:name/action', admin, asyncHandler(async (req, res) => {
  await libvirtClient().networkAction(req.params.name, req.body?.action, req.body?.enabled); logAudit(req.auth!.sub, req.auth!.username, 'libvirt.network.action', undefined, JSON.stringify({ name: req.params.name, ...req.body })); res.json({ ok: true });
}));
interface MigrationJob { id: string; uuid: string; destination: string; source: string; status: 'running' | 'succeeded' | 'failed'; error?: string; started: number }
const migrations = new Map<string, MigrationJob>();
libvirtRouter.get('/migrations', admin, (_req, res) => res.set('Cache-Control', 'no-store').json({ jobs: [...migrations.values()] }));
libvirtRouter.post('/vms/:uuid/migrate', admin, asyncHandler(async (req, res) => {
  const uuid = req.params.uuid;
  if ([...migrations.values()].some(j => j.status === 'running')) throw new HttpError(409, 'Wait for the current migration to finish');
  // Validate identity and destination before accepting a background job.
  const client = libvirtClient(); await client.migrationArgs(uuid, req.body);
  if ([...migrations.values()].some(j => j.status === 'running')) throw new HttpError(409, 'Wait for the current migration to finish');
  const destination = validateLibvirtSettings({ enabled: true, uri: req.body?.destination }).uri;
  const job: MigrationJob = { id: crypto.randomUUID(), uuid, destination, source: client.uri, status: 'running', started: Date.now() };
  if (migrations.size >= 100) { const oldest = [...migrations.values()].find(j => j.status !== 'running'); if (oldest) migrations.delete(oldest.id); }
  migrations.set(job.id, job);
  logAudit(req.auth!.sub, req.auth!.username, 'libvirt.migrate.start', uuid, JSON.stringify({ id: job.id, ...req.body }));
  void client.migrate(uuid, req.body).then(() => { job.status = 'succeeded'; }, error => { job.status = 'failed'; job.error = error instanceof Error ? error.message : 'Migration failed'; }).finally(() => {
    logAudit(req.auth!.sub, req.auth!.username, `libvirt.migrate.${job.status}`, uuid, JSON.stringify(job));
  });
  res.status(202).json({ job });
}));
libvirtRouter.post('/migrations/:id/abort', admin, asyncHandler(async (req, res) => {
  const job = migrations.get(req.params.id);
  if (!job || job.status !== 'running') throw new HttpError(409, 'No running migration with that ID');
  await new LibvirtClient(job.source).abortMigration(job.uuid);
  logAudit(req.auth!.sub, req.auth!.username, 'libvirt.migrate.abort', job.uuid, job.id);
  res.json({ ok: true });
}));
