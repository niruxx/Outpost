import { useEffect, useState } from 'react';
import { api, downloadUrl } from '../../api/client.js';
import { useServerDetail } from './ServerContext.js';
import { Button, Card, Input, ErrorText } from '../../components/ui.js';
import { useConfirm } from '../../components/ConfirmDialog.js';
type Health = {
    enabled: boolean;
    cpu: number;
    memoryMb: number;
    diskGrowthMbHour: number;
    tickMs: number;
    startupSeconds: number;
    queryFailures: number;
    sustainedSeconds: number;
    cooldownSeconds: number;
    silencedUntil: number;
};
type Data = {
    health: Health;
    alerts: {
        at: number;
        metric: string;
        value: number;
        threshold: number;
        suggestion: string;
    }[];
    maintenance: {
        id: string;
        name: string;
        state: string;
        at: number;
        error?: string;
        steps: string[];
    }[];
    backups: {
        storedBytes: number;
        logicalBytes: number;
        savedBytes: number;
        policy: {
            daily: number;
            weekly: number;
            monthly: number;
        };
        manifests: {
            id: string;
            at: number;
            fileCount: number;
            logicalBytes: number;
            addedBytes: number;
        }[];
    };
    verification: {
        name: string;
        ok: boolean;
        at: number;
        note?: string;
        error?: string;
    }[];
    preflight: {
        checks: {
            name: string;
            ok: boolean;
            detail: string;
        }[];
        recovery: string[];
    } | null;
    recovery: {
        directory: string;
    } | null;
};
const size = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MiB`;
export function ReliabilityTab() {
    const { serverId, can } = useServerDetail();
    const prefix = `/servers/${serverId}/reliability`;
    const [data, setData] = useState<Data | null>(null);
    const [health, setHealth] = useState<Health | null>(null);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState('');
    const [policy, setPolicy] = useState({ daily: 7, weekly: 4, monthly: 6 });
    const [zip, setZip] = useState('');
    const [restoreTest, setRestoreTest] = useState(true);
    const [when, setWhen] = useState('');
    const [downtime, setDowntime] = useState(60);
    const [warning, setWarning] = useState(60);
    const [message, setMessage] = useState('Scheduled maintenance');
    const [inventory, setInventory] = useState<{
        id: string;
        name: string;
    }[]>([]);
    const [deps, setDeps] = useState<{
        id: string;
        dependsOn: string[];
    }[]>([{ id: serverId, dependsOn: [] }]);
    const confirm = useConfirm();
    async function load(initial = false) { try {
        const result = await api.get<Data>(prefix);
        setData(result);
        if (initial) {
            setHealth(result.health);
            setPolicy(result.backups.policy);
        }
    }
    catch (e) {
        setError((e as Error).message);
    } }
    useEffect(() => { void load(true); api.get<{
        servers: {
            id: string;
            name: string;
        }[];
    }>('/servers').then(r => setInventory(r.servers)).catch(() => { }); const timer = setInterval(() => load(), 15000); return () => clearInterval(timer); }, [prefix]);
    async function action(path: string, body?: unknown, method = 'post') { setBusy(true); setError(''); setNotice(''); try {
        const r = method === 'put' ? await api.put(prefix + path, body) : await api.post(prefix + path, body);
        await load();
        setNotice('Completed. See the report and job history below.');
        return r;
    }
    catch (e) {
        setError((e as Error).message);
    }
    finally {
        setBusy(false);
    } }
    if (!data || !health)
        return <><ErrorText>{error}</ErrorText><p>Loading reliability controls…</p></>;
    const labels: Record<string, string> = { cpu: 'CPU % (one core = 100%)', memoryMb: 'Memory MiB', diskGrowthMbHour: 'Disk growth MiB/hour', tickMs: 'Tick time ms (profiler sample)', startupSeconds: 'Startup timeout seconds', queryFailures: 'Consecutive failed game queries', sustainedSeconds: 'Sustained duration seconds', cooldownSeconds: 'Alert cooldown seconds' };
    return <div className="space-y-4"><ErrorText>{error}</ErrorText>{notice && <p role="status">{notice}</p>}
    <Card className="space-y-3 p-4"><h2 className="text-lg font-semibold">Health alerts</h2><p className="text-sm text-ink-400">Sustained resource pressure and readiness failures create panel alerts and can use your configured notification webhooks. Tick alerts need a recent supported profiler sample; query alerts require query support.</p>
      <label className="flex gap-2"><input type="checkbox" checked={health.enabled} onChange={e => setHealth({ ...health, enabled: e.target.checked })}/>Enable monitoring</label>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{Object.entries(labels).map(([key, label]) => <label className="text-sm" key={key}>{label}<Input type="number" value={health[key as keyof Health] as number} onChange={e => setHealth({ ...health, [key]: +e.target.value })}/></label>)}</div>
      <label className="block text-sm">Silence until (local time)<Input type="datetime-local" onChange={e => setHealth({ ...health, silencedUntil: e.target.value ? new Date(e.target.value).getTime() : 0 })}/></label>
      <Button disabled={busy || !can('settings')} onClick={() => action('/health', health, 'put')}>Save alert rules</Button>
      <div className="space-y-2">{data.alerts.map((a, i) => <div key={i} className="rounded border border-surface-700 p-2 text-sm"><strong>{a.metric}: {a.value.toFixed(1)} / {a.threshold}</strong><p>{a.suggestion}</p><small>{new Date(a.at).toLocaleString()}</small></div>)}</div>
    </Card>
    <Card className="space-y-3 p-4"><h2 className="text-lg font-semibold">Maintenance window</h2><p className="text-sm text-ink-400">Warn players, stop dependents before their dependencies, then restart previously running instances in dependency order. Alerts are silenced during the window. A failed step stops the workflow for review.</p>
      <div className="grid gap-3 sm:grid-cols-2"><label>Start time (blank = next monitoring cycle)<Input type="datetime-local" value={when} onChange={e => setWhen(e.target.value)}/></label><label>Downtime seconds<Input type="number" min={0} max={86400} value={downtime} onChange={e => setDowntime(+e.target.value)}/></label><label>Warning lead time seconds<Input type="number" min={0} max={3600} value={warning} onChange={e => setWarning(+e.target.value)}/></label><label>Player warning<Input value={message} onChange={e => setMessage(e.target.value)}/></label></div>
      <fieldset className="space-y-2"><legend>Included instances and dependencies</legend>{inventory.map(s => { const item = deps.find(d => d.id === s.id); return <div key={s.id} className="space-y-1 text-sm"><label><input type="checkbox" checked={!!item} disabled={s.id === serverId} onChange={e => setDeps(e.target.checked ? [...deps, { id: s.id, dependsOn: [] }] : deps.filter(d => d.id !== s.id).map(d => ({ ...d, dependsOn: d.dependsOn.filter(id => id !== s.id) })))}/> {s.name}</label>{item && <div className="flex flex-wrap gap-2 pl-4"><span>Depends on:</span>{deps.filter(d => d.id !== s.id).map(d => <label key={d.id}><input type="checkbox" checked={item.dependsOn.includes(d.id)} onChange={e => setDeps(deps.map(x => x.id === s.id ? { ...x, dependsOn: e.target.checked ? [...x.dependsOn, d.id] : x.dependsOn.filter(id => id !== d.id) } : x))}/> {inventory.find(i => i.id === d.id)?.name}</label>)}</div>}</div>; })}</fieldset>
      <Button disabled={busy || !can('power') || !can('console')} onClick={() => action('/maintenance', { name: 'Scheduled maintenance', at: when ? new Date(when).getTime() : Date.now(), downtimeSeconds: downtime, warningSeconds: warning, message, dependencies: deps })}>Schedule maintenance</Button>
      {data.maintenance.map(m => <details key={m.id} className="rounded border border-surface-700 p-2"><summary>{m.name} · {m.state} · {new Date(m.at).toLocaleString()}</summary>{m.steps.map((s, i) => <p className="text-xs" key={i}>{s}</p>)}{m.error && <p className="text-red-400">{m.error}</p>}{m.state === 'scheduled' && can('power') && <Button disabled={busy} onClick={async () => { try {
        await api.delete(`${prefix}/maintenance/${m.id}`);
        await load();
    }
    catch (e) {
        setError((e as Error).message);
    } }}>Cancel window</Button>}</details>)}
    </Card>
    <Card className="space-y-3 p-4"><h2 className="text-lg font-semibold">Verified and deduplicated backups</h2><p className="text-sm text-ink-400">Stop the instance for consistent deduplicated snapshots. Unchanged files share stored content. Disposable restore tests verify copies without launching a game process.</p><p>Stored {size(data.backups.storedBytes)} · Logical {size(data.backups.logicalBytes)} · Saved {size(data.backups.savedBytes)}</p>
      <div className="flex flex-wrap gap-3">{(['daily', 'weekly', 'monthly'] as const).map(k => <label key={k}>{k} buckets<Input type="number" min={k === 'daily' ? 1 : 0} max={k === 'daily' ? 365 : k === 'weekly' ? 104 : 120} value={policy[k]} onChange={e => setPolicy({ ...policy, [k]: +e.target.value })}/></label>)}</div><Button disabled={busy || !can('backups.create')} onClick={() => action('/backup-policy', policy, 'put')}>Save retention</Button> <Button disabled={busy || !can('backups.create')} onClick={() => action('/deduplicated')}>Create deduplicated snapshot</Button>
      <label className="flex gap-2"><input type="checkbox" checked={restoreTest} onChange={e => setRestoreTest(e.target.checked)}/>Include disposable restore test</label>
      <div className="flex flex-wrap gap-2"><Input aria-label="ZIP backup filename" placeholder="Existing ZIP backup filename" value={zip} onChange={e => setZip(e.target.value)}/><Button disabled={busy || !zip || !can('backups.create')} onClick={() => action('/verify', { kind: 'zip', name: zip, restoreTest })}>Verify ZIP backup</Button></div>
      {data.backups.manifests.map(m => <div key={m.id} className="flex flex-wrap items-center gap-2 rounded border border-surface-700 p-2 text-sm"><span className="min-w-0 flex-1">{new Date(m.at).toLocaleString()} · {m.fileCount} files · {size(m.logicalBytes)} ({size(m.addedBytes)} added)</span><Button disabled={busy || !can('backups.create')} onClick={() => action('/verify', { kind: 'deduplicated', name: m.id, restoreTest })}>Verify</Button><Button disabled={busy || !can('backups.restore')} onClick={async () => { if (await confirm({ title: 'Restore snapshot', message: 'Replace the stopped instance with this snapshot? The displaced files will be retained in a recovery directory.', confirmLabel: 'Restore', tone: 'danger' }))
        await action(`/deduplicated/${m.id}/restore`, { confirm: true }); }}>Restore</Button></div>)}
      {data.recovery && <p className="text-sm">Previous instance retained beside the instance directory as <code>{data.recovery.directory}</code>.</p>}
      {data.verification.map((v, i) => <p className="break-all text-sm" key={i}>{v.ok ? '✓' : '✗'} {v.name} · {new Date(v.at).toLocaleString()} · {v.note ?? v.error}</p>)}
    </Card>
    <Card className="space-y-3 p-4"><h2 className="text-lg font-semibold">Update readiness and troubleshooting</h2><Button disabled={busy || !can('update')} onClick={() => action('/preflight')}>Run update preflight</Button>{data.preflight && <><ul>{data.preflight.checks.map(c => <li key={c.name}>{c.ok ? '✓' : '✗'} {c.name}: {c.detail}</li>)}</ul><h3>Recovery steps</h3><ol className="list-inside list-decimal">{data.preflight.recovery.map(s => <li key={s}>{s}</li>)}</ol></>}
      {can('files.read') && can('console') && <a className="inline-block rounded bg-accent-600 px-3 py-2 text-sm text-white" href={downloadUrl(prefix + '/bundle')}>Download troubleshooting bundle</a>}<p className="text-xs text-ink-400">Credentials are redacted and sensitive files are excluded. Review logs before sharing; game/mod output can contain personal or unexpected sensitive information.</p>
    </Card>
  </div>;
}
