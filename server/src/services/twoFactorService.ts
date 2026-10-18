import crypto from 'node:crypto';
import { prep } from '../db/db.js';
import { getUserById } from './userService.js';
import { HttpError } from '../utils/asyncHandler.js';

/**
 * Two-factor sign-in: TOTP (RFC 6238 — 30-second steps, 6 digits, HMAC-SHA1, the defaults every
 * authenticator app uses) plus single-use recovery codes. No dependencies; Node's crypto does it.
 */

const STEP_SECONDS = 30;
const DIGITS = 6;
const RECOVERY_CODES = 8;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | BASE32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function hotp(key: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(code).padStart(DIGITS, '0');
}

/** The time step a code matches (allowing one step of clock drift either way), or null. */
function matchingStep(secret: string, code: string, now = Date.now()): number | null {
  const key = base32Decode(secret);
  const current = Math.floor(now / 1000 / STEP_SECONDS);
  for (const step of [current, current - 1, current + 1]) {
    const expected = hotp(key, step);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(code))) return step;
  }
  return null;
}

const hashCode = (code: string) => crypto.createHash('sha256').update(code.toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');

function newRecoveryCodes(): { plain: string[]; hashes: string[] } {
  const plain = Array.from({ length: RECOVERY_CODES }, () => {
    const raw = base32Encode(crypto.randomBytes(6)).slice(0, 8);
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  });
  return { plain, hashes: plain.map(hashCode) };
}

export interface TwoFactorStatus {
  enabled: boolean;
  recoveryCodesLeft: number;
}

export function twoFactorStatus(userId: string): TwoFactorStatus {
  const user = getUserById(userId);
  const left = user?.totp_recovery ? (JSON.parse(user.totp_recovery) as string[]).length : 0;
  return { enabled: !!user?.totp_enabled, recoveryCodesLeft: left };
}

/** Starts setup: stores a fresh secret (not yet active) and returns it with an otpauth:// URI for a QR code. */
export function beginTotpSetup(userId: string): { secret: string; uri: string } {
  const user = getUserById(userId);
  if (!user) throw new HttpError(404, 'User not found');
  if (user.totp_enabled) throw new HttpError(409, 'Two-factor sign-in is already on');
  const secret = base32Encode(crypto.randomBytes(20));
  prep('UPDATE users SET totp_secret = ?, totp_last_step = 0 WHERE id = ?').run(secret, userId);
  const label = encodeURIComponent(`Outpost:${user.username}`);
  const uri = `otpauth://totp/${label}?secret=${secret}&issuer=Outpost&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
  return { secret, uri };
}

/** Confirms setup with a code from the app and turns 2FA on. Returns the recovery codes (shown once). */
export function enableTotp(userId: string, code: string): string[] {
  const user = getUserById(userId);
  if (!user?.totp_secret) throw new HttpError(400, 'Start two-factor setup first');
  if (user.totp_enabled) throw new HttpError(409, 'Two-factor sign-in is already on');
  const step = /^\d{6}$/.test(code.trim()) ? matchingStep(user.totp_secret, code.trim()) : null;
  if (step === null) throw new HttpError(400, 'That code doesn’t match — check the time on your phone and try the newest code');
  const recovery = newRecoveryCodes();
  prep('UPDATE users SET totp_enabled = 1, totp_last_step = ?, totp_recovery = ? WHERE id = ?').run(step, JSON.stringify(recovery.hashes), userId);
  return recovery.plain;
}

export function disableTotp(userId: string): void {
  prep('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_step = 0, totp_recovery = NULL WHERE id = ?').run(userId);
}

export function regenerateRecoveryCodes(userId: string): string[] {
  const recovery = newRecoveryCodes();
  prep('UPDATE users SET totp_recovery = ? WHERE id = ?').run(JSON.stringify(recovery.hashes), userId);
  return recovery.plain;
}

/**
 * Checks a second factor: a current authenticator code (each accepted once — a step at or before
 * the last accepted one is refused) or an unused recovery code, which is then used up.
 */
export function verifySecondFactor(userId: string, input: string): boolean {
  const user = getUserById(userId);
  if (!user?.totp_enabled || !user.totp_secret) return false;
  const code = input.trim();
  if (/^\d{6}$/.test(code)) {
    const step = matchingStep(user.totp_secret, code);
    if (step === null || step <= user.totp_last_step) return false;
    prep('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, userId);
    return true;
  }
  const hashes: string[] = user.totp_recovery ? JSON.parse(user.totp_recovery) : [];
  const hash = hashCode(code);
  const index = hashes.indexOf(hash);
  if (index === -1) return false;
  hashes.splice(index, 1);
  prep('UPDATE users SET totp_recovery = ? WHERE id = ?').run(JSON.stringify(hashes), userId);
  return true;
}

// Guessing a 6-digit code needs many tries — lock an account's second step after a few misses.
const MAX_FAILURES = 5;
const LOCK_MS = 5 * 60_000;
const failures = new Map<string, { count: number; lockedUntil: number }>();

export function assertNotLocked(userId: string): void {
  const entry = failures.get(userId);
  if (entry && entry.lockedUntil > Date.now()) {
    const mins = Math.ceil((entry.lockedUntil - Date.now()) / 60_000);
    throw new HttpError(429, `Too many wrong codes — try again in ${mins} minute${mins === 1 ? '' : 's'}`);
  }
}

export function recordSecondFactorResult(userId: string, ok: boolean): void {
  if (ok) {
    failures.delete(userId);
    return;
  }
  const entry = failures.get(userId) ?? { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= MAX_FAILURES) {
    entry.count = 0;
    entry.lockedUntil = Date.now() + LOCK_MS;
  }
  failures.set(userId, entry);
}
