import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type UploadProgress } from '../../api/client.js';
import { Badge, Button, Card, CardTitle, ErrorText, Field, Input, Notice, Spinner } from '../../components/ui.js';
import { UploadTracker } from '../../components/UploadTracker.js';
import { useServerDetail } from './ServerContext.js';
import { useToast } from '../../components/Toast.js';
import { useConfirm } from '../../components/ConfirmDialog.js';
import { useUnsavedChanges } from '../../lib/unsaved.js';

interface State { connected: boolean; offline?: boolean; options?: Record<string, string>; pendingOptions?: Record<string, string>; sessions?: { name: string; saves: { name: string; at: string }[] }[]; state?: Record<string, unknown> }
export function SatisfactoryControls({ base }: { base: string }) {
  const { can, server } = useServerDetail(), toast = useToast(), confirm = useConfirm();
  const [state, setState] = useState<State | null>(null), [token, setToken] = useState('');
  const [options, setOptions] = useState<Record<string, string>>({});
  const [name, setName] = useState(''), [saveName, setSaveName] = useState(''), [sessionName, setSessionName] = useState('');
  const [busy, setBusy] = useState(''), [error, setError] = useState('');
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dirty = JSON.stringify(options) !== JSON.stringify(state?.options ?? {});
  useUnsavedChanges(dirty, 'Satisfactory options');
  const apply = (v: State) => { setState(v); setOptions(v.options ?? {}); };
  useEffect(() => {
    if (!can('settings')) return;
    let cancelled = false;
    api.get<State>(base).then((v) => { if (!cancelled) apply(v); }).catch((err) => { if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not query Satisfactory'); });
    return () => { cancelled = true; };
    // Permissions and status come from the instance poll, without overwriting option drafts.
  }, [base]);
  async function run(key: string, fn: () => Promise<void>) { setBusy(key); setError(''); try { await fn(); } catch (err) { setError(err instanceof ApiError ? err.message : 'Satisfactory action failed'); } finally { setBusy(''); setProgress(null); } }
  const running = server?.status === 'running';
  const disabled = !!busy || !running || !can('settings') || !can('console');
  if (!can('settings')) return <Notice tone="info">Satisfactory API settings require configuration permission.</Notice>;
  return <Card className="p-5">
    <CardTitle action={<Badge tone={state?.connected ? 'green' : 'neutral'}>{state?.connected ? 'API connected' : 'API not connected'}</Badge>}>Satisfactory server &amp; saves</CardTitle>
    <ErrorText>{error}</ErrorText><UploadTracker progress={progress} />
    {!running && <Notice tone="info">Start Satisfactory to use its native API. Port changes still apply through the startup settings above.</Notice>}
    {!state?.connected && <div className="my-4 space-y-3">
      <p className="text-sm text-ink-400">Claim the server in the game’s Server Manager once, then generate an application token using <code>server.GenerateAPIToken</code> in its admin console. Paste it here to manage the server and saves from Outpost. The token stays on the Outpost host.</p>
      <Field label="Application API token"><Input type="password" autoComplete="new-password" value={token} onChange={(e) => setToken(e.target.value)} /></Field>
      <Button variant="primary" disabled={!token.trim() || !running || !!busy} onClick={() => void run('connect', async () => { apply(await api.post<State>(`${base}/connect`, { token })); setToken(''); })}>{busy === 'connect' ? 'Connecting…' : 'Connect API'}</Button>
    </div>}
    <div className="my-4 flex gap-2"><Button variant="ghost" disabled={!!busy || !running} onClick={() => void run('refresh', async () => {
      if (dirty && !await confirm({ title: 'Reload server options', message: 'Discard unsaved option edits?', confirmLabel: 'Reload' })) return;
      apply(await api.get<State>(base));
    })}>Refresh API state</Button>{state?.connected && <Button variant="ghost" disabled={!!busy} onClick={() => void run('disconnect', async () => { await api.delete(`${base}/connect`); apply({ connected: false }); })}>Disconnect API</Button>}</div>
    {!state && !error && running && <Spinner />}
    {state?.connected && !state.offline && <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-2"><div className="min-w-48 flex-1"><Field label="Server name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name shown in Server Manager" /></Field></div><Button disabled={disabled || !name.trim()} onClick={() => void run('rename', async () => { await api.post(`${base}/action`, { action: 'rename', name }); toast.success('Satisfactory server renamed'); })}>Rename server</Button></div>
      <div>
        <h3 className="mb-2 text-sm font-medium text-ink-100">Native server options</h3>
        <div className="grid gap-3 sm:grid-cols-2">{Object.entries(options).map(([key, value]) => <Field key={key} label={key}><Input disabled={disabled} value={value} onChange={(e) => setOptions({ ...options, [key]: e.target.value })} />{state.pendingOptions?.[key] !== undefined && <p className="mt-1 text-xs text-ink-400">Pending after restart: {state.pendingOptions[key]}</p>}</Field>)}</div>
        <Button className="mt-3" disabled={disabled || !dirty} onClick={() => void run('options', async () => { await api.post(`${base}/action`, { action: 'options', options }); apply(await api.get<State>(base)); toast.success('Options accepted — some require a session or server restart'); })}>Save server options</Button>
      </div>
      <div className="flex flex-wrap items-end gap-2"><div className="min-w-48 flex-1"><Field label="Create a save of the current session"><Input value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="New save filename" /></Field></div><Button disabled={disabled || !saveName.trim()} onClick={() => void run('save', async () => { await api.post(`${base}/action`, { action: 'save', name: saveName }); const v = await api.get<State>(base); setState((old) => old ? { ...old, sessions: v.sessions } : v); toast.success('Save created'); })}>Save current game</Button></div>
      <div>
        <h3 className="mb-2 text-sm font-medium text-ink-100">Sessions &amp; saves</h3>
        <div className="divide-y divide-surface-700">{state.sessions?.map((session) => <div key={session.name} className="py-3"><p className="text-sm font-medium text-ink-100">{session.name}</p>{session.saves.map((save) => <div key={save.name} className="flex items-center gap-2 py-1"><span className="min-w-0 flex-1 break-all text-sm text-ink-400">{save.name}</span><Button variant="ghost" disabled={disabled} onClick={() => void run('load', async () => {
          if (!await confirm({ title: 'Load Satisfactory save', message: `Load ${save.name}? This replaces the active session. Save current progress first. The API is temporarily unavailable while loading.`, confirmLabel: 'Load save' })) return;
          await api.post(`${base}/action`, { action: 'load', name: save.name }); toast.success('Save load accepted — refresh API state once loading finishes');
        })}>Load save</Button></div>)}</div>)}</div>
        {!state.sessions?.length && <p className="text-sm text-ink-400">No saves found. Create a new session or upload a .sav file.</p>}
        <input ref={fileRef} type="file" accept=".sav" className="hidden" onChange={(e) => {
          const file = e.target.files?.[0]; e.target.value = ''; if (!file) return;
          void run('upload', async () => { const form = new FormData(); form.append('file', file); const v = await api.upload<State>(`${base}/upload`, form, setProgress); setState((old) => old ? { ...old, sessions: v.sessions } : v); toast.success('Save uploaded — choose Load save to start it'); });
        }} />
        <Button className="mt-3" disabled={disabled || !can('files.write')} onClick={() => fileRef.current?.click()}>Upload .sav</Button>
      </div>
      <div className="flex flex-wrap items-end gap-2"><div className="min-w-48 flex-1"><Field label="New session name"><Input value={sessionName} onChange={(e) => setSessionName(e.target.value)} /></Field></div><Button disabled={disabled || !sessionName.trim()} onClick={() => void run('create', async () => {
        if (!await confirm({ title: 'Create Satisfactory session', message: 'Start a new session on the fixed game map? Save current progress before replacing the active session.', confirmLabel: 'Create session' })) return;
        await api.post(`${base}/action`, { action: 'create', name: sessionName }); toast.success('Session creation accepted — refresh API state after loading');
      })}>Create session</Button></div>
    </div>}
  </Card>;
}
