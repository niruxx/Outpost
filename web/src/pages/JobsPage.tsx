import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { Layout, PageHeader } from '../components/Layout.js';
import { Button, Card, ErrorText, Input, Select } from '../components/ui.js';
import { setVisibleInterval } from '../lib/perf.js';
import { useConfirm } from '../components/ConfirmDialog.js';
interface Job { id: string; server_id: string | null; kind: string; status: string; stage: string; progress: number | null; logs: string[]; created_at: number; updated_at: number }
export function JobsPage() {
  const confirm = useConfirm();
  const [retrying, setRetrying] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]), [status, setStatus] = useState('all'), [query, setQuery] = useState(''), [error, setError] = useState(''), [names, setNames] = useState<Record<string, string>>({});
  async function load() { try { const r = await api.get<{ jobs: Job[] }>('/workspace/jobs'); setJobs(r.jobs); setError(''); } catch (e) { setError(e instanceof Error ? e.message : 'Could not load jobs'); } }
  useEffect(() => { void load(); api.get<{ servers: { id: string; name: string }[] }>('/servers').then(r => setNames(Object.fromEntries(r.servers.map(s => [s.id, s.name])))).catch(() => {}); return setVisibleInterval(load, 3000); }, []);
  return <Layout><div className="mx-auto max-w-5xl space-y-4 p-4 sm:p-8"><PageHeader title="Job center" subtitle="Install, update, import, backup and transfer history survives panel restarts." action={<Button onClick={load}>Refresh</Button>} /><ErrorText>{error}</ErrorText>
    <div className="flex flex-wrap gap-3"><Input aria-label="Search jobs" placeholder="Search instance, job or stage" value={query} onChange={e => setQuery(e.target.value)} className="!w-auto flex-1" /><Select aria-label="Job status" value={status} onChange={e => setStatus(e.target.value)} className="!w-auto">{['all', 'running', 'completed', 'failed', 'interrupted'].map(s => <option key={s}>{s}</option>)}</Select></div>
    <p className="text-xs text-ink-400">Cancellation is available between items in fleet batches. Individual installs, updates and transfers must finish safely. Interrupted transfers and imports require checking both hosts before retrying.</p>
    {jobs.filter(j => (status === 'all' || j.status === status) && `${names[j.server_id ?? '']} ${j.kind} ${j.stage}`.toLowerCase().includes(query.toLowerCase())).map(j => <Card key={j.id} className="space-y-3 p-5"><div className="flex flex-wrap justify-between gap-2"><h2>{names[j.server_id ?? ''] ?? 'Removed instance'} · {j.kind}</h2><span role="status">{j.status}{j.progress !== null ? ` · ${Math.round(j.progress)}%` : ''}</span></div><p className="break-words text-sm text-ink-300">{j.stage}</p>{j.status === 'running' && <progress className="w-full" aria-label={`${j.kind} progress`} max={100} value={j.progress ?? undefined} />}<p className="text-xs text-ink-400">{new Date(j.created_at).toLocaleString()} — {new Date(j.updated_at).toLocaleString()}</p>
      <details><summary className="cursor-pointer text-sm">Stage log</summary><pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-surface-950 p-3 text-xs">{j.logs.join('\n') || 'No additional stages recorded.'}</pre></details>
      {j.server_id && names[j.server_id] && <Link className="text-sm text-accent-400" to={`/instances/${j.server_id}/${j.kind === 'update' ? 'update' : j.kind === 'backup' ? 'backups' : j.kind.startsWith('world-') ? 'world-health' : 'console'}`}>{j.status === 'failed' && ['install', 'update', 'backup'].includes(j.kind) ? 'Review instance and retry' : 'Open instance'}</Link>}
      {j.status === 'failed' && j.server_id && names[j.server_id] && ['install', 'backup'].includes(j.kind) && <Button disabled={!!retrying || jobs.some(other => other.server_id === j.server_id && other.status === 'running')} onClick={async () => {
        if (!await confirm({ title: `Retry ${j.kind}?`, message: `Start a new ${j.kind} operation for ${names[j.server_id!]}. Existing instance permissions and state checks still apply.`, confirmLabel: `Retry ${j.kind}` })) return;
        setRetrying(j.id); setError(''); try { await api.post(`/servers/${j.server_id}/${j.kind === 'install' ? 'retry-install' : 'backups'}`, j.kind === 'backup' ? { label: 'Job retry' } : undefined); await load(); } catch (e) { setError(e instanceof Error ? e.message : 'Retry failed'); } finally { setRetrying(null); }
      }}>{retrying === j.id ? 'Starting retry…' : `Retry ${j.kind}`}</Button>}
    </Card>)}{!jobs.length && <Card className="p-8">No jobs recorded yet. New operations will appear here.</Card>}
    <Link className="text-accent-400" to="/configuration/operations?section=bulk">Fleet batches and cancellation</Link>
  </div></Layout>;
}
