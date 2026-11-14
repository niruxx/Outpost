import express, { Router, type Request, type Response } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { currentFleetAdmin, requireFleetAdmin } from '../services/fleetSecurity.js';
import * as capacity from '../services/fleetCapacityService.js';
import * as enrollment from '../services/hostEnrollmentService.js';
import * as recovery from '../services/fleetRecoveryService.js';
import * as billing from '../services/billingService.js';
import * as extensions from '../services/extensionService.js';
import * as community from '../services/communityCatalogService.js';
import { logAudit } from '../services/userService.js';
import { nodeProvisionIdentity, provisionOnNode } from './operations.routes.js';
import { remoteNode } from '../services/fleetService.js';
export const fleetAdvancedRouter = Router();
fleetAdvancedRouter.use(requireAuth, currentFleetAdmin);
const audit = (req: Request, action: string, detail?: string) => logAudit(req.auth!.sub, req.auth!.username, action, undefined, detail);
fleetAdvancedRouter.get('/capacity', asyncHandler(async (_req, res) => res.json({ hosts: await capacity.explainFleetCapacity({ memoryMb: 2048, cpuPercent: 100, diskMb: 10240, platform: 'java', tags: [], roles: [{ role: 'game', offset: 0, protocol: 'tcp' }] }), policy: capacity.capacityPolicy() })));
fleetAdvancedRouter.post('/capacity/preview', asyncHandler(async (req, res) => res.json(await capacity.explainFleetCapacity(req.body?.request, req.body?.nodeId ?? 'auto'))));
fleetAdvancedRouter.put('/capacity/policy', (req, res, next) => {
    try {
        res.json(capacity.saveCapacityPolicy(req.body ?? {}));
        audit(req, 'fleet.capacity.policy');
    }
    catch (e) {
        next(e);
    }
});
fleetAdvancedRouter.post('/capacity/reserve', asyncHandler(async (req, res) => { const result = await capacity.reserveFleetCapacity(String(req.body?.nodeId), String(req.body?.id), req.body?.request); requireFleetAdmin(req.auth!.sub); audit(req, 'fleet.capacity.reserve', result.id); res.status(201).json(result); }));
export async function provisionReserved(req: Request, res: Response) { const id = String(req.body?.id), lease = capacity.capacityLease(id), input = req.body?.definition ?? {}; const definition = { name: input.name, platform: lease.resources.platform, loader: input.loader ?? 'vanilla', version: input.version, maxMemoryMb: lease.resources.memoryMb, minMemoryMb: Math.min(1024, lease.resources.memoryMb), serverPort: lease.ports.find(p => p.role.startsWith('game'))?.port, steamPreset: lease.resources.steamPreset, steamAppId: lease.resources.steamAppId, acceptEula: input.acceptEula === true }; req.body = definition; req.headers['x-outpost-provision-id'] = id; req.headers['x-outpost-capacity-lease'] = id; return provisionOnNode(req, res); }
fleetAdvancedRouter.post('/capacity/provision', asyncHandler(async (req, res) => {
    const node = String(req.body?.nodeId ?? 'local');
    if (node === 'local')
        return provisionReserved(req, res);
    const result = await remoteNode(node, '/capacity/provision', { id: req.body?.id, definition: req.body?.definition });
    audit(req, 'fleet.capacity.provision', String(req.body?.id));
    res.status(201).json(result);
}));
fleetAdvancedRouter.post('/capacity/release', asyncHandler(async (req, res) => {
    if (req.body?.nodeId === 'local')
        capacity.releaseCapacity(String(req.body?.id));
    else
        await remoteNode(String(req.body?.nodeId), '/capacity/release', { id: req.body?.id });
    audit(req, 'fleet.capacity.release', String(req.body?.id));
    res.json({ ok: true });
}));
fleetAdvancedRouter.get('/enrollments', (_req, res) => res.json({ jobs: enrollment.enrollmentRows() }));
fleetAdvancedRouter.post('/enrollments', asyncHandler(async (req, res) => { const r = await enrollment.createEnrollment(req.auth!.sub, req.body ?? {}); audit(req, 'fleet.enrollment.plan', r.id); res.status(201).json(r); }));
fleetAdvancedRouter.post('/enrollments/:id/execute', asyncHandler(async (req, res) => { res.status(202).json(await enrollment.executeEnrollment(req.auth!.sub, req.params.id, req.body ?? {})); audit(req, 'fleet.enrollment.execute', req.params.id); }));
fleetAdvancedRouter.post('/enrollments/:id/cancel', (req, res, next) => {
    try {
        enrollment.cancelEnrollment(req.auth!.sub, req.params.id);
        audit(req, 'fleet.enrollment.cancel', req.params.id);
        res.json({ ok: true });
    }
    catch (e) {
        next(e);
    }
});
fleetAdvancedRouter.get('/recovery', (_req, res) => res.json({ runs: recovery.recoveryRows() }));
fleetAdvancedRouter.post('/recovery', asyncHandler(async (req, res) => { res.status(202).json(await recovery.startFleetRecovery(req.auth!.sub, req.body ?? {})); audit(req, 'fleet.recovery.plan'); }));
fleetAdvancedRouter.post('/recovery/:id/reconcile', asyncHandler(async (req, res) => res.json(await recovery.reconcileRecovery(req.auth!.sub, req.params.id))));
fleetAdvancedRouter.post('/recovery/:id/activate', asyncHandler(async (req, res) => { res.json(await recovery.activateRecovery(req.auth!.sub, req.params.id, req.body ?? {})); audit(req, 'fleet.recovery.activate', req.params.id); }));
fleetAdvancedRouter.post('/recovery/:id/rollback', asyncHandler(async (req, res) => { res.json(await recovery.rollbackRecovery(req.auth!.sub, req.params.id)); audit(req, 'fleet.recovery.rollback', req.params.id); }));
fleetAdvancedRouter.get('/billing', (_req, res) => res.json({ connections: billing.billingConnections(), plans: billing.billingPlans(), services: billing.billingServices(), events: billing.billingEvents() }));
fleetAdvancedRouter.post('/billing/connections', (req, res, next) => {
    try {
        res.status(201).json(billing.saveBillingConnection(req.body ?? {}));
        audit(req, 'billing.connection.save');
    }
    catch (e) {
        next(e);
    }
});
fleetAdvancedRouter.post('/billing/connections/:id/rotate', (req, res, next) => {
    try {
        res.json(billing.rotateBillingSecret(req.params.id));
        audit(req, 'billing.connection.rotate', req.params.id);
    }
    catch (e) {
        next(e);
    }
});
fleetAdvancedRouter.post('/billing/plans', (req, res, next) => {
    try {
        res.status(201).json(billing.saveBillingPlan(req.auth!.sub, req.body ?? {}));
        audit(req, 'billing.plan.save');
    }
    catch (e) {
        next(e);
    }
});
fleetAdvancedRouter.get('/extensions', (_req, res) => res.json({ sdkVersion: 1, panelVersion: extensions.PANEL_VERSION, extensions: extensions.extensionRows() }));
fleetAdvancedRouter.post('/extensions/review', (req, res, next) => {
    try {
        res.json(extensions.extensionReview(req.body));
    }
    catch (e) {
        next(e);
    }
});
fleetAdvancedRouter.post('/extensions/install', (req, res, next) => {
    try {
        res.status(201).json(extensions.installExtension(req.body?.manifest, req.body?.digest, { kind: 'local-admin-import', owner: req.auth!.sub, at: Date.now() }));
        audit(req, 'extension.install');
    }
    catch (e) {
        next(e);
    }
});
fleetAdvancedRouter.post('/extensions/:id/enabled', (req, res, next) => {
    try {
        if (typeof req.body?.enabled !== 'boolean')
            throw new HttpError(400, 'enabled must be boolean');
        extensions.toggleExtension(req.params.id, req.body.enabled);
        audit(req, 'extension.toggle', req.params.id);
        res.json({ ok: true });
    }
    catch (e) {
        next(e);
    }
});
fleetAdvancedRouter.post('/extensions/:id/rollback', (req, res, next) => {
    try {
        res.json(extensions.rollbackExtension(req.params.id));
        audit(req, 'extension.rollback', req.params.id);
    }
    catch (e) {
        next(e);
    }
});
fleetAdvancedRouter.get('/community', (_req, res) => res.json({ sources: community.catalogSources(), installations: community.catalogInstallations() }));
fleetAdvancedRouter.post('/community/sources', (req, res, next) => {
    try {
        res.status(201).json(community.addCatalogSource(req.body ?? {}));
        audit(req, 'community.source.add');
    }
    catch (e) {
        next(e);
    }
});
fleetAdvancedRouter.post('/community/sources/:id/enabled', (req, res, next) => {
    try {
        community.toggleCatalogSource(req.params.id, req.body?.enabled === true);
        audit(req, 'community.source.toggle', req.params.id);
        res.json({ ok: true });
    }
    catch (e) {
        next(e);
    }
});
fleetAdvancedRouter.post('/community/sources/:id/sync', asyncHandler(async (req, res) => { res.json(await community.syncCatalog(req.params.id)); audit(req, 'community.sync', req.params.id); }));
fleetAdvancedRouter.post('/community/review', asyncHandler(async (req, res) => res.json(await community.reviewCatalogRelease(String(req.body?.sourceId), String(req.body?.packageId), String(req.body?.version)))));
fleetAdvancedRouter.post('/community/install', asyncHandler(async (req, res) => { res.status(201).json(await community.installCatalogRelease(req.auth!.sub, req.body ?? {})); audit(req, 'community.install', String(req.body?.packageId)); }));
export const enrollmentPublicRouter = Router();
enrollmentPublicRouter.get('/:id/bundle', (req, res, next) => {
    try {
        const token = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
        res.set('Cache-Control', 'no-store').sendFile(enrollment.enrollmentBundle(req.params.id, token));
    }
    catch (e) {
        next(e);
    }
});
enrollmentPublicRouter.post('/:id/complete', asyncHandler(async (req, res) => { const token = req.headers.authorization?.replace(/^Bearer /, '') ?? ''; res.json(await enrollment.completeEnrollment(req.params.id, token, req.body?.nodeKey)); }));
export const recoveryDownloadRouter = Router();
recoveryDownloadRouter.get('/download/:id', (req, res, next) => {
    try {
        const token = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
        res.set('Cache-Control', 'no-store').sendFile(recovery.resolveRecoveryDownload(req.params.id, token));
    }
    catch (e) {
        next(e);
    }
});
export const billingInboundRouter = Router();
billingInboundRouter.post('/events/:connectionId', express.raw({ type: 'application/json', limit: '64kb' }), asyncHandler(async (req, res) => {
    if (!Buffer.isBuffer(req.body))
        throw new HttpError(400, 'Raw JSON billing payload required');
    const id = req.get('X-Outpost-Event-Id') ?? '', connection = billing.verifyBillingSignature(req.params.connectionId, id, req.get('X-Outpost-Timestamp') ?? '', req.get('X-Outpost-Signature') ?? '', req.body);
    res.set('Cache-Control', 'no-store').json(await billing.acceptBillingEvent(req, connection, id, req.body));
}));
export const extensionUserRouter = Router();
extensionUserRouter.use(requireAuth);
extensionUserRouter.get('/', (req, res) => res.json({ extensions: extensions.extensionRows().filter(r => r.enabled).map(r => ({ id: r.id, name: r.manifest.name, version: r.manifest.version, pages: r.manifest.pages.map(p => ({ id: p.id, title: p.title, permissions: p.permissions })) })) }));
extensionUserRouter.get('/:id/pages/:page', (req, res, next) => {
    try {
        res.json(extensions.extensionPage(req, req.params.id, req.params.page, typeof req.query.serverId === 'string' ? req.query.serverId : undefined));
    }
    catch (e) {
        next(e);
    }
});
extensionUserRouter.post('/:id/actions/:action', asyncHandler(async (req, res) => { const result = await extensions.invokeExtension(req, req.params.id, req.params.action, req.body?.input, typeof req.query.serverId === 'string' ? req.query.serverId : undefined); logAudit(req.auth!.sub, req.auth!.username, 'extension.action', typeof req.query.serverId === 'string' ? req.query.serverId : undefined, req.params.id + ':' + req.params.action); res.json(result); }));
export const capacityNodeRouter = Router();
capacityNodeRouter.get('/', (_req, res) => res.json(capacity.localCapacity()));
capacityNodeRouter.post('/reserve', (req, res, next) => {
    try {
        res.json(capacity.reserveLocalCapacity(String(req.body?.id), req.body?.request));
    }
    catch (e) {
        next(e);
    }
});
capacityNodeRouter.post('/release', (req, res, next) => {
    try {
        capacity.releaseCapacity(String(req.body?.id));
        res.json({ ok: true });
    }
    catch (e) {
        next(e);
    }
});
capacityNodeRouter.post('/provision', asyncHandler(async (req, res) => { nodeProvisionIdentity(req); await provisionReserved(req, res); }));
export const recoveryNodeRouter = Router();
recoveryNodeRouter.post('/snapshot', asyncHandler(async (req, res) => res.json(await recovery.prepareRecoverySnapshot(String(req.body?.id), String(req.body?.serverId), String(req.body?.publicUrl)))));
recoveryNodeRouter.post('/import', asyncHandler(async (req, res) => res.status(201).json(await recovery.importRecoverySnapshot(String(req.body?.id), req.body?.snapshot, req.body?.request))));
recoveryNodeRouter.post('/fence', (req, res, next) => {
    try {
        res.json(recovery.setRecoveryFence(String(req.body?.serverId), String(req.body?.id), req.body?.active === true, String(req.body?.reason)));
    }
    catch (e) {
        next(e);
    }
});
recoveryNodeRouter.get('/status/:id', (req, res, next) => {
    try {
        res.json(recovery.destinationRecoveryStatus(req.params.id));
    }
    catch (e) {
        next(e);
    }
});
