import { Router, type Request } from 'express';
import { assertDiskRoom } from '../services/limitsService.js';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { requireAuth, requirePermission, requireServerAccess } from '../auth/middleware.js';
import {
  createDirectory,
  deleteEntry,
  listDirectory,
  readTextFile,
  renameEntry,
  resolveForDownload,
  resolveForUpload,
  writeTextFile,
} from '../services/fileService.js';
import { logAudit } from '../services/userService.js';
import { fileChange, renameChange, snapshotFile, snapshotBuffer } from '../services/fileChangeService.js';
import { instanceDir, isSymlinkAt, safeJoinReal } from '../utils/paths.js';
import type { Role } from '../types/index.js';

export const filesRouter = Router({ mergeParams: true });
filesRouter.use(requireAuth, requireServerAccess());


/** "/plugins//x.yml" → "plugins/x.yml": the same spelling for every change to one file. */
const clean = (p: string) => p.replace(/\\/g, '/').split('/').filter((part) => part && part !== '.').join('/');

/** The real path of an instance file for the history, or null if it can't be resolved (the
 *  file operation itself then reports the error). */
function instancePath(serverId: string, relative: string): string | null {
  try {
    return safeJoinReal(instanceDir(serverId), relative);
  } catch {
    return null;
  }
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 * 1024 } });

filesRouter.get(
  '/list',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'files.read');
    const dir = typeof req.query.path === 'string' ? req.query.path : '';
    res.json({ entries: await listDirectory(req.params.serverId, dir) });
  })
);

filesRouter.get(
  '/content',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'files.read');
    const filePath = typeof req.query.path === 'string' ? req.query.path : '';
    res.json({ content: await readTextFile(req.params.serverId, filePath) });
  })
);

filesRouter.put(
  '/content',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'files.write');
    assertDiskRoom(req.params.serverId, 'write');
    const { path: filePath, content } = req.body ?? {};
    if (typeof filePath !== 'string' || typeof content !== 'string') {
      throw new HttpError(400, 'path and content are required');
    }
    const target = instancePath(req.params.serverId, filePath);
    const before = target ? snapshotFile(target) : null;
    await writeTextFile(req.params.serverId, filePath, content);
    const change = before ? fileChange(clean(filePath), before, snapshotBuffer(Buffer.from(content))) : undefined;
    logAudit(req.auth!.sub, req.auth!.username, 'file.write', req.params.serverId, filePath, change);
    res.json({ ok: true });
  })
);

filesRouter.post(
  '/mkdir',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'files.write');
    const { path: dirPath } = req.body ?? {};
    if (typeof dirPath !== 'string' || !dirPath) throw new HttpError(400, 'path is required');
    const target = instancePath(req.params.serverId, dirPath);
    const before = target ? snapshotFile(target) : null;
    await createDirectory(req.params.serverId, dirPath);
    const change = before && target ? fileChange(clean(dirPath), before, snapshotFile(target)) : undefined;
    logAudit(req.auth!.sub, req.auth!.username, 'file.mkdir', req.params.serverId, dirPath, change);
    res.status(201).json({ ok: true });
  })
);

filesRouter.post(
  '/rename',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'files.write');
    const { from, to } = req.body ?? {};
    if (typeof from !== 'string' || typeof to !== 'string') throw new HttpError(400, 'from and to are required');
    const source = instancePath(req.params.serverId, from);
    const directory = !!source && snapshotFile(source).directory;
    await renameEntry(req.params.serverId, from, to);
    logAudit(req.auth!.sub, req.auth!.username, 'file.rename', req.params.serverId, `${from} -> ${to}`, renameChange(clean(from), clean(to), directory));
    res.json({ ok: true });
  })
);

filesRouter.delete(
  '/',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'files.write');
    const filePath = typeof req.query.path === 'string' ? req.query.path : '';
    // What the file held, so the history can show what was lost. Links are removed, not followed.
    const target = isSymlinkAt(instanceDir(req.params.serverId), filePath) ? null : instancePath(req.params.serverId, filePath);
    const before = target ? snapshotFile(target) : null;
    await deleteEntry(req.params.serverId, filePath);
    const change = before ? fileChange(clean(filePath), before, { exists: false, text: '' }) : undefined;
    logAudit(req.auth!.sub, req.auth!.username, 'file.delete', req.params.serverId, filePath, change);
    res.status(204).end();
  })
);

filesRouter.get(
  '/download',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'files.read');
    const filePath = typeof req.query.path === 'string' ? req.query.path : '';
    const target = resolveForDownload(req.params.serverId, filePath);
    logAudit(req.auth!.sub, req.auth!.username, 'file.download', req.params.serverId, filePath);
    res.download(target, path.basename(target));
  })
);

filesRouter.post(
  '/upload',
  upload.array('files'),
  asyncHandler(async (req, res) => {
    requirePermission(req, 'files.write');
    assertDiskRoom(req.params.serverId, 'write');
    const dirPath = typeof req.body?.path === 'string' ? req.body.path : '';
    const targetDir = resolveForUpload(req.params.serverId, dirPath);
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    for (const file of files) {
      // The browser supplies originalname — never trust it as a path ("../../x", "/etc/x").
      const name = path.basename(file.originalname.replace(/\\/g, '/'));
      if (!name || name === '.' || name === '..') throw new HttpError(400, `Invalid file name: ${file.originalname}`);
      let target: string;
      try {
        target = safeJoinReal(targetDir, name);
      } catch {
        throw new HttpError(400, `Refusing to write ${name}: it would land outside the instance folder`);
      }
      const before = snapshotFile(target);
      fs.writeFileSync(target, file.buffer);
      const relative = path.relative(instanceDir(req.params.serverId), target).split(path.sep).join('/');
      logAudit(req.auth!.sub, req.auth!.username, 'file.upload', req.params.serverId, relative, fileChange(relative, before, snapshotBuffer(file.buffer)));
    }

    res.status(201).json({ uploaded: files.map((f) => f.originalname) });
  })
);
