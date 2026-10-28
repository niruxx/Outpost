import { useEffect, useState } from 'react';
import { api, ApiError } from '../../api/client.js';
import type { InstalledPlugin } from '../../api/types.js';
import { Button, Card, ErrorText, Input } from '../../components/ui.js';
import { useServerDetail } from './ServerContext.js';

export function ModVersionsCard() {
  const { serverId, server, can, running } = useServerDetail();
  const [mods, setMods] = useState<InstalledPlugin[]>([]);
  const [file, setFile] = useState('');
  const [source, setSource] = useState('modrinth');
  const [project, setProject] = useState('');
  const [ref, setRef] = useState('');
  const [versions, setVersions] = useState<{ id: string; name: string }[]>([]);
  const [version, setVersion] = useState('');
  const [dependencies, setDependencies] = useState<{ title: string; required: boolean; error?: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const eligible = server?.platform === 'java' && ['fabric', 'quilt', 'forge', 'neoforge', 'mohist', 'spongeforge'].includes(server.loader);
  const load = () => api.get<{ plugins: InstalledPlugin[] }>(`/servers/${serverId}/plugins`).then(r => setMods(r.plugins.filter(p => p.enabled)));
  useEffect(() => { if (eligible && can('plugins')) load().catch(e => setError(e.message)); }, [serverId, eligible]);
  useEffect(() => { setDependencies(null); }, [file, source, project, version]);
  if (!eligible || !can('plugins')) return null;
  const body = { source, ...(source === 'curseforge' ? { modId: Number(ref) } : { slug: ref }), versionId: version };
  async function act(action: 'lookup' | 'review' | 'install') {
    setBusy(true); setError(''); setMessage('');
    try {
      if (action === 'lookup') {
        setDependencies(null); setVersions([]); setVersion('');
        const result = await api.post<{ ref: string; versions: { id: string; name: string }[] }>(`/servers/${serverId}/plugins/versions`, { source, project });
        setRef(result.ref); setVersions(result.versions); setVersion(result.versions[0]?.id ?? '');
        if (!result.versions.length) setError('No compatible downloadable versions found for this instance.');
      } else if (action === 'review') {
        const result = await api.post<{ dependencies: NonNullable<typeof dependencies> }>(`/servers/${serverId}/plugins/dependencies`, body);
        setDependencies(result.dependencies);
      } else {
        await api.post(`/servers/${serverId}/plugins/install`, { ...body, includeDependencies: true, replaceFile: file });
        await load(); setDependencies(null); setFile('');
        setMessage('Version installed with required dependencies. The previous mod file was disabled when its filename changed.');
      }
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Version change failed'); }
    finally { setBusy(false); }
  }
  const reset = () => { setVersions([]); setVersion(''); setDependencies(null); };
  return <Card className="space-y-3 p-5">
    <h2 className="font-medium text-ink-100">Mod versions</h2>
    <p className="text-sm text-ink-400">Upgrade or downgrade an installed mod. Choose its project and a version compatible with Minecraft {server?.version}. Create a backup before changing versions.</p>
    <label className="block text-sm">Installed mod
      <select className="ui-input w-full" value={file} onChange={e => setFile(e.target.value)}><option value="">Choose a mod</option>{mods.map(m => <option key={m.fileName} value={m.fileName}>{m.displayName}</option>)}</select>
    </label>
    <select aria-label="Mod source" className="ui-input w-full" value={source} onChange={e => { setSource(e.target.value); reset(); }}><option value="modrinth">Modrinth</option><option value="curseforge">CurseForge</option></select>
    <Input aria-label="Mod project" value={project} onChange={e => { setProject(e.target.value); reset(); }} placeholder={source === 'curseforge' ? 'CurseForge mod project link or ID' : 'Modrinth project slug (for example, fabric-api)'} />
    <Button disabled={busy || !project.trim()} onClick={() => act('lookup')}>Find versions</Button>
    {versions.length > 0 && <>
      <select aria-label="Mod version" className="ui-input w-full" value={version} onChange={e => setVersion(e.target.value)}>{versions.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</select>
      <Button disabled={busy || !file || !version} onClick={() => act('review')}>Review dependencies</Button>
    </>}
    {dependencies && <div className="space-y-2 text-sm">
      {dependencies.length ? dependencies.map((d, i) => <p key={i}>{d.title} ({d.required ? 'required' : 'optional'}){d.error && `: ${d.error}`}</p>) : <p>No dependencies listed.</p>}
      <Button variant="primary" disabled={busy || running || dependencies.some(d => d.required && d.error)} onClick={() => act('install')}>{busy ? 'Installing...' : 'Install selected version and dependencies'}</Button>
    </div>}
    {running && <p className="text-sm text-ink-400">Stop the server before changing mod versions.</p>}
    <ErrorText>{error}</ErrorText>{message && <p role="status" className="text-sm">{message}</p>}
  </Card>;
}
