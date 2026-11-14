import { useEffect, useRef, useState } from 'react';
import { useChangeReview } from '../../components/ChangeReview.js';
import { Link } from 'react-router-dom';
import { api, ApiError, type UploadProgress } from '../../api/client.js';
import { Badge, Button, Card, CardTitle, ErrorText, Field, Input, Modal, Notice, Select, Spinner } from '../../components/ui.js';
import { UploadTracker } from '../../components/UploadTracker.js';
import { useToast } from '../../components/Toast.js';
import { useConfirm } from '../../components/ConfirmDialog.js';
import { useUnsavedChanges } from '../../lib/unsaved.js';
import { useServerDetail } from './ServerContext.js';
import { SatisfactoryControls } from './SatisfactoryControls.js';

interface GameField { key: string; label: string; type: 'text' | 'number' | 'boolean' | 'password' | 'select'; min?: number; max?: number; options?: string[]; help?: string }
interface View {
  profile: { id: string; label: string; fields: GameField[]; notes: string[]; map?: { key: string; label: string; upload?: string; rotation?: boolean; live?: string; note?: string } };
  settings: { values: Record<string, string>; rotation: string[] };
  maps: { value: string; label: string; source: string }[];
  files: { id: string; path: string; exists: boolean }[];
  uploads: { id: string; name: string; maps: string[]; files: number }[];
  secretSet: Record<string, boolean>;
  revision: string; port: number; allocatedPort: number | null; managed: boolean;
}
const area = 'ui-input min-h-32 w-full rounded-xl border border-surface-600 bg-surface-950 p-3 font-mono text-xs text-ink-200';
export function GameSettingsTab() {
  const review = useChangeReview();
  const { serverId, server, can, refresh } = useServerDetail();
  const toast = useToast(), confirm = useConfirm();
  const [view, setView] = useState<View | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [rotation, setRotation] = useState('');
  const [port, setPort] = useState(0);
  const [clearSecrets, setClearSecrets] = useState<string[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [mapQuery, setMapQuery] = useState('');
  const [mapNow, setMapNow] = useState('');
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [fileId, setFileId] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const base = `/servers/${serverId}/game-controls`;
  const dirty = !!view && (JSON.stringify(values) !== JSON.stringify(view.settings.values) || rotation !== view.settings.rotation.join('\n') || port !== view.port || clearSecrets.length > 0);
  useUnsavedChanges(dirty, 'Game settings');
  const apply = (v: View) => { setView(v); setValues(v.settings.values); setRotation(v.settings.rotation.join('\n')); setPort(v.port); setClearSecrets([]); };
  useEffect(() => {
    let cancelled = false; setView(null); setError('');
    api.get<View>(base).then((v) => { if (!cancelled) apply(v); }).catch((err) => { if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load game settings'); });
    return () => { cancelled = true; };
  }, [base]);
  async function run(key: string, action: () => Promise<void>) {
    setBusy(key); setError('');
    try { await action(); } catch (err) { setError(err instanceof ApiError ? err.message : 'Game settings action failed'); }
    finally { setBusy(''); setProgress(null); }
  }
  if (!view) return error ? <Notice tone="error">{error}</Notice> : <Spinner />;
  const stopped = !!server && ['stopped', 'crashed', 'install_failed'].includes(server.status);
  const canEdit = can('settings');
  const disabled = !canEdit || !stopped || !!busy;
  const map = view.profile.map;
  const setValue = (key: string, value: string) => setValues((v) => ({ ...v, [key]: value, ...(view.profile.id === 'valheim' && key === 'world' && view.maps.some((m) => m.value === value) ? { worldStorage: 'instance' } : {}) }));
  const maps = view.maps.filter((m) => m.label.toLowerCase().includes(mapQuery.toLowerCase()));
  async function upload(file: File | undefined) {
    if (!file) return;
    await run('upload', async () => {
      const form = new FormData(); form.append('file', file);
      const next = await api.upload<View & { uploaded: string[] }>(`${base}/maps/upload`, form, setProgress);
      apply(next);
      toast.success(`Uploaded ${file.name}. Select the map/world and save to use it.`);
    });
  }
  const accept = map?.upload === 'bsp' ? '.bsp,.zip' : map?.upload === 'pk3' ? '.pk3' : map?.upload === 'pbo' ? '.pbo' : map?.upload === 'terraria' ? '.wld,.zip' : '.zip';
  return (
    <div className="space-y-5">
      <ErrorText>{error}</ErrorText>
      <UploadTracker progress={progress} />
      {!canEdit && <Notice tone="info">Game settings are read-only for this account. Saving changes requires settings permission.</Notice>}
      {map?.upload && !can('files.write') && <Notice tone="info">Uploading or removing maps/worlds also requires files.write permission. Open Capabilities for all action requirements.</Notice>}
      {!stopped && <Notice tone="info">Stop the server to change startup settings, edit native configuration or upload maps/worlds. Live map changes remain available where supported.</Notice>}
      {server?.launch_config && <Notice tone="warning">Custom launch settings may override this page. Check Configuration → Launch if the server does not use the selected settings.</Notice>}
      <Card className="p-5">
        <CardTitle action={<Badge tone={view.managed ? 'green' : 'neutral'}>{view.managed ? 'Managed settings' : 'Existing configuration'}</Badge>}>{view.profile.label} settings</CardTitle>
        <div className="mb-4 space-y-1 text-sm text-ink-400">{view.profile.notes.map((note) => <p key={note}>{note}</p>)}</div>
        <fieldset disabled={disabled} className="grid gap-4 sm:grid-cols-2">
          <Field label="Game port"><Input type="number" min={1} max={65535} value={port} disabled={disabled || view.allocatedPort !== null} onChange={(e) => setPort(Number(e.target.value))} />{view.allocatedPort !== null && <p className="mt-1 text-xs text-ink-400">Assigned by an allocation pool. Change the assignment before changing ports.</p>}</Field>
          {view.profile.fields.map((field) => <Field key={field.key} label={field.label}>
            {field.type === 'select' || field.type === 'boolean' ? <Select value={values[field.key]} onChange={(e) => setValue(field.key, e.target.value)}>
              {(field.type === 'boolean' ? ['true', 'false'] : field.options ?? []).map((option) => <option key={option} value={option}>{field.type === 'boolean' ? option === 'true' ? 'On' : 'Off' : option}</option>)}
            </Select> : <Input type={field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'} autoComplete={field.type === 'password' ? 'new-password' : undefined} value={values[field.key] ?? ''} min={field.min} max={field.max} step={field.min !== undefined && !Number.isInteger(field.min) ? 'any' : 1} list={field.key === map?.key ? 'game-map-options' : undefined} placeholder={field.type === 'password' && view.secretSet[field.key] ? 'Set — leave blank to keep' : undefined} onChange={(e) => setValue(field.key, e.target.value)} />}
            {field.help && <p className="mt-1 text-xs text-ink-400">{field.help}</p>}
            {field.type === 'password' && view.secretSet[field.key] && <label className="mt-1 flex items-center gap-2 text-xs text-ink-400"><input type="checkbox" checked={clearSecrets.includes(field.key)} onChange={(e) => setClearSecrets(e.target.checked ? [...clearSecrets, field.key] : clearSecrets.filter((k) => k !== field.key))} />Clear saved password</label>}
          </Field>)}
          <datalist id="game-map-options">{view.maps.map((m) => <option key={m.value} value={m.value} />)}</datalist>
          {map?.rotation && <div className="sm:col-span-2"><Field label={view.profile.id === 'arma3' ? 'Mission rotation (one template per line)' : 'Map rotation (one map per line)'}><textarea className={area} value={rotation} onChange={(e) => setRotation(e.target.value)} /></Field></div>}
        </fieldset>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button variant="primary" disabled={disabled} onClick={() => void run('save', async () => {
            if (!await review(null, null, '', { serverId, kind: 'game-controls', input: { revision: view.revision, values, port, clearSecrets, ...(map?.rotation ? { rotation: rotation.split(/\r?\n/).map(v => v.trim()).filter(Boolean) } : {}) } })) return;
            if (map && values[map.key] !== view.settings.values[map.key] && !await confirm({ title: 'Change map or world', message: 'The next start will use the selected map/world. A different world or save name may create a fresh save. Existing saves are kept; make a backup before switching.', confirmLabel: 'Save selection' })) return;
            apply(await api.put<View>(base, { revision: view.revision, values, port, clearSecrets, ...(map?.rotation ? { rotation: rotation.split(/\r?\n/).map((v) => v.trim()).filter(Boolean) } : {}) }));
            await refresh(); toast.success('Game settings saved — apply on next start');
          })}>{busy === 'save' ? 'Saving…' : 'Save game settings'}</Button>
          <Button variant="ghost" disabled={!!busy} onClick={() => void run('reload', async () => {
            if (dirty && !await confirm({ title: 'Reload settings', message: 'Discard unsaved edits and reload the current server configuration?', confirmLabel: 'Reload' })) return;
            apply(await api.get<View>(base));
          })}>Reload</Button>
          {dirty && <Button variant="ghost" disabled={!!busy} onClick={() => apply(view)}>Discard changes</Button>}
        </div>
        <p className="mt-2 text-xs text-ink-400">Changes apply on restart. The port is shared with Outpost’s Configuration tab. Managed fields take precedence over matching extra launch arguments.</p>
      </Card>
      {map && <Card className="p-5">
        <CardTitle>{map.label}</CardTitle>
        {map.note && <p className="mb-4 text-sm text-ink-400">{map.note}</p>}
        <div className="mb-3 flex flex-wrap gap-2"><Input className="min-w-48 flex-1" aria-label="Filter maps or worlds" placeholder="Filter installed maps or worlds…" value={mapQuery} onChange={(e) => setMapQuery(e.target.value)} />
          {map.upload && <><input ref={fileInput} type="file" accept={accept} className="hidden" onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ''; }} /><Button disabled={disabled || !can('files.write') || dirty} onClick={() => fileInput.current?.click()}>Upload map / world</Button></>}
        </div>
        <div className="max-h-80 divide-y divide-surface-700 overflow-y-auto rounded-xl border border-surface-700">
          {maps.map((m) => <div key={m.value} className="flex flex-wrap items-center gap-3 px-3 py-2"><span className="min-w-0 flex-1"><span className="block break-all text-sm text-ink-100">{m.label}</span><span className="block text-xs text-ink-500">{m.source}</span></span>
            <Button variant="ghost" disabled={disabled} onClick={() => setValue(map.key, view.profile.id === 'project_zomboid' ? [...new Set([m.value, ...values[map.key].split(';').filter(Boolean)])].join(';') : m.value)}>{view.profile.id === 'project_zomboid' ? 'Add to map order' : 'Select'}</Button>
            {map.rotation && <Button variant="ghost" disabled={disabled} onClick={() => setRotation((v) => [...new Set([...v.split('\n').filter(Boolean), m.value])].join('\n'))}>Add to rotation</Button>}
          </div>)}
          {!maps.length && <p className="p-3 text-sm text-ink-400">No map/world files found. Install game content or upload a supported map package.</p>}
        </div>
        {map.upload && <p className="mt-2 text-xs text-ink-400">Accepted: {accept}. Maximum 256 MB per upload. Existing maps and saves are never overwritten.</p>}
        {map.upload && dirty && <p className="mt-2 text-xs text-ink-400">Save or discard form edits before uploading or removing a package.</p>}
        {!!view.uploads.length && <div className="mt-4 space-y-2"><h3 className="text-sm font-medium text-ink-100">Uploaded packages</h3>{view.uploads.map((upload) => <div key={upload.id} className="flex items-center gap-2 rounded-xl bg-surface-950 p-3"><span className="min-w-0 flex-1 break-all text-sm text-ink-300">{upload.name}<span className="ml-2 text-xs text-ink-500">{upload.files} files</span></span><Button variant="ghost" disabled={disabled || dirty || !can('files.write')} onClick={() => void run('remove', async () => {
          if (!await confirm({ title: 'Remove uploaded map / world', message: `Delete the files uploaded in ${upload.name}? This cannot be undone. Selected worlds and rotation entries must be changed first.`, confirmLabel: 'Remove files', tone: 'danger' })) return;
          apply(await api.delete<View>(`${base}/maps/uploads/${upload.id}`)); toast.success('Uploaded package removed');
        })}>Remove package</Button></div>)}</div>}
        {map.live && <div className="mt-4 flex flex-wrap items-end gap-2"><div className="min-w-48 flex-1"><Field label="Change map now"><Input value={mapNow} list="game-map-options" onChange={(e) => setMapNow(e.target.value)} /></Field></div>
          <Button disabled={!can('console') || server?.status !== 'running' || !!busy || !mapNow} onClick={() => void run('change-map', async () => {
            if (!await confirm({ title: 'Change map now', message: 'This will end the current map for connected players.', confirmLabel: 'Change map' })) return;
            await api.post(`${base}/maps/change`, { map: mapNow }); toast.success('Map change sent — check Console for the game response');
          })}>Change map</Button>
        </div>}
      </Card>}
      {view.profile.id === 'satisfactory' && <SatisfactoryControls base={`${base}/satisfactory`} />}
      {!!view.files.length && <Card className="p-5">
        <CardTitle>Native configuration</CardTitle>
        <p className="mb-3 text-sm text-ink-400">Edit the game’s full configuration for settings beyond the common controls above. Common fields are synchronized when saving the primary file.</p>
        <div className="divide-y divide-surface-700">{view.files.map((file) => <div key={file.id} className="flex items-center gap-3 py-2"><span className="min-w-0 flex-1 break-all font-mono text-xs text-ink-300">{file.path}{!file.exists && <span className="ml-2 text-ink-500">not created yet</span>}</span><Button variant="ghost" disabled={!canEdit || !!busy || dirty} onClick={() => setFileId(file.id)}>Edit</Button></div>)}</div>
        {dirty && <p className="mt-2 text-xs text-ink-400">Save or discard your form edits before opening native configuration.</p>}
      </Card>}
      <p className="text-xs text-ink-400">Map changes, world imports and configuration edits are separate from snapshots. <Link to="../backups" className="text-accent-400 underline">Create a backup</Link> before making world changes.</p>
      {fileId !== null && <NativeConfig base={base} id={fileId} writable={stopped && canEdit} onClose={() => setFileId(null)} onSaved={async () => apply(await api.get<View>(base))} />}
    </div>
  );
}

function NativeConfig({ base, id, writable, onClose, onSaved }: { base: string; id: string; writable: boolean; onClose: () => void; onSaved: () => Promise<void> }) {
  const confirm = useConfirm(), toast = useToast();
  const [file, setFile] = useState<{ path: string; content: string; revision: string } | null>(null);
  const [content, setContent] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const dirty = !!file && content !== file.content;
  useUnsavedChanges(dirty, 'Native game configuration');
  useEffect(() => { api.get<NonNullable<typeof file>>(`${base}/config/${id}`).then((v) => { setFile(v); setContent(v.content); }).catch((err) => setError(err instanceof ApiError ? err.message : 'Could not read configuration')); }, [base, id]);
  async function close() { if (!busy && (!dirty || await confirm({ title: 'Discard configuration edits', message: 'Close without saving?', confirmLabel: 'Discard' }))) onClose(); }
  return <Modal open title={file?.path ?? 'Native configuration'} onClose={() => void close()} size="xl">
    <div className="space-y-3"><ErrorText>{error}</ErrorText>{!file && !error ? <Spinner /> : file && <>
      {!writable && <Notice tone="info">Stop the server to edit this configuration.</Notice>}
      <textarea aria-label="Native configuration content" spellCheck={false} className={`${area} h-[50vh]`} value={content} disabled={!writable || busy} onChange={(e) => setContent(e.target.value)} />
      <div className="flex justify-end gap-2"><Button variant="ghost" disabled={busy} onClick={() => void close()}>Close</Button><Button variant="primary" disabled={!writable || busy || !dirty} onClick={async () => {
        setBusy(true); setError(''); try { const v = await api.put<NonNullable<typeof file>>(`${base}/config/${id}`, { content, revision: file.revision }); setFile(v); await onSaved(); toast.success('Native configuration saved'); } catch (err) { setError(err instanceof ApiError ? err.message : 'Save failed'); } finally { setBusy(false); }
      }}>{busy ? 'Saving…' : 'Save configuration'}</Button></div>
    </>}</div>
  </Modal>;
}
