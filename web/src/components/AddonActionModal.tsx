import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import type { AddonAction, AddonActionPlan, AddonActionResult, InstalledAddon } from '../api/addons.js';
import { Button, ErrorText, Modal, Notice, Spinner } from './ui.js';
export function AddonActionModal({ serverId, item, action, dependencyCleanup, onClose, onApplied }: {
    serverId: string;
    item: InstalledAddon;
    action: AddonAction;
    dependencyCleanup: boolean;
    onClose: () => void;
    onApplied: (r: AddonActionResult) => void;
}) {
    const mounted = useRef(true);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const [cleanup, setCleanup] = useState(action === 'remove'), [untracked, setUntracked] = useState(false), [ack, setAck] = useState(false), [plan, setPlan] = useState<AddonActionPlan | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [retry, setRetry] = useState(0);
    useEffect(() => { let active = true; setPlan(null); setError(''); setAck(false); api.post<AddonActionPlan>(`/servers/${serverId}/plugins/installed/${item.id}/plan`, { action, cleanup, includeUntracked: untracked }).then(p => active && setPlan(p)).catch(e => active && setError(e.message)); return () => { active = false; }; }, [serverId, item.id, action, cleanup, untracked, retry]);
    const verb = action === 'remove' ? 'Uninstall' : action === 'disable' ? 'Disable' : 'Enable';
    return <Modal open title={`${verb} ${item.name}`} onClose={() => { if (!busy)
        onClose(); }} size="lg"><div className="space-y-4"><ErrorText>{error}</ErrorText>
 {action === 'remove' && dependencyCleanup && <div className="space-y-2"><label className="flex min-h-11 items-center gap-3"><input type="checkbox" disabled={busy} checked={cleanup} onChange={e => setCleanup(e.target.checked)}/>Also remove unused dependencies</label>{cleanup && <label className="flex min-h-11 items-start gap-3 text-sm"><input type="checkbox" disabled={busy} checked={untracked} onChange={e => setUntracked(e.target.checked)}/>Include untracked dependencies with readable manifests. Review every filename below; explicitly kept mods remain protected.</label>}<p className="text-xs text-ink-400">Shared libraries, optional consumers and disabled installed mods are included in dependency checks. World data and separate configuration folders are kept.</p></div>}
 {!plan && !error && <div className="flex items-center gap-2 text-sm"><Spinner /> Inspecting installed dependencies…</div>}
 {plan && <><div className="space-y-2"><h3 className="font-medium">{action === 'remove' ? 'Artifacts to uninstall' : 'Artifact to change'}</h3>{plan.remove.map(p => <div key={p.id} className="rounded-xl bg-surface-900 p-3"><p className="break-words text-sm">{p.name}</p><p className="break-all font-mono text-xs text-ink-400">{p.fileName} · {p.installation}</p></div>)}</div>{!!plan.keep.length && <details className="space-y-2"><summary className="cursor-pointer">Dependencies retained ({plan.keep.length})</summary>{plan.keep.map(p => <p className="text-sm text-ink-400" key={p.id}><strong>{p.name}</strong>: {p.reason}</p>)}</details>}{plan.blockers.map((b, i) => <Notice key={i} tone="error">{b}</Notice>)}{plan.warnings.map((w, i) => <Notice key={i} tone="warning">{w}</Notice>)}{plan.requiresAcknowledgement && <label className="flex min-h-11 items-start gap-3 text-sm"><input type="checkbox" disabled={busy} checked={ack} onChange={e => setAck(e.target.checked)}/>I understand that incomplete or undeclared dependencies cannot be verified. Change only the selected artifact and retain its dependencies.</label>}<p className="text-xs text-ink-400">Review expires {new Date(plan.expires).toLocaleTimeString()}. Installed file hashes and current permissions are checked again when applying.</p></>}
 <div className="flex flex-wrap gap-2"><Button disabled={busy || !plan?.canApply || (!!plan?.requiresAcknowledgement && !ack)} variant={action === 'enable' ? 'primary' : 'danger'} onClick={async () => { if (!plan)
        return; setBusy(true); setError(''); try {
        const result = await api.post<AddonActionResult>(`/servers/${serverId}/plugins/installed/actions/${plan.id}/apply`, { acknowledged: ack });
        if (mounted.current) onApplied(result);
    }
    catch (e) {
        if (mounted.current) { setError((e as Error).message); setPlan(null); }
    }
    finally {
        if (mounted.current) setBusy(false);
    } }}>{busy ? 'Applying…' : `${verb} reviewed ${plan?.remove.length === 1 ? 'artifact' : 'artifacts'}`}</Button><Button disabled={busy} onClick={() => setRetry(n => n + 1)}>Refresh preview</Button><Button disabled={busy} variant="ghost" onClick={onClose}>Cancel</Button></div>
 </div></Modal>;
}
