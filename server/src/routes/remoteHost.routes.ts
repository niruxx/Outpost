import crypto from 'node:crypto';
import os from 'node:os';
import { Readable } from 'node:stream';
import { Router, type Request } from 'express';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { getNode, nodeAuthHeaders } from '../services/nodeService.js';
import { logAudit } from '../services/userService.js';

/**
 * Host administration of a linked Outpost host: /api/remote-host/:nodeId/<path> is forwarded to
 * that panel's /api/node-link/host/<path> with the node key, the acting administrator's name and a
 * session id derived from this browser session (so Admin Mode on the remote host belongs to this
 * browser session only). The remote host must allow linked panels to administer it.
 */
export const remoteHostRouter = Router();

function bearer(req: Request): string {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return typeof req.query.token === 'string' ? req.query.token : '';
}

remoteHostRouter.all(
  '/:nodeId/*',
  asyncHandler(async (req, res) => {
    const node = getNode(req.params.nodeId);
    const sub = (req.params as Record<string, string>)[0] ?? '';
    if (!/^[A-Za-z0-9/_.@\%:-]*$/.test(sub) || sub.includes('..')) throw new HttpError(400, 'Invalid path');
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(req.query)) if (k !== 'token' && typeof v === 'string') query.set(k, v);
    const url = `${node.url}/api/node-link/host/${sub}${query.size ? `?${query}` : ''}`;
    const session = crypto.createHash('sha256').update(`${bearer(req)}\0${node.id}`).digest('base64url');
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    let upstream: Response;
    try {
      upstream = await fetch(url, {
        method: req.method,
        headers: {
          ...nodeAuthHeaders(node.api_key),
          'x-outpost-host-session': session,
          'x-outpost-acting-user': req.auth!.username,
          'x-outpost-origin': os.hostname(),
          ...(hasBody ? { 'content-type': 'application/json' } : {}),
        },
        body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
        signal: AbortSignal.timeout(10 * 60_000),
      });
    } catch (err) {
      throw new HttpError(502, `Couldn’t reach ${node.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
    // A 401 from the node means the node key was rejected; passed through it would sign the browser out.
    if (upstream.status === 401) throw new HttpError(502, `${node.name} rejected this panel’s node key — re-add the node under Configuration → Operations`);
    if (hasBody) logAudit(req.auth!.sub, req.auth!.username, 'host.remote', undefined, `${node.name}: ${req.method} ${sub} → ${upstream.status}`);
    res.status(upstream.status);
    for (const h of ['content-type', 'content-disposition', 'content-length', 'cache-control']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (!upstream.body) {
      res.end();
      return;
    }
    Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream).pipe(res);
  })
);
