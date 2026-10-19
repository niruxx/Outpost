import { Router } from 'express';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import {
  SETTING_STEAMCMD_SOURCE,
  clearSetting,
  getSystemSettings,
  setSetting,
} from '../services/systemSettingsService.js';
import { logAudit } from '../services/userService.js';
import { getSandboxStatus, setSandboxEnabled } from '../services/sandboxService.js';
import { curseforgeStatus, saveCurseforgeKey } from '../services/curseforgeService.js';

export const settingsRouter = Router();
settingsRouter.use(requireAuth, requireRole('admin'));

settingsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(getSystemSettings());
  })
);

settingsRouter.put(
  '/',
  asyncHandler(async (req, res) => {
    const { steamcmdSource } = req.body ?? {};
    if (steamcmdSource !== undefined) {
      if (typeof steamcmdSource !== 'string') throw new HttpError(400, 'steamcmdSource must be a string');
      if (steamcmdSource.trim()) {
        setSetting(SETTING_STEAMCMD_SOURCE, steamcmdSource.trim());
      } else {
        clearSetting(SETTING_STEAMCMD_SOURCE);
      }
    }
    logAudit(req.auth!.sub, req.auth!.username, 'settings.update');
    res.json(getSystemSettings());
  })
);

/** Process sandbox (bubblewrap) status and the global switch. */
settingsRouter.get(
  '/security',
  asyncHandler(async (_req, res) => {
    res.json({ sandbox: getSandboxStatus() });
  })
);

settingsRouter.put(
  '/security',
  asyncHandler(async (req, res) => {
    const { sandboxEnabled } = req.body ?? {};
    if (typeof sandboxEnabled !== 'boolean') throw new HttpError(400, 'sandboxEnabled must be a boolean');
    setSandboxEnabled(sandboxEnabled);
    logAudit(req.auth!.sub, req.auth!.username, 'settings.sandbox', undefined, String(sandboxEnabled));
    res.json({ sandbox: getSandboxStatus() });
  })
);

/** CurseForge API key for add-on search (the key itself is never sent back). */
settingsRouter.get(
  '/curseforge',
  asyncHandler(async (_req, res) => {
    res.json(curseforgeStatus());
  })
);

settingsRouter.put(
  '/curseforge',
  asyncHandler(async (req, res) => {
    const raw = req.body?.apiKey;
    if (raw !== null && typeof raw !== 'string') throw new HttpError(400, 'apiKey must be a string or null');
    const key = typeof raw === 'string' ? raw.trim() : '';
    if (key && !/^[\x21-\x7e]{10,200}$/.test(key)) throw new HttpError(400, 'That doesn’t look like a CurseForge API key');
    await saveCurseforgeKey(key || null);
    logAudit(req.auth!.sub, req.auth!.username, 'settings.curseforge', undefined, key ? 'key saved' : 'key removed');
    res.json(curseforgeStatus());
  })
);
