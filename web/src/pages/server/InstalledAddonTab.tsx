import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api/client.js';
import type { AddonAction, AddonDetails } from '../../api/addons.js';
import { useServerDetail } from './ServerContext.js';
import { Badge, Button, Card, CardTitle, ErrorText, Notice, Spinner } from '../../components/ui.js';
import { AddonActionModal } from '../../components/AddonActionModal.js';
import { useToast } from '../../components/Toast.js';
export function InstalledAddonTab() {
    const { serverId, server, can } = useServerDetail(), { addonId } = useParams(), navigate = useNavigate(), toast = useToast();
    const [data, setData] = useState<AddonDetails | null>(null), [error, setError] = useState(''), [retry, setRetry] = useState(0), [action, setAction] = useState<AddonAction | null>(null), [busy, setBusy] = useState(false);
    useEffect(() => { let current = true; setData(null); setError(''); setAction(null); api.get<AddonDetails>(`/servers/${serverId}/plugins/installed/${addonId}`).then(d => current && setData(d)).catch(e => current && setError(e.message)); return () => { current = false; }; }, [serverId, addonId, retry]);
    const root = `/instances/${serverId}/plugins`, stopped = !!server && ['stopped', 'crashed', 'install_failed'].includes(server.status), canWrite = can('plugins');
    if (!data || data.serverId !== serverId || data.item.id !== addonId)
        return <Card className="space-y-3 p-5"><Link className="text-accent-400 underline" to={root}>Back to installed add-ons</Link><ErrorText>{error}</ErrorText>{error ? <Button onClick={() => setRetry(n => n + 1)}>Retry add-on details</Button> : <Spinner />}</Card>;
    const m = data.item;
    return <div className="space-y-4"><Link className="text-sm text-accent-400 underline" to={root}>Back to installed add-ons</Link><ErrorText>{error}</ErrorText><Card className="space-y-4 p-5"><CardTitle>{m.name}</CardTitle><div className="flex flex-wrap gap-2"><Badge tone={m.enabled ? 'green' : 'neutral'}>{m.enabled ? 'Enabled' : 'Disabled'}</Badge><Badge>{m.installation === 'dependency' ? 'Automatic dependency' : m.installation === 'explicit' ? 'Explicitly installed / kept' : 'Untracked file'}</Badge><Badge>{m.coverage === 'incomplete' ? 'Incomplete metadata' : m.coverage === 'catalog' ? 'Catalog dependency declarations' : 'Embedded manifest'}</Badge></div>{m.metadata.description && <p className="whitespace-pre-wrap text-sm text-ink-300">{m.metadata.description}</p>}
 <dl className="grid gap-3 text-sm sm:grid-cols-2">{[['Version', m.metadata.version ?? m.provenance?.version ?? 'Unknown'], ['File', m.fileName], ['Instance path', m.relativePath ?? 'Not safely inspectable'], ['Size', `${(m.sizeBytes / 1048576).toFixed(2)} MiB`], ['Source', m.provenance?.source ?? 'Untracked / outside catalog'], ['Project ID', m.provenance?.project ?? 'Not recorded'], ['Manifest', m.metadata.format], ['Last modified', new Date(m.modifiedAt).toLocaleString()], ['Authors', m.metadata.authors.join(', ') || 'Not declared'], ['License', m.metadata.licenses.join(', ') || 'Not declared']].map(([k, v]) => <div className="min-w-0" key={k}><dt className="text-ink-500">{k}</dt><dd className="break-all text-ink-200">{v}</dd></div>)}</dl>
 {m.hash && <p className="break-all font-mono text-xs text-ink-400">SHA-256: {m.hash}</p>}{m.provenance?.versionId && <p className="break-all text-xs text-ink-400">Catalog version ID: {m.provenance.versionId}</p>}{m.metadata.links.map(l => <a key={l} href={l} target="_blank" rel="noopener noreferrer" className="block break-all text-sm text-accent-400 underline">{l}</a>)}{!stopped && <Notice tone="info">Stop the instance and finish background jobs before changing installed add-ons.</Notice>}{!canWrite && <Notice tone="info">Managing this add-on requires plugins permission.</Notice>}
 <div className="flex flex-wrap gap-2">{m.canToggle && <Button disabled={!canWrite || !stopped || busy} onClick={() => setAction(m.enabled ? 'disable' : 'enable')}>{m.enabled ? 'Disable' : 'Enable'}</Button>}<Button variant="danger" disabled={!canWrite || !stopped || busy} onClick={() => setAction('remove')}>Uninstall with dependency review</Button>{m.installation !== 'explicit' && <Button disabled={!canWrite || !stopped || busy} onClick={async () => { setBusy(true); setError(''); try {
        await api.post(`/servers/${serverId}/plugins/installed/${m.id}/keep`);
        toast.success('This add-on will be retained by automatic dependency cleanup');
        setRetry(n => n + 1);
    }
    catch (e) {
        setError((e as Error).message);
    }
    finally {
        setBusy(false);
    } }}>Keep explicitly installed</Button>}</div></Card>
 <Card className="space-y-3 p-5"><CardTitle>Dependencies</CardTitle><p className="text-xs text-ink-400">Declared requirements only. Version constraints are displayed for review; presence does not certify compatibility or game startup.</p>{data.dependencies.map((d, i) => <div className="space-y-1 rounded-xl border border-surface-700 p-3" key={d.key + i}><p className="break-all text-sm">{d.name} · {d.required ? 'Required' : 'Optional'} · {d.constraint}</p>{d.runtime ? <p className="text-xs text-ink-400">Game / loader runtime requirement</p> : d.installed.length ? d.installed.map(p => <Link className="block text-sm text-accent-400 underline" to={`${root}/${p.id}`} key={p.id}>{p.name} · {p.enabled ? 'Enabled' : 'Disabled'}{p.version ? ` · ${p.version}` : ''}</Link>) : <p className={`text-xs ${d.required ? 'text-amber-400' : 'text-ink-400'}`}>No installed provider identified.</p>}</div>)}{!data.dependencies.length && <p className="text-sm text-ink-400">{m.coverage === 'incomplete' ? 'Dependencies could not be fully determined.' : 'No dependencies declared in the inspected metadata.'}</p>}</Card>
 <Card className="space-y-3 p-5"><CardTitle>Used by other installed add-ons</CardTitle>{m.requiredBy.map(p => <Link className="block text-accent-400 underline" to={`${root}/${p.id}`} key={p.id}>{p.name} · Required{!p.enabled ? ' · Disabled, still protected' : ''}</Link>)}{m.optionalBy.map(p => <Link className="block text-accent-400 underline" to={`${root}/${p.id}`} key={p.id}>{p.name} · Optional integration</Link>)}{!m.requiredBy.length && !m.optionalBy.length && <p className="text-sm text-ink-400">No incoming references identified in declared metadata.</p>}</Card>
 {(m.provides.length > 0 || m.metadata.bundled.length > 0) && <Card className="space-y-2 p-5"><CardTitle>Provided modules and bundled libraries</CardTitle>{m.provides.map(p => <p className="break-all font-mono text-xs text-ink-300" key={p}>{p}</p>)}{m.metadata.bundled.map((p, i) => <p className="break-all text-xs text-ink-400" key={i}>Bundled: {p}</p>)}<p className="text-xs text-ink-400">Bundled modules belong to this artifact and are not separate removable files.</p></Card>}{[...m.metadata.warnings, ...data.warnings].map((w, i) => <Notice key={i} tone="warning">{w}</Notice>)}
 {action && <AddonActionModal serverId={serverId} item={m} action={action} dependencyCleanup={data.dependencyCleanup} onClose={() => setAction(null)} onApplied={r => { setAction(null); toast.success(r.action === 'remove' ? `Uninstalled ${r.removed.map(i => i.name).join(', ')}` : 'Add-on state updated'); if (r.focusId)
        navigate(`${root}/${r.focusId}`, { replace: true });
    else
        navigate(root); setRetry(n => n + 1); }}/>}</div>;
}
