import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client.js';
import type { InstanceCapabilities } from '../../api/capabilities.js';
import { Badge, Button, Card, CardTitle, ErrorText, Notice, Spinner } from '../../components/ui.js';
import { useServerDetail } from './ServerContext.js';
function useCapabilities(live = false) {
    const { serverId, server, permissions } = useServerDetail();
    const [data, setData] = useState<InstanceCapabilities | null>(null), [error, setError] = useState(''), [retry, setRetry] = useState(0);
    const context = [serverId, server?.platform, server?.loader, server?.version, server?.steam_preset, server?.steam_app_id].join(':');
    const state = live ? [server?.status, server?.suspended, permissions.join(',')].join(':') : '';
    useEffect(() => { let active = true; setData(null); setError(''); api.get<InstanceCapabilities>(`/servers/${serverId}/capabilities`).then(d => active && setData(d)).catch(e => active && setError(e.message)); return () => { active = false; }; }, [context, state, retry]);
    return { data, error, retry: () => setRetry(n => n + 1) };
}
export function CapabilityGate({ feature, gameId, children }: {
    feature?: string;
    gameId?: string;
    children: ReactNode;
}) {
    const { data, error, retry } = useCapabilities();
    if (error)
        return <Card className="space-y-3 p-5"><ErrorText>{error}</ErrorText><Button onClick={retry}>Retry capability information</Button></Card>;
    if (!data)
        return <Spinner />;
    const action = feature ? data.actions.find(a => a.id === feature) : undefined;
    const reason = data.host.support === 'unavailable' ? data.host.reason : gameId && data.game?.id !== gameId ? `These controls apply to ${gameId}; this instance uses ${data.game?.name ?? 'a custom workload'}.` : feature === 'settings' && data.game?.settingsPath !== 'game-settings' ? `Use this game’s ${data.game?.settingsPath ?? 'Configuration'} controls; the generic Game settings adapter does not apply.` : feature && (!action || action.support === 'unavailable') ? action?.reason ?? 'No adapter is registered for this action.' : null;
    if (reason)
        return <Card className="space-y-3 p-5"><CardTitle>Action unavailable</CardTitle><p className="text-sm text-ink-300">{reason}</p><Link className="block text-accent-400 underline" to="../capabilities">View capabilities and prerequisites</Link><Link className="block text-accent-400 underline" to="../files">Open File Management</Link></Card>;
    return <>{data.host.support === 'conditional' && <Notice tone="warning">{data.host.reason} <Link className="underline" to="../capabilities">Review prerequisites</Link></Notice>}{children}</>;
}
export function CapabilitiesTab() {
    const { data, error, retry } = useCapabilities(true);
    if (!data)
        return error ? <Card className="space-y-3 p-5"><ErrorText>{error}</ErrorText><Button onClick={retry}>Retry capability information</Button></Card> : <Spinner />;
    return <div className="space-y-4"><Card className="space-y-3 p-5"><CardTitle>Instance capabilities</CardTitle><p>{data.game?.name ?? 'Custom / unrecognized workload'} · {data.loader} · {data.version} · {data.hostName}</p><Badge tone={data.host.support === 'unavailable' ? 'red' : data.host.support === 'conditional' ? 'yellow' : 'neutral'}>{data.host.support} host adapter</Badge><p className="text-sm text-ink-400">{data.host.reason}</p>{!data.validation.live.length && <Notice tone="warning">This exact game version / loader / host OS has no recorded live game validation. {data.validation.exactVersion.length ? 'Exact fixture-label coverage is recorded; it does not certify a game launch.' : 'No exact version/loader execution evidence is recorded.'}</Notice>}<p className="text-xs text-ink-400">{data.validation.note}</p><Link className="text-accent-400 underline" to="/compatibility">Open full game / version / OS matrix</Link></Card>
    <Card className="space-y-3 p-5"><CardTitle>Prerequisites to verify</CardTitle><p className="text-xs text-ink-400">These are setup requirements, not a claim that external dependencies were detected.</p>{[...(data.game?.prerequisites ?? []), ...(data.game?.notes ?? [])].map((p, i) => <p className="text-sm text-ink-300" key={i}>{p}</p>)}{!data.game && <p>Use File Management and Configuration → Launch for this workload. A preset-specific game adapter is unavailable.</p>}</Card>
    <div className="grid gap-3 md:grid-cols-2">{data.actions.map(a => <Card className="space-y-2 p-4" key={a.id}><h2 className="font-medium">{a.label}</h2><Badge tone={!a.available ? 'neutral' : a.support === 'conditional' ? 'yellow' : 'green'}>{!a.available ? 'Unavailable now' : a.support === 'conditional' ? 'Requires setup / review' : 'Implemented'}</Badge><p className="text-sm text-ink-400">{a.reason}</p>{a.blockers.map((b, i) => <p className="text-sm text-amber-400" key={i}>{b}</p>)}{a.prerequisites.map((p, i) => <p className="text-xs text-ink-400" key={i}>{p}</p>)}</Card>)}</div>
    <Card className="space-y-2 p-5"><CardTitle>Recorded evidence for this game and host OS</CardTitle>{data.validation.runs.map(r => <div className="rounded border border-surface-700 p-3 text-sm" key={r.id}><p>{r.kind} · {new Date(r.at).toLocaleString()} · {r.arch}</p><p className="break-all text-xs">{r.suite} · {(r.versions[data.game?.id ?? ''] ?? []).join(', ')}</p><p className="text-xs text-ink-400">{r.scope}</p></div>)}{!data.validation.runs.length && <p className="text-sm text-amber-400">No executed validation is recorded for this game on this host OS.</p>}</Card></div>;
}
