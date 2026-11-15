import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth } from '../state/AuthContext.js';
import { setVisibleInterval } from '../lib/perf.js';
import { beginOperation, clearOperations, operationActive, operationsSnapshot, subscribeOperations, updateOperation, type Operation, type OperationState } from '../lib/operationQueue.js';

interface Job { id: string; operation_id?: string | null; server_id: string | null; kind: string; status: string; stage: string; progress: number | null; created_at: number; updated_at: number }
const titles: Record<string, string> = { backup: 'Save backup', snapshot: 'Save snapshot', 'snapshot-restore': 'Restore snapshot', 'content-download': 'Download content', 'file-upload': 'Upload file', download: 'Download file', antivirus: 'Antivirus scan', 'antivirus-upload': 'Upload antivirus check', install: 'Install instance', update: 'Update instance', import: 'Import instance', transfer: 'Transfer instance' };
const linkFor = (job: Job) => !job.server_id ? '/jobs' : `/instances/${job.server_id}/${job.kind.startsWith('antivirus') ? 'configuration?section=antivirus' : job.kind === 'file-upload' || job.kind === 'download' ? 'files' : job.kind.includes('snapshot') ? 'rewind' : job.kind.includes('backup') ? 'backups' : 'console'}`;

export function OperationQueue() {
  const { user } = useAuth();
  return user ? <AccountOperationQueue key={user.id} /> : null;
}
function AccountOperationQueue() {
  const local = useSyncExternalStore(subscribeOperations, operationsSnapshot);
  const [jobs, setJobs] = useState<Job[]>([]), [names, setNames] = useState<Record<string, string>>({}), [collapsed, setCollapsed] = useState(false), [dismissed, setDismissed] = useState(new Set<string>()), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  const started = useRef(Date.now()), seen = useRef(new Set<string>());
  useEffect(() => () => clearOperations(), []);
  useEffect(() => {
    let active = true, busy = false, lastNames = 0;
    async function load() {
      if (busy) return; busy = true;
      try {
        const response = await api.get<{ jobs: Job[] }>('/workspace/jobs?view=queue');
        if (active) {
          const relevant = response.jobs.filter(j => j.status === 'running' || seen.current.has(j.id) || j.updated_at >= started.current);
          relevant.forEach(j => seen.current.add(j.id)); setJobs(relevant); setError('');
          for (const row of operationsSnapshot().filter(r => r.followsJob && r.status === 'running')) {
            const job = relevant.filter(j => j.operation_id === row.id).sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.updated_at - a.updated_at)[0];
            if (job && job.status !== 'running') updateOperation(row.id, { status: job.status as OperationState, progress: job.progress, stage: job.stage });
            else if (!job && Date.now() - row.startedAt > 120_000) updateOperation(row.id, { status: 'interrupted', progress: null, stage: 'Server download status unavailable. Check your browser downloads before retrying.' });
          }
        }
        if (Date.now() - lastNames > 30_000) { lastNames = Date.now(); const response = await api.get<{ servers: { id: string; name: string }[] }>('/servers'); if (active) setNames(Object.fromEntries(response.servers.map(s => [s.id, s.name]))); }
      } catch { if (active) setError('Job status refresh unavailable. Displayed stages may be out of date.'); }
      finally { busy = false; }
    }
    void load(); const stop = setVisibleInterval(() => void load(), 2000);
    return () => { active = false; stop(); };
  }, [retry]);
  useEffect(() => {
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest('a') : null;
      if (!anchor) return;
      const url = new URL(anchor.href, location.href);
      if (url.origin !== location.origin || !url.pathname.startsWith('/api/') || (!/\/(download|export|bundle)(\/|$)/.test(url.pathname) && !anchor.hasAttribute('download'))) return;
      const serverId = url.pathname.match(/^\/api\/servers\/([^/]+)/)?.[1];
      const id = beginOperation('Download file', serverId, 'Preparing download; awaiting server progress', serverId ? `/instances/${serverId}/files` : '/jobs');
      updateOperation(id, { followsJob: true });
      url.searchParams.set('operation', id); anchor.href = url.href;
    };
    document.addEventListener('click', click);
    return () => document.removeEventListener('click', click);
  }, []);

  const merged = new Map<string, Operation>(local.map(row => [row.id, row]));
  const groups = new Map<string, Job[]>();
  for (const job of jobs) { const id = job.operation_id ?? `job:${job.id}`; const group = groups.get(id) ?? []; group.push(job); groups.set(id, group); }
  for (const [id, group] of groups) {
    const job = [...group].sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.updated_at - a.updated_at)[0], current = merged.get(id);
    const status = ['running', 'completed', 'failed', 'interrupted'].includes(job.status) ? job.status as OperationState : 'interrupted';
    const remote: Operation = { id, title: titles[job.kind] ?? job.kind.replace(/-/g, ' '), stage: job.stage, status, progress: job.progress, serverId: job.server_id ?? undefined, href: linkFor(job), startedAt: job.created_at, updatedAt: job.updated_at };
    if (!current) merged.set(id, remote);
    else if (current.followsJob) merged.set(id, { ...current, status: remote.status, stage: remote.stage, progress: remote.progress, updatedAt: remote.updatedAt });
    else {
      const transmitting = current.status === 'running' && current.progress !== null && current.title.startsWith('Upload');
      const useRemote = current.status !== 'failed' && !transmitting && (status === 'running' || status === 'failed');
      merged.set(id, { ...current, status: current.status === 'failed' ? 'failed' : status === 'running' ? 'running' : operationActive(current) ? current.status : status === 'failed' ? 'failed' : current.status, stage: useRemote ? remote.stage : current.stage, progress: useRemote ? remote.progress : current.progress, updatedAt: Math.max(current.updatedAt, remote.updatedAt) });
    }
  }
  const allRows = [...merged.values()].filter(r => !dismissed.has(r.id)).sort((a, b) => Number(operationActive(b)) - Number(operationActive(a)) || b.startedAt - a.startedAt);
  const rows = allRows.slice(0, 100);
  // A resumed transfer reuses its ID. Dismissing its earlier failure must not hide the retry.
  useEffect(() => {
    const resumed = [...merged.values()].filter(row => dismissed.has(row.id) && ['queued', 'running'].includes(row.status));
    if (resumed.length) setDismissed(old => { const next = new Set(old); resumed.forEach(row => next.delete(row.id)); return next; });
  }, [local, jobs, dismissed]);
  if (!rows.length) return null;
  const pending = allRows.filter(operationActive).length, failed = allRows.filter(r => ['failed', 'interrupted'].includes(r.status)).length;
  return <section aria-label="Operation queue" className="ui-card fixed bottom-4 right-4 z-[45] flex max-h-[calc(100dvh-2rem)] w-[min(24rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-surface-600 bg-surface-850 shadow-card">
    <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-1.5"><div className="min-w-0 flex-1"><h2 className="flex items-center gap-2 text-sm font-medium text-ink-100">{pending > 0 && <span aria-hidden="true" className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent-400" />}Operations</h2><p className="mt-0.5 text-xs text-ink-400">{pending ? `${pending} pending` : 'Finished'}{failed ? ` · ${failed} need attention` : ''}</p></div><button type="button" className="state-layer min-h-11 shrink-0 rounded-full px-3 text-xs font-medium text-accent-400" aria-label={collapsed ? 'Expand operation queue' : 'Collapse operation queue'} aria-expanded={!collapsed} aria-controls={collapsed ? undefined : 'operation-queue-items'} onClick={() => setCollapsed(v => !v)}>{collapsed ? 'Show' : 'Hide'}</button></div>
    {!collapsed && <div id="operation-queue-items" className="flex min-h-0 flex-col">
      {error && <div role="status" className="shrink-0 px-3 pb-2 text-xs text-yellow-400">{error} <button type="button" className="min-h-11 px-2 underline" onClick={() => setRetry(n => n + 1)}>Retry status</button></div>}
      <ul className="min-h-0 max-h-[48vh] space-y-3 overflow-y-auto border-t border-surface-700 p-3">{rows.map(row => <li key={row.id} className="space-y-1.5 rounded-xl bg-surface-900 p-3">
        <div className="flex items-center justify-between gap-2"><p className="min-w-0 break-words text-sm font-medium text-ink-100 [overflow-wrap:anywhere]">{row.title}</p>{!['queued', 'running'].includes(row.status) && <button type="button" className="state-layer -mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-base text-ink-400 hover:text-ink-100" aria-label={`Dismiss ${row.title}`} onClick={() => setDismissed(old => new Set(old).add(row.id))}>×</button>}</div>
        {row.serverId && <p className="truncate text-xs text-ink-400">{names[row.serverId] ?? 'Instance'}</p>}
        <p className={`break-words text-xs [overflow-wrap:anywhere] ${['failed', 'interrupted'].includes(row.status) ? 'text-red-400' : 'text-ink-300'}`}>{row.stage}</p>
        {['running', 'queued'].includes(row.status) && <><progress className="h-1.5 w-full accent-accent-400" max={100} value={row.progress ?? undefined} aria-label={`${row.title} progress`} /><p className="text-xs tabular-nums text-ink-400">{row.progress === null ? 'In progress · total not available' : `${Math.round(row.progress)}%`}</p></>}
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs"><span className={row.status === 'completed' ? 'text-success-400' : 'text-ink-400'}>{row.status === 'completed' ? 'Completed · 100%' : row.status === 'paused' ? 'Paused · action needed' : row.status.charAt(0).toUpperCase() + row.status.slice(1)}</span>{row.href && <Link to={row.href} className="inline-flex min-h-11 items-center text-accent-400 hover:underline">View details</Link>}</div>
      </li>)}</ul>
      {allRows.length > rows.length && <p className="px-3 pb-2 text-xs text-ink-400">Showing {rows.length} of {allRows.length} operations.</p>}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-surface-700 px-3 py-1.5 text-xs"><Link className="inline-flex min-h-11 items-center text-accent-400" to="/jobs">Open job center</Link><button type="button" className="state-layer min-h-11 rounded-full px-2 text-ink-400 hover:text-ink-100 disabled:cursor-not-allowed disabled:opacity-40" disabled={!allRows.some(r => !operationActive(r))} onClick={() => setDismissed(old => new Set([...old, ...allRows.filter(r => !operationActive(r)).map(r => r.id)]))}>Clear finished</button></div>
    </div>}
  </section>;
}
