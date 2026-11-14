import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import type { InstanceListMetrics, ServerRecord } from '../api/types.js';
import { Layout, PageHeader } from '../components/Layout.js';
import { HostOverview } from '../components/HostOverview.js';
import { Button, Card, ErrorText } from '../components/ui.js';
import { setVisibleInterval } from '../lib/perf.js';
import { useAuth } from '../state/AuthContext.js';

const LABELS: Record<string, string> = { instances: 'Instances', host: 'Host health', players: 'Players', storage: 'Instance storage', backups: 'Recent backups', failures: 'Recent failures' };
interface Job { id: string; server_id: string | null; kind: string; stage: string; status: string; updated_at: number }
export function DashboardPage() {
  const { user } = useAuth();
  const [widgets, setWidgets] = useState(Object.keys(LABELS)), [ready, setReady] = useState(false), [editing, setEditing] = useState(false), [error, setError] = useState('');
  const [servers, setServers] = useState<ServerRecord[]>([]), [metrics, setMetrics] = useState<Record<string, InstanceListMetrics>>({}), [jobs, setJobs] = useState<Job[]>([]);
  const [storage, setStorage] = useState<{ name: string; bytes: number }[]>([]);
  useEffect(() => {
    let active = true;
    api.get<{ value: string[] | null }>('/workspace/preferences/dashboard').then(r => { if (active) { if (r.value) setWidgets(r.value); setReady(true); } }).catch(e => setError(e.message));
    const load = async () => { try { const [s, j, d] = await Promise.all([api.get<{ servers: ServerRecord[]; metrics: Record<string, InstanceListMetrics> }>('/servers'), api.get<{ jobs: Job[] }>('/workspace/jobs'), api.get<{ storage: { name: string; bytes: number }[] }>('/workspace/summary')]); if (active) { setServers(s.servers); setMetrics(s.metrics ?? {}); setJobs(j.jobs); setStorage(d.storage); } } catch (e) { if (active) setError(e instanceof Error ? e.message : 'Dashboard unavailable'); } };
    void load(); const stop = setVisibleInterval(load, 10000); return () => { active = false; stop(); };
  }, [user?.id]);
  async function save(next: string[]) { try { await api.put('/workspace/preferences/dashboard', { value: next }); setWidgets(next); setError(''); } catch (e) { setError(e instanceof Error ? e.message : 'Could not save dashboard'); } }
  function move(id: string, delta: number) { const next = [...widgets], at = next.indexOf(id), to = at + delta; if (to < 0 || to >= next.length) return; [next[at], next[to]] = [next[to], next[at]]; void save(next); }
  const render = (id: string) => {
    if (id === 'host') return <HostOverview />;
    if (id === 'instances') return <><p className="text-2xl">{servers.filter(s => s.status === 'running').length} / {servers.length} running</p><Link className="text-accent-400" to="/">Browse instances</Link></>;
    if (id === 'players') return <><p className="text-2xl">{Object.values(metrics).reduce((n, m) => n + (m.playersOnline ?? 0), 0)} online</p><p className="text-xs text-ink-400">From supported game queries; unavailable queries are excluded.</p></>;
    if (id === 'storage') return storage.length ? storage.map(s => <p key={s.name} className="break-words text-sm">{s.name}: {(s.bytes / 1048576).toLocaleString(undefined, { maximumFractionDigits: 1 })} MiB</p>) : <p>No storage samples yet.</p>;
    const rows = jobs.filter(j => id === 'backups' ? j.kind === 'backup' : ['failed', 'interrupted'].includes(j.status)).slice(0, 5);
    return <>{rows.length ? rows.map(j => <p key={j.id} className="mb-2 break-words text-sm">{servers.find(s => s.id === j.server_id)?.name ?? 'Removed instance'} · {j.kind} · {j.status}<span className="block text-xs text-ink-400">{j.stage}</span></p>) : <p className="text-sm text-ink-400">No recorded {id === 'backups' ? 'backup jobs' : 'failures'}.</p>}<Link className="text-accent-400" to="/jobs">Open job center</Link></>;
  };
  return <Layout><div className="mx-auto max-w-7xl space-y-5 p-4 sm:p-8"><PageHeader title="Dashboard" subtitle="Your widgets, saved to your account." action={<Button disabled={!ready} onClick={() => setEditing(!editing)}>{editing ? 'Done customizing' : 'Customize dashboard'}</Button>} /><ErrorText>{error}</ErrorText>
    {editing && <Card className="flex flex-wrap gap-4 p-4">{Object.entries(LABELS).map(([id, label]) => <label key={id} className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={widgets.includes(id)} onChange={e => void save(e.target.checked ? [...widgets, id] : widgets.filter(w => w !== id))} />{label}</label>)}</Card>}
    {!widgets.length && <p>Choose Customize dashboard to add widgets.</p>}
    <div className="grid gap-5 lg:grid-cols-2">{widgets.map((id, index) => <Card key={id} className={`min-w-0 space-y-3 p-5 ${id === 'host' ? 'lg:col-span-2' : ''}`} draggable={editing} onDragStart={e => e.dataTransfer.setData('text/plain', id)} onDragOver={e => { if (editing) e.preventDefault(); }} onDrop={e => { if (!editing) return; e.preventDefault(); const source = e.dataTransfer.getData('text/plain'); if (!widgets.includes(source)) return; const next = widgets.filter(w => w !== source); next.splice(next.indexOf(id), 0, source); void save(next); }}>
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg">{LABELS[id]}</h2>{editing && <div className="flex gap-2"><Button aria-label={`Move ${LABELS[id]} earlier`} disabled={index === 0} onClick={() => move(id, -1)}>↑</Button><Button aria-label={`Move ${LABELS[id]} later`} disabled={index === widgets.length - 1} onClick={() => move(id, 1)}>↓</Button></div>}</div>{render(id)}
    </Card>)}</div></div></Layout>;
}
