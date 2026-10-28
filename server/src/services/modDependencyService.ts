import { resolvePluginVersion, modrinthProjectTitle, type ResolvedPluginVersion } from './pluginRegistryService.js';
import { curseforge, type CfTarget } from './curseforgeService.js';
import type { AddonCatalog } from './pluginService.js';

export interface ModDependency {
  id: string;
  title: string;
  required: boolean;
  resolved?: ResolvedPluginVersion;
  error?: string;
}

/** Resolve the complete required graph before downloading anything. Optional mods are shown only. */
export async function resolveModPlan(source: string, ref: string, catalog: AddonCatalog, gameVersion: string) {
  const dependencies: ModDependency[] = [];
  const seen = new Set<string>();
  const projects = new Map<string, string>();
  async function visit(id: string, required: boolean, versionId?: string, root = false): Promise<ResolvedPluginVersion | undefined> {
    const key = `${id}:${versionId ?? ''}:${required}`;
    if (seen.has(key)) return;
    if (seen.size >= 100) throw new Error('Too many mod dependencies');
    seen.add(key);
    const row: ModDependency = { id, title: id, required };
    if (!root) dependencies.push(row);
    try {
      let refs: { id: string; required: boolean; versionId?: string }[];
      let resolved: ResolvedPluginVersion;
      if (source === 'curseforge') {
        const file = await curseforge.resolveFile(Number(id), gameVersion, catalog as CfTarget);
        row.title = file.title;
        resolved = { versionNumber: file.versionLabel, fileName: file.fileName, downloadUrl: file.downloadUrl, sizeBytes: file.sizeBytes, versionMismatchWarning: file.versionMismatchWarning };
        refs = file.dependencies.filter(d => [2, 3].includes(d.relationType)).map(d => ({ id: String(d.modId), required: d.relationType === 3 }));
      } else {
        resolved = await resolvePluginVersion(id, catalog, gameVersion, versionId);
        row.title = await modrinthProjectTitle(resolved.projectId ?? id);
        refs = (resolved.dependencies ?? []).map(d => ({ id: d.projectId ?? d.versionId ?? '', versionId: d.versionId ?? undefined, required: d.required }));
      }
      if (resolved.versionMismatchWarning) throw new Error(`No compatible build for Minecraft ${gameVersion}`);
      if (required) {
        const project = resolved.projectId ?? id;
        const previous = projects.get(project);
        if (previous && previous !== resolved.fileName) throw new Error(`Conflicting required versions of ${row.title}; install compatible versions manually`);
        projects.set(project, resolved.fileName);
      }
      row.resolved = resolved;
      if (required) for (const dep of refs) {
        if (!dep.id) {
          dependencies.push({ id: 'external', title: 'External dependency', required: dep.required, error: 'Install manually; no catalog reference provided' });
        } else await visit(dep.id, dep.required, dep.versionId);
      }
      return resolved;
    } catch (err) {
      if (root) throw err;
      row.error = err instanceof Error ? err.message : 'Could not resolve dependency';
    }
  }
  const resolved = await visit(ref, true, undefined, true);
  return { resolved: resolved!, dependencies };
}
