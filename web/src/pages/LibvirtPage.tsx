import { VmImageLibrary } from '../components/VmImageLibrary.js';
import { VmDevices } from './VmDevices.js';
import { CreateVmModal } from './CreateVmModal.js';
import { useAuth } from '../state/AuthContext.js';
import { VmConsole, VmSnapshots, VmMigration } from './VmTools.js';
import { VmInfrastructure } from './VmInfrastructure.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Layout, PageHeader } from '../components/Layout.js';
import { Badge, Button, Card, ErrorText, Field, Input, Modal, Notice, Spinner } from '../components/ui.js';
import { Icon } from '../components/icons.js';
import { useConfirm } from '../components/ConfirmDialog.js';
import { useToast } from '../components/Toast.js';
import { api, getToken } from '../api/client.js';
import { setVisibleInterval } from '../lib/perf.js';
import type { LibvirtSettings, VirtualMachine, VmAction } from '../api/types.js';

const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'The request failed';
const textareaClass = 'min-h-80 w-full rounded-xl border border-surface-600 bg-surface-950 p-3 font-mono text-xs text-ink-100 focus:outline-none focus:ring-2 focus:ring-accent-400';

export function LibvirtPage() {
  const location = useLocation();
  const { user } = useAuth();
  const admin = user?.role === 'admin';
  const configuration = admin && location.pathname === '/libvirt/configuration';
  return <Layout><div className="mx-auto max-w-7xl p-4 sm:p-8">
    <PageHeader title={configuration ? 'Libvirt Configuration' : 'Virtual Machines'} subtitle={configuration ? 'Connect Outpost to a local or remote QEMU/KVM hypervisor.' : 'All guests on this libvirt connection, including VMs created with Cockpit, virt-manager or virsh.'}
      action={admin ? <Link to={configuration ? '/libvirt' : '/libvirt/configuration'}><Button>{configuration ? 'Virtual machines' : 'Connection settings'}</Button></Link> : undefined} />
    {configuration ? <><ConnectionSettings /><div className="mt-6 space-y-5"><VmImageLibrary /><VmInfrastructure /></div></> : <VirtualMachines />}
  </div></Layout>;
}

function ConnectionSettings() {
  const [settings, setSettings] = useState<LibvirtSettings | null>(null);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get<LibvirtSettings>('/libvirt/settings').then(setSettings).catch((err) => setError(errorMessage(err))); }, []);
  async function submit(test: boolean) {
    setBusy(true); setError(''); setFeedback('');
    try {
      if (test) {
        const result = await api.post<{ count: number }>('/libvirt/test', settings);
        setFeedback(`Connected successfully. Found ${result.count} virtual machine(s). These settings have not been saved.`);
      } else {
        setSettings(await api.put<LibvirtSettings>('/libvirt/settings', settings));
        setFeedback('Connection settings saved.');
      }
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  return <div className="space-y-6"><Card className="space-y-4 p-5">
    <h2 className="text-lg font-medium text-ink-100">Hypervisor connection</h2>
    <ErrorText>{error}</ErrorText>
    {!settings && !error && <Spinner />}
    {settings && <>
      <label className="flex items-center gap-2 text-sm text-ink-200"><input type="checkbox" checked={settings.enabled} onChange={(e) => setSettings({ ...settings, enabled: e.target.checked })} disabled={busy} />Enable libvirt management</label>
      <Field label="Libvirt URI"><Input value={settings.uri} disabled={busy} onChange={(e) => setSettings({ ...settings, uri: e.target.value })} placeholder="qemu:///system" /></Field>
      <p className="text-xs text-ink-400">Local: qemu:///system or qemu:///session. Remote: qemu+ssh://user@host/system. Passwords and URI query parameters are not accepted.</p>
      <div className="flex flex-wrap gap-2"><Button variant="primary" disabled={busy} onClick={() => submit(false)}>Save settings</Button><Button disabled={busy} onClick={() => submit(true)}>{busy ? 'Working…' : 'Test connection'}</Button></div>
      {feedback && <p role="status" className="text-sm text-success-500">{feedback}</p>}
    </>}
  </Card><Card className="space-y-3 p-5">
    <h2 className="text-base font-medium text-ink-100">Host setup</h2>
    <p className="text-sm text-ink-300">Install the libvirt client tools so <code>virsh</code> is on the Outpost service’s PATH. The selected hypervisor must already have QEMU/KVM and libvirt configured. Outpost uses the same operating system account as its service to connect.</p>
    <p className="text-sm text-ink-300">For a local system connection, grant that account libvirt access using your host’s group or polkit policy, then restart Outpost. A session connection sees only that account’s VMs.</p>
    <p className="text-sm text-ink-300">For SSH, configure key-based authentication and a verified known-host entry for the service account first. Test the URI with virsh from that account. On Windows, use a virsh client with the SSH transport available to reach a Linux hypervisor.</p>
    <p className="text-sm text-ink-300">The preview uses libvirt screenshots and needs a guest with a supported graphical display. It is read-only and does not expose VNC or SPICE ports. CPU/memory changes require a stopped persistent VM; Pool, disk and network forms are below; boot and advanced device settings remain available in the XML editor. Interactive VNC/SPICE controls are separate from the screenshot preview.</p>
  </Card></div>;
}

function VirtualMachines() {
  const { user } = useAuth();
  const admin = user?.role === 'admin';
  const [machines, setMachines] = useState<VirtualMachine[]>([]);
  const [connection, setConnection] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [creationWarning, setCreationWarning] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [xml, setXml] = useState('');
  const [importError, setImportError] = useState('');
  const [importing, setImporting] = useState(false);
  const polling = useRef(false);
  const toast = useToast();
  const load = useCallback(async () => {
    if (polling.current) return;
    polling.current = true;
    try {
      const result = await api.get<{ machines: VirtualMachine[]; connection: string }>('/libvirt/vms');
      setConnection(result.connection);
      setMachines(result.machines); setError('');
      setSelectedId((current) => result.machines.some((vm) => vm.uuid === current) ? current : result.machines[0]?.uuid ?? null);
    } catch (err) { setError(errorMessage(err)); } finally { setLoading(false); polling.current = false; }
  }, []);
  useEffect(() => { void load(); return setVisibleInterval(load, 10_000); }, [load]);
  const selected = machines.find((vm) => vm.uuid === selectedId);
  async function importVm() {
    setImporting(true); setImportError('');
    try {
      await api.post('/libvirt/vms', { xml }); setImportOpen(false); setXml('');
      toast.success('VM defined. Its referenced disks must already exist on the hypervisor.'); await load();
    } catch (err) { setImportError(errorMessage(err)); } finally { setImporting(false); }
  }
  return <div className="space-y-5">
    <p className="text-sm text-ink-400">Existing VMs are discovered automatically, including stopped and transient guests. No import is needed. If a Cockpit VM is missing, select the same host and system/session URI in Libvirt Configuration.</p>
    {connection && <p className="break-all font-mono text-xs text-ink-500">Connection: {connection}</p>}
    <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-ink-400">{machines.length} virtual machine(s) · refreshes every 10 seconds</p><div className="flex flex-wrap gap-2"><Button disabled={loading} onClick={load}><Icon name="refresh" className="h-4 w-4" />Refresh</Button>{admin && <Button onClick={() => { setImportError(''); setImportOpen(true); }}>Define VM from XML</Button>}{admin && <Button variant="primary" onClick={() => setCreateOpen(true)}><Icon name="plus" className="h-4 w-4" />New virtual machine</Button>}</div></div>
    {error && <Notice tone="warning"><p>{error}</p><Link className="mt-2 inline-block underline" to="/libvirt/configuration">Open libvirt configuration</Link></Notice>}
    {loading && <Spinner />}
    {!loading && !error && machines.length === 0 && <Card className="p-8 text-center"><Icon name="monitor" className="mx-auto mb-3 h-10 w-10 text-ink-400" /><h2 className="text-lg text-ink-100">No virtual machines found</h2><p className="mt-2 text-sm text-ink-400">Create a new virtual machine or connect to the libvirt host where your guests are running.</p></Card>}
    {!error && machines.length > 0 && <div className="grid gap-5 lg:grid-cols-[260px_minmax(0,1fr)]"><div className="space-y-2" aria-label="Virtual machines">{machines.map((vm) => <button key={vm.uuid} onClick={() => setSelectedId(vm.uuid)} aria-pressed={vm.uuid === selectedId} className={`w-full rounded-2xl border p-4 text-left transition-colors ${vm.uuid === selectedId ? 'border-accent-400 bg-secondary-container text-secondary-on-container' : 'border-surface-700 bg-surface-850 text-ink-200'}`}>
      <span className="flex items-center gap-2"><Icon name="monitor" className="h-5 w-5" /><span className="min-w-0 truncate font-medium">{vm.name}</span></span><span className="mt-2 block text-xs opacity-80">{vm.state} · {vm.cpus} vCPU · {vm.memoryMb} MB</span>
    </button>)}</div>{selected && <VmDetail key={selected.uuid} vm={selected} onRefresh={load} />}</div>}
    {creationWarning && <Notice tone="warning">{creationWarning}</Notice>}
    {createOpen && <CreateVmModal onClose={() => setCreateOpen(false)} onCreated={async (uuid, warning) => { setCreationWarning(warning ?? ""); toast.success("Virtual machine created"); await load(); setSelectedId(uuid); }} />}
    <Modal title="Define a virtual machine" open={importOpen} onClose={() => !importing && setImportOpen(false)} size="lg"><div className="space-y-4"><p className="text-sm text-ink-300">Paste libvirt domain XML. This registers a new persistent VM; referenced disks, ISOs, bridges and networks must already exist on the hypervisor. Nothing is downloaded or installed.</p><textarea aria-label="New VM domain XML" spellCheck={false} className={textareaClass} value={xml} onChange={(e) => setXml(e.target.value)} disabled={importing} placeholder={'<domain type="kvm">\n  <name>my-vm</name>\n  …\n</domain>'} /><ErrorText>{importError}</ErrorText><div className="flex justify-end gap-2"><Button onClick={() => setImportOpen(false)} disabled={importing}>Cancel</Button><Button variant="primary" disabled={importing || !xml.trim()} onClick={importVm}>{importing ? 'Defining…' : 'Define VM'}</Button></div></div></Modal>
  </div>;
}

function VmDetail({ vm, onRefresh }: { vm: VirtualMachine; onRefresh: () => Promise<void> }) {
  const { user } = useAuth();
  const admin = user?.role === 'admin';
  const can = (permission: string) => admin || vm.permissions?.some(p => p === permission);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [memory, setMemory] = useState(vm.memoryMb);
  const [cpus, setCpus] = useState(vm.cpus);
  const [autostart, setAutostart] = useState(vm.autostart);
  const [xml, setXml] = useState<string | null>(null);
  const [xmlDirty, setXmlDirty] = useState(false);
  const [xmlLoading, setXmlLoading] = useState(false);
  const confirm = useConfirm(); const toast = useToast();
  const [deleteOpen, setDeleteOpen] = useState(false), [deleteName, setDeleteName] = useState(''), [removeSnapshotMetadata, setRemoveSnapshotMetadata] = useState(false);
  const stopped = vm.state === 'shut off';
  // Only reinitialize fields when persisted values change, preserving drafts during polling.
  useEffect(() => { setMemory(vm.memoryMb); setCpus(vm.cpus); setAutostart(vm.autostart); }, [vm.memoryMb, vm.cpus, vm.autostart]);
  async function action(action: VmAction) {
    if (['destroy', 'shutdown', 'reboot'].includes(action) && !await confirm({ title: `${action === 'destroy' ? 'Force off' : action === 'shutdown' ? 'Shut down' : 'Reboot'} ${vm.name}?`, message: action === 'destroy' ? 'This immediately cuts power to the VM and can lose unsaved guest data. Its disks and definition are kept.' : 'This sends a request to the guest operating system. Wait for the state to change before continuing.', tone: action === 'destroy' ? 'danger' : 'default' })) return;
    setBusy(true); setError('');
    try { await api.post(`/libvirt/vms/${vm.uuid}/action`, { action }); toast.success('VM action accepted'); await onRefresh(); }
    catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  async function save() {
    setBusy(true); setError('');
    try { await api.put(`/libvirt/vms/${vm.uuid}/config`, { memoryMb: memory, cpus, autostart }); toast.success('VM configuration saved'); await onRefresh(); }
    catch (err) { setError(errorMessage(err)); await onRefresh(); } finally { setBusy(false); }
  }
  async function keepDefinition() {
    setBusy(true); setError('');
    try { await api.post(`/libvirt/vms/${vm.uuid}/persistent`); toast.success('VM definition kept without restarting the guest'); await onRefresh(); }
    catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  async function loadXml() {
    if (xmlDirty && !await confirm({ title: 'Reload XML?', message: 'Discard your unsaved XML changes?' })) return;
    setXmlLoading(true); setError('');
    try { const result = await api.get<{ xml: string }>(`/libvirt/vms/${vm.uuid}/xml`); setXml(result.xml); setXmlDirty(false); }
    catch (err) { setError(errorMessage(err)); } finally { setXmlLoading(false); }
  }
  async function saveXml() {
    if (!await confirm({ title: 'Save VM XML?', message: 'Replace this VM’s persistent definition with the edited XML? Disk paths, devices, networks and boot configuration can change.' })) return;
    setBusy(true); setError('');
    try { await api.put(`/libvirt/vms/${vm.uuid}/xml`, { xml }); setXmlDirty(false); setXml(null); toast.success('VM XML saved'); await onRefresh(); }
    catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  return <div className="min-w-0 space-y-5"><Card className="p-5"><div className="mb-4 flex flex-wrap items-center gap-3"><h2 className="min-w-0 break-words text-xl font-medium text-ink-100">{vm.name}</h2><Badge tone={vm.state === 'running' ? 'green' : 'neutral'}>{vm.state}</Badge>{vm.autostart && <Badge tone="blue">Autostart</Badge>}</div><p className="mb-4 break-all font-mono text-xs text-ink-400">{vm.uuid}</p><div className="flex flex-wrap gap-2">
    <Button variant="primary" disabled={busy || !stopped || !can('power')} onClick={() => action('start')}>Start</Button>
    <Button disabled={busy || stopped || !can('power')} onClick={() => action('shutdown')}>Shut down</Button>
    <Button disabled={busy || vm.state !== 'running' || !can('power')} onClick={() => action('reboot')}>Reboot</Button>
    <Button disabled={busy || !['running', 'paused'].includes(vm.state) || !can('power')} onClick={() => action(vm.state === 'paused' ? 'resume' : 'suspend')}>{vm.state === 'paused' ? 'Resume' : 'Pause'}</Button>
    <Button variant="danger" disabled={busy || stopped || !can('power')} onClick={() => action('destroy')}>Force off</Button>
    {admin && <Button variant="danger" disabled={busy || !stopped || !vm.persistent} onClick={() => { setDeleteName(''); setRemoveSnapshotMetadata(false); setError(''); setDeleteOpen(true); }}>Delete VM entry</Button>}
  </div><ErrorText>{error}</ErrorText></Card>
  <Modal title={`Delete VM entry: ${vm.name}`} open={deleteOpen} onClose={() => !busy && setDeleteOpen(false)}><div className="space-y-4"><p className="text-sm text-ink-300">Remove this stopped VM's persistent libvirt definition? Its disk volumes, UEFI NVRAM and TPM state are retained. Save its XML first if you plan to register it again. Any Outpost access grants for this connection/VM will be removed.</p><Field label={`Type ${vm.name} to confirm`}><Input value={deleteName} onChange={e => setDeleteName(e.target.value)} disabled={busy} /></Field><label className="flex items-start gap-2 text-xs text-ink-300"><input type="checkbox" checked={removeSnapshotMetadata} onChange={e => setRemoveSnapshotMetadata(e.target.checked)} disabled={busy} /> Also remove libvirt snapshot metadata (required if it blocks deletion; snapshot data in disk files remains)</label><ErrorText>{error}</ErrorText><div className="flex justify-end gap-2"><Button disabled={busy} onClick={() => setDeleteOpen(false)}>Cancel</Button><Button variant="danger" disabled={busy || deleteName !== vm.name} onClick={async () => { setBusy(true); setError(''); try { await api.delete(`/libvirt/vms/${vm.uuid}`, { confirmName: deleteName, removeSnapshotMetadata }); setDeleteOpen(false); toast.success('VM entry removed; disk files retained'); await onRefresh(); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); } }}>Delete entry and retain disks</Button></div></div></Modal>
  {admin && !vm.persistent && <Notice tone="warning"><p>This is a transient guest. Shutting it down can remove its definition from libvirt. Keep its definition to retain it after shutdown and enable next-boot configuration.</p><Button className="mt-3" disabled={busy} onClick={keepDefinition}>Keep VM definition</Button></Notice>}
  <VmPreview uuid={vm.uuid} active={['running', 'paused', 'in shutdown', 'pmsuspended'].includes(vm.state)} />
  {can('console') && <VmConsole uuid={vm.uuid} active={['running', 'paused'].includes(vm.state)} />}
  {can('snapshots') && <VmSnapshots uuid={vm.uuid} stopped={stopped && vm.persistent} onRefresh={onRefresh} />}
  {can('configure') && <Card className="space-y-4 p-5"><h3 className="font-medium text-ink-100">Next-boot configuration</h3><p className="text-xs text-ink-400">Shut down a persistent VM to edit. Increase CPU or memory ceilings in XML if necessary.</p><div className="grid gap-4 sm:grid-cols-2"><Field label="Memory (MB)"><Input type="number" min={128} max={vm.maxMemoryMb} value={memory} disabled={busy || !stopped || !vm.persistent} onChange={(e) => setMemory(Number(e.target.value))} /></Field><Field label="Virtual CPUs"><Input type="number" min={1} max={4096} value={cpus} disabled={busy || !stopped || !vm.persistent} onChange={(e) => setCpus(Number(e.target.value))} /></Field></div><label className="flex items-center gap-2 text-sm text-ink-200"><input type="checkbox" checked={autostart} disabled={busy || !stopped || !vm.persistent} onChange={(e) => setAutostart(e.target.checked)} />Start with the hypervisor</label><Button variant="primary" disabled={busy || !stopped || !vm.persistent} onClick={save}>{busy ? 'Working…' : 'Save configuration'}</Button></Card>}
  {admin && <Card className="space-y-4 p-5"><div className="flex items-center justify-between gap-3"><h3 className="font-medium text-ink-100">Domain XML</h3><Button disabled={busy || xmlLoading} onClick={loadXml}>{xmlLoading ? 'Loading…' : xml === null ? 'Load XML' : 'Reload XML'}</Button></div><p className="text-xs text-ink-400">Advanced disk, network, boot and device configuration. The VM must be stopped to save. Keep its UUID unchanged. No disks are created or deleted.</p>{xml !== null && <><textarea aria-label="VM domain XML" className={textareaClass} spellCheck={false} value={xml} onChange={(e) => { setXml(e.target.value); setXmlDirty(true); }} disabled={busy || !stopped || !vm.persistent} /><Button variant="primary" disabled={busy || !stopped || !vm.persistent || !xmlDirty} onClick={saveXml}>Save XML</Button></>}</Card>}
  {admin && <><VmDevices uuid={vm.uuid} stopped={stopped && vm.persistent} /><VmInfrastructure uuid={vm.uuid} stopped={stopped && vm.persistent} /><VmMigration uuid={vm.uuid} /></>}
  </div>;
}

function VmPreview({ uuid, active }: { uuid: string; active: boolean }) {
  const [image, setImage] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [auto, setAuto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [updated, setUpdated] = useState<string | null>(null);
  const imageRef = useRef<string | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const request = useRef<AbortController | null>(null);
  const capture = useCallback(async () => {
    if (!active || inFlight.current || document.hidden) return;
    inFlight.current = true; setBusy(true);
    const controller = new AbortController(); request.current = controller;
    try {
      const response = await fetch(`/api/libvirt/vms/${uuid}/preview`, { headers: { Authorization: `Bearer ${getToken() ?? ''}` }, cache: 'no-store', signal: controller.signal });
      if (!response.ok) { const result = await response.json(); throw new Error(result.error ?? 'Preview failed'); }
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      const next = URL.createObjectURL(blob);
      if (imageRef.current) URL.revokeObjectURL(imageRef.current);
      imageRef.current = next; setImage(next); setUpdated(new Date().toLocaleTimeString()); setError('');
    } catch (err) { if (!controller.signal.aborted) { setError(errorMessage(err)); setAuto(false); } }
    finally { inFlight.current = false; if (!controller.signal.aborted) setBusy(false); }
  }, [uuid, active]);
  useEffect(() => { if (active) void capture(); }, [active, capture]);
  useEffect(() => () => { request.current?.abort(); if (imageRef.current) { URL.revokeObjectURL(imageRef.current); imageRef.current = null; } }, [uuid]);
  useEffect(() => { if (!auto || !active) return; return setVisibleInterval(capture, 5000); }, [auto, active, capture]);
  return <Card className="space-y-3 p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-medium text-ink-100">Display preview</h3><p className="mt-1 text-xs text-ink-400">Read-only screenshot{updated ? ` · captured ${updated}` : ''}</p></div><div className="flex flex-wrap items-center gap-3"><label className="flex items-center gap-2 text-xs text-ink-300"><input type="checkbox" checked={auto} disabled={!active} onChange={(e) => setAuto(e.target.checked)} />Refresh every 5 seconds</label><Button disabled={!active || busy} onClick={capture}>{busy ? 'Capturing…' : 'Capture'}</Button><Button disabled={!image || !active} onClick={() => { frame.current?.requestFullscreen?.().catch((err) => setError(errorMessage(err))); }}>Fullscreen</Button></div></div><div ref={frame} className="flex min-h-48 items-center justify-center overflow-hidden rounded-xl bg-black p-2">{!active ? <p className="p-8 text-sm text-ink-400">Start the VM to preview its display.</p> : image ? <img src={image} alt="Virtual machine display preview" className="max-h-[65vh] max-w-full object-contain" /> : <p className="p-8 text-sm text-ink-400">{busy ? 'Capturing the guest display…' : 'No display captured yet.'}</p>}</div><ErrorText>{error}</ErrorText><p className="text-xs text-ink-500">Requires a graphics device supported by the hypervisor screenshot API. Keyboard and mouse input are not forwarded.</p></Card>;
}
