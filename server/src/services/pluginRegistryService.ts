import type { AddonCatalog } from './pluginService.js';

const MODRINTH_API = 'https://api.modrinth.com/v2';
// Modrinth tags Bukkit-ecosystem plugins with these loader/category values.
const BUKKIT_LOADERS = ['bukkit', 'spigot', 'paper', 'purpur', 'folia'];

async function modrinthFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${MODRINTH_API}${path}`, { headers: { 'User-Agent': 'Outpost-Panel (contact: panel-admin)' } });
  if (!res.ok) throw new Error(`Modrinth request failed (${res.status}): ${path}`);
  return (await res.json()) as T;
}

export interface PluginSearchResult {
  slug: string;
  title: string;
  description: string;
  iconUrl: string | null;
  downloads: number;
  author: string;
  categories: string[];
}

interface ModrinthSearchHit {
  slug: string;
  title: string;
  description: string;
  icon_url: string | null;
  downloads: number;
  author: string;
  categories: string[];
}

function loadersFor(catalog: AddonCatalog): string[] {
  if (catalog === 'bedrock') throw new Error('Modrinth has no Bedrock packs — use CurseForge');
  return catalog === 'datapack' ? ['datapack'] : BUKKIT_LOADERS;
}

/** Searches Modrinth for Bukkit-family plugins, or vanilla data packs. */
export async function searchPlugins(query: string, limit = 24, catalog: AddonCatalog = 'plugin'): Promise<PluginSearchResult[]> {
  const facets = JSON.stringify(
    catalog === 'datapack' ? [['project_type:datapack']] : [BUKKIT_LOADERS.map((l) => `categories:${l}`)]
  );
  const params = new URLSearchParams({
    query,
    facets,
    limit: String(Math.min(limit, 50)),
    index: query ? 'relevance' : 'downloads',
  });
  const data = await modrinthFetch<{ hits: ModrinthSearchHit[] }>(`/search?${params}`);
  return data.hits.map((h) => ({
    slug: h.slug,
    title: h.title,
    description: h.description,
    iconUrl: h.icon_url ?? null,
    downloads: h.downloads,
    author: h.author,
    categories: h.categories,
  }));
}

export interface ResolvedPluginVersion {
  versionNumber: string;
  fileName: string;
  downloadUrl: string;
  sizeBytes: number;
  /** Set when we couldn't confirm exact Minecraft-version compatibility and fell back to the newest release. */
  versionMismatchWarning: boolean;
}

interface ModrinthVersion {
  version_number: string;
  version_type: string;
  game_versions: string[];
  files: { filename: string; url: string; size: number; primary: boolean }[];
}

function pickFile(version: ModrinthVersion) {
  return version.files.find((f) => f.primary) ?? version.files[0];
}

/** Resolves the best download for a plugin against a specific server's loader + Minecraft version. */
export async function resolvePluginVersion(
  slug: string,
  catalog: AddonCatalog,
  gameVersion: string
): Promise<ResolvedPluginVersion> {
  const loadersParam = JSON.stringify(loadersFor(catalog));

  const exact = await modrinthFetch<ModrinthVersion[]>(
    `/project/${encodeURIComponent(slug)}/version?loaders=${encodeURIComponent(loadersParam)}&game_versions=${encodeURIComponent(
      JSON.stringify([gameVersion])
    )}`
  ).catch(() => [] as ModrinthVersion[]);

  const fromList = (list: ModrinthVersion[], mismatch: boolean): ResolvedPluginVersion | null => {
    if (!list.length) return null;
    const best = list.find((v) => v.version_type === 'release') ?? list[0];
    const file = pickFile(best);
    if (!file) return null;
    return {
      versionNumber: best.version_number,
      fileName: file.filename,
      downloadUrl: file.url,
      sizeBytes: file.size,
      versionMismatchWarning: mismatch,
    };
  };

  const exactMatch = fromList(exact, false);
  if (exactMatch) return exactMatch;

  const fallback = await modrinthFetch<ModrinthVersion[]>(
    `/project/${encodeURIComponent(slug)}/version?loaders=${encodeURIComponent(loadersParam)}`
  ).catch(() => [] as ModrinthVersion[]);
  const fallbackMatch = fromList(fallback, true);
  if (fallbackMatch) return fallbackMatch;

  throw new Error(`No downloadable version of "${slug}" was found for this instance type.`);
}
