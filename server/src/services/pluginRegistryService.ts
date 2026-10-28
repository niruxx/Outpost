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
  if (catalog.startsWith('mod:')) {
    const loader = catalog.slice(4);
    return loader === 'quilt' ? ['quilt', 'fabric'] : [loader];
  }
  if (catalog === 'proxy:velocity') return ['velocity'];
  if (catalog === 'proxy:bungee') return ['bungeecord', 'waterfall'];
  return catalog === 'datapack' ? ['datapack'] : BUKKIT_LOADERS;
}

/** Searches Modrinth for Bukkit-family plugins, or vanilla data packs. */
export async function searchPlugins(query: string, limit = 24, catalog: AddonCatalog = 'plugin'): Promise<PluginSearchResult[]> {
  const facets = JSON.stringify(
    catalog === 'datapack'
      ? [['project_type:datapack']]
      : catalog.startsWith('mod:')
        ? [['project_type:mod'], loadersFor(catalog).map((l) => `categories:${l}`), ['server_side:required', 'server_side:optional']]
        : [loadersFor(catalog).map((l) => `categories:${l}`)]
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
  projectId?: string;
  dependencies?: { projectId: string | null; versionId: string | null; required: boolean }[];
  versionNumber: string;
  fileName: string;
  downloadUrl: string;
  sizeBytes: number;
  /** Set when we couldn't confirm exact Minecraft-version compatibility and fell back to the newest release. */
  versionMismatchWarning: boolean;
}

interface ModrinthVersion {
  project_id: string;
  loaders: string[];
  dependencies?: { project_id: string | null; version_id: string | null; dependency_type: string }[];
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
  gameVersion: string,
  versionId?: string
): Promise<ResolvedPluginVersion> {
  if (versionId) {
    const v = await modrinthFetch<ModrinthVersion>(`/version/${encodeURIComponent(versionId)}`);
    if (!v.game_versions.includes(gameVersion) || !v.loaders.some(l => loadersFor(catalog).includes(l))) throw new Error(`Required version of ${slug} is incompatible with this instance`);
    const project = await modrinthFetch<{ id: string }>(`/project/${encodeURIComponent(slug)}`);
    if (project.id !== v.project_id) throw new Error('Selected version does not belong to this mod project');
    const file = pickFile(v);
    if (!file) throw new Error(`No downloadable file for ${slug}`);
    return { projectId: v.project_id, dependencies: dependencyRefs(v), versionNumber: v.version_number, fileName: file.filename, downloadUrl: file.url, sizeBytes: file.size, versionMismatchWarning: false };
  }
  const loadersParam = JSON.stringify(loadersFor(catalog));

  // Proxy plugins aren't tied to a Minecraft version (the proxy's own version is unrelated).
  const proxy = catalog.startsWith('proxy:');
  const exact = proxy ? [] : await modrinthFetch<ModrinthVersion[]>(
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
      projectId: best.project_id,
      dependencies: dependencyRefs(best),
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
  const fallbackMatch = fromList(fallback, !proxy);
  if (fallbackMatch) return fallbackMatch;

  throw new Error(`No downloadable version of "${slug}" was found for this instance type.`);
}

function dependencyRefs(v: ModrinthVersion) {
  return (v.dependencies ?? []).filter(d => ['required', 'optional'].includes(d.dependency_type)).map(d => ({ projectId: d.project_id, versionId: d.version_id, required: d.dependency_type === 'required' }));
}
export async function modrinthProjectTitle(id: string): Promise<string> {
  return (await modrinthFetch<{ title: string }>(`/project/${encodeURIComponent(id)}`)).title;
}

export async function listModVersions(project: string, catalog: AddonCatalog, gameVersion: string) {
  const params = new URLSearchParams({ loaders: JSON.stringify(loadersFor(catalog)), game_versions: JSON.stringify([gameVersion]) });
  const versions = await modrinthFetch<(ModrinthVersion & { id: string })[]>(`/project/${encodeURIComponent(project)}/version?${params}`);
  return versions.filter(v => pickFile(v)).map(v => ({ id: v.id, name: v.version_number }));
}
