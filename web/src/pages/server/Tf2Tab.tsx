import { useEffect, useRef, useState } from 'react';
import { useChangeReview } from '../../components/ChangeReview.js';
import { api, ApiError, type UploadProgress } from '../../api/client.js';
import { Badge, Button, Card, CardTitle, ErrorText, Field, Input, Notice, Select, Spinner } from '../../components/ui.js';
import { UploadTracker } from '../../components/UploadTracker.js';
import { useToast } from '../../components/Toast.js';
import { useConfirm } from '../../components/ConfirmDialog.js';
import { useUnsavedChanges } from '../../lib/unsaved.js';
import { useServerDetail } from './ServerContext.js';

interface Settings {
  map: string; rotation: string[]; maxPlayers: number; hostname: string;
  preset: string | null; cvars: Record<string, string>; hasPassword: boolean; hasGslt: boolean;
}
interface View {
  settings: Settings;
  maps: string[];
  plugins: { name: string; kind: 'plugin' | 'vpk' | 'custom'; enabled: boolean }[];
  presets: { id: string; label: string; description: string; maxPlayers: number; cvars: Record<string, string> }[];
  frameworks: { metamod: boolean; sourcemod: boolean };
  frameworkJob: { state: 'running' | 'failed' | 'done'; error?: string } | null;
  running: boolean;
}
export function Tf2Tab() {
  const review = useChangeReview();
  const { serverId, server, can } = useServerDetail();
  const toast = useToast();
  const confirm = useConfirm();
  const [view, setView] = useState<View | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [rotation, setRotation] = useState('');
  const [cvars, setCvars] = useState('');
  const [password, setPassword] = useState('');
  const [gslt, setGslt] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  const [clearGslt, setClearGslt] = useState(false);
  const [changeMap, setChangeMap] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const mapInput = useRef<HTMLInputElement>(null);
  const modInput = useRef<HTMLInputElement>(null);
  const base = `/servers/${serverId}/tf2`;
  const cfgText = (settings: Settings) => Object.entries(settings.cvars).map(([k, v]) => `${k}=${v}`).join('\n');
  const dirty = !!view && !!draft && (JSON.stringify(view.settings) !== JSON.stringify(draft) || rotation !== view.settings.rotation.join('\n') || cvars !== cfgText(view.settings) || !!password || !!gslt || clearPassword || clearGslt);
  useUnsavedChanges(dirty, 'TF2 settings');
  function apply(v: View) {
    setView(v); setDraft(v.settings); setRotation(v.settings.rotation.join('\n')); setCvars(cfgText(v.settings));
    setPassword(''); setGslt(''); setClearPassword(false); setClearGslt(false);
  }
  useEffect(() => {
    let cancelled = false;
    setView(null); setDraft(null); setError('');
    api.get<View>(base).then((v) => { if (!cancelled) apply(v); }).catch((err) => { if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load TF2 controls'); });
    return () => { cancelled = true; };
  }, [base]);
  const installing = view?.frameworkJob?.state === 'running';
  useEffect(() => {
    if (!installing) return;
    const timer = window.setInterval(() => {
      api.get<View>(base).then((v) => setView(v)).catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [installing, base]);
  // Refresh uploaded maps and plugin state without overwriting unsaved settings.
  useEffect(() => {
    const timer = window.setInterval(() => {
      api.get<View>(base).then((v) => setView((current) => current ? { ...current, maps: v.maps, plugins: v.plugins, frameworks: v.frameworks, frameworkJob: v.frameworkJob, running: v.running } : current)).catch(() => undefined);
    }, 30000);
    return () => window.clearInterval(timer);
  }, [base]);
  async function run(key: string, action: () => Promise<void>) {
    setBusy(key); setError('');
    try { await action(); }
    catch (err) { setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'TF2 action failed'); }
    finally { setBusy(''); setProgress(null); }
  }
  async function upload(file: File | undefined, kind: 'map' | 'mod') {
    if (!file || busy) return;
    await run(`upload-${kind}`, async () => {
      const form = new FormData(); form.append('file', file);
      const v = await api.upload<View>(`${base}/upload/${kind}`, form, setProgress);
      setView((old) => old ? { ...old, maps: v.maps, plugins: v.plugins, frameworks: v.frameworks } : v);
      toast.success(`${file.name} installed${kind === 'mod' ? ' — start TF2 to load it' : ''}`);
    });
  }
  if (!view || !draft) return error ? <ErrorText>{error}</ErrorText> : <Spinner />;
  const locked = !!busy || !!installing;
  const running = !!server && ['running', 'starting', 'stopping'].includes(server.status);
  const canEdit = can('settings');
  const textArea = 'ui-input min-h-28 w-full rounded-xl border border-surface-600 bg-surface-950 p-3 font-mono text-xs text-ink-200';
  return (
    <div className="space-y-5">
      <ErrorText>{error}</ErrorText>
      <UploadTracker progress={progress} />
      <Card className="p-5">
        <CardTitle>TF2 presets</CardTitle>
        <div className="grid gap-3 sm:grid-cols-3">{view.presets.map((p) => <button key={p.id} type="button" disabled={!canEdit || locked} onClick={() => {
          const next = { ...draft, preset: p.id, maxPlayers: p.maxPlayers, cvars: { ...draft.cvars, ...p.cvars } };
          setDraft(next); setCvars(cfgText(next));
        }} className={`state-layer rounded-2xl border p-4 text-left disabled:opacity-50 ${draft.preset === p.id ? 'border-accent-400 bg-secondary-container' : 'border-surface-600 bg-surface-900'}`}>
          <span className="block font-medium text-ink-100">{p.label}</span><span className="mt-1 block text-xs text-ink-400">{p.description}</span>
        </button>)}</div>
        <p className="mt-3 text-xs text-ink-400">Presets fill the form below. Save to activate them. Competitive is a basic configuration, not a league ruleset.</p>
      </Card>
      <Card className="p-5">
        <CardTitle>Maps &amp; rotation</CardTitle>
        <fieldset disabled={!canEdit || locked} className="space-y-4">
          <Field label="Start map"><Input value={draft.map} onChange={(e) => setDraft({ ...draft, map: e.target.value })} list="tf2-installed-maps" placeholder="ctf_2fort or a TF2 Workshop map link / ID" /></Field>
          <datalist id="tf2-installed-maps">{view.maps.map((m) => <option key={m} value={m} />)}</datalist>
          <Field label="Map rotation (one map or Workshop ID per line)"><textarea className={textArea} value={rotation} onChange={(e) => setRotation(e.target.value)} placeholder={'ctf_2fort\ncp_dustbowl\npl_badwater'} /></Field>
          <p className="text-xs text-ink-400">TF2 downloads Workshop maps when loading them. Use map items from the TF2 Workshop; cosmetic submissions are not server mods. An empty rotation uses the server’s normal mapcycle.txt.</p>
        </fieldset>
        <div className="mt-4 flex flex-wrap gap-2">
          <input ref={mapInput} type="file" accept=".bsp" className="hidden" onChange={(e) => { void upload(e.target.files?.[0], 'map'); e.target.value = ''; }} />
          <Button disabled={!canEdit || locked} onClick={() => mapInput.current?.click()}>Upload .bsp map</Button>
          <a href="https://steamcommunity.com/workshop/browse/?appid=440&requiredtags%5B%5D=Map" target="_blank" rel="noreferrer" className="rounded-full px-4 py-2 text-sm text-accent-400 underline">Browse TF2 Workshop</a>
        </div>
        <p className="mt-2 text-xs text-ink-400">{view.maps.length} installed maps. Uploaded maps appear in the start-map suggestions.</p>
        <div className="mt-4 flex flex-wrap items-end gap-2">
          <div className="min-w-48 flex-1"><Field label="Change map now"><Input value={changeMap} onChange={(e) => setChangeMap(e.target.value)} list="tf2-installed-maps" placeholder="Map name or Workshop ID" /></Field></div>
          <Button disabled={!can('console') || locked || server?.status !== 'running' || !changeMap.trim()} onClick={() => void run('map', async () => {
            await api.post(`${base}/action`, { action: 'changelevel', map: changeMap }); toast.success('Map change sent');
          })}>Change map</Button>
        </div>
      </Card>
      <Card className="p-5">
        <CardTitle>Server settings</CardTitle>
        <fieldset disabled={!canEdit || locked} className="grid gap-4 sm:grid-cols-2">
          <Field label="Server name"><Input value={draft.hostname} onChange={(e) => setDraft({ ...draft, hostname: e.target.value })} /></Field>
          <Field label="Max players"><Input type="number" min={1} max={100} value={draft.maxPlayers} onChange={(e) => setDraft({ ...draft, maxPlayers: Number(e.target.value) })} /></Field>
          <Field label="Join password"><Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={draft.hasPassword ? 'Set — leave blank to keep' : 'No password'} /><label className="mt-1 flex gap-2 text-xs text-ink-400"><input type="checkbox" checked={clearPassword} onChange={(e) => setClearPassword(e.target.checked)} />Clear saved password</label></Field>
          <Field label="Game Server Login Token (app 440)"><Input type="password" autoComplete="new-password" value={gslt} onChange={(e) => setGslt(e.target.value)} placeholder={draft.hasGslt ? 'Set — leave blank to keep' : 'Optional server login token'} /><label className="mt-1 flex gap-2 text-xs text-ink-400"><input type="checkbox" checked={clearGslt} onChange={(e) => setClearGslt(e.target.checked)} />Clear saved token</label></Field>
          <div className="sm:col-span-2"><Field label="Extra cvars (name=value, one per line)"><textarea className={textArea} value={cvars} onChange={(e) => { setCvars(e.target.value); setDraft({ ...draft, preset: null }); }} placeholder={'mp_timelimit=30\ntf_bot_quota=0\nsv_alltalk=0'} /></Field></div>
        </fieldset>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="primary" disabled={!canEdit || locked} onClick={() => void run('save', async () => {
            const entries = cvars.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
              const i = line.indexOf('='); if (i < 1) throw new Error('Each cvar needs name=value');
              return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
            });
            const input = { ...draft, rotation: rotation.split(/\r?\n/).map((s) => s.trim()).filter(Boolean), cvars: Object.fromEntries(entries), password, gslt, clearPassword, clearGslt };
            if (!await review(null, null, '', { serverId, kind: 'tf2', input })) return;
            apply(await api.put<View>(base, input));
            toast.success(running ? 'Saved — apply saved cvars now, or restart for all settings' : 'Saved — applies on next start');
          })}>{busy === 'save' ? 'Saving…' : 'Save settings'}</Button>
          <Button disabled={!canEdit || !can('console') || locked || dirty || server?.status !== 'running'} onClick={() => void run('apply', async () => { await api.post(`${base}/action`, { action: 'apply' }); toast.success('Saved cvars sent to TF2'); })}>Apply saved cvars now</Button>
          <Button variant="ghost" disabled={!can('console') || locked || server?.status !== 'running'} onClick={() => void run('round', async () => { await api.post(`${base}/action`, { action: 'restart-round' }); toast.success('Round restart sent'); })}>Restart round</Button>
          {dirty && <Button variant="ghost" disabled={locked} onClick={() => apply(view)}>Discard changes</Button>}
        </div>
        <p className="mt-2 text-xs text-ink-400">Start map, player slots and login token apply on restart. Saved cvars load on every map. Custom launch arguments can override launch settings.</p>
      </Card>
      <Card className="p-5">
        <CardTitle>Mods &amp; SourceMod plugins</CardTitle>
        <p className="mb-3 text-sm text-ink-400">Install Metamod:Source and SourceMod for server plugins. Upload .smx plugins, .vpk mods, or a .zip laid out relative to the tf folder (addons, cfg, custom, materials, models, sound, scripts or resource).</p>
        <div className="mb-3 flex flex-wrap items-center gap-2"><Badge tone={view.frameworks.metamod ? 'green' : 'neutral'}>Metamod {view.frameworks.metamod ? 'installed' : 'not installed'}</Badge><Badge tone={view.frameworks.sourcemod ? 'green' : 'neutral'}>SourceMod {view.frameworks.sourcemod ? 'installed' : 'not installed'}</Badge></div>
        {running && <Notice tone="info">Stop TF2 before installing frameworks or changing mods and plugins.</Notice>}
        {installing && <Notice tone="info">Installing official frameworks. Progress is in Console; this page updates automatically.</Notice>}
        {view.frameworkJob?.state === 'failed' && <Notice tone="error">{view.frameworkJob.error}</Notice>}
        {view.frameworkJob?.state === 'done' && <Notice tone="info">Frameworks installed. Start TF2 and run “meta list” and “sm plugins list” in Console to check loading.</Notice>}
        <div className="my-4 flex flex-wrap gap-2">
          <Button disabled={!can('plugins') || running || locked} onClick={() => void run('frameworks', async () => { const v = await api.post<View>(`${base}/frameworks`); setView((old) => old ? { ...old, frameworks: v.frameworks, frameworkJob: v.frameworkJob } : v); })}>{installing ? 'Installing…' : 'Install / update frameworks'}</Button>
          <input ref={modInput} type="file" accept=".smx,.vpk,.zip" className="hidden" onChange={(e) => { void upload(e.target.files?.[0], 'mod'); e.target.value = ''; }} />
          <Button disabled={!can('plugins') || running || locked} onClick={() => modInput.current?.click()}>Upload mod / plugin</Button>
        </div>
        <div className="divide-y divide-surface-700">{view.plugins.map((p) => <div key={`${p.kind}:${p.name}:${p.enabled}`} className="flex flex-wrap items-center gap-2 py-3">
          <span className="min-w-0 flex-1 break-all font-mono text-sm text-ink-200">{p.name}</span><Badge tone={p.enabled ? 'green' : 'neutral'}>{p.enabled ? 'Enabled' : 'Disabled'}</Badge>
          <Button variant="ghost" disabled={!can('plugins') || running || locked} onClick={() => void run('toggle', async () => {
            const v = await api.post<View>(`${base}/plugins/action`, { name: p.name, kind: p.kind, action: p.enabled ? 'disable' : 'enable' });
            setView((old) => old ? { ...old, plugins: v.plugins } : v);
          })}>{p.enabled ? 'Disable' : 'Enable'}</Button>
          <Button variant="ghost" disabled={!can('plugins') || running || locked} onClick={() => void run('remove', async () => {
            if (!await confirm({ title: 'Remove plugin', message: `Remove ${p.name}? Its configuration files are kept.`, confirmLabel: 'Remove', tone: 'danger' })) return;
            const v = await api.post<View>(`${base}/plugins/action`, { name: p.name, kind: p.kind, action: 'remove' }); setView((old) => old ? { ...old, plugins: v.plugins } : v);
          })}>Remove</Button>
        </div>)}</div>
        {!view.plugins.length && <p className="text-sm text-ink-400">No .smx plugins or .vpk mods installed yet.</p>}
        <p className="mt-3 text-xs text-ink-400">Plugin configs are in tf/cfg/sourcemod and tf/addons/sourcemod/configs in File Management. ZIP packages can replace existing files. Mods requiring client content may need FastDL and matching client downloads.</p>
      </Card>
    </div>
  );
}
