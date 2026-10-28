import { HttpError } from '../utils/asyncHandler.js';
import { clearSetting, getSetting, setSetting } from './systemSettingsService.js';

/**
 * CurseForge catalog: Bedrock add-ons, texture packs and maps, plus Java Bukkit plugins and data
 * packs alongside Modrinth. The API needs a key (free, from console.curseforge.com) that an admin
 * saves once; it never leaves the server.
 *
 * Class ids (Add-ons, Texture Packs, Bukkit Plugins…) are looked up from the API by name rather than
 * hard-coded, and files whose authors opted out of third-party downloads are reported as such
 * instead of being fetched some other way.
 */

export const SETTING_CURSEFORGE_KEY = 'curseforge_api_key';
const API = 'https://api.curseforge.com';

export type CfTarget = 'bedrock' | 'plugin' | 'datapack' | 'mod:fabric' | 'mod:quilt' | 'mod:forge' | 'mod:neoforge';

/** CurseForge's modLoaderType numbers. */
const MOD_LOADER_TYPE: Record<string, number> = { 'mod:forge': 1, 'mod:fabric': 4, 'mod:quilt': 5, 'mod:neoforge': 6 };

export interface CfClass {
  id: number;
  name: string;
  slug: string;
}

export interface CfResult {
  id: number;
  slug: string;
  title: string;
  description: string;
  iconUrl: string | null;
  downloads: number;
  author: string;
  categories: string[];
  className: string | null;
  websiteUrl: string | null;
  /** false when the author doesn't allow downloads outside CurseForge. */
  downloadable: boolean;
}

export interface CfResolvedFile {
  title: string;
  dependencies: { modId: number; relationType: number }[];
  fileName: string;
  downloadUrl: string;
  versionLabel: string;
  sizeBytes: number;
  versionMismatchWarning: boolean;
}

interface CfMod {
  id: number;
  name: string;
  slug: string;
  summary: string;
  downloadCount: number;
  classId: number | null;
  links?: { websiteUrl?: string | null };
  logo?: { thumbnailUrl?: string | null } | null;
  authors?: { name: string }[];
  categories?: { name: string }[];
  allowModDistribution?: boolean | null;
}

interface CfFile {
  dependencies?: { modId: number; relationType: number }[];
  id: number;
  displayName: string;
  fileName: string;
  releaseType: number; // 1 release, 2 beta, 3 alpha
  fileDate: string;
  downloadUrl: string | null;
  gameVersions: string[];
  isAvailable?: boolean;
  fileLength: number;
}

type FetchFn = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Which game and which classes each target searches. Names are matched case-insensitively. */
const TARGETS: Record<CfTarget, { gameSlug: string; fallbackGameId: number; classes: string[] }> = {
  // Maps (.mcworld) and skins aren't server add-ons, so they're left out.
  bedrock: { gameSlug: 'minecraft-bedrock', fallbackGameId: 78022, classes: ['addons', 'texture packs', 'scripts'] },
  plugin: { gameSlug: 'minecraft', fallbackGameId: 432, classes: ['bukkit plugins'] },
  datapack: { gameSlug: 'minecraft', fallbackGameId: 432, classes: ['data packs'] },
  'mod:fabric': { gameSlug: 'minecraft', fallbackGameId: 432, classes: ['mods'] },
  'mod:quilt': { gameSlug: 'minecraft', fallbackGameId: 432, classes: ['mods'] },
  'mod:forge': { gameSlug: 'minecraft', fallbackGameId: 432, classes: ['mods'] },
  'mod:neoforge': { gameSlug: 'minecraft', fallbackGameId: 432, classes: ['mods'] },
};

export function createCurseForge(deps: { fetch: FetchFn; getKey: () => string | null }) {
  const gameIds = new Map<string, number>();
  const classCache = new Map<number, CfClass[]>();

  async function cf<T>(path: string): Promise<T> {
    const key = deps.getKey();
    if (!key) throw new HttpError(409, 'CurseForge isn’t set up — an admin needs to add a CurseForge API key in Configuration');
    let res;
    try {
      res = await deps.fetch(`${API}${path}`, { headers: { 'x-api-key': key, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    } catch (err) {
      throw new HttpError(502, `Couldn’t reach CurseForge: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.status === 401 || res.status === 403) throw new HttpError(502, 'CurseForge rejected the API key — check it in Configuration');
    if (!res.ok) throw new HttpError(502, `CurseForge request failed (${res.status})`);
    return (await res.json()) as T;
  }

  async function gameId(target: CfTarget): Promise<number> {
    const t = TARGETS[target];
    const cached = gameIds.get(t.gameSlug);
    if (cached) return cached;
    try {
      const { data } = await cf<{ data: { id: number; slug: string }[] }>('/v1/games?pageSize=50');
      for (const g of data) gameIds.set(g.slug, g.id);
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) throw err;
    }
    return gameIds.get(t.gameSlug) ?? t.fallbackGameId;
  }

  /** The searchable classes for a target, in the order TARGETS lists them. */
  async function classes(target: CfTarget): Promise<CfClass[]> {
    const gid = await gameId(target);
    let all = classCache.get(gid);
    if (!all) {
      const { data } = await cf<{ data: { id: number; name: string; slug: string; isClass?: boolean }[] }>(`/v1/categories?gameId=${gid}&classesOnly=true`);
      all = data.map((c) => ({ id: c.id, name: c.name, slug: c.slug }));
      classCache.set(gid, all);
    }
    const wanted = TARGETS[target].classes;
    return wanted.map((w) => all!.find((c) => c.name.toLowerCase() === w)).filter((c): c is CfClass => !!c);
  }

  async function search(target: CfTarget, query: string, opts: { classId?: number; gameVersion?: string; limit?: number } = {}): Promise<CfResult[]> {
    const gid = await gameId(target);
    const available = await classes(target);
    if (!available.length) throw new HttpError(502, 'CurseForge didn’t list any matching categories for this game');
    const cls = opts.classId ? available.find((c) => c.id === opts.classId) : available[0];
    if (!cls) throw new HttpError(400, 'Unknown CurseForge category');
    const params = new URLSearchParams({
      gameId: String(gid),
      classId: String(cls.id),
      sortField: query ? '1' : '2', // featured/relevance when searching, popularity when browsing
      sortOrder: 'desc',
      pageSize: String(Math.min(Math.max(opts.limit ?? 24, 1), 50)),
    });
    if (query) params.set('searchFilter', query);
    if (MOD_LOADER_TYPE[target]) params.set('modLoaderType', String(MOD_LOADER_TYPE[target]));
    const { data } = await cf<{ data: CfMod[] }>(`/v1/mods/search?${params}`);
    return data.map((m) => ({
      id: m.id,
      slug: m.slug,
      title: m.name,
      description: m.summary,
      iconUrl: m.logo?.thumbnailUrl ?? null,
      downloads: m.downloadCount,
      author: m.authors?.[0]?.name ?? 'unknown',
      categories: (m.categories ?? []).map((c) => c.name),
      className: cls.name,
      websiteUrl: m.links?.websiteUrl ?? null,
      downloadable: m.allowModDistribution !== false,
    }));
  }

  /** The newest downloadable file, preferring releases and (for Java) the server's Minecraft version. */
  async function resolveFile(modId: number, gameVersion: string | null, target?: CfTarget, fileId?: number): Promise<CfResolvedFile> {
    const { data: mod } = await cf<{ data: CfMod }>(`/v1/mods/${modId}`);
    if (mod.allowModDistribution === false) {
      throw new HttpError(409, `“${mod.name}”’s author only allows downloads from the CurseForge website — download it there and upload it here`);
    }
    const loaderType = target ? MOD_LOADER_TYPE[target] : undefined;
    const { data: files } = await cf<{ data: CfFile[] }>(`/v1/mods/${modId}/files?pageSize=50${loaderType ? `&modLoaderType=${loaderType}` : ''}`);
    const candidates = fileId ? [(await cf<{ data: CfFile }>(`/v1/mods/${modId}/files/${fileId}`)).data] : files;
    if (fileId && loaderType && !candidates[0].gameVersions.some(v => v.toLowerCase() === target!.slice(4))) {
      throw new HttpError(400, 'Selected mod version does not support this loader');
    }
    const usable = candidates
      .filter((f) => f.downloadUrl && f.isAvailable !== false)
      .sort((a, b) => a.releaseType - b.releaseType || Date.parse(b.fileDate) - Date.parse(a.fileDate));
    if (!usable.length) throw new HttpError(409, `No downloadable file for “${mod.name}”`);
    const matching = gameVersion ? usable.filter((f) => f.gameVersions.includes(gameVersion)) : [];
    const pick = matching[0] ?? usable[0];
    return {
      title: mod.name,
      dependencies: pick.dependencies ?? [],
      fileName: pick.fileName,
      downloadUrl: pick.downloadUrl!,
      versionLabel: pick.displayName,
      sizeBytes: pick.fileLength,
      versionMismatchWarning: !!gameVersion && !matching.length,
    };
  }

  /** Resolve a public Minecraft mod project URL through the API; never fetch user URLs. */
  async function resolveLink(link: string): Promise<CfResult> {
    const slug = parseCurseForgeModLink(link);
    const params = new URLSearchParams({ gameId: '432', classId: '6', slug, pageSize: '1' });
    const { data } = await cf<{ data: CfMod[] }>(`/v1/mods/search?${params}`);
    const mod = data.find(m => m.slug === slug && m.classId === 6);
    if (!mod) throw new HttpError(404, 'That Minecraft mod was not found on CurseForge');
    return {
      id: mod.id, slug: mod.slug, title: mod.name, description: mod.summary,
      iconUrl: mod.logo?.thumbnailUrl ?? null, downloads: mod.downloadCount,
      author: mod.authors?.[0]?.name ?? 'unknown', categories: (mod.categories ?? []).map(c => c.name),
      className: 'Mods', websiteUrl: `https://www.curseforge.com/minecraft/mc-mods/${mod.slug}`,
      downloadable: mod.allowModDistribution !== false,
    };
  }

  async function versions(modId: number, gameVersion: string, target: CfTarget) {
    const params = new URLSearchParams({ gameVersion, pageSize: '50' });
    if (MOD_LOADER_TYPE[target]) params.set('modLoaderType', String(MOD_LOADER_TYPE[target]));
    const { data } = await cf<{ data: CfFile[] }>(`/v1/mods/${modId}/files?${params}`);
    return data.filter(f => f.downloadUrl && f.isAvailable !== false && f.gameVersions.includes(gameVersion)).map(f => ({ id: String(f.id), name: f.displayName }));
  }

  /** Confirms a key works before it's saved. */
  async function checkKey(key: string): Promise<void> {
    const res = await deps.fetch(`${API}/v1/games?pageSize=1`, { headers: { 'x-api-key': key, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (res.status === 401 || res.status === 403) throw new HttpError(400, 'CurseForge rejected that key');
    if (!res.ok) throw new HttpError(502, `CurseForge answered ${res.status}`);
  }

  return { classes, search, resolveFile, resolveLink, versions, checkKey, reset: () => (gameIds.clear(), classCache.clear()) };
}

export const curseforge = createCurseForge({
  fetch: (url, init) => fetch(url, init),
  getKey: () => getSetting(SETTING_CURSEFORGE_KEY) ?? null,
});

export function curseforgeStatus(): { configured: boolean; keyHint: string | null } {
  const key = getSetting(SETTING_CURSEFORGE_KEY);
  return { configured: !!key, keyHint: key ? `…${key.slice(-4)}` : null };
}

export async function saveCurseforgeKey(key: string | null): Promise<void> {
  if (!key) {
    clearSetting(SETTING_CURSEFORGE_KEY);
  } else {
    await curseforge.checkKey(key);
    setSetting(SETTING_CURSEFORGE_KEY, key);
  }
  curseforge.reset();
}

/** Only project links are accepted so a file URL cannot silently select a different release. */
export function parseCurseForgeModLink(link: string): string {
  let url: URL;
  try { url = new URL(link.trim()); } catch { throw new HttpError(400, 'Enter a valid CurseForge Minecraft mod project link'); }
  if (url.protocol !== 'https:' || !['curseforge.com', 'www.curseforge.com'].includes(url.hostname) || url.username || url.password || url.port) {
    throw new HttpError(400, 'Use an HTTPS link from curseforge.com');
  }
  const match = /^\/minecraft\/mc-mods\/([a-z0-9][a-z0-9-]*)\/?$/.exec(url.pathname);
  if (!match) throw new HttpError(400, 'Use a Minecraft mod project link, such as https://www.curseforge.com/minecraft/mc-mods/jade. Modpacks and individual file links are not supported here.');
  return match[1];
}
