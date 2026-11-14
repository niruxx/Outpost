import { scanIncomingUploads } from './antivirus.routes.js';
import { Router } from 'express';
import multer from 'multer';
import { requireAuth, requirePermission, requireServerAccess } from '../auth/middleware.js';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { getServer } from '../services/serverService.js';
import { isRunning, sendCommand } from '../services/processManager.js';
import { logAudit } from '../services/userService.js';
import { installTf2Frameworks } from '../services/tf2FrameworkService.js';
import { appendLine } from '../services/consoleLogService.js';
import { GAMERULE_PRESETS, RULES, gamerulesOf, gameruleCommands, saveGamerules, supportsGamerules, usesModernGamerules } from '../services/gameruleService.js';
import { TF2_PRESETS, isTf2, tf2SettingsOf, saveTf2, tf2Content, tf2Map, installTf2Upload, tf2PluginAction, writeTf2Configs, tf2FrameworkJobs as frameworkJobs } from '../services/tf2Service.js';

export const gameCustomizationRouter = Router({ mergeParams: true });
gameCustomizationRouter.use(['/gamerules', '/tf2'], requireAuth, requireServerAccess());
function serverOf(id: string, game: 'minecraft' | 'tf2') {
  const server = getServer(id);
  if (!server) throw new HttpError(404, 'Server not found');
  if (!(game === 'tf2' ? isTf2(server) : supportsGamerules(server))) throw new HttpError(400, `This instance does not support ${game === 'tf2' ? 'TF2 controls' : 'Minecraft gamerules'}`);
  return server;
}
function rulesView(id: string) {
  const s = serverOf(id, 'minecraft');
  return { settings: gamerulesOf(s), presets: GAMERULE_PRESETS, rules: RULES, commands: gameruleCommands(s), modern: usesModernGamerules(s), running: s.status === 'running' && isRunning(s.id), platform: s.platform };
}
gameCustomizationRouter.get('/gamerules', asyncHandler(async (req, res) => { res.json(rulesView(req.params.serverId)); }));
gameCustomizationRouter.put('/gamerules', asyncHandler(async (req, res) => {
  requirePermission(req, 'settings');
  const s = serverOf(req.params.serverId, 'minecraft');
  saveGamerules(s, req.body ?? {});
  logAudit(req.auth!.sub, req.auth!.username, 'server.gamerules.save', s.id);
  res.json(rulesView(s.id));
}));
gameCustomizationRouter.post('/gamerules/apply', asyncHandler(async (req, res) => {
  requirePermission(req, 'settings');
  requirePermission(req, 'console');
  const s = serverOf(req.params.serverId, 'minecraft');
  if (!isRunning(s.id) || s.status !== 'running') throw new HttpError(409, 'Wait until the Minecraft server is ready');
  const commands = gameruleCommands(s);
  for (const command of commands) sendCommand(s.id, command);
  logAudit(req.auth!.sub, req.auth!.username, 'server.gamerules.apply', s.id, `${commands.length} rules sent`);
  res.json({ ...rulesView(s.id), sent: commands.length });
}));
function tf2View(id: string) {
  const s = serverOf(id, 'tf2');
  const { password, gslt, ...settings } = tf2SettingsOf(s);
  return { settings: { ...settings, hasPassword: !!password, hasGslt: !!gslt }, ...tf2Content(s), presets: TF2_PRESETS, running: isRunning(s.id), frameworkJob: frameworkJobs.get(s.id) ?? null };
}
gameCustomizationRouter.get('/tf2', asyncHandler(async (req, res) => { res.json(tf2View(req.params.serverId)); }));
gameCustomizationRouter.put('/tf2', asyncHandler(async (req, res) => {
  requirePermission(req, 'settings');
  const s = serverOf(req.params.serverId, 'tf2');
  const body = { ...(req.body ?? {}) };
  if (body.password === '') delete body.password;
  if (body.gslt === '') delete body.gslt;
  if (body.clearPassword === true) body.password = '';
  if (body.clearGslt === true) body.gslt = '';
  saveTf2(s, body);
  logAudit(req.auth!.sub, req.auth!.username, 'server.tf2.save', s.id);
  res.json(tf2View(s.id));
}));
gameCustomizationRouter.post('/tf2/action', asyncHandler(async (req, res) => {
  requirePermission(req, 'console');
  const s = serverOf(req.params.serverId, 'tf2');
  if (!isRunning(s.id) || s.status !== 'running') throw new HttpError(409, 'Start the TF2 server and wait until it is ready');
  const action = req.body?.action;
  if (action === 'changelevel') sendCommand(s.id, `changelevel ${tf2Map(req.body?.map)}`);
  else if (action === 'apply') { requirePermission(req, 'settings'); writeTf2Configs(s); sendCommand(s.id, 'exec outpost.cfg'); }
  else if (action === 'restart-round') sendCommand(s.id, 'mp_restartgame 1');
  else throw new HttpError(400, 'Unknown TF2 action');
  logAudit(req.auth!.sub, req.auth!.username, 'server.tf2.action', s.id, action);
  res.json({ ok: true });
}));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 256 * 1048576, files: 1, fields: 0 } });
for (const kind of ['map', 'mod'] as const) {
  gameCustomizationRouter.post(`/tf2/upload/${kind}`, (req, _res, next) => {
    try {
      requirePermission(req, kind === 'map' ? 'settings' : 'plugins');
      const s = serverOf(req.params.serverId, 'tf2');
      if (kind === 'mod' && isRunning(s.id)) throw new HttpError(409, 'Stop TF2 before installing mods or plugins');
      if (frameworkJobs.get(s.id)?.state === 'running') throw new HttpError(409, 'Wait for framework installation to finish');
      next();
    } catch (err) { next(err); }
  }, upload.single('file'), scanIncomingUploads, asyncHandler(async (req, res) => {
    const s = serverOf(req.params.serverId, 'tf2');
    if (kind === 'mod' && isRunning(s.id)) throw new HttpError(409, 'Stop TF2 before installing mods or plugins');
    if (frameworkJobs.get(s.id)?.state === 'running') throw new HttpError(409, 'Wait for framework installation to finish');
    if (!req.file) throw new HttpError(400, 'Choose a file to upload');
    installTf2Upload(s, req.file.originalname, req.file.buffer, kind);
    logAudit(req.auth!.sub, req.auth!.username, `server.tf2.upload.${kind}`, s.id, req.file.originalname);
    res.json(tf2View(s.id));
  }));
}
gameCustomizationRouter.post('/tf2/plugins/action', asyncHandler(async (req, res) => {
  requirePermission(req, 'plugins');
  const s = serverOf(req.params.serverId, 'tf2');
  if (isRunning(s.id)) throw new HttpError(409, 'Stop TF2 before changing mods or plugins');
  if (frameworkJobs.get(s.id)?.state === 'running') throw new HttpError(409, 'Wait for framework installation to finish');
  tf2PluginAction(s, req.body?.name, req.body?.kind, req.body?.action);
  logAudit(req.auth!.sub, req.auth!.username, 'server.tf2.plugin', s.id, `${req.body?.action}: ${req.body?.name}`);
  res.json(tf2View(s.id));
}));
gameCustomizationRouter.post('/tf2/frameworks', asyncHandler(async (req, res) => {
  requirePermission(req, 'plugins');
  const s = serverOf(req.params.serverId, 'tf2');
  if (isRunning(s.id)) throw new HttpError(409, 'Stop TF2 before installing frameworks');
  if (frameworkJobs.get(s.id)?.state === 'running') throw new HttpError(409, 'Framework installation is already running');
  frameworkJobs.set(s.id, { state: 'running' });
  logAudit(req.auth!.sub, req.auth!.username, 'server.tf2.frameworks', s.id);
  void installTf2Frameworks(s, (line) => appendLine(s.id, `[Outpost] ${line}`, 'system'))
    .then(() => { frameworkJobs.set(s.id, { state: 'done' }); })
    .catch((err) => {
      const error = err instanceof Error ? err.message : String(err);
      frameworkJobs.set(s.id, { state: 'failed', error });
      appendLine(s.id, `[Outpost] Framework installation failed: ${error}`, 'system');
    });
  res.status(202).json(tf2View(s.id));
}));
