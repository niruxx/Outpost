import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { Button, Card, CardTitle, ErrorText, Input, Select } from '../components/ui.js';
import { useConfirm } from '../components/ConfirmDialog.js';
import { createRequestId } from '../lib/requestId.js';
const area = 'ui-input min-h-28 w-full rounded-xl border border-surface-600 bg-surface-950 p-3 font-mono text-xs text-ink-200';
function Field({ label, children }: {
    label: string;
    children: ReactNode;
}) { return <label className="block min-w-0 space-y-1 text-sm text-ink-300"><span>{label}</span>{children}</label>; }
function Result({ value }: {
    value: unknown;
}) { return value == null ? null : <details open className="rounded border border-surface-700 p-3"><summary>Operation result</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(value, null, 2)}</pre></details>; }
function useFleet<T>(path: string, initial: T) {
    const [data, setData] = useState(initial), [error, setError] = useState(''), [busy, setBusy] = useState(false);
    async function load() {
        try {
            setData(await api.get<T>('/fleet' + path));
        }
        catch (e) {
            setError((e as Error).message);
        }
    }
    useEffect(() => { void load(); const timer = setInterval(load, 15000); return () => clearInterval(timer); }, [path]);
    async function perform<R = unknown>(endpoint: string, body?: unknown, method = 'post') {
        setBusy(true);
        setError('');
        try {
            const r = method === 'put' ? await api.put<R>('/fleet' + endpoint, body) : await api.post<R>('/fleet' + endpoint, body);
            await load();
            return r;
        }
        catch (e) {
            setError((e as Error).message);
        }
        finally {
            setBusy(false);
        }
    }
    return { data, error, setError, busy, perform, load };
}
interface Budget {
    memoryMb: number;
    cpuPercent: number;
    diskMb: number;
    platform: string;
    steamPreset?: string;
    steamAppId?: string;
    poolId: string;
    basePort?: number;
    tags: string[];
    roles: {
        role: string;
        offset: number;
        protocol: string;
    }[];
}
const defaultBudget: Budget = { memoryMb: 2048, cpuPercent: 100, diskMb: 10240, platform: 'java', poolId: 'auto', tags: [], roles: [{ role: 'game', offset: 0, protocol: 'tcp' }] };
function BudgetFields({ value, onChange, disabled = false }: {
    value: Budget;
    onChange: (b: Budget) => void;
    disabled?: boolean;
}) {
    const [ports, setPorts] = useState(JSON.stringify(value.roles, null, 2)), [error, setError] = useState('');
    useEffect(() => { setPorts(JSON.stringify(value.roles, null, 2)); setError(''); }, [value.roles]);
    return <fieldset disabled={disabled} className="space-y-3"><div className="grid gap-3 sm:grid-cols-3">{(['memoryMb', 'cpuPercent', 'diskMb'] as const).map(k => <Field key={k} label={k === 'memoryMb' ? 'Reserved memory MiB' : k === 'cpuPercent' ? 'Reserved CPU % (100 = one core)' : 'Reserved disk MiB'}><Input type="number" min={k === 'memoryMb' ? 128 : k === 'diskMb' ? 100 : 0} value={value[k]} onChange={e => onChange({ ...value, [k]: +e.target.value })}/></Field>)}<Field label="Game platform"><Select value={value.platform} onChange={e => onChange({ ...value, platform: e.target.value, roles: [{ role: 'game', offset: 0, protocol: e.target.value === 'java' ? 'tcp' : 'udp' }, ...(e.target.value === 'bedrock' ? [{ role: 'ipv6', offset: 1, protocol: 'udp' }] : [])] })}><option value="java">Minecraft Java</option><option value="bedrock">Minecraft Bedrock</option><option value="steam">Steam game</option></Select></Field>{value.platform === 'steam' && <><Field label="Steam preset ID"><Input value={value.steamPreset ?? ''} onChange={e => onChange({ ...value, steamPreset: e.target.value })}/></Field><Field label="Steam App ID"><Input value={value.steamAppId ?? ''} onChange={e => onChange({ ...value, steamAppId: e.target.value })}/></Field></>}<Field label="Pool ID (auto = compatible pool)"><Input value={value.poolId} onChange={e => onChange({ ...value, poolId: e.target.value })}/></Field><Field label="Optional fixed base port"><Input type="number" min={1024} max={65535} value={value.basePort ?? ''} onChange={e => onChange({ ...value, basePort: e.target.value ? +e.target.value : undefined })}/></Field><Field label="Required tags (comma separated)"><Input value={value.tags.join(',')} onChange={e => onChange({ ...value, tags: e.target.value.split(',').map(t => t.trim()).filter(Boolean) })}/></Field></div><details><summary className="text-sm">Auxiliary port bundle offsets</summary><p className="text-xs text-ink-400">Include a game role at offset zero. Add query, RCON, voice or companion offsets required by the game. A reservation needs the complete bundle to fit.</p><textarea aria-label="Capacity port roles" className={area} value={ports} onChange={e => {
            setPorts(e.target.value);
            try {
                const parsed = JSON.parse(e.target.value);
                onChange({ ...value, roles: parsed });
                setError('');
            }
            catch {
                setError('Enter a valid JSON list of role, offset and protocol entries.');
            }
        }}/><ErrorText>{error}</ErrorText></details></fieldset>;
}
interface HostCapacity {
    id: string;
    name: string;
    eligible: boolean;
    reasons: string[];
    warnings: string[];
    available: {
        memoryMb: number;
        cpuPercent: number;
        diskMb: number;
    } | null;
    held?: object;
    ports: {
        role: string;
        port: number;
        protocol: string;
    }[];
}
export function FleetCapacityPanel() {
    const ctl = useFleet<{
        policy: {
            reserveDiskMb: number;
            reserveCpuPercent: number;
        };
        hosts: {
            hosts: (HostCapacity & {
                reservations?: {
                    id: string;
                    resources: Budget;
                    ports: HostCapacity['ports'];
                    expires: number;
                }[];
            })[];
        };
    }>('/capacity', { policy: { reserveDiskMb: 2048, reserveCpuPercent: 100 }, hosts: { hosts: [] } }), confirm = useConfirm();
    const [request, setRequest] = useState({ ...defaultBudget }), [preview, setPreview] = useState<HostCapacity[]>([]), [lease, setLease] = useState<{
        nodeId: string;
        id: string;
        expires: number;
        ports: HostCapacity['ports'];
    } | null>(null), [name, setName] = useState(''), [version, setVersion] = useState(''), [loader, setLoader] = useState('vanilla'), [eula, setEula] = useState(false), [result, setResult] = useState<unknown>(null), [policyDraft, setPolicyDraft] = useState<{
        reserveDiskMb: number;
        reserveCpuPercent: number;
    } | null>(null);
    return <div className="space-y-4"><Card className="space-y-4 p-5"><CardTitle>Capacity and placement explanations</CardTitle><p className="text-sm text-ink-400">Preview memory, CPU, disk, host policy, tags and the entire port bundle across linked hosts. Reservations expire after ten minutes and are rechecked on creation. Existing unconstrained workloads can still exceed planned resources.</p><BudgetFields value={request} onChange={r => { setRequest(r); setPreview([]); }} disabled={!!lease}/><Button disabled={ctl.busy || !!lease} onClick={async () => {
            const r = await ctl.perform<{
                hosts: HostCapacity[];
            }>('/capacity/preview', { request });
            if (r)
                setPreview(r.hosts);
        }}>Explain placement</Button>{preview.map(h => <div key={h.id} className="space-y-2 rounded border border-surface-700 p-3"><h3>{h.name} · {h.eligible ? 'Eligible' : 'Blocked'}</h3>{h.available && <p className="text-sm">Available: {Math.max(0, Math.floor(h.available.memoryMb))} MiB memory · {Math.max(0, Math.floor(h.available.cpuPercent))}% CPU · {Math.max(0, Math.floor(h.available.diskMb))} MiB disk</p>}{h.reasons.map(r => <p className="text-red-400" key={r}>{r}</p>)}{h.warnings.map(w => <p className="text-xs text-amber-400" key={w}>{w}</p>)}<p className="text-xs">{h.ports.map(p => `${p.role}: ${p.port}/${p.protocol}`).join(' · ')}</p><Button disabled={ctl.busy || !h.eligible || !!lease} onClick={async () => {
                const id = createRequestId(), r = await ctl.perform<{
                    id: string;
                    expires: number;
                    ports: HostCapacity['ports'];
                }>('/capacity/reserve', { nodeId: h.id, id, request });
                if (r)
                    setLease({ ...r, nodeId: h.id });
            }}>Reserve this host and bundle</Button></div>)}</Card>
    {lease && <Card className="space-y-3 p-5"><h2 className="text-lg">Reserved placement</h2><p className="break-all text-sm">Host {lease.nodeId} · {lease.id} · expires {new Date(lease.expires).toLocaleString()}</p><p>{lease.ports.map(p => `${p.role}: ${p.port}`).join(' · ')}</p><div className="grid gap-3 sm:grid-cols-3"><Field label="Instance name"><Input value={name} onChange={e => setName(e.target.value)}/></Field><Field label="Loader"><Input value={loader} onChange={e => setLoader(e.target.value)}/></Field><Field label="Game version"><Input value={version} onChange={e => setVersion(e.target.value)}/></Field></div>{request.platform === 'java' && <label className="flex gap-2"><input type="checkbox" checked={eula} onChange={e => setEula(e.target.checked)}/>I accept Mojang's EULA for this instance.</label>}<Button disabled={ctl.busy || !name || !version || (request.platform === 'java' && !eula)} onClick={async () => {
                if (!await confirm({ title: 'Provision reserved instance', message: `Create ${name} on the reserved host with this resource/port budget?`, confirmLabel: 'Provision' }))
                    return;
                const r = await ctl.perform('/capacity/provision', { id: lease.id, nodeId: lease.nodeId, definition: { name, loader, version, acceptEula: eula } });
                if (r) {
                    setResult(r);
                    setLease(null);
                }
            }}>Provision reserved instance</Button> <Button disabled={ctl.busy} onClick={async () => {
                const r = await ctl.perform('/capacity/release', { id: lease.id, nodeId: lease.nodeId });
                if (r)
                    setLease(null);
            }}>Release unused reservation</Button></Card>}
    <Card className="space-y-3 p-5"><CardTitle>Pending host reservations</CardTitle>{ctl.data.hosts.hosts.flatMap(h => (h.reservations ?? []).map(l => <div key={h.id + l.id} className="space-y-2 rounded border border-surface-700 p-3"><p className="break-all text-sm">{h.name} ? {l.id}</p><p className="text-xs">{l.resources.memoryMb} MiB memory ? {l.resources.cpuPercent}% CPU ? {l.resources.diskMb} MiB disk ? expires {new Date(l.expires).toLocaleString()}</p><Button disabled={ctl.busy || !!lease} onClick={() => { setRequest(l.resources); setLease({ ...l, nodeId: h.id }); setPreview([]); }}>Resume reservation</Button> <Button disabled={ctl.busy || lease?.id === l.id} onClick={() => ctl.perform('/capacity/release', { nodeId: h.id, id: l.id })}>Release unused reservation</Button></div>))}<p className="text-xs text-ink-400">Reservations persist across navigation and expire after ten minutes. Check instance lists before reusing an uncertain provisioning request.</p></Card>
    <Card className="space-y-3 p-5"><CardTitle>Local capacity headroom</CardTitle><p className="text-sm">Reserved for this host: {ctl.data.policy.reserveCpuPercent}% CPU ? {ctl.data.policy.reserveDiskMb} MiB disk. Memory headroom and admission tags are configured under Host fleet.</p>{policyDraft ? <><Field label="Host CPU reserve percent"><Input type="number" min={0} value={policyDraft.reserveCpuPercent} onChange={e => setPolicyDraft({ ...policyDraft, reserveCpuPercent: +e.target.value })}/></Field><Field label="Host disk reserve MiB"><Input type="number" min={0} value={policyDraft.reserveDiskMb} onChange={e => setPolicyDraft({ ...policyDraft, reserveDiskMb: +e.target.value })}/></Field><Button disabled={ctl.busy} onClick={async () => { if (await ctl.perform('/capacity/policy', policyDraft, 'put'))
        setPolicyDraft(null); }}>Save local headroom</Button> <Button onClick={() => setPolicyDraft(null)}>Cancel</Button></> : <Button onClick={() => setPolicyDraft({ ...ctl.data.policy })}>Edit local headroom</Button>}</Card><Result value={result}/><ErrorText>{ctl.error}</ErrorText></div>;
}
interface EnrollmentJob {
    id: string;
    name: string;
    state: string;
    nodeVersion: string;
    bundleHash: string;
    nodeId?: string;
    error?: string;
    logs: string[];
    rollback: string;
}
export function HostEnrollmentPanel() {
    const ctl = useFleet<{
        jobs: EnrollmentJob[];
    }>('/enrollments', { jobs: [] }), confirm = useConfirm();
    const [name, setName] = useState(''), [nodeUrl, setNodeUrl] = useState(''), [port, setPort] = useState(8642), [ownerUsername, setOwner] = useState('owner'), [ownerPassword, setPassword] = useState(''), [proxyReady, setProxyReady] = useState(false), [plan, setPlan] = useState<(EnrollmentJob & {
        script: string;
    }) | null>(null), [host, setHost] = useState(''), [sshPort, setSshPort] = useState(22), [username, setUsername] = useState('root'), [fingerprint, setFingerprint] = useState(''), [privateKey, setPrivateKey] = useState(''), [passphrase, setPassphrase] = useState('');
    return <div className="space-y-4"><Card className="space-y-3 p-5"><CardTitle>Unattended host installation and enrollment</CardTitle><p className="text-sm text-ink-400">Linux systemd x64/arm64 hosts only. Requires pinned SSH identity, root/passwordless sudo, curl/tar/sha256sum/useradd and an existing HTTPS reverse proxy to the chosen panel port. A unique install directory/unit is created; existing Outpost installations are never overwritten.</p><div className="grid gap-3 sm:grid-cols-2"><Field label="Host label"><Input value={name} onChange={e => setName(e.target.value)}/></Field><Field label="New host HTTPS URL"><Input placeholder="https://node.example.com" value={nodeUrl} onChange={e => setNodeUrl(e.target.value)}/></Field><Field label="New panel port"><Input type="number" min={1024} max={65535} value={port} onChange={e => setPort(+e.target.value)}/></Field><Field label="New owner username"><Input value={ownerUsername} onChange={e => setOwner(e.target.value)}/></Field><Field label="New owner password (12+ characters)"><Input type="password" autoComplete="new-password" value={ownerPassword} onChange={e => setPassword(e.target.value)}/></Field></div><label className="flex gap-2"><input type="checkbox" checked={proxyReady} onChange={e => setProxyReady(e.target.checked)}/>I prepared HTTPS routing from the new host URL to the selected port.</label><Button disabled={ctl.busy || !proxyReady} onClick={async () => {
            const r = await ctl.perform<EnrollmentJob & {
                script: string;
            }>('/enrollments', { name, nodeUrl, panelUrl: location.origin, port, ownerUsername, ownerPassword, reverseProxyReady: proxyReady });
            if (r)
                setPlan(r);
        }}>Build pinned installation plan</Button>
    {plan && <><p>Plan {plan.id} · Node {plan.nodeVersion}</p><p className="break-all text-xs">Bundle SHA-256: {plan.bundleHash}</p><details><summary>Review installer (secrets redacted)</summary><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">{plan.script}</pre></details><div className="grid gap-3 sm:grid-cols-2"><Field label="SSH host"><Input value={host} onChange={e => setHost(e.target.value)}/></Field><Field label="SSH port"><Input type="number" value={sshPort} onChange={e => setSshPort(+e.target.value)}/></Field><Field label="SSH user"><Input value={username} onChange={e => setUsername(e.target.value)}/></Field><Field label="SHA-256 SSH host-key fingerprint (hex or SHA256:base64)"><Input value={fingerprint} onChange={e => setFingerprint(e.target.value)}/></Field></div><Field label="SSH private key (used only for this run)"><textarea className={area} value={privateKey} onChange={e => setPrivateKey(e.target.value)} autoComplete="off"/></Field><Field label="Optional key passphrase"><Input type="password" autoComplete="off" value={passphrase} onChange={e => setPassphrase(e.target.value)}/></Field><Button disabled={ctl.busy || !privateKey || !fingerprint} onClick={async () => {
                if (!await confirm({ title: 'Install reviewed host', message: `Run the reviewed installer as root/passwordless sudo on ${host}? It creates /opt/outpost-enroll/${plan.id} and a new service. Rollback stops/disables that service and retains files for inspection.`, confirmLabel: 'Install and enroll' }))
                    return;
                const r = await ctl.perform(`/enrollments/${plan.id}/execute`, { host, port: sshPort, username, fingerprint, privateKey, passphrase, bundleHash: plan.bundleHash });
                if (r) {
                    setPrivateKey('');
                    setPassphrase('');
                    setPassword('');
                    setPlan(null);
                }
            }}>Execute reviewed installation</Button></>}
  </Card>{ctl.data.jobs.map(j => <Card key={j.id} className="space-y-2 p-4"><h2>{j.name} · {j.state}</h2><p className="break-all text-xs">{j.id}{j.nodeId ? ` · linked host ${j.nodeId}` : ''}</p>{j.error && <ErrorText>{j.error}</ErrorText>}<p className="text-xs text-ink-400">{j.rollback}</p><details><summary>Provisioning logs</summary><pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all text-xs">{j.logs.join('\n')}</pre></details>{['review', 'failed'].includes(j.state) && <Button onClick={() => ctl.perform(`/enrollments/${j.id}/cancel`)}>Revoke enrollment token</Button>}</Card>)}<ErrorText>{ctl.error}</ErrorText></div>;
}
interface FleetHost {
    id: string;
    name: string;
    url: string;
    error: string | null;
    inventory: {
        servers: {
            id: string;
            name: string;
            platform: string;
            status: string;
            memoryMb: number;
            port: number;
        }[];
    } | null;
}
interface RecoveryRun {
    id: string;
    sourceNodeId: string;
    sourceServerId: string;
    destinationNodeId: string;
    destinationServerId?: string;
    state: string;
    mode: string;
    error?: string;
    logs: string[];
    snapshot?: {
        sha256: string;
        sizeBytes: number;
        warnings: string[];
    };
}
export function FleetRecoveryPanel() {
    const ctl = useFleet<{
        runs: RecoveryRun[];
    }>('/recovery', { runs: [] }), confirm = useConfirm();
    const [hosts, setHosts] = useState<FleetHost[]>([]), [source, setSource] = useState(''), [destination, setDestination] = useState(''), [mode, setMode] = useState('standby'), [request, setRequest] = useState({ ...defaultBudget }), [reviewed, setReviewed] = useState<Record<string, boolean>>({}), [fenced, setFenced] = useState<Record<string, boolean>>({});
    useEffect(() => {
        api.get<{
            nodes: FleetHost[];
        }>('/operations/fleet').then(r => setHosts(r.nodes)).catch(e => ctl.setError(e.message));
    }, []);
    const split = source.indexOf(':'), sourceNode = source.slice(0, split), serverId = source.slice(split + 1);
    return <div className="space-y-4"><Card className="space-y-3 p-5"><CardTitle>Verified evacuation and failover</CardTitle><p className="text-sm text-ink-400">Stop the source first. Recovery v1 supports managed, instance-contained trees up to 1 GiB. The destination is checksum-verified, restore-tested, stopped and fenced until reviewed. Standby mode releases the source; evacuation keeps it fenced. No automatic split-brain recovery is attempted.</p><div className="grid gap-3 sm:grid-cols-3"><Field label="Stopped source instance"><Select value={source} onChange={e => {
            setSource(e.target.value);
            const [n, id] = e.target.value.split(':'), s = hosts.find(h => h.id === n)?.inventory?.servers.find(s => s.id === id);
            if (s)
                setRequest({ ...request, platform: s.platform, memoryMb: s.memoryMb || 2048, roles: [{ role: 'game', offset: 0, protocol: s.platform === 'java' ? 'tcp' : 'udp' }] });
        }}><option value="">Select source</option>{hosts.flatMap(h => (h.inventory?.servers ?? []).map(s => <option key={`${h.id}:${s.id}`} value={`${h.id}:${s.id}`}>{h.name} / {s.name} ({s.status})</option>))}</Select></Field><Field label="Destination host"><Select value={destination} onChange={e => setDestination(e.target.value)}><option value="">Select destination</option>{hosts.filter(h => h.id !== sourceNode && !h.error).map(h => <option key={h.id} value={h.id}>{h.name}</option>)}</Select></Field><Field label="Handover mode"><Select value={mode} onChange={e => setMode(e.target.value)}><option value="standby">Prepare fenced standby</option><option value="evacuate">Evacuate; retain source fence</option></Select></Field></div><BudgetFields value={request} onChange={setRequest}/><Button disabled={ctl.busy || !source || !destination} onClick={async () => {
            if (!await confirm({ title: 'Prepare verified recovery', message: 'Fence the stopped source, make and verify a recovery snapshot, then import a fenced destination? Network and external dependencies need review before activation.', confirmLabel: 'Prepare standby' }))
                return;
            await ctl.perform('/recovery', { sourceNodeId: sourceNode, serverId, destinationNodeId: destination, mode, request, sourcePublicUrl: location.origin });
        }}>Prepare verified standby</Button></Card>
    {ctl.data.runs.map(r => <Card className="space-y-3 p-5" key={r.id}><h2>{r.sourceNodeId}/{r.sourceServerId} → {r.destinationNodeId} · {r.state}</h2>{r.destinationServerId && <p className="break-all text-sm">Destination instance: {r.destinationServerId}</p>}{r.snapshot && <><p className="break-all text-xs">SHA-256: {r.snapshot.sha256} · {(r.snapshot.sizeBytes / 1048576).toFixed(1)} MiB</p>{r.snapshot.warnings.map(w => <p className="text-xs text-amber-400" key={w}>{w}</p>)}</>}{r.error && <ErrorText>{r.error}</ErrorText>}<details><summary>Recovery steps</summary>{r.logs.map((l, i) => <p className="text-xs" key={i}>{l}</p>)}</details><div className="flex flex-wrap gap-2"><Button disabled={ctl.busy} onClick={() => ctl.perform(`/recovery/${r.id}/reconcile`)}>Reconcile destination state</Button><Button disabled={ctl.busy || ['preparing', 'importing'].includes(r.state)} onClick={async () => {
                if (await confirm({ title: 'Roll back handover', message: 'Confirm the destination is stopped. It will be fenced before releasing the source. Newer destination world changes are not merged.', confirmLabel: 'Fence destination and release source', tone: 'danger' }))
                    await ctl.perform(`/recovery/${r.id}/rollback`);
            }}>Roll back handover</Button></div><label className="flex gap-2 text-sm"><input type="checkbox" checked={!!reviewed[r.id]} onChange={e => setReviewed({ ...reviewed, [r.id]: e.target.checked })}/>I reviewed destination ports, save paths, runtimes, licenses and dependencies.</label><label className="flex gap-2 text-sm"><input type="checkbox" checked={!!fenced[r.id]} onChange={e => setFenced({ ...fenced, [r.id]: e.target.checked })}/>If the source cannot be reached, I have fenced it externally and prevented it from restarting.</label><Button disabled={ctl.busy || r.state !== 'standby' || !reviewed[r.id]} onClick={async () => {
                if (await confirm({ title: 'Release reviewed standby', message: 'The source must be fenced before the destination becomes startable. The destination remains stopped for your final game-level checks.', confirmLabel: 'Activate reviewed standby', tone: 'danger' }))
                    await ctl.perform(`/recovery/${r.id}/activate`, { reviewedDependencies: reviewed[r.id], externallyFenced: !!fenced[r.id] });
            }}>Activate reviewed standby (keeps it stopped)</Button></Card>)}<ErrorText>{ctl.error}</ErrorText></div>;
}
interface BillingData {
    connections: {
        id: string;
        name: string;
        enabled: number;
        allow_termination: number;
    }[];
    plans: {
        id: string;
        name: string;
        templateId: string;
        memoryMb: number;
        cpuPercent: number;
        diskMb: number;
    }[];
    services: {
        connection_id: string;
        external_id: string;
        user_id: string;
        server_id: string | null;
        plan_id: string;
        state: string;
        expires: number | null;
    }[];
    events: {
        connection_id: string;
        event_id: string;
        state: string;
        result: string;
        at: number;
    }[];
}
export function BillingPanel() {
    const ctl = useFleet<BillingData>('/billing', { connections: [], plans: [], services: [], events: [] }), confirm = useConfirm();
    const [name, setName] = useState(''), [allowTermination, setAllow] = useState(false), [secret, setSecret] = useState<unknown>(null), [templates, setTemplates] = useState<{
        id: string;
        name: string;
    }[]>([]), [templateId, setTemplate] = useState(''), [planName, setPlanName] = useState(''), [memory, setMemory] = useState(2048), [cpu, setCpu] = useState(100), [disk, setDisk] = useState(10240), [pool, setPool] = useState('auto'), [variables, setVariables] = useState('{}'), [eula, setEula] = useState(false);
    useEffect(() => {
        api.get<{
            templates: typeof templates;
        }>('/templates').then(r => setTemplates(r.templates)).catch(e => ctl.setError(e.message));
    }, []);
    return <div className="space-y-4"><Card className="space-y-3 p-5"><CardTitle>Billing lifecycle connections</CardTitle><p className="text-sm text-ink-400">Signed API v1 supports WHMCS provisioning, plan changes, renewal, suspension and opt-in termination. It is scoped to billing plans/services and cannot issue arbitrary console or admin commands. The bundled WHMCS module is in integrations/whmcs/outpost.</p><Field label="Connection name"><Input value={name} onChange={e => setName(e.target.value)}/></Field><label className="flex gap-2"><input type="checkbox" checked={allowTermination} onChange={e => setAllow(e.target.checked)}/>Allow termination after a verified recovery archive is retained.</label><Button disabled={ctl.busy} onClick={async () => setSecret(await ctl.perform('/billing/connections', { name, allowTermination }))}>Create billing connection</Button><Result value={secret}/>{secret != null && <Button onClick={() => setSecret(null)}>Dismiss copied secret</Button>}{ctl.data.connections.map(c => <div className="rounded border border-surface-700 p-3 text-sm" key={c.id}><p>{c.name} · {c.enabled ? 'Enabled' : 'Disabled'} · termination {c.allow_termination ? 'allowed' : 'blocked'}</p><code className="break-all">{location.origin}/api/billing/events/{c.id}</code><div className="mt-2 flex flex-wrap gap-2"><Button disabled={ctl.busy} onClick={() => ctl.perform('/billing/connections', { id: c.id, name: c.name, enabled: !c.enabled, allowTermination: !!c.allow_termination })}>{c.enabled ? 'Disable' : 'Enable'} connection</Button><Button disabled={ctl.busy} onClick={async () => {
                if (await confirm({ title: 'Rotate billing secret', message: 'The old integration secret stops working immediately. Update WHMCS after copying the new secret.', confirmLabel: 'Rotate' }))
                    setSecret(await ctl.perform(`/billing/connections/${c.id}/rotate`));
            }}>Rotate secret</Button></div></div>)}</Card>
    <Card className="space-y-3 p-5"><CardTitle>Billing plans and resource limits</CardTitle><p className="text-sm text-ink-400">Plans pin an existing template and local host port pool. Customers receive restricted accounts; arrange sign-in credentials separately. Plans do not grant instance creation, host access or arbitrary launch configuration.</p><div className="grid gap-3 sm:grid-cols-3"><Field label="Plan name"><Input value={planName} onChange={e => setPlanName(e.target.value)}/></Field><Field label="Pinned template"><Select value={templateId} onChange={e => setTemplate(e.target.value)}><option value="">Select template</option>{templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field><Field label="Port pool ID"><Input value={pool} onChange={e => setPool(e.target.value)}/></Field><Field label="Memory MiB"><Input type="number" min={128} value={memory} onChange={e => setMemory(+e.target.value)}/></Field><Field label="CPU percent"><Input type="number" min={10} value={cpu} onChange={e => setCpu(+e.target.value)}/></Field><Field label="Disk MiB"><Input type="number" min={100} value={disk} onChange={e => setDisk(+e.target.value)}/></Field></div><Field label="Pinned template variables"><textarea className={area} value={variables} onChange={e => setVariables(e.target.value)}/></Field><label className="flex gap-2"><input type="checkbox" checked={eula} onChange={e => setEula(e.target.checked)}/>I accept the Minecraft EULA for Java plans.</label><Button disabled={ctl.busy || !templateId} onClick={async () => {
            try {
                await ctl.perform('/billing/plans', { name: planName, templateId, memoryMb: memory, cpuPercent: cpu, diskMb: disk, portPoolId: pool, variables: JSON.parse(variables), acceptEula: eula });
            }
            catch (e) {
                ctl.setError((e as Error).message);
            }
        }}>Save billing plan</Button>{ctl.data.plans.map(p => <p className="break-all text-sm" key={p.id}>{p.name} · {p.id} · {p.memoryMb} MiB / {p.cpuPercent}% CPU / {p.diskMb} MiB disk</p>)}</Card>
    <Card className="space-y-3 p-5"><CardTitle>Billing services and deliveries</CardTitle>{ctl.data.services.map(s => <p className="break-all text-sm" key={s.connection_id + ':' + s.external_id}>{s.external_id} · {s.state} · user {s.user_id} · instance {s.server_id ?? 'none'}{s.expires ? ` · period end ${new Date(s.expires).toLocaleString()}` : ''}</p>)}{ctl.data.events.map(e => <details className="rounded border border-surface-700 p-2" key={e.connection_id + e.event_id}><summary>{e.state} · {new Date(e.at).toLocaleString()} · {e.event_id}</summary><pre className="overflow-auto whitespace-pre-wrap break-all text-xs">{e.result}</pre></details>)}<p className="text-xs text-ink-400">A processing/interrupted delivery needs operator review before another create request. Disabling a connection pauses inbound lifecycle actions and expiry automation. Manual administrator suspensions are preserved on renewal.</p></Card><ErrorText>{ctl.error}</ErrorText></div>;
}
interface ExtensionRow {
    id: string;
    enabled: boolean;
    manifest: {
        id: string;
        name: string;
        version: string;
        description: string;
        gameAdapters: {
            id: string;
        }[];
    };
    provenance: unknown;
    history: unknown[];
}
interface ExtensionReview {
    manifest: unknown;
    digest: string;
    currentVersion: string | null;
    permissions: string[];
    addedPermissions: string[];
    backend: string | null;
    gameAdapters: string[];
    boundary: string;
}
export function ExtensionAdminPanel() {
    const ctl = useFleet<{
        sdkVersion: number;
        panelVersion: string;
        extensions: ExtensionRow[];
    }>('/extensions', { sdkVersion: 1, panelVersion: '', extensions: [] }), confirm = useConfirm();
    const [manifest, setManifest] = useState(''), [review, setReview] = useState<ExtensionReview | null>(null);
    return <div className="space-y-4"><Card className="space-y-3 p-5"><CardTitle>Versioned extension SDK</CardTitle><p className="text-sm text-ink-400">SDK {ctl.data.sdkVersion} · Outpost {ctl.data.panelVersion}. Pages run in isolated iframes; backend calls and native game adapters use declared permissions and compatibility checks. Panel-process JavaScript and arbitrary package installation are not supported. SDK files and an example are provided under sdk/.</p><Link className="text-accent-400 underline" to="/extensions">Open enabled extension pages</Link><Field label="Extension manifest JSON"><textarea aria-label="Extension manifest" className={area} value={manifest} onChange={e => { setManifest(e.target.value); setReview(null); }}/></Field><Button disabled={ctl.busy} onClick={async () => {
            try {
                const r = await ctl.perform<ExtensionReview>('/extensions/review', JSON.parse(manifest));
                if (r)
                    setReview(r);
            }
            catch (e) {
                ctl.setError((e as Error).message);
            }
        }}>Review extension</Button>{review && <><p>Current version: {review.currentVersion ?? 'not installed'}</p><p className="break-all text-xs">Review SHA-256: {review.digest}</p><p>Permissions: {review.permissions.join(', ') || 'Administrator only'}</p><p className="text-amber-400">New permissions: {review.addedPermissions.join(', ') || 'none'}</p><p className="break-all">Backend: {review.backend ?? 'none'}</p><p className="text-xs text-ink-400">{review.boundary}</p><details><summary>Full reviewed manifest</summary><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(review.manifest, null, 2)}</pre></details><Button disabled={ctl.busy} onClick={async () => {
                if (await confirm({ title: 'Install reviewed extension', message: 'Install this exact reviewed digest? It remains disabled until you explicitly enable it.', confirmLabel: 'Install disabled' })) {
                    const r = await ctl.perform('/extensions/install', { manifest: review.manifest, digest: review.digest });
                    if (r)
                        setReview(null);
                }
            }}>Install reviewed extension (disabled)</Button></>}</Card>{ctl.data.extensions.map(e => <Card key={e.id} className="space-y-2 p-4"><h2>{e.manifest.name} {e.manifest.version} · {e.enabled ? 'Enabled' : 'Disabled'}</h2><p className="text-sm">{e.manifest.description}</p><p className="text-xs">Game adapters: {e.manifest.gameAdapters.map(g => g.id).join(', ') || 'none'}</p><Button disabled={ctl.busy} onClick={() => ctl.perform(`/extensions/${e.id}/enabled`, { enabled: !e.enabled })}>{e.enabled ? 'Disable' : 'Enable'} extension</Button> <Button disabled={ctl.busy || !e.history.length} onClick={async () => {
                if (await confirm({ title: 'Roll back extension', message: 'Restore the previous retained manifest as a disabled version? Instances using its adapters must be migrated first.', confirmLabel: 'Restore previous version' }))
                    await ctl.perform(`/extensions/${e.id}/rollback`);
            }}>Restore previous version</Button><details><summary>Provenance</summary><pre className="overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(e.provenance, null, 2)}</pre></details></Card>)}<ErrorText>{ctl.error}</ErrorText></div>;
}
interface CommunitySource {
    id: string;
    name: string;
    enabled: number;
    url: string;
    fingerprint: string;
    synced_at: number | null;
    manifest: {
        publisher: string;
        entries: {
            id: string;
            name: string;
            kind: string;
            releases: {
                version: string;
                summary: string;
                sha256: string;
            }[];
        }[];
    } | null;
}
interface CommunityReview {
    sourceId: string;
    packageId: string;
    version: string;
    digest: string;
    sourceFingerprint: string;
    kind: string;
    publisher: string;
    summary: string;
    review: unknown;
}
export function CommunityCatalogPanel() {
    const ctl = useFleet<{
        sources: CommunitySource[];
        installations: unknown[];
    }>('/community', { sources: [], installations: [] }), confirm = useConfirm();
    const [name, setName] = useState(''), [url, setUrl] = useState(''), [publicKey, setKey] = useState(''), [review, setReview] = useState<CommunityReview | null>(null);
    return <div className="space-y-4"><Card className="space-y-3 p-5"><CardTitle>Curated community catalog</CardTitle><p className="text-sm text-ink-400">Trust a curator's Ed25519 public key, sync its signed catalog and review an exact version/digest before installing. Signed provenance identifies a publisher; it does not certify package safety. No automatic update or enable step is performed.</p><div className="grid gap-3 sm:grid-cols-2"><Field label="Curator label"><Input value={name} onChange={e => setName(e.target.value)}/></Field><Field label="Signed catalog HTTPS URL"><Input value={url} onChange={e => setUrl(e.target.value)}/></Field></div><Field label="Publisher Ed25519 public key (64 hex characters)"><Input value={publicKey} onChange={e => setKey(e.target.value)}/></Field><Button disabled={ctl.busy} onClick={async () => {
            if (await confirm({ title: 'Trust catalog publisher', message: 'Verify this public key through the publisher before trusting it. Syncing never installs packages automatically.', confirmLabel: 'Add trusted source' }))
                await ctl.perform('/community/sources', { name, url, publicKey });
        }}>Add trusted source</Button></Card>
    {ctl.data.sources.map(s => <Card key={s.id} className="space-y-3 p-5"><h2>{s.name} · {s.enabled ? 'Trusted/enabled' : 'Disabled'}</h2><p className="break-all text-xs">{s.url}</p><p className="break-all text-xs">Key fingerprint: {s.fingerprint}</p><Button disabled={ctl.busy || !s.enabled} onClick={() => ctl.perform(`/community/sources/${s.id}/sync`)}>Verify and sync catalog</Button> <Button disabled={ctl.busy} onClick={() => ctl.perform(`/community/sources/${s.id}/enabled`, { enabled: !s.enabled })}>{s.enabled ? 'Disable' : 'Enable'} source</Button>{s.manifest && <><p>Publisher: {s.manifest.publisher}</p>{s.manifest.entries.map(e => <div key={e.id} className="rounded border border-surface-700 p-3"><h3>{e.name} · {e.kind}</h3>{e.releases.map(v => <div key={v.version} className="mt-2 space-y-1 text-sm"><p>v{v.version} · {v.summary}</p><p className="break-all text-xs">{v.sha256}</p><Button disabled={ctl.busy || !s.enabled} onClick={async () => {
                            const r = await ctl.perform<CommunityReview>('/community/review', { sourceId: s.id, packageId: e.id, version: v.version });
                            if (r)
                                setReview(r);
                        }}>Review pinned version</Button></div>)}</div>)}</>}</Card>)}
    {review && <Card className="space-y-3 p-5"><h2>Review {review.packageId} {review.version}</h2><p>{review.publisher} · {review.kind}</p><p className="break-all text-xs">Publisher key: {review.sourceFingerprint} · package SHA-256: {review.digest}</p><Result value={review.review}/><Button disabled={ctl.busy} onClick={async () => {
                if (await confirm({ title: 'Install pinned community package', message: 'Re-download and verify the exact package digest and trusted source key before importing? Extensions remain disabled.', confirmLabel: 'Install reviewed pin' })) {
                    const r = await ctl.perform('/community/install', { sourceId: review.sourceId, packageId: review.packageId, version: review.version, digest: review.digest, sourceFingerprint: review.sourceFingerprint });
                    if (r)
                        setReview(null);
                }
            }}>Install reviewed pinned package</Button></Card>}<Card className="space-y-2 p-5"><CardTitle>Installed catalog pins</CardTitle><Result value={ctl.data.installations}/></Card><ErrorText>{ctl.error}</ErrorText></div>;
}
