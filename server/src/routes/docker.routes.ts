import { Router, type Request } from 'express';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { requireAuth } from '../auth/middleware.js';
import { engineSocket, getEngineStatus, type EngineStatus } from '../services/containerService.js';
import { NativeContainerClient, CONTAINER_ACTIONS, type ContainerEngine } from '../services/nativeContainerService.js';
import { getUserById, logAudit } from '../services/userService.js';
import { getServer } from '../services/serverService.js';
import { isRunning } from '../services/processManager.js';

interface Dependencies {
  status: (force?: boolean) => EngineStatus;
  client: (engine: ContainerEngine) => NativeContainerClient;
  socket: typeof engineSocket;
  supervised?: (instanceId: string) => boolean;
}
function currentAdmin(req: Request) { return getUserById(req.auth!.sub)?.role === 'admin'; }
export function createDockerRouter(deps: Dependencies = { status: getEngineStatus, client: (engine) => new NativeContainerClient(engine), socket: engineSocket }) {
  const router = Router(); router.use(requireAuth);
  const client = () => {
    const status = deps.status();
    if (!status.available || !status.engine) throw new HttpError(503, status.error || 'Container engine unavailable');
    return deps.client(status.engine);
  };
  const link = (instanceId: string | null) => {
    const server = instanceId ? getServer(instanceId) : undefined;
    return server?.platform === 'docker' ? { id: server.id, name: server.name, supervised: (deps.supervised ?? isRunning)(server.id) } : null;
  };
  router.get('/', asyncHandler(async (req, res) => {
    const engine = deps.status(req.query.refresh === '1');
    if (!engine.available || !engine.engine || !currentAdmin(req)) {
      res.json({ engine, counts: null, containers: [], socket: null }); return;
    }
    const engineClient = deps.client(engine.engine);
    const [containers, images] = await Promise.all([engineClient.list(), engineClient.imageCount()]);
    res.set('Cache-Control', 'no-store').json({ engine, counts: { containers: containers.length, running: containers.filter((c) => c.state === 'running').length, images }, containers: containers.map((c) => ({ ...c, instance: link(c.instanceId) })), socket: deps.socket() });
  }));
  router.use('/containers', (req, res, next) => {
    if (!currentAdmin(req)) return res.status(403).json({ error: 'Current administrator access required to manage host containers' });
    next();
  });
  router.get('/containers/:id', asyncHandler(async (req, res) => {
    const container = await client().details(req.params.id);
    res.set('Cache-Control', 'no-store').json({ container: { ...container, instance: link(container.instanceId) } });
  }));
  router.get('/containers/:id/logs', asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store').json({ logs: await client().logs(req.params.id) });
  }));
  const writable = async (req: Request) => {
    const engineClient = client(); const container = await engineClient.details(req.params.id);
    if (link(container.instanceId)?.supervised) throw new HttpError(409, 'This container has an active Outpost supervisor. Use its instance controls to keep power and restart policies in sync.');
    return { engineClient, container };
  };
  router.post('/containers/:id/action', asyncHandler(async (req, res) => {
    if (!CONTAINER_ACTIONS.includes(req.body?.action)) throw new HttpError(400, 'Unknown container action');
    const { engineClient, container } = await writable(req);
    if (req.body.action === 'remove' && req.body.confirmation !== container.name) throw new HttpError(400, 'Confirm removal with the exact container name');
    await engineClient.action(container.id, req.body.action);
    logAudit(req.auth!.sub, req.auth!.username, `container.${req.body.action}`, container.id, container.name);
    res.json({ ok: true });
  }));
  router.put('/containers/:id', asyncHandler(async (req, res) => {
    const { engineClient, container } = await writable(req);
    await engineClient.update(container.id, req.body);
    logAudit(req.auth!.sub, req.auth!.username, 'container.update', container.id, JSON.stringify(req.body).slice(0, 1000));
    res.json({ ok: true });
  }));
  return router;
}
export const dockerRouter = createDockerRouter();
