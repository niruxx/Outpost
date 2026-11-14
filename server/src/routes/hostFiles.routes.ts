import { scanIncomingUploads } from './antivirus.routes.js';
import { scanUploadBuffers } from '../services/antivirusService.js';
import { Router, type Request } from 'express';
import multer from 'multer';
import path from 'node:path';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { terminalIdentity } from '../services/hostTerminalService.js';
import { logAudit } from '../services/userService.js';
import { CHUNK_BYTES, normalizeHostPath } from '../services/hostFileOps.js';
import {
  disableAdminMode,
  enableAdminMode,
  hostFilesStatus,
  isAdminModeActive,
  runHostFileOp,
} from '../services/hostFilesService.js';

/** Host File Manager: the host's filesystem as the service account, or as root in Admin Mode. */
export const hostFilesRouter = Router();
hostFilesRouter.use(requireAuth, requireRole('admin'));

function rawToken(req: Request): string {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return typeof req.query.token === 'string' ? req.query.token : '';
}

// Like the host console: current administrators with a real panel sign-in only — no API keys.
hostFilesRouter.use((req, _res, next) => {
  try {
    terminalIdentity(rawToken(req));
    next();
  } catch (error) {
    next(error);
  }
});

const token = (req: Request) => rawToken(req);
const mode = (req: Request) => (isAdminModeActive(token(req)) ? 'admin' : 'user');
const audit = (req: Request, action: string, target: string, detail?: string) =>
  logAudit(req.auth!.sub, req.auth!.username, action, undefined, JSON.stringify({ path: target, mode: mode(req), ...(detail ? { detail } : {}) }));
const queryPath = (req: Request) => (typeof req.query.path === 'string' ? req.query.path : '');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 * 1024 } });

hostFilesRouter.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store').json(hostFilesStatus(token(req)));
});

hostFilesRouter.post(
  '/admin',
  asyncHandler(async (req, res) => {
    const identity = terminalIdentity(token(req));
    try {
      const status = await enableAdminMode(token(req), identity, req.body?.password);
      logAudit(identity.id, identity.username, 'host.admin.enable', undefined, 'Administrative access turned on');
      res.set('Cache-Control', 'no-store').json(status);
    } catch (err) {
      logAudit(identity.id, identity.username, 'host.admin.denied', undefined, err instanceof Error ? err.message : 'Failed');
      throw err;
    }
  })
);

hostFilesRouter.delete('/admin', (req, res) => {
  const status = disableAdminMode(token(req));
  logAudit(req.auth!.sub, req.auth!.username, 'host.admin.disable', undefined, 'Administrative access turned off');
  res.set('Cache-Control', 'no-store').json(status);
});

hostFilesRouter.get(
  '/list',
  asyncHandler(async (req, res) => {
    const dir = queryPath(req) || hostFilesStatus(token(req)).home;
    const target = normalizeHostPath(dir);
    res.set('Cache-Control', 'no-store').json({ path: target, entries: await runHostFileOp(token(req), 'list', { path: target }) });
  })
);

hostFilesRouter.get(
  '/content',
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store').json({ content: await runHostFileOp(token(req), 'readText', { path: queryPath(req) }) });
  })
);

hostFilesRouter.put(
  '/content',
  asyncHandler(async (req, res) => {
    const { path: filePath, content } = req.body ?? {};
    if (typeof filePath !== 'string' || typeof content !== 'string') throw new HttpError(400, 'path and content are required');
    await scanUploadBuffers([{ name: filePath, buffer: Buffer.from(content) }]);
    await runHostFileOp(token(req), 'writeText', { path: filePath, content });
    audit(req, 'host.file.write', filePath);
    res.json({ ok: true });
  })
);

hostFilesRouter.post(
  '/mkdir',
  asyncHandler(async (req, res) => {
    const dirPath = req.body?.path;
    if (typeof dirPath !== 'string') throw new HttpError(400, 'path is required');
    await runHostFileOp(token(req), 'mkdir', { path: dirPath });
    audit(req, 'host.file.mkdir', dirPath);
    res.status(201).json({ ok: true });
  })
);

hostFilesRouter.post(
  '/rename',
  asyncHandler(async (req, res) => {
    const { from, to } = req.body ?? {};
    if (typeof from !== 'string' || typeof to !== 'string') throw new HttpError(400, 'from and to are required');
    await runHostFileOp(token(req), 'rename', { from, to });
    audit(req, 'host.file.rename', from, `→ ${to}`);
    res.json({ ok: true });
  })
);

hostFilesRouter.delete(
  '/',
  asyncHandler(async (req, res) => {
    const target = queryPath(req);
    await runHostFileOp(token(req), 'remove', { path: target });
    audit(req, 'host.file.delete', target);
    res.status(204).end();
  })
);

hostFilesRouter.get(
  '/download',
  asyncHandler(async (req, res) => {
    const target = queryPath(req);
    const info = await runHostFileOp(token(req), 'stat', { path: target });
    if (info.isDirectory) throw new HttpError(400, 'Folders cannot be downloaded');
    audit(req, 'host.file.download', info.path);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(info.size));
    res.attachment(path.basename(info.path));
    // Streamed in slices so Admin Mode downloads work through the privileged helper too.
    let offset = 0;
    let aborted = false;
    req.on('close', () => { aborted = true; });
    while (!aborted && offset < info.size) {
      let chunk;
      try {
        chunk = await runHostFileOp(token(req), 'readChunk', { path: info.path, offset, length: Math.min(CHUNK_BYTES, info.size - offset) });
      } catch (err) {
        res.destroy(err instanceof Error ? err : undefined);
        return;
      }
      const buffer = Buffer.from(chunk.data, 'base64');
      if (buffer.length === 0) break; // file shrank while downloading
      offset += buffer.length;
      if (!res.write(buffer)) await new Promise((resolve) => res.once('drain', resolve));
    }
    res.end();
  })
);

hostFilesRouter.post(
  '/upload',
  upload.array('files'), scanIncomingUploads,
  asyncHandler(async (req, res) => {
    const dir = typeof req.body?.path === 'string' ? req.body.path : '';
    const targetDir = normalizeHostPath(dir);
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    for (const file of files) {
      // The browser supplies originalname — never trust it as a path.
      const name = path.basename(file.originalname.replace(/\\/g, '/'));
      if (!name || name === '.' || name === '..') throw new HttpError(400, `Invalid file name: ${file.originalname}`);
      const target = path.join(targetDir, name);
      let offset = 0;
      do {
        const slice = file.buffer.subarray(offset, offset + CHUNK_BYTES);
        await runHostFileOp(token(req), 'writeChunk', { path: target, offset, data: slice.toString('base64'), truncate: offset === 0 });
        offset += slice.length;
      } while (offset < file.buffer.length);
      audit(req, 'host.file.upload', target, `${file.buffer.length} bytes`);
    }
    res.status(201).json({ uploaded: files.map((f) => f.originalname) });
  })
);
