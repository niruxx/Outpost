import { Router } from 'express';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { libvirtClient, LibvirtClient, libvirtSettings, saveLibvirtSettings, validateLibvirtSettings, VM_ACTIONS, type VmAction } from '../services/libvirtService.js';
import { getUserById, logAudit } from '../services/userService.js';

export const libvirtRouter = Router();
libvirtRouter.use(requireAuth, requireRole('admin'));
// VM management is host administration. Recheck the current role, including old session tokens.
libvirtRouter.use((req, res, next) => {
  if (getUserById(req.auth!.sub)?.role !== 'admin') return res.status(403).json({ error: 'Current administrator access required' });
  next();
});
libvirtRouter.get('/settings', (_req, res) => res.json(libvirtSettings()));
libvirtRouter.put('/settings', (req, res, next) => {
  try {
    const settings = saveLibvirtSettings(req.body);
    logAudit(req.auth!.sub, req.auth!.username, 'libvirt.settings', undefined, JSON.stringify(settings));
    res.json(settings);
  } catch (error) { next(error); }
});
libvirtRouter.post('/test', asyncHandler(async (req, res) => {
  const settings = validateLibvirtSettings(req.body);
  const machines = await new LibvirtClient(settings.uri).list();
  res.json({ ok: true, count: machines.length });
}));
libvirtRouter.get('/vms', asyncHandler(async (_req, res) => {
  res.set('Cache-Control', 'no-store').json({ machines: await libvirtClient().list(), connection: libvirtSettings().uri });
}));
libvirtRouter.post('/vms/:uuid/persistent', asyncHandler(async (req, res) => {
  await libvirtClient().makePersistent(req.params.uuid);
  logAudit(req.auth!.sub, req.auth!.username, 'libvirt.persist', req.params.uuid);
  res.json({ ok: true });
}));
libvirtRouter.post('/vms', asyncHandler(async (req, res) => {
  await libvirtClient().define(req.body?.xml);
  logAudit(req.auth!.sub, req.auth!.username, 'libvirt.define');
  res.status(201).json({ ok: true });
}));
libvirtRouter.get('/vms/:uuid/xml', asyncHandler(async (req, res) => {
  res.json({ xml: await libvirtClient().xml(req.params.uuid) });
}));
libvirtRouter.put('/vms/:uuid/xml', asyncHandler(async (req, res) => {
  await libvirtClient().define(req.body?.xml, req.params.uuid);
  logAudit(req.auth!.sub, req.auth!.username, 'libvirt.xml', req.params.uuid);
  res.json({ ok: true });
}));
libvirtRouter.put('/vms/:uuid/config', asyncHandler(async (req, res) => {
  await libvirtClient().configure(req.params.uuid, req.body);
  logAudit(req.auth!.sub, req.auth!.username, 'libvirt.configure', req.params.uuid, JSON.stringify(req.body));
  res.json({ ok: true });
}));
libvirtRouter.post('/vms/:uuid/action', asyncHandler(async (req, res) => {
  const action = req.body?.action;
  if (!VM_ACTIONS.includes(action)) throw new HttpError(400, 'Unknown VM action');
  await libvirtClient().action(req.params.uuid, action as VmAction);
  logAudit(req.auth!.sub, req.auth!.username, `libvirt.${action}`, req.params.uuid);
  res.json({ ok: true });
}));
const previews = new Set<string>();
libvirtRouter.get('/vms/:uuid/preview', asyncHandler(async (req, res) => {
  const uuid = req.params.uuid;
  if (previews.has(uuid) || previews.size >= 4) throw new HttpError(429, 'A preview is already being captured. Try again shortly.');
  previews.add(uuid);
  try {
    res.set('Cache-Control', 'no-store').type('png').send(await libvirtClient().screenshot(uuid));
  } finally { previews.delete(uuid); }
}));
