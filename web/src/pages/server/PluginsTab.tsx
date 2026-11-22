import { UploadTracker } from '../../components/UploadTracker.js';
import { BeamngEarthCard } from './BeamngEarthCard.js';
import { ModProtectionNotice } from '../../components/ModProtectionNotice.js';
import type { UploadProgress } from '../../api/client.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AddonInventory, AddonAction, InstalledAddon } from '../../api/addons.js';
import { AddonActionModal } from '../../components/AddonActionModal.js';
import { useServerDetail } from './ServerContext.js';
import { api, ApiError, downloadUrl } from '../../api/client.js';
import type { AddonSupport, InstalledPlugin, ServerRecord } from '../../api/types.js';
import { isProxyLoader, PLUGIN_CAPABLE_LOADERS } from '../../api/types.js';
import { useToast } from '../../components/Toast.js';
import { useConfirm } from '../../components/ConfirmDialog.js';
import { PluginSearchModal } from '../../components/PluginSearchModal.js';
import { Badge, Button, Card, ErrorText, Input, Select, Notice, Spinner } from '../../components/ui.js';
import { Icon } from '../../components/icons.js';
import { gameKindOf } from '../../components/GameArt.js';

/** Sidebar label for an instance's add-on page — each game calls them something different. */
export function addonNavLabel(server: ServerRecord): string {
  if (server.platform === 'bedrock') return 'Add-ons';
  if (server.platform === 'java' && (PLUGIN_CAPABLE_LOADERS.includes(server.loader) || isProxyLoader(server.loader))) return 'Plugins';
  if (server.platform === 'java' && server.loader === 'vanilla') return 'Data Packs';
  if (server.platform === 'steam' && (server.steam_preset === 'gmod' || server.steam_app_id === '4020')) return 'Addons';
  return gameKindOf(server) === 'valheim' ? 'Plugins' : 'Mods';
}

function formatSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb < 1 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${mb.toFixed(1)} MB`;
}

export function PluginsTab() {
  const { serverId, server, can } = useServerDetail();
  const canWrite = can('plugins');
  const toast = useToast();
  const confirm = useConfirm();
  const [support, setSupport] = useState<AddonSupport | null>(null);
  const [plugins, setPlugins] = useState<InstalledPlugin[] | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [inventory,setInventory]=useState<AddonInventory|null>(null),[query,setQuery]=useState(''),[filter,setFilter]=useState('all'),[error,setError]=useState(''),[action,setAction]=useState<{item:InstalledAddon;action:AddonAction}|null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const currentInstance=useRef(serverId),sequence=useRef(0);currentInstance.current=serverId;
  const coreKeeper = server?.steam_preset === 'core_keeper';
  const [replaceCoreKeeper, setReplaceCoreKeeper] = useState(false);
  const stopped=!!server&&(coreKeeper ? ['stopped','crashed'] : ['stopped','crashed','install_failed']).includes(server.status);

  const load = useCallback(async () => {
    if(currentInstance.current!==serverId)return;const seq=++sequence.current;
    try {
      const res = await api.get<{ support: AddonSupport; plugins: InstalledPlugin[];inventory:AddonInventory }>(`/servers/${serverId}/plugins`);
      if(currentInstance.current!==serverId||seq!==sequence.current)return;
      setSupport(res.support);
      setPlugins(res.plugins);
      setInventory(res.inventory);setError('');
    } catch (err) {
      if(currentInstance.current===serverId&&seq===sequence.current)setError(err instanceof Error?err.message:'Failed to load');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  useEffect(() => {
    setSupport(null);setPlugins(null);setInventory(null);setAction(null);setQuery('');setFilter('all');setBrowsing(false);setReplaceCoreKeeper(false);void load();return()=>{sequence.current++;};
  }, [load]);

  if (!support || plugins === null || (inventory && inventory.serverId !== serverId)) {
    return (
      <div className="flex items-center gap-2 text-sm text-ink-400">
        {error?<><ErrorText>{error}</ErrorText><Button onClick={load}>Retry installed add-ons</Button></>:<><Spinner /> Reading installed add-ons and manifests…</>}
      </div>
    );
  }

  if (!support.supported) {
    return (
      <Card className="p-8 text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-surface-700 text-ink-300">
          <Icon name="plugin" />
        </div>
        <p className="mb-2 text-base font-medium text-ink-100">No mod support for this instance</p>
        <p className="mx-auto max-w-lg text-sm text-ink-400">{support.reason}</p>
      </Card>
    );
  }

  const profile = support.profile;

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    const form = new FormData();
    if (coreKeeper && replaceCoreKeeper) form.append('replace', 'true');
    Array.from(files).forEach((f) => form.append('files', f));
    setUploading(true);
    try {
      const res = await api.upload<{ installed: string[]; plugins: InstalledPlugin[] }>(`/servers/${serverId}/plugins/upload`, form, setUploadProgress);
      if(currentInstance.current===serverId){setPlugins(res.plugins);await load();}
      toast.success(coreKeeper ? `Installed ${res.installed.length} mod(s)` : `Installed ${res.installed.join(', ')}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      setUploadProgress(null);
      if (fileInput.current) fileInput.current.value = '';
      setReplaceCoreKeeper(false);
    }
  }

  function openAction(plugin:InstalledPlugin,action:AddonAction){const item=inventory?.items.find(i=>i.fileName===plugin.fileName);if(!item){setError('Installed metadata changed; refresh the list.');return;}setAction({item,action});}
  const shown=plugins.filter(p=>{const item=inventory?.items.find(i=>i.fileName===p.fileName);const match=[p.fileName,item?.name??p.displayName,item?.metadata.version??'',...(item?.provides??[])].join(' ').toLowerCase().includes(query.toLowerCase());return match&&(filter==='all'||filter==='enabled'&&p.enabled||filter==='disabled'&&!p.enabled||filter===item?.installation);});
  const actions = canWrite && (
    <div className="flex flex-wrap gap-2">
      {profile.catalog && (
        <Button variant="primary" onClick={() => setBrowsing(true)}>
          <Icon name="search" className="h-4 w-4" /> Browse {profile.label.toLowerCase()}
        </Button>
      )}
      <Button variant={profile.catalog ? 'default' : 'primary'} disabled={uploading||!stopped} onClick={() => fileInput.current?.click()}>
        {uploading ? <Spinner /> : <Icon name="upload" className="h-4 w-4" />} Upload {profile.extensions.join(' / ')}
      </Button>
      <input ref={fileInput} type="file" multiple accept={profile.extensions.join(',')} className="hidden" onChange={(e) => upload(e.target.files)} />
    </div>
  );

  return (
    <div className="space-y-4">
      <BeamngEarthCard key={`earth-${serverId}`} onChanged={() => { void load(); }} />
      <ErrorText>{error}</ErrorText>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-normal text-ink-50">Installed {profile.label.toLowerCase()} ({plugins.length})</h2>
          <p className="mt-1 break-words text-sm text-ink-400">
            Stored in <span className="break-all font-mono text-ink-300">{profile.folder}</span>
          </p>
        </div>
        {actions}
      </div>

      {coreKeeper && (
        <Card className="space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3 text-sm">
            <a className="text-accent-400 underline" href="https://mod.io/g/corekeeper" target="_blank" rel="noreferrer">Browse mod.io</a>
            <a className="text-accent-400 underline" href="https://steamcommunity.com/app/1621690/workshop/" target="_blank" rel="noreferrer">Browse Steam Workshop</a>
            {can('files.read') && plugins.some((mod) => mod.enabled) && (
              <a className="inline-flex items-center gap-2 text-accent-400 underline" href={downloadUrl(`/servers/${serverId}/plugins/core-keeper-pack`)} download>
                <Icon name="download" className="h-4 w-4" /> Download enabled mods
              </a>
            )}
          </div>
          {canWrite && (
            <label className="flex items-start gap-2 text-sm text-ink-300">
              <input className="mt-1" type="checkbox" checked={replaceCoreKeeper} disabled={!stopped || uploading} onChange={(e) => setReplaceCoreKeeper(e.target.checked)} />
              <span>Replace installed versions on upload. Outpost takes a full instance backup first.</span>
            </label>
          )}
          <p className="text-xs text-ink-400">Players can use the downloaded ZIP to match the server’s enabled mod versions. Restart the server after making changes.</p>
        </Card>
      )}
      {!stopped&&<Notice tone="info">The installed list and detail pages are available while running. Stop the instance and finish background jobs before changing add-ons.</Notice>}
      {!canWrite&&<Notice tone="info">Managing installed add-ons requires plugins permission.</Notice>}
      <UploadTracker progress={uploadProgress} />
      <ModProtectionNotice serverId={serverId} />
      {profile.warning && <Notice tone="warning">{profile.warning}</Notice>}
      {profile.notes.length > 0 && (
        <Notice tone="info">
          <ul className="list-disc space-y-1 pl-4">
            {profile.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </Notice>
      )}

      <div className="grid gap-3 sm:grid-cols-[1fr_220px]"><Input aria-label="Search installed add-ons" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search names, versions, files or mod IDs"/><Select aria-label="Filter installed add-ons" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">All installed</option><option value="enabled">Enabled</option><option value="disabled">Disabled</option><option value="explicit">Explicitly installed / kept</option><option value="dependency">Automatic dependencies</option><option value="untracked">Untracked</option></Select></div>
      {!!inventory?.interrupted?.length&&<Card className="space-y-3 p-5"><h2>Interrupted add-on action: recovery required</h2><p className="text-sm text-amber-400">Startup is blocked. Restore the original artifacts from the File Management recycle bin or the recorded backup, then verify recovery here.</p>{inventory.interrupted.map(p=><div className="space-y-2" key={p.id}><p className="break-all text-xs">{p.action} - {p.id}</p>{p.backup&&<p className="break-all text-xs">Recovery backup: {p.backup}</p>}<Link className="text-sm text-accent-400 underline" to={`/instances/${serverId}/files`}>Open File Management</Link> <Link className="text-sm text-accent-400 underline" to={`/instances/${serverId}/backups`}>Open backups</Link><Button disabled={!canWrite||!stopped} onClick={async()=>{if(!await confirm({title:'Verify restored add-on set',message:'Compare every installed add-on with the pre-action hashes before clearing the startup fence?',confirmLabel:'Verify original files restored'}))return;try{await api.post('/servers/'+serverId+'/plugins/installed/recovery/'+p.id+'/resolve');await load();}catch(e){setError((e as Error).message);}}}>Confirm original files restored</Button></div>)}</Card>}
      <Card className="overflow-hidden">
        {shown.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-ink-400">{plugins.length?'No installed add-ons match these filters.':`No ${profile.label.toLowerCase()} installed yet.`}</div>
        ) : (
          <div className="divide-y divide-surface-700">
            {shown.map((p, i) => {const item=inventory?.items.find(n=>n.fileName===p.fileName);return (
              <div key={p.fileName} style={{ animationDelay: `${Math.min(i, 20) * 18}ms` }} className="animate-fade-in-up flex flex-wrap items-center gap-3 px-4 py-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-700 text-ink-300">
                  <Icon name="plugin" className="h-[18px] w-[18px]" />
                </span>
                <div className="min-w-0 flex-1 basis-40">
                  <p className="break-all text-sm font-medium text-ink-100">{item?<Link className="text-accent-400 hover:underline" to={`/instances/${serverId}/plugins/${item.id}`}>{item.name}</Link>:p.displayName}</p>
                  <p className="truncate text-xs text-ink-400">
                    {item?.metadata.version??item?.provenance?.version??'Unknown version'} - {formatSize(p.sizeBytes)}
                    {p.detail && ` · ${p.detail}`}
                  </p>
                </div>
                {item&&<><p className="text-xs text-ink-400">{item.installation==='dependency'?'Automatic dependency':item.installation==='explicit'?'Explicitly installed / kept':'Untracked'}{item.requiredBy.length?' - Required by '+item.requiredBy.length+' installed add-on(s)':''}</p><Link className="rounded-full border border-surface-600 px-3 py-2 text-sm text-ink-300" to={`/instances/${serverId}/plugins/${item.id}`}>Details</Link></>}
                <Badge tone={p.enabled ? 'green' : 'neutral'}>{p.enabled ? 'Enabled' : 'Disabled'}</Badge>
                {canWrite && (
                  <div className="flex flex-wrap gap-1.5">
                    {p.canToggle && (
                      <Button disabled={uploading||!stopped} onClick={() => openAction(p,p.enabled?'disable':'enable')}>
                        {p.enabled ? 'Disable' : 'Enable'}
                      </Button>
                    )}
                    <Button variant="danger" disabled={uploading||!stopped} onClick={() => openAction(p,'remove')}>
                      Uninstall
                    </Button>
                  </div>
                )}
              </div>
            );})}
          </div>
        )}
      </Card>

      {inventory?.warnings.map((w,i)=><Notice key={i} tone="warning">{w}</Notice>)}
      {inventory?.dependencyCleanup && <p className="text-xs text-ink-400">Dependency cleanup uses declared manifests and recorded installation ownership. Shared and explicitly kept mods are retained. Untracked dependencies are kept unless selected for review.</p>}
      {action&&<AddonActionModal key={serverId+action.item.id+action.action} serverId={serverId} item={action.item} action={action.action} dependencyCleanup={inventory?.dependencyCleanup??false} onClose={()=>setAction(null)} onApplied={r=>{setAction(null);toast.success(r.action==='remove'?'Uninstalled '+r.removed.map(i=>i.name).join(', '):'Add-on state updated');void load();}}/>}
      {profile.catalog && (
        <PluginSearchModal
          open={browsing}
          onClose={() => setBrowsing(false)}
          defaultServerId={serverId}
          catalog={profile.catalog}
          onInstalled={load}
        />
      )}
    </div>
  );
}
