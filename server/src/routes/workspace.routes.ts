import { Router } from 'express';
import crypto from 'node:crypto';
import { prep } from '../db/db.js';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { requireAuth, requireConfigItems, requirePermission, requireRole, requireServerAccess } from '../auth/middleware.js';
import { previewGameChange } from '../services/changePreviewService.js';
import { getUserById, logAudit, userHasServerAccess } from '../services/userService.js';
import { readPreference, savePreference, configPreview, performUiAction, permissionReport } from '../services/uiWorkspaceService.js';
import { fleetInventory, remoteNode } from '../services/fleetService.js';
import { jobRows } from '../services/jobService.js';
import { getServer, listServers } from '../services/serverService.js';
import { getDiskUsage } from '../services/diskUsageService.js';

export const workspaceRouter = Router();
workspaceRouter.use(requireAuth, (req, _res, next) => {
  const user = getUserById(req.auth!.sub);
  if (!user) return next(new HttpError(401, 'Current account required'));
  req.auth!.role = user.role; next();
});
workspaceRouter.get('/preferences/:kind', (req, res) => res.json({ value: readPreference(req.auth!.sub, req.params.kind) }));
workspaceRouter.put('/preferences/:kind', (req, res, next) => { try { res.json({ value: savePreference(req.auth!.sub, req.params.kind, req.body?.value) }); } catch (err) { next(err); } });
workspaceRouter.get('/jobs', (req, res) => {
  const admin = req.auth!.role === 'admin';
  res.json({ jobs: jobRows().filter(j => admin || (j.server_id && getServer(j.server_id) && !getServer(j.server_id)!.suspended && userHasServerAccess(req.auth!.sub, j.server_id))) });
});
workspaceRouter.get('/summary', (req, res) => res.json({ storage: listServers().filter(s => req.auth!.role === 'admin' || (!s.suspended && userHasServerAccess(req.auth!.sub, s.id))).map(s => ({ name: s.name, bytes: getDiskUsage(s.id).serverBytes })) }));
workspaceRouter.post('/preview/:serverId', requireServerAccess(), (req, res, next) => { try { requireConfigItems(req, 'setting', req.body?.patch ?? {}); res.json(configPreview(req.params.serverId, req.body?.patch)); } catch (err) { next(err); } });
workspaceRouter.post('/game-preview/:serverId/:kind', requireServerAccess(), (req, res, next) => { try { requirePermission(req, 'settings'); res.json(previewGameChange(req.params.serverId, req.params.kind, req.body ?? {})); } catch (err) { next(err); } });
workspaceRouter.post('/apply/:serverId', requireServerAccess(), asyncHandler(async (req, res) => {
  requireConfigItems(req, 'setting', req.body?.patch ?? {});
  await performUiAction(req.params.serverId, 'configure', req.body?.patch, req.body?.revision);
  logAudit(req.auth!.sub, req.auth!.username, 'configuration.review.apply', req.params.serverId); res.json({ ok: true });
}));
workspaceRouter.get('/permissions/:userId/:serverId', requireRole('admin'), (req, res, next) => { try { res.json(permissionReport(req.params.userId, req.params.serverId)); } catch (err) { next(err); } });
workspaceRouter.get('/fleet', requireRole('admin'), asyncHandler(async (_req, res) => res.json({ nodes: await fleetInventory() })));

interface Target { nodeId: string; serverId: string; name: string; revision?: string; changes?: unknown; error?: string; state: 'ready' | 'failed' | 'running' | 'completed' | 'cancelled' | 'uncertain' }
interface Run { id: string; user_id: string; action: string; patch: string | null; results: string; cancel: number; status: string; created_at: number }
const runs = () => prep('SELECT * FROM ui_bulk_runs ORDER BY created_at DESC LIMIT 50').all() as unknown as Run[];
const shape = (r: Run) => ({ ...r, patch: r.patch ? JSON.parse(r.patch) : null, results: JSON.parse(r.results) as Target[] });
const actions = ['start', 'stop', 'restart', 'backup', 'configure'];
function targets(input: unknown): Target[] {
  if (!Array.isArray(input) || !input.length || input.length > 100 || !input.every(t => t && typeof t.nodeId === 'string' && typeof t.serverId === 'string' && t.nodeId.length <= 100 && /^[\w-]{1,100}$/.test(t.serverId))) throw new HttpError(400, 'Choose 1–100 instance targets');
  return [...new Map(input.map(t => [`${t.nodeId}:${t.serverId}`, { nodeId: t.nodeId, serverId: t.serverId, name: t.serverId, state: 'ready' as const }])).values()];
}
async function previewTargets(action: string, rows: Target[], patch: unknown) {
  const inventory = await fleetInventory();
  for (const row of rows) {
    try {
      const node = inventory.find(n => n.id === row.nodeId), server = node?.inventory?.servers.find(s => s.id === row.serverId);
      if (!node || node.error || !server) throw new HttpError(409, 'Host unavailable or instance missing');
      row.name = `${node.name} / ${server.name}`;
      if (action === 'configure') {
        const preview = row.nodeId === 'local' ? configPreview(row.serverId, patch) : await remoteNode<ReturnType<typeof configPreview>>(row.nodeId, '/workspace/preview', { serverId: row.serverId, patch });
        row.revision = preview.revision; row.changes = preview.changes;
      } else {
        const allowed = action === 'start' ? ['stopped', 'crashed'] : ['stop', 'restart'].includes(action) ? ['running'] : ['stopped', 'running', 'crashed'];
        if (!allowed.includes(server.status)) throw new HttpError(409, `Cannot ${action} an instance in ${server.status} state`);
      }
    } catch (err) { row.state = 'failed'; row.error = err instanceof Error ? err.message : 'Preview failed'; }
  }
  return rows;
}
workspaceRouter.post('/bulk/preview', requireRole('admin'), asyncHandler(async (req, res) => {
  if (!actions.includes(req.body?.action)) throw new HttpError(400, 'Choose a supported action');
  const rows = await previewTargets(req.body.action, targets(req.body.targets), req.body.patch);
  const id = crypto.randomUUID();
  prep('INSERT INTO ui_bulk_runs(id,user_id,action,patch,results,status,created_at) VALUES (?,?,?,?,?,?,?)').run(id, req.auth!.sub, req.body.action, req.body.action === 'configure' ? JSON.stringify(req.body.patch ?? null) : null, JSON.stringify(rows), 'preview', Date.now());
  res.json(shape(runs().find(r => r.id === id)!));
}));
async function execute(run: Run) {
  const rows = JSON.parse(run.results) as Target[];
  const save = () => prep('UPDATE ui_bulk_runs SET results=? WHERE id=?').run(JSON.stringify(rows), run.id);
  for (const row of rows) {
    if (row.state !== 'ready') continue;
    const current = prep('SELECT cancel FROM ui_bulk_runs WHERE id=?').get(run.id) as { cancel: number } | undefined;
    const user = getUserById(run.user_id);
    if (!current || current.cancel || !user || user.disabled || user.role !== 'admin') { row.state = 'cancelled'; save(); continue; }
    row.state = 'running'; save();
    try {
      const patch = run.patch ? JSON.parse(run.patch) : undefined;
      if (row.nodeId === 'local') await performUiAction(row.serverId, run.action, patch, row.revision);
      else await remoteNode(row.nodeId, '/workspace/action', { serverId: row.serverId, action: run.action, patch, revision: row.revision });
      row.state = 'completed';
      logAudit(user.id, user.username, `fleet.bulk.${run.action}`, row.serverId, row.nodeId);
    } catch (err) { row.state = row.nodeId === 'local' || (err instanceof HttpError && err.status === 409) ? 'failed' : 'uncertain'; row.error = err instanceof Error ? err.message : 'Action failed'; }
    save();
  }
  prep("UPDATE ui_bulk_runs SET status='finished' WHERE id=?").run(run.id);
}
workspaceRouter.get('/bulk', requireRole('admin'), (_req, res) => res.json({ runs: runs().map(shape) }));
workspaceRouter.post('/bulk/:id/run', requireRole('admin'), (req, res, next) => {
  try {
    const run = runs().find(r => r.id === req.params.id); if (!run || run.status !== 'preview') throw new HttpError(409, 'Preview again before running');
    if (Date.now() - run.created_at > 15 * 60_000) throw new HttpError(409, 'Preview expired; preview again');
    const locked = prep("UPDATE ui_bulk_runs SET status='running' WHERE id=? AND status='preview'").run(run.id); if (!locked.changes) throw new HttpError(409, 'Already started');
    void execute(run).catch(() => prep("UPDATE ui_bulk_runs SET status='interrupted' WHERE id=?").run(run.id));
    res.status(202).json({ ok: true });
  } catch (err) { next(err); }
});
workspaceRouter.post('/bulk/:id/cancel', requireRole('admin'), (req, res) => { prep("UPDATE ui_bulk_runs SET cancel=1 WHERE id=? AND status='running'").run(req.params.id); res.json({ ok: true }); });
export function recoverBulkRuns() { prep("UPDATE ui_bulk_runs SET status='interrupted' WHERE status='running'").run(); }
