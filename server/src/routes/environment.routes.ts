import { scanIncomingUploads } from './antivirus.routes.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import {
  assertNoServersRunning,
  exportEnvironment,
  importEnvironment,
  resetEnvironment,
  validateEnvironmentArchive,
} from '../services/environmentBackupService.js';
import { authenticate, logAudit } from '../services/userService.js';
import { logger } from '../utils/logger.js';

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

environmentRouter.get(
  '/export',
  asyncHandler(async (req, res) => {
    const { filePath, fileName } = await exportEnvironment();
    logAudit(req.auth!.sub, req.auth!.username, 'environment.export');
    res.download(filePath, fileName, (err) => {
      fs.rm(filePath, { force: true }, () => {});
      if (err) logger.warn('Environment export download did not complete cleanly', err);
    });
  })
);

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
