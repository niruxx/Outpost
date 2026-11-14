import { Router, type Request } from 'express';
import { requireAuth, requirePermission, requireServerAccess } from '../auth/middleware.js';
import { authorizeFiles } from './fileWorkspace.routes.js';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { logAudit } from '../services/userService.js';
import { readWorkflow } from '../services/workflowStore.js';
import * as games from '../services/gameWorkflowService.js';
import * as updates from '../services/gameUpdateWorkflowService.js';
import * as sleep from '../services/minecraftSleepService.js';
import * as fastdl from '../services/fastdlService.js';
import { authorizeWorkflowActor } from '../services/reliabilityService.js';
export const gameWorkflowsRouter = Router({ mergeParams: true });
gameWorkflowsRouter.use(requireAuth, (req, _res, next) => { try {
    authorizeFiles(req, null);
    next();
}
catch (e) {
    next(e);
} }, requireServerAccess());
function check(req: Request, p: Parameters<typeof requirePermission>[1], admin = false) { authorizeFiles(req, null); requirePermission(req, p); if (admin && req.auth!.role !== 'admin')
    throw new HttpError(403, 'This host-wide integration requires an administrator'); }
function allowed(req: Request, p: Parameters<typeof requirePermission>[1]) { try {
    check(req, p);
    return true;
}
catch {
    return false;
} }
const audit = (req: Request, action: string, detail?: string) => logAudit(req.auth!.sub, req.auth!.username, action, req.params.serverId, detail);
gameWorkflowsRouter.get('/', (req: Request, res, next) => { try {
    check(req, 'files.read');
    const id = req.params.serverId;
    res.json({ ports: games.portBundle(id), suggestedPorts: games.suggestedPorts(id), profiles: games.configurationProfiles(req.auth!.sub), managed: allowed(req, 'plugins') ? updates.managedMods(id) : [], modPlan: allowed(req, 'plugins') ? readWorkflow('mod-plan', id, null) : null, staging: req.auth!.role === 'admin' ? updates.stagingRows(id) : [], imports: readWorkflow('world-import-checks', id, []), matches: allowed(req, 'players') ? games.matchHistory(id) : [], bans: allowed(req, 'players') ? games.timedBans(id) : [], profiler: allowed(req, 'console') ? games.profilerReport(id) : null, sleep: sleep.sleepStatus(id), fastdl: fastdl.fastdlInfo(id), fastdlVerification: readWorkflow('fastdl-verification', id, null), sharedBans: req.auth!.role === 'admin' ? games.sharedBans() : undefined });
}
catch (e) {
    next(e);
} });
gameWorkflowsRouter.put('/ports', (req: Request, res, next) => { try {
    check(req, 'settings', true);
    const result = games.allocatePortBundle(req.params.serverId, req.body?.base, req.body?.roles);
    audit(req, 'ports.bundle');
    res.json(result);
}
catch (e) {
    next(e);
} });
gameWorkflowsRouter.post('/profiles', (req: Request, res, next) => { try {
    check(req, 'files.write');
    const p = games.saveConfigurationProfile(req.auth!.sub, req.params.serverId, req.body ?? {});
    audit(req, 'profile.save', p.id);
    res.status(201).json(p);
}
catch (e) {
    next(e);
} });
gameWorkflowsRouter.post('/profiles/preview', (req: Request, res, next) => { try {
    check(req, 'files.read');
    res.json(games.previewProfile(req.auth!.sub, req.params.serverId, String(req.body?.profile), Number(req.body?.version), req.body?.selected));
}
catch (e) {
    next(e);
} });
gameWorkflowsRouter.post('/profiles/apply', asyncHandler(async (req, res) => { check(req, 'files.write'); check(req, 'backups.create'); const result = await games.applyProfile(req.auth!.sub, req.params.serverId, req.body ?? {}, () => { check(req, 'files.write'); check(req, 'backups.create'); }); audit(req, 'profile.apply', String(req.body?.profile)); res.json(result); }));
gameWorkflowsRouter.post('/mods/plan', asyncHandler(async (req, res) => { check(req, 'plugins'); const result = await updates.planModUpdate(req.params.serverId, req.auth!.sub, req.body?.projects); audit(req, 'mods.plan', result.id); res.json(result); }));
gameWorkflowsRouter.post('/mods/apply', asyncHandler(async (req, res) => { check(req, 'plugins'); check(req, 'backups.create'); const result = await updates.applyModUpdate(req.params.serverId, req.auth!.sub, String(req.body?.plan), () => { check(req, 'plugins'); check(req, 'backups.create'); }); audit(req, 'mods.apply'); res.json(result); }));
gameWorkflowsRouter.post('/mods/rollback', asyncHandler(async (req, res) => { check(req, 'plugins'); const result = await updates.rollbackModSet(req.params.serverId, () => check(req, 'plugins')); audit(req, 'mods.rollback'); res.json(result); }));
gameWorkflowsRouter.post('/world/check', asyncHandler(async (req, res) => { check(req, 'files.read'); if (typeof req.body?.path !== 'string')
    throw new HttpError(400, 'Select an uploaded world path'); const result = await updates.inspectWorldImport(req.params.serverId, req.body.path, req.body.requirements ?? []); audit(req, 'world.import.check', req.body.path); res.json(result); }));
gameWorkflowsRouter.post('/staging', asyncHandler(async (req, res) => { check(req, 'files.write', true); const result = await updates.cloneForStaging(req.params.serverId, req.auth!.sub, Number(req.body?.port), () => check(req, 'files.write', true)); audit(req, 'staging.clone', result.clone); res.status(201).json(result); }));
gameWorkflowsRouter.post('/staging/:id/review', asyncHandler(async (req, res) => { check(req, 'files.write', true); const run = updates.stagingRows(req.params.serverId).find(r => r.id === req.params.id); if (!run)
    throw new HttpError(404, 'Staging run unavailable'); const result = await updates.reviewPromotion(req.params.serverId, req.params.id, () => authorizeWorkflowActor(req.auth!.sub, [req.params.serverId, run.clone], ['files.read', 'files.write'])); res.json(result); }));
gameWorkflowsRouter.post('/staging/:id/promote', asyncHandler(async (req, res) => { check(req, 'files.write', true); check(req, 'backups.create'); const run = updates.stagingRows(req.params.serverId).find(r => r.id === req.params.id); if (!run)
    throw new HttpError(404, 'Staging run unavailable'); const result = await updates.promoteStaging(req.params.serverId, req.params.id, String(req.body?.revision), () => authorizeWorkflowActor(req.auth!.sub, [req.params.serverId, run.clone], ['files.write', 'backups.create'])); audit(req, 'staging.promote', req.params.id); res.json(result); }));
gameWorkflowsRouter.post('/staging/rollback', asyncHandler(async (req, res) => { check(req, 'backups.restore', true); if (req.body?.confirm !== true)
    throw new HttpError(400, 'Confirm promotion rollback'); res.json(await updates.rollbackStaging(req.params.serverId, () => check(req, 'backups.restore', true))); audit(req, 'staging.rollback'); }));
gameWorkflowsRouter.get('/players', (req: Request, res, next) => { try {
    check(req, 'players');
    res.json({ players: games.playerDirectory(req.params.serverId, String(req.query.q ?? '').slice(0, 100)) });
}
catch (e) {
    next(e);
} });
gameWorkflowsRouter.post('/players/note', (req: Request, res, next) => { try {
    check(req, 'players');
    games.addModerationNote(req.params.serverId, req.auth!.sub, req.body?.name, req.body?.note);
    audit(req, 'player.note', String(req.body?.name));
    res.json({ ok: true });
}
catch (e) {
    next(e);
} });
gameWorkflowsRouter.post('/players/ban', (req: Request, res, next) => { try {
    check(req, 'players');
    res.json(games.banPlayer(req.params.serverId, req.auth!.sub, req.body ?? {}));
    audit(req, 'player.ban.timed', String(req.body?.name));
}
catch (e) {
    next(e);
} });
gameWorkflowsRouter.put('/shared-bans', (req: Request, res, next) => { try {
    check(req, 'players', true);
    res.json(games.saveSharedBans(req.body?.bans));
    audit(req, 'player.shared-bans.save');
}
catch (e) {
    next(e);
} });
gameWorkflowsRouter.post('/shared-bans/apply', (req: Request, res, next) => { try {
    check(req, 'players', true);
    res.json(games.applySharedBans(req.params.serverId));
    audit(req, 'player.shared-bans.apply');
}
catch (e) {
    next(e);
} });
gameWorkflowsRouter.post('/matches', (req: Request, res, next) => { try {
    check(req, 'players');
    res.status(201).json(games.saveTournament(req.params.serverId, req.body ?? {}));
    audit(req, 'match.create');
}
catch (e) {
    next(e);
} });
gameWorkflowsRouter.post('/matches/:id/veto', (req: Request, res, next) => { try {
    check(req, 'players');
    res.json(games.vetoMap(req.params.serverId, req.params.id, String(req.body?.map)));
    audit(req, 'match.veto', String(req.body?.map));
}
catch (e) {
    next(e);
} });
gameWorkflowsRouter.post('/matches/:id/action', (req: Request, res, next) => { try {
    check(req, req.body?.action === 'prepare' ? 'files.write' : 'players');
    res.json(games.tournamentAction(req.params.serverId, req.params.id, req.body ?? {}));
    audit(req, 'match.action', String(req.body?.action));
}
catch (e) {
    next(e);
} });
gameWorkflowsRouter.post('/profiler', (req: Request, res, next) => { try {
    check(req, 'console');
    if (req.body?.consent !== true)
        throw new HttpError(400, 'Acknowledge that spark can upload reports to its viewer');
    res.json(games.profilerAction(req.params.serverId, String(req.body?.action), Number(req.body?.seconds ?? 60)));
    audit(req, 'profiler.action', String(req.body?.action));
}
catch (e) {
    next(e);
} });
gameWorkflowsRouter.put('/sleep', asyncHandler(async (req, res) => { check(req, 'power', true); res.json(await sleep.configureSleep(req.params.serverId, req.auth!.sub, req.body ?? {})); audit(req, 'sleep.configure'); }));
gameWorkflowsRouter.post('/sleep/wake', asyncHandler(async (req, res) => { check(req, 'power'); res.json(await sleep.wakeMinecraft(req.params.serverId)); audit(req, 'sleep.wake'); }));
gameWorkflowsRouter.post('/fastdl', asyncHandler(async (req, res) => { check(req, 'files.read', true); res.json(await fastdl.publishFastdl(req.params.serverId, req.body ?? {}, () => check(req, 'files.read', true))); audit(req, 'fastdl.publish'); }));
gameWorkflowsRouter.delete('/fastdl', (req: Request, res, next) => { try {
    check(req, 'files.read', true);
    fastdl.disableFastdl(req.params.serverId);
    audit(req, 'fastdl.disable');
    res.status(204).end();
}
catch (e) {
    next(e);
} });
gameWorkflowsRouter.post('/fastdl/verify', asyncHandler(async (req, res) => { check(req, 'files.read', true); res.json(await fastdl.verifyFastdl(req.params.serverId)); }));
export const fastdlPublicRouter = Router();
fastdlPublicRouter.get('/:serverId/*', (req: Request, res, next) => { try {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.sendFile(fastdl.resolveFastdl(req.params.serverId, req.params[0]));
}
catch (e) {
    next(e);
} });
