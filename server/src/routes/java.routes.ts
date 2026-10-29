import { Router } from 'express';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { availableMajors, installJobs, installRuntime, listRuntimes, removeRuntime, requiredJava } from '../services/javaRuntimeService.js';
import { getUserById, logAudit } from '../services/userService.js';
import { systemJava, setSystemJava } from '../services/hostSetupService.js';
import { resetJavaDetection } from '../services/javaService.js';

/** Java version manager: list runtimes (anyone signed in), install/remove Temurin runtimes (admins). */
export const javaRouter = Router();
javaRouter.use(requireAuth);
javaRouter.get('/system-default', asyncHandler(async (_req, res) => res.set('Cache-Control', 'no-store').json(await systemJava())));
javaRouter.put('/system-default', asyncHandler(async (req, res) => {
  if (req.auth!.apiKey || getUserById(req.auth!.sub)?.role !== 'admin') throw new HttpError(403, 'Sign in with a current administrator account to change system Java');
  const command = await setSystemJava(req.body?.choice);
  resetJavaDetection();
  logAudit(req.auth!.sub, req.auth!.username, 'java.system-default', undefined, JSON.stringify(command));
  await listRuntimes(true);
  res.json(await systemJava());
}));

javaRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const [runtimes, majors] = await Promise.all([listRuntimes(req.query.refresh === '1'), availableMajors()]);
    res.json({ runtimes, ...majors, jobs: installJobs() });
  })
);

/** Which Java a Minecraft version needs. */
javaRouter.get(
  '/required',
  asyncHandler(async (req, res) => {
    const version = typeof req.query.version === 'string' ? req.query.version : '';
    if (!/^[\w.\-]{1,40}$/.test(version)) throw new HttpError(400, 'version required');
    res.json({ version, major: await requiredJava(version) });
  })
);

function majorParam(raw: unknown): number {
  const major = Number(raw);
  if (!Number.isInteger(major) || major < 8 || major > 99) throw new HttpError(400, 'Pick a Java version between 8 and 99');
  return major;
}

javaRouter.post(
  '/install',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const major = majorParam(req.body?.major);
    const job = installRuntime(major);
    logAudit(req.auth!.sub, req.auth!.username, 'java.install', undefined, `Java ${major}`);
    res.status(202).json({ job });
  })
);

javaRouter.delete(
  '/:major',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const major = majorParam(req.params.major);
    if (!removeRuntime(major)) throw new HttpError(404, `Java ${major} wasn’t installed by Outpost`);
    logAudit(req.auth!.sub, req.auth!.username, 'java.remove', undefined, `Java ${major}`);
    res.json({ ok: true });
  })
);
