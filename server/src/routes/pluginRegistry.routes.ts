import { Router } from 'express';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { requireAuth } from '../auth/middleware.js';
import { searchPlugins } from '../services/pluginRegistryService.js';
import { curseforge, curseforgeStatus, type CfTarget } from '../services/curseforgeService.js';

export const pluginRegistryRouter = Router();
pluginRegistryRouter.use(requireAuth);

const cfTarget = (v: unknown): CfTarget =>
  v === 'bedrock' || v === 'datapack' || v === 'mod:fabric' || v === 'mod:quilt' || v === 'mod:forge' || v === 'mod:neoforge' ? v : 'plugin';

/** Whether CurseForge search is available, and its categories for a catalog. */
pluginRegistryRouter.get(
  '/curseforge',
  asyncHandler(async (req, res) => {
    const status = curseforgeStatus();
    if (!status.configured) return res.json({ configured: false, classes: [] });
    res.json({ configured: true, classes: await curseforge.classes(cfTarget(req.query.catalog)) });
  })
);

/** Import a CurseForge project into the normal instance/dependency review flow. */
pluginRegistryRouter.post(
  '/curseforge/resolve-link',
  asyncHandler(async (req, res) => {
    if (typeof req.body?.url !== 'string' || req.body.url.length > 2048) throw new HttpError(400, 'A CurseForge mod link is required');
    res.json({ result: await curseforge.resolveLink(req.body.url) });
  })
);

/** Global catalog search — Modrinth (default) or CurseForge (`source=curseforge`). */
pluginRegistryRouter.get(
  '/search',
  asyncHandler(async (req, res) => {
    const query = typeof req.query.query === 'string' ? req.query.query : '';
    const limit = req.query.limit ? Number(req.query.limit) : 24;
    const PROXY_CATALOGS = ['proxy:velocity', 'proxy:bungee'] as const;
    const proxyCatalog = PROXY_CATALOGS.find((c) => c === req.query.catalog);
    if (req.query.source === 'curseforge') {
      if (proxyCatalog) throw new HttpError(400, 'Proxy plugins are searched on Modrinth');
      const classId = req.query.classId ? Number(req.query.classId) : undefined;
      const results = await curseforge.search(cfTarget(req.query.catalog), query, { classId, limit });
      return res.json({ results });
    }
    if (req.query.catalog === 'bedrock') throw new HttpError(400, 'Bedrock packs are on CurseForge, not Modrinth');
    const MOD_CATALOGS = ['mod:fabric', 'mod:quilt', 'mod:forge', 'mod:neoforge'] as const;
    const catalog =
      proxyCatalog ?? (req.query.catalog === 'datapack' ? 'datapack' : MOD_CATALOGS.find((c) => c === req.query.catalog) ?? 'plugin');
    try {
      const results = await searchPlugins(query, limit, catalog);
      res.json({ results });
    } catch (err) {
      throw new HttpError(502, err instanceof Error ? err.message : 'Plugin search failed');
    }
  })
);
