import { scanIncomingUploads } from './antivirus.routes.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Router, urlencoded, type Request, type Response } from 'express';
import multer from 'multer';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import {
  assertNoServersRunning,
  environmentExportPreview,
  importEnvironment,
  resetEnvironment,
  validateEnvironmentArchive,
} from '../services/environmentBackupService.js';
import { authenticate, logAudit } from '../services/userService.js';
import { logger } from '../utils/logger.js';
import { legacyEnvironmentExportOptions, parseEnvironmentExportOptions, previewEnvironmentExport, streamEnvironmentExport, type EnvironmentExportOptions } from '../services/environmentExportService.js';
import { beginJob, finishJob, progressJob } from '../services/jobService.js';

export const environmentRouter = Router();
environmentRouter.use(requireAuth, requireRole('admin'));

/** Exact phrase the client must send back to confirm a factory reset — defense in depth
 * beyond the UI's own confirmation steps, in case the API is ever called directly. */
export const RESET_CONFIRM_PHRASE = 'DELETE EVERYTHING';

// Uploads can be large (a full environment including worlds), so stream straight to disk
// rather than buffering in memory like the smaller file-manager uploads do.
const upload = multer({
  storage: multer.diskStorage({ destination: os.tmpdir() }),
  limits: { fileSize: 20 * 1024 * 1024 * 1024 }, // 20 GB
});

environmentRouter.get('/export/preview', (req, res) => {
  res.json(environmentExportPreview(req.query.history !== 'exclude'));
});
environmentRouter.post('/export/preview', (req, res) => {
  res.json(previewEnvironmentExport(parseEnvironmentExportOptions(req.body)));
});

async function sendExport(req: Request, res: Response, options: EnvironmentExportOptions) {
  const cancel = new AbortController();
  const onClose = () => {
    if (!res.writableFinished) cancel.abort(new Error('Environment download was cancelled or disconnected.'));
  };
  res.once('close', onClose);
  const job = beginJob('environment-export', null, 'Checking export selection');
  try {
    if (res.destroyed) onClose();
    await streamEnvironmentExport(options, () => {
      logAudit(req.auth!.sub, req.auth!.username, 'environment.export');
      const date = new Date().toISOString().replace(/[:.]/g, '-');
      const suffix = options.includeDatabase ? 'environment' : 'files';
      res.attachment(`outpost-${suffix}-${date}.zip`);
      res.set({ 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      return res;
    }, cancel.signal, (stage) => progressJob(job, stage));
    finishJob(job);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    const disconnected = cancel.signal.aborted && (err === cancel.signal.reason || code === 'ABORT_ERR' || code === 'ERR_STREAM_PREMATURE_CLOSE');
    const failure = disconnected ? cancel.signal.reason : err;
    finishJob(job, failure);
    if (!res.headersSent && !res.destroyed) throw failure;
    if (!disconnected) logger.warn('Environment export stream failed', failure);
  } finally { res.off('close', onClose); }
}

environmentRouter.get('/export', asyncHandler((req, res) => sendExport(req, res, legacyEnvironmentExportOptions(req.query.history !== 'exclude'))));
environmentRouter.post('/export', urlencoded({ extended: false, limit: '768kb', parameterLimit: 2 }), asyncHandler((req, res) => {
  let options: unknown = req.body;
  if (req.is('application/x-www-form-urlencoded')) {
    try { options = JSON.parse(req.body?.options); }
    catch { throw new HttpError(400, 'Invalid environment export options.'); }
  }
  return sendExport(req, res, parseEnvironmentExportOptions(options));
}));

environmentRouter.post(
  '/import',
  upload.single('archive'), scanIncomingUploads,
  asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file) throw new HttpError(400, 'No archive file was uploaded');

    try {
      assertNoServersRunning();
      validateEnvironmentArchive(file.path);

      logAudit(req.auth!.sub, req.auth!.username, 'environment.import');
      const result = await importEnvironment(file.path);

      res.json({
        ok: true,
        message: 'Import applied. Outpost is restarting now — this may take a few seconds.',
        previousDataDirBackup: result.previousDataDirBackup,
      });

      // Give the response time to flush, then exit so a process manager (or the user) restarts
      // us fresh against the restored database — see environmentBackupService for why.
      setTimeout(() => process.exit(0), 400);
    } finally {
      fs.rm(file.path, { force: true }, () => {});
    }
  })
);

environmentRouter.post(
  '/reset',
  asyncHandler(async (req, res) => {
    const { confirmText, password } = req.body ?? {};

    if (confirmText !== RESET_CONFIRM_PHRASE) {
      throw new HttpError(400, `Type "${RESET_CONFIRM_PHRASE}" exactly to confirm`);
    }
    if (typeof password !== 'string' || !password) {
      throw new HttpError(400, 'Enter your password to confirm');
    }
    if (!authenticate(req.auth!.username, password)) {
      throw new HttpError(401, 'Incorrect password');
    }

    assertNoServersRunning();

    logAudit(req.auth!.sub, req.auth!.username, 'environment.reset');
    const result = await resetEnvironment();

    res.json({
      ok: true,
      message: 'Factory reset applied. Outpost is restarting now — you\'ll land on the first-run setup wizard.',
      previousDataDirBackup: result.previousDataDirBackup,
    });

    setTimeout(() => process.exit(0), 400);
  })
);
