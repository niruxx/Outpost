import { getServer } from '../services/serverService.js';
import { Router, type Request } from 'express';
import { requireAuth, requirePermission, requireServerAccess } from '../auth/middleware.js';
import { authorizeFiles } from './fileWorkspace.routes.js';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { logAudit } from '../services/userService.js';
import { readWorkflow, appendWorkflow } from '../services/workflowStore.js';
import * as reliability from '../services/reliabilityService.js';
import * as backups from '../services/verifiedBackupService.js';
export const reliabilityRouter = Router({ mergeParams: true });
reliabilityRouter.use(requireAuth, (req, _res, next) => { try {
    authorizeFiles(req, null);
    next();
}
catch (e) {
    next(e);
} }, requireServerAccess());
const permission = (req: Request, p: Parameters<typeof requirePermission>[1]) => { authorizeFiles(req, null); requirePermission(req, p); };
reliabilityRouter.get('/', (req: Request, res, next) => {
    try {
        permission(req, 'files.read');
        const id = req.params.serverId;
        res.json({ health: reliability.healthConfig(id), alerts: readWorkflow('health-alerts', id, []), maintenance: reliability.maintenanceRows(id).map(m => ({ ...m, dependencies: m.dependencies.filter(d => d.id === id) })), backups: backups.backupEstimate(id), verification: readWorkflow('verification', id, []), recovery: readWorkflow('restore-recovery', id, null), preflight: readWorkflow('update-preflight', id, null) });
    }
    catch (e) {
        next(e);
    }
});
reliabilityRouter.put('/health', (req: Request, res, next) => { try {
    permission(req, 'settings');
    res.json(reliability.saveHealth(req.params.serverId, req.body ?? {}));
    logAudit(req.auth!.sub, req.auth!.username, 'health.configure', req.params.serverId);
}
catch (e) {
    next(e);
} });
reliabilityRouter.post('/maintenance', (req: Request, res, next) => { try {
    permission(req, 'power');
    const run = reliability.scheduleMaintenance(req.auth!.sub, req.body ?? {}, req.params.serverId);
    logAudit(req.auth!.sub, req.auth!.username, 'maintenance.schedule', req.params.serverId, run.id);
    res.status(201).json(run);
}
catch (e) {
    next(e);
} });
reliabilityRouter.delete('/maintenance/:id', (req: Request, res, next) => { try {
    reliability.cancelMaintenance(req.params.id, req.auth!.sub, req.params.serverId);
    logAudit(req.auth!.sub, req.auth!.username, 'maintenance.cancel', req.params.serverId, req.params.id);
    res.status(204).end();
}
catch (e) {
    next(e);
} });
reliabilityRouter.post('/preflight', asyncHandler(async (req, res) => { permission(req, 'update'); res.json(await reliability.updatePreflight(req.params.serverId)); }));
reliabilityRouter.get('/bundle', (req: Request, res, next) => { try {
    permission(req, 'files.read');
    permission(req, 'console');
    res.attachment(`outpost-diagnostics-${req.params.serverId}.json`).json(reliability.troubleshootingBundle(req.params.serverId, req.auth!.role === 'admin' || getServer(req.params.serverId)?.created_by === req.auth!.sub));
    logAudit(req.auth!.sub, req.auth!.username, 'diagnostics.export', req.params.serverId);
}
catch (e) {
    next(e);
} });
reliabilityRouter.put('/backup-policy', (req: Request, res, next) => { try {
    permission(req, 'backups.create');
    res.json(backups.saveBackupPolicy(req.params.serverId, req.body ?? {}));
}
catch (e) {
    next(e);
} });
reliabilityRouter.post('/deduplicated', asyncHandler(async (req, res) => { permission(req, 'backups.create'); const result = await backups.createDedup(req.params.serverId); logAudit(req.auth!.sub, req.auth!.username, 'backup.deduplicated', req.params.serverId, result.id); res.status(201).json(result); }));
reliabilityRouter.post('/verify', asyncHandler(async (req, res) => {
    permission(req, 'backups.create');
    permission(req, 'files.read');
    const { name, kind, restoreTest } = req.body ?? {};
    if (typeof name !== 'string' || !['zip', 'deduplicated'].includes(kind))
        throw new HttpError(400, 'Select a ZIP or deduplicated backup');
    try {
        const result = kind === 'zip' ? await backups.verifyZip(req.params.serverId, name, restoreTest === true) : await backups.verifyDedup(req.params.serverId, name, restoreTest === true);
        appendWorkflow('verification', req.params.serverId, { ...result, kind });
        logAudit(req.auth!.sub, req.auth!.username, 'backup.verify', req.params.serverId, name);
        res.json(result);
    }
    catch (e) {
        appendWorkflow('verification', req.params.serverId, { name, kind, at: Date.now(), ok: false, error: (e as Error).message });
        throw e;
    }
}));
reliabilityRouter.post('/deduplicated/:id/restore', asyncHandler(async (req, res) => {
    permission(req, 'backups.restore');
    if (req.body?.confirm !== true)
        throw new HttpError(400, 'Explicit restore confirmation required');
    const result = await backups.restoreDedup(req.params.serverId, req.params.id, () => permission(req, 'backups.restore'));
    logAudit(req.auth!.sub, req.auth!.username, 'backup.restore.deduplicated', req.params.serverId, req.params.id);
    res.json(result);
}));
