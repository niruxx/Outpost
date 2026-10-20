import fs from 'node:fs';
import path from 'node:path';
import { Router, type Request } from 'express';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { requireAuth, requirePermission, requireRole, requireServerAccess } from '../auth/middleware.js';
import { getServer } from '../services/serverService.js';
import { logAudit } from '../services/userService.js';
import { deleteTemplate, exportTemplate, getTemplate, listTemplates, saveTemplate, validateTemplate } from '../services/templateService.js';
import { instanceDir } from '../utils/paths.js';

/** The template library: anyone signed in can browse it (to create from it); admins import and delete. */
export const templatesRouter = Router();
templatesRouter.use(requireAuth);

templatesRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ templates: listTemplates() });
  })
);

templatesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const tpl = getTemplate(req.params.id);
    if (!tpl) throw new HttpError(404, 'Template not found');
    res.json({ template: tpl });
  })
);

templatesRouter.get(
  '/:id/download',
  asyncHandler(async (req, res) => {
    const tpl = getTemplate(req.params.id);
    if (!tpl) throw new HttpError(404, 'Template not found');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${tpl.name.replace(/[^\w.-]+/g, '_')}.outpost.json"`);
    res.send(JSON.stringify(tpl, null, 2));
  })
);

/** Import: the body is the template file's JSON. */
templatesRouter.post(
  '/',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const tpl = validateTemplate(req.body);
    const id = saveTemplate(tpl, req.auth!.sub);
    logAudit(req.auth!.sub, req.auth!.username, 'template.import', undefined, tpl.name);
    res.status(201).json({ id, templates: listTemplates() });
  })
);

templatesRouter.delete(
  '/:id',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const tpl = getTemplate(req.params.id);
    if (!tpl || !deleteTemplate(req.params.id)) throw new HttpError(404, 'Template not found');
    logAudit(req.auth!.sub, req.auth!.username, 'template.delete', undefined, tpl.name);
    res.json({ templates: listTemplates() });
  })
);

// ---------------------------------------------------------------------------
// Per instance: export it as a template / save it into the library
// ---------------------------------------------------------------------------

export const instanceTemplateRouter = Router({ mergeParams: true });
instanceTemplateRouter.use(requireAuth, requireServerAccess());

const CONFIG_FILE = /\.(properties|cfg|conf|ini|ya?ml|json|toml|xml|txt|lua|sh|env)$/i;
const SKIP_DIRS = new Set(['world', 'world_nether', 'world_the_end', 'worlds', 'logs', 'crash-reports', 'cache', 'libraries', 'versions', 'steamapps', '.wine', '.home', '_workshop', 'node_modules', 'Saved', 'plugins']);

/** Small text config files an instance has, to pick from when exporting. */
instanceTemplateRouter.get(
  '/files',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'settings');
    const server = getServer(req.params.serverId);
    if (!server) throw new HttpError(404, 'Server not found');
    const root = instanceDir(server.id);
    const found: { path: string; sizeBytes: number }[] = [];
    const walk = (dir: string, depth: number) => {
      if (found.length >= 200) return;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (depth < 3 && !SKIP_DIRS.has(e.name)) walk(abs, depth + 1);
        } else if (e.isFile() && CONFIG_FILE.test(e.name)) {
          const size = fs.statSync(abs).size;
          if (size <= 256 * 1024) found.push({ path: path.relative(root, abs).split(path.sep).join('/'), sizeBytes: size });
        }
      }
    };
    walk(root, 0);
    res.json({ files: found.sort((a, b) => a.path.localeCompare(b.path)) });
  })
);

function buildFrom(req: Request) {
  const server = getServer(req.params.serverId);
  if (!server) throw new HttpError(404, 'Server not found');
  const src = req.body && Object.keys(req.body).length ? req.body : req.query;
  const files = Array.isArray(src.files) ? src.files.map(String) : typeof src.files === 'string' && src.files ? src.files.split(',') : [];
  return exportTemplate(server, {
    name: typeof src.name === 'string' ? src.name : undefined,
    description: typeof src.description === 'string' ? src.description : '',
    author: req.auth!.username,
    filePaths: files,
  });
}

/** Downloads the instance as a template file. */
instanceTemplateRouter.get(
  '/export',
  asyncHandler(async (req, res) => {
    requirePermission(req, 'settings');
    const tpl = buildFrom(req);
    logAudit(req.auth!.sub, req.auth!.username, 'template.export', req.params.serverId, tpl.name);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${tpl.name.replace(/[^\w.-]+/g, '_')}.outpost.json"`);
    res.send(JSON.stringify(tpl, null, 2));
  })
);

/** Saves the instance into the template library (admins). */
instanceTemplateRouter.post(
  '/',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const tpl = buildFrom(req);
    if (Array.isArray(req.body?.variables)) Object.assign(tpl, validateTemplate({ ...tpl, variables: req.body.variables }));
    const id = saveTemplate(tpl, req.auth!.sub);
    logAudit(req.auth!.sub, req.auth!.username, 'template.save', req.params.serverId, tpl.name);
    res.status(201).json({ id, template: tpl });
  })
);
