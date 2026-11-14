import fs from 'node:fs';
import { Router, type RequestHandler, type Request } from 'express';
import { requireAuth, requireRole, requireServerAccess } from '../auth/middleware.js';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { getUserById, logAudit } from '../services/userService.js';
import { getServer } from '../services/serverService.js';
import { realtimeAntivirusStatus } from '../services/antivirusService.js';
import { allowedItems, allowFinding, revokeAllowed, disableAntivirus, antivirusDisabled, antivirusMaxFileBytes, antivirusExclusions, instanceExcluded, setInstanceExcluded, antivirusConfig, antivirusHealth, antivirusSchedules, saveAntivirusConfig, updateAntivirusSignatures, quarantineRows, deleteQuarantine, scanRows, securityHoldRows, securityHold, startInstanceScan, cancelInstanceScan, saveAntivirusSchedule, scanUploadBuffers, protectionEnabled } from '../services/antivirusService.js';

/** Place after multer, before a handler can extract or publish any uploaded file. */
export const scanIncomingUploads: RequestHandler = asyncHandler(async (req, _res, next) => {
  if (!protectionEnabled(req.params.serverId)) return next();
  const files = [ ...(req.file ? [req.file] : []), ...(Array.isArray(req.files) ? req.files : Object.values(req.files ?? {}).flat()) ];
  try { const payload = files.map(file => {
    if (file.size > antivirusMaxFileBytes()) throw new HttpError(413, 'Protected upload exceeds the configured antivirus file size limit');
    return { name: file.originalname, buffer: file.buffer ?? fs.readFileSync(file.path) };
  });
  await scanUploadBuffers(payload, req.params.serverId && getServer(req.params.serverId) ? req.params.serverId : null);
  next();
  } catch (err) { for (const file of files) if (file.path) { try { fs.unlinkSync(file.path); } catch {} } throw err; }
});
export const antivirusRouter = Router();
const currentAccount: RequestHandler = (req, _res, next) => {
  const user = getUserById(req.auth!.sub); if (!user) return next(new HttpError(401, 'Current account required')); req.auth!.role = user.role; next();
};
antivirusRouter.use(requireAuth, currentAccount, requireRole('admin'));
antivirusRouter.get('/', (_req, res) => res.json({ disabled: antivirusDisabled(), allowed: allowedItems(), excludedInstances: antivirusExclusions(), config: antivirusConfig(), realtime: realtimeAntivirusStatus(), scans: scanRows(), holds: securityHoldRows(), quarantine: quarantineRows(), schedules: antivirusSchedules(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }));
antivirusRouter.put('/exclusion/:serverId', (req, res, next) => { try { setInstanceExcluded(req.params.serverId, req.body?.excluded); logAudit(req.auth!.sub, req.auth!.username, 'security.antivirus.exclusion', req.params.serverId, JSON.stringify({ excluded: req.body.excluded })); res.json({ ok: true }); } catch (err) { next(err); } });
antivirusRouter.post('/enable', asyncHandler(async (req, res) => { const config = await saveAntivirusConfig({ ...antivirusConfig(), enabled: true }); logAudit(req.auth!.sub, req.auth!.username, 'security.antivirus.enable'); res.json({ config }); }));
antivirusRouter.post('/disable', (req, res) => { disableAntivirus(); logAudit(req.auth!.sub, req.auth!.username, 'security.antivirus.disable'); res.json({ ok: true }); });
antivirusRouter.post('/allow/:serverId', (req, res, next) => { try { const item = allowFinding(req.params.serverId, req.body?.scanId, req.body?.index); logAudit(req.auth!.sub, req.auth!.username, 'security.antivirus.allow', req.params.serverId, item.path); const hold = securityHoldRows(req.params.serverId)[0];
  const needsScan = securityHold(req.params.serverId);
  let scanQueued = false;
  if (needsScan && hold?.report?.findings?.length) {
    // Retry an incomplete scan after all recorded findings have been reviewed.
    const approved = allowedItems(req.params.serverId);
    if (hold.report.findings.every((finding: string) => approved.some(row => row.path === finding.slice(0, finding.indexOf(': '))))) {
      try { startInstanceScan(req.params.serverId); scanQueued = true; } catch { /* Approval remains saved; the UI offers a manual scan retry. */ }
    }
  }
  res.json({ ...item, needsScan, scanQueued }); } catch (err) { next(err); } });
antivirusRouter.delete('/allow/:serverId', (req, res, next) => { try { revokeAllowed(req.params.serverId, req.body?.path); logAudit(req.auth!.sub, req.auth!.username, 'security.antivirus.revoke', req.params.serverId, req.body?.path); res.json({ ok: true }); } catch (err) { next(err); } });
antivirusRouter.get('/health', asyncHandler(async (_req, res) => res.json(await antivirusHealth())));
antivirusRouter.put('/config', asyncHandler(async (req, res) => { const config = await saveAntivirusConfig(req.body); logAudit(req.auth!.sub, req.auth!.username, 'security.antivirus.configure'); res.json({ config }); }));
antivirusRouter.post('/signatures', asyncHandler(async (req, res) => { const output = await updateAntivirusSignatures(); logAudit(req.auth!.sub, req.auth!.username, 'security.antivirus.signatures'); res.json(output); }));
antivirusRouter.delete('/quarantine/:id', (req, res, next) => { try { deleteQuarantine(req.params.id); logAudit(req.auth!.sub, req.auth!.username, 'security.antivirus.quarantine.delete', undefined, req.params.id); res.json({ ok: true }); } catch (err) { next(err); } });
antivirusRouter.post('/scan/:serverId', (req, res, next) => { try { res.status(202).json(startInstanceScan(req.params.serverId)); logAudit(req.auth!.sub, req.auth!.username, 'security.antivirus.scan', req.params.serverId); } catch (err) { next(err); } });
antivirusRouter.post('/cancel/:serverId', (req, res) => { cancelInstanceScan(req.params.serverId); logAudit(req.auth!.sub, req.auth!.username, 'security.antivirus.cancel', req.params.serverId); res.json({ ok: true }); });
antivirusRouter.put('/schedule/:serverId', (req, res, next) => { try { saveAntivirusSchedule(req.params.serverId, req.body?.expression, req.body?.enabled); logAudit(req.auth!.sub, req.auth!.username, 'security.antivirus.schedule', req.params.serverId); res.json({ ok: true }); } catch (err) { next(err); } });
export const instanceAntivirusRouter = Router({ mergeParams: true });
instanceAntivirusRouter.use(requireAuth, currentAccount, requireServerAccess());
instanceAntivirusRouter.get('/', (req: Request, res) => res.json({ disabled: antivirusDisabled(), allowed: allowedItems(req.params.serverId), excluded: instanceExcluded(req.params.serverId), protectedUploads: protectionEnabled(req.params.serverId), realtimeEnabled: protectionEnabled(req.params.serverId) && antivirusConfig().realtime, hold: securityHold(req.params.serverId), holds: securityHoldRows(req.params.serverId), scans: scanRows(req.params.serverId), schedule: antivirusSchedules().find(s => s.server_id === req.params.serverId) ?? null, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }));
