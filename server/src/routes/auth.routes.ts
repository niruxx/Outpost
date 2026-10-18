import { Router } from 'express';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { requireAuth } from '../auth/middleware.js';
import { createToken } from '../auth/tokens.js';
import { authenticate, countUsers, createUser, getPublicUser, getUserById, logAudit } from '../services/userService.js';
import { getEffectiveCreation } from '../services/userService.js';
import {
  assertNotLocked,
  beginTotpSetup,
  disableTotp,
  enableTotp,
  recordSecondFactorResult,
  regenerateRecoveryCodes,
  twoFactorStatus,
  verifySecondFactor,
} from '../services/twoFactorService.js';

export const authRouter = Router();

authRouter.get(
  '/status',
  asyncHandler(async (_req, res) => {
    res.json({ setupRequired: countUsers() === 0 });
  })
);

// First-run only: creates the initial admin account. Locked out once any user exists.
authRouter.post(
  '/setup',
  asyncHandler(async (req, res) => {
    if (countUsers() > 0) throw new HttpError(409, 'Setup has already been completed');
    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || username.trim().length < 3) {
      throw new HttpError(400, 'Username must be at least 3 characters');
    }
    if (typeof password !== 'string' || password.length < 8) {
      throw new HttpError(400, 'Password must be at least 8 characters');
    }
    const user = createUser(username.trim(), password, 'admin');
    logAudit(user.id, user.username, 'setup.create_admin');
    const token = createToken(user.id, user.username, user.role);
    res.json({ token, user });
  })
);

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { username, password, code } = req.body ?? {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      throw new HttpError(400, 'Username and password are required');
    }
    const user = authenticate(username.trim(), password);
    if (!user) {
      logAudit(null, username.trim().slice(0, 64), 'auth.login_failed');
      throw new HttpError(401, 'Invalid username or password');
    }
    if (user.totp_enabled) {
      // Password was right; the client asks for the code and sends all three again.
      if (typeof code !== 'string' || !code.trim()) return res.json({ twoFactorRequired: true });
      assertNotLocked(user.id);
      const ok = verifySecondFactor(user.id, code);
      recordSecondFactorResult(user.id, ok);
      if (!ok) {
        logAudit(user.id, user.username, 'auth.2fa_failed');
        throw new HttpError(401, 'That code isn’t valid — use the newest code from your app, or a recovery code');
      }
    }
    const token = createToken(user.id, user.username, user.role);
    logAudit(user.id, user.username, 'auth.login');
    res.json({ token, user });
  })
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = getUserById(req.auth!.sub);
    if (!user) throw new HttpError(401, 'Session no longer valid');
    res.json({ user: getPublicUser(user.id), creation: getEffectiveCreation(user.id, user.role) });
  })
);

// ---------------------------------------------------------------------------
// Two-factor sign-in for the signed-in user's own account
// ---------------------------------------------------------------------------

authRouter.get(
  '/2fa',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(twoFactorStatus(req.auth!.sub));
  })
);

authRouter.post(
  '/2fa/setup',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(beginTotpSetup(req.auth!.sub));
  })
);

authRouter.post(
  '/2fa/enable',
  requireAuth,
  asyncHandler(async (req, res) => {
    const code = typeof req.body?.code === 'string' ? req.body.code : '';
    const recoveryCodes = enableTotp(req.auth!.sub, code);
    logAudit(req.auth!.sub, req.auth!.username, 'auth.2fa_enabled');
    res.json({ recoveryCodes });
  })
);

/** Turning it off or getting new recovery codes needs the password and a current code. */
function requirePasswordAndCode(userId: string, password: unknown, code: unknown) {
  const user = getUserById(userId);
  if (!user) throw new HttpError(404, 'User not found');
  if (typeof password !== 'string' || !authenticate(user.username, password)) throw new HttpError(400, 'Wrong password');
  if (!user.totp_enabled) return;
  assertNotLocked(userId);
  const ok = typeof code === 'string' && verifySecondFactor(userId, code);
  recordSecondFactorResult(userId, ok);
  if (!ok) throw new HttpError(400, 'That code isn’t valid');
}

authRouter.post(
  '/2fa/disable',
  requireAuth,
  asyncHandler(async (req, res) => {
    requirePasswordAndCode(req.auth!.sub, req.body?.password, req.body?.code);
    disableTotp(req.auth!.sub);
    logAudit(req.auth!.sub, req.auth!.username, 'auth.2fa_disabled');
    res.json(twoFactorStatus(req.auth!.sub));
  })
);

authRouter.post(
  '/2fa/recovery-codes',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!twoFactorStatus(req.auth!.sub).enabled) throw new HttpError(400, 'Two-factor sign-in is off');
    requirePasswordAndCode(req.auth!.sub, req.body?.password, req.body?.code);
    const recoveryCodes = regenerateRecoveryCodes(req.auth!.sub);
    logAudit(req.auth!.sub, req.auth!.username, 'auth.2fa_recovery_regenerated');
    res.json({ recoveryCodes });
  })
);
