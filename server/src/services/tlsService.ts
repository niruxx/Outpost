/**
 * HTTPS for the panel itself. Outpost keeps serving plain HTTP on its normal port and, when a
 * certificate is configured, also serves HTTPS on a second port (8643 by default) with the same
 * app and WebSocket endpoints. The certificate comes from an upload, a self-signed certificate
 * generated with openssl, or Let's Encrypt through certbot (issued in Admin Mode; certbot's
 * deploy hook copies renewals into the data folder). Changed files are picked up without a restart.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { Express, NextFunction, Request, Response } from 'express';
import { DATA_DIR } from '../utils/paths.js';
import { HttpError } from '../utils/asyncHandler.js';
import { logger } from '../utils/logger.js';
import { getSetting, setSetting } from './systemSettingsService.js';
import { runCommand } from './hostSystemOps.js';

export const TLS_DIR = path.join(DATA_DIR, 'tls');
const CERT = path.join(TLS_DIR, 'cert.pem');
const KEY = path.join(TLS_DIR, 'key.pem');

export type TlsSource = 'custom' | 'self-signed' | 'acme';

export interface CertInfo {
  subject: string;
  issuer: string;
  names: string[];
  validFrom: string;
  validTo: string;
  daysLeft: number;
  selfSigned: boolean;
  fingerprint: string;
}

export function describeCert(pem: string): CertInfo {
  const x = new crypto.X509Certificate(pem);
  const names = (x.subjectAltName ?? '').split(',').map((s) => s.trim().replace(/^(DNS|IP Address):/, '')).filter(Boolean);
  const validTo = new Date(x.validTo);
  return {
    subject: x.subject.replace(/\n/g, ', '),
    issuer: x.issuer.replace(/\n/g, ', '),
    names,
    validFrom: new Date(x.validFrom).toISOString(),
    validTo: validTo.toISOString(),
    daysLeft: Math.floor((validTo.getTime() - Date.now()) / 86_400_000),
    selfSigned: x.subject === x.issuer,
    fingerprint: x.fingerprint256,
  };
}

/** Checks a PEM certificate chain and private key belong together. */
export function validatePair(certPem: string, keyPem: string): CertInfo {
  if (typeof certPem !== 'string' || typeof keyPem !== 'string' || certPem.length > 64 * 1024 || keyPem.length > 64 * 1024) throw new HttpError(400, 'Paste a PEM certificate and private key');
  let cert: crypto.X509Certificate;
  let key: crypto.KeyObject;
  try {
    cert = new crypto.X509Certificate(certPem);
  } catch {
    throw new HttpError(400, 'The certificate isn’t valid PEM');
  }
  try {
    key = crypto.createPrivateKey(keyPem);
  } catch {
    throw new HttpError(400, 'The private key isn’t valid PEM (encrypted keys aren’t supported)');
  }
  if (!cert.checkPrivateKey(key)) throw new HttpError(400, 'The private key doesn’t match the certificate');
  return describeCert(certPem);
}

function writePair(certPem: string, keyPem: string) {
  fs.mkdirSync(TLS_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${KEY}.tmp`, keyPem, { mode: 0o600 });
  fs.writeFileSync(`${CERT}.tmp`, certPem, { mode: 0o600 });
  fs.renameSync(`${KEY}.tmp`, KEY);
  fs.renameSync(`${CERT}.tmp`, CERT);
}

export const tlsPort = () => Number(getSetting('tls_port') ?? process.env.OUTPOST_HTTPS_PORT ?? 8643);

export function tlsStatus() {
  let cert: CertInfo | null = null;
  let error: string | null = null;
  try {
    if (fs.existsSync(CERT)) cert = describeCert(fs.readFileSync(CERT, 'utf8'));
  } catch (err) {
    error = err instanceof Error ? err.message : 'Unreadable certificate';
  }
  return {
    enabled: getSetting('tls_enabled') === '1',
    listening: !!httpsServer?.listening,
    port: tlsPort(),
    redirect: getSetting('tls_redirect') === '1',
    source: (getSetting('tls_source') as TlsSource | null) ?? null,
    domain: getSetting('tls_domain'),
    cert,
    error,
    lastError: lastStartError,
    serviceUser: os.userInfo().username,
    dir: TLS_DIR,
  };
}

export function saveCustomCertificate(certPem: string, keyPem: string) {
  const info = validatePair(certPem, keyPem);
  writePair(certPem, keyPem);
  setSetting('tls_source', 'custom');
  reloadContext();
  return info;
}

export async function generateSelfSigned(hostnames: string[]) {
  const names = [...new Set([os.hostname(), 'localhost', ...hostnames])].filter((n) => /^[A-Za-z0-9.*-]{1,253}$/.test(n)).slice(0, 20);
  const san = [...names.map((n) => `DNS:${n}`), 'IP:127.0.0.1'].join(',');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-tls-'));
  try {
    const r = await runCommand('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '825',
      '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-subj', `/CN=${names[0]}`, '-addext', `subjectAltName=${san}`,
    ], { timeoutMs: 30_000 });
    if (r.code !== 0) throw new HttpError(502, `openssl couldn’t create a certificate: ${r.stderr.trim().split('\n').pop() || 'not installed'}`);
    const certPem = fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8');
    const keyPem = fs.readFileSync(path.join(dir, 'key.pem'), 'utf8');
    writePair(certPem, keyPem);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  setSetting('tls_source', 'self-signed');
  reloadContext();
  return describeCert(fs.readFileSync(CERT, 'utf8'));
}

export function markAcme(domain: string) {
  setSetting('tls_source', 'acme');
  setSetting('tls_domain', domain);
  reloadContext();
}

// ---------------------------------------------------------------------------
// The HTTPS listener
// ---------------------------------------------------------------------------

let httpsServer: https.Server | null = null;
let appRef: Express | null = null;
let attachRef: ((server: Server) => void) | null = null;
let lastMtime = 0;
let lastStartError: string | null = null;

function readPair() {
  return { cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY) };
}

function reloadContext() {
  if (!httpsServer) {
    void applyTlsSettings();
    return;
  }
  try {
    httpsServer.setSecureContext(readPair());
    lastMtime = fs.statSync(CERT).mtimeMs;
    logger.info('Panel HTTPS certificate reloaded');
  } catch (err) {
    logger.error('Couldn’t reload the panel certificate', err);
  }
}

/** Starts, restarts or stops the HTTPS listener to match the settings. */
export async function applyTlsSettings(): Promise<void> {
  if (!appRef) return;
  const want = getSetting('tls_enabled') === '1' && fs.existsSync(CERT) && fs.existsSync(KEY);
  const port = tlsPort();
  if (httpsServer && (!want || (httpsServer.address() as { port?: number } | null)?.port !== port)) {
    const old = httpsServer;
    httpsServer = null;
    await new Promise<void>((resolve) => {
      old.close(() => resolve());
      old.closeAllConnections?.();
    });
  }
  if (!want || httpsServer) return;
  try {
    const server = https.createServer(readPair(), appRef);
    attachRef?.(server as unknown as Server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, () => resolve());
    });
    httpsServer = server;
    lastMtime = fs.statSync(CERT).mtimeMs;
    lastStartError = null;
    logger.info(`Outpost panel listening on https://localhost:${port}`);
  } catch (err) {
    lastStartError = err instanceof Error ? err.message : String(err);
    logger.error(`Couldn’t start HTTPS on port ${port}`, err);
  }
}

export function setTlsOptions(opts: { enabled?: boolean; port?: number; redirect?: boolean }) {
  if (opts.port !== undefined) {
    if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) throw new HttpError(400, 'Port must be 1–65535');
    setSetting('tls_port', String(opts.port));
  }
  if (opts.enabled !== undefined) {
    if (opts.enabled && !fs.existsSync(CERT)) throw new HttpError(409, 'Add a certificate first');
    setSetting('tls_enabled', opts.enabled ? '1' : '0');
  }
  if (opts.redirect !== undefined) setSetting('tls_redirect', opts.redirect ? '1' : '0');
}

/** Starts HTTPS if configured and watches the certificate for renewals. */
export function initTls(app: Express, attach: (server: Server) => void) {
  appRef = app;
  attachRef = attach;
  void applyTlsSettings();
  setInterval(() => {
    try {
      const m = fs.statSync(CERT).mtimeMs;
      if (httpsServer && m !== lastMtime) reloadContext();
    } catch {
      // no certificate
    }
  }, 60_000).unref();
}

export function stopTls() {
  httpsServer?.close();
}

/**
 * Sends browsers on plain HTTP to HTTPS when enabled. Node-to-node links, ACME challenges and
 * requests from this machine itself stay on HTTP.
 */
export function httpsRedirect(req: Request, res: Response, next: NextFunction) {
  if (!httpsServer || getSetting('tls_redirect') !== '1') return next();
  const encrypted = (req.socket as { encrypted?: boolean }).encrypted || req.headers['x-forwarded-proto'] === 'https';
  const local = req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::1' || req.socket.remoteAddress === '::ffff:127.0.0.1';
  if (encrypted || local || req.path.startsWith('/api/node-link') || req.path.startsWith('/.well-known/')) return next();
  const host = (req.headers.host ?? '').replace(/:\d+$/, '');
  if (!host || !/^[A-Za-z0-9.:[\]-]+$/.test(host)) return next();
  res.redirect(308, `https://${host}:${tlsPort()}${req.originalUrl}`);
}
