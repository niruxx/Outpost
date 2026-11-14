import crypto from 'node:crypto';
import type { RequestHandler } from 'express';
import { SESSION_SECRET } from '../auth/secret.js';
import { getUserById } from './userService.js';
import { HttpError } from '../utils/asyncHandler.js';
const key = crypto.createHash('sha256').update(SESSION_SECRET).update('fleet-integrations-v1').digest();
export const sha256 = (value: crypto.BinaryLike) => crypto.createHash('sha256').update(value).digest('hex');
export function seal(value: string) { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64'); }
export function unseal(value: string) { const raw = Buffer.from(value, 'base64'), decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12)); decipher.setAuthTag(raw.subarray(-16)); return Buffer.concat([decipher.update(raw.subarray(12, -16)), decipher.final()]).toString('utf8'); }
export function constantEqual(a: string, b: string) { const left = Buffer.from(a), right = Buffer.from(b); return left.length === right.length && crypto.timingSafeEqual(left, right); }
export const currentFleetAdmin: RequestHandler = (req, _res, next) => {
    const user = req.auth && getUserById(req.auth.sub);
    if (!user || user.disabled || user.role !== 'admin')
        return next(new HttpError(403, 'Current administrator access required'));
    req.auth!.role = user.role;
    next();
};
export function requireFleetAdmin(userId: string) {
    const u = getUserById(userId);
    if (!u || u.disabled || u.role !== 'admin')
        throw new HttpError(403, 'Workflow administrator access was revoked');
    return u;
}
export function trustedTransport(raw: unknown) {
    let url: URL;
    try {
        url = new URL(String(raw));
    }
    catch {
        throw new HttpError(400, 'A full HTTPS URL is required');
    }
    if (url.username || url.password || url.hash || !['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
        throw new HttpError(400, 'Use HTTPS with no embedded credentials (HTTP is allowed only on loopback for local development)');
    return url;
}
export async function fetchBounded(url: string, options: RequestInit = {}, maximum = 2 * 1024 * 1024) {
    const response = await fetch(url, { ...options, redirect: 'error', signal: options.signal ?? AbortSignal.timeout(20000) });
    if (!response.ok)
        throw new HttpError(502, `Remote service returned HTTP ${response.status}`);
    if (Number(response.headers.get('content-length')) > maximum)
        throw new HttpError(413, 'Remote response exceeds size limit');
    const chunks: Buffer[] = [];
    let bytes = 0;
    if (response.body)
        for await (const part of response.body as unknown as AsyncIterable<Uint8Array>) {
            bytes += part.length;
            if (bytes > maximum)
                throw new HttpError(413, 'Remote response exceeds size limit');
            chunks.push(Buffer.from(part));
        }
    return Buffer.concat(chunks);
}
export function plainId(value: unknown, label = 'ID') {
    if (typeof value !== 'string' || !/^[\w.-]{1,100}$/.test(value))
        throw new HttpError(400, `Invalid ${label}`);
    return value;
}
