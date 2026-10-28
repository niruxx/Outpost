import { AdvancedDeviceControls, AdvancedOperationFields, LvmPanel, ADVANCED_TITLES, type AdvancedAction, type AdvancedFields, type LvmState } from './AdvancedStorage.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Layout, PageHeader } from '../components/Layout.js';
import { Badge, Button, Card, ErrorText, Field, Input, Modal, Notice, Select, Spinner } from '../components/ui.js';
import { Icon } from '../components/icons.js';
import { api, ApiError } from '../api/client.js';
import { setVisibleInterval } from '../lib/perf.js';
import type { StoragePermission } from '../api/types.js';

interface Device {
  path: string; kernel: string; id: string; type: string; size: number; model: string;
  serial: string; filesystem: string; label: string; uuid: string; transport: string;
  critical?: boolean; readOnly?: boolean;
  mountpoints: string[]; children: Device[]; protected: boolean; reason: string | null;
}
type Action = 'mount' | 'unmount' | 'automount' | 'format' | 'wipe' | 'partition' | AdvancedAction;
interface Operation extends AdvancedFields { action: Action; device: string; mountpoint?: string; persistent?: boolean; enabled?: boolean; readOnly?: boolean; filesystem?: string; label?: string }
interface Job { id: string; action: string; device: string; state: 'running' | 'done' | 'failed'; message: string; createdAt: string }
interface Overview {
  lvm?: LvmState;
  available: boolean; error: string | null; devices: Device[]; busy: boolean; permissions: StoragePermission[];
  fstab: { source: string; target: string; filesystem: string; options: string; managed: boolean }[]; jobs: Job[];
}
interface Plan { ticket: string; device: Device; operation: Operation; confirmation: string; destructive: boolean; explanation: string }
const flatten = (nodes: Device[]): Device[] => nodes.flatMap((node) => [node, ...flatten(node.children)]);
const bytes = (size: number) => size >= 1024 ** 4 ? `${(size / 1024 ** 4).toFixed(1)} TiB` : size >= 1024 ** 3 ? `${(size / 1024 ** 3).toFixed(1)} GiB` : `${(size / 1024 ** 2).toFixed(0)} MiB`;
const message = (err: unknown) => err instanceof Error ? err.message : 'Storage request failed';
const TITLES: Record<Action, string> = { ...ADVANCED_TITLES, mount: 'Mount filesystem', unmount: 'Unmount filesystem', automount: 'Boot mount settings', format: 'Format filesystem', wipe: 'Wipe disk signatures', partition: 'Initialize GPT disk' };

export function StoragePage() {
  const [state, setState] = useState<Overview | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [operation, setOperation] = useState<Operation | null>(null);
  const loadingRef = useRef(false);
  const load = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const result = await api.get<Overview>('/storage'); setState(result); setError('');
      setSelectedPath((current) => flatten(result.devices).some((d) => d.path === current) ? current : result.devices[0]?.path ?? null);
    } catch (err) {
      setError(message(err));
      if (err instanceof ApiError && err.status === 403) { setState(null); setSelectedPath(null); setOperation(null); }
    } finally { setLoading(false); loadingRef.current = false; }
  }, []);
  useEffect(() => { void load(); return setVisibleInterval(load, 5000); }, [load]);
  const device = state ? flatten(state.devices).find((d) => d.path === selectedPath) : null;
  const mounted = !!device && flatten([device]).some((d) => d.mountpoints.length > 0);
  const can = (permission: StoragePermission) => !!state?.available && !state.busy && !!state.permissions.includes(permission) && !!device && !device.protected;
  function open(action: Action) {
    if (!device) return;
    const current = state?.fstab.find((entry) => entry.source === `UUID=${device.uuid}` || entry.source === device.path);
    setOperation({ action, device: device.path, mountpoint: current?.target ?? device.mountpoints[0] ?? `/mnt/outpost/${device.kernel}`, persistent: false, enabled: current?.managed ?? true, readOnly: current?.options.split(',').includes('ro') ?? false, filesystem: 'ext4', label: '', vg: state?.lvm?.pvs.find((p) => p.path === device.path)?.vg || undefined });
  }
  return <Layout><div className="mx-auto max-w-7xl space-y-5 p-4 sm:p-8">
    <PageHeader title="Storage" subtitle="Disks, filesystems, mounts and persistent boot mounts on this host." action={<Button onClick={load}><Icon name="refresh" className="h-4 w-4" />Refresh</Button>} />
    <ErrorText>{error}</ErrorText>{loading && <Spinner />}
    {state && !state.available && <Notice tone="warning"><p>{state.error}</p><p className="mt-2">This feature requires Linux disk utilities and the privileged Outpost storage helper. Existing instances and backups continue to work.</p></Notice>}
    {state?.busy && <Notice tone="info">A storage operation is running. Changes are temporarily disabled; do not disconnect its disk.</Notice>}
    {state?.available && <div className="grid items-start gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
      <div className="space-y-3">{state.devices.map((disk) => <Card key={disk.path} className="overflow-hidden p-2"><DeviceTree device={disk} depth={0} selected={selectedPath} onSelect={setSelectedPath} /></Card>)}{state.devices.length === 0 && <Card className="p-5 text-sm text-ink-400">No block devices found.</Card>}</div>
      {device && <div className="space-y-5"><Card className="space-y-4 p-5">
        <div className="flex flex-wrap items-center gap-2"><Icon name="storage" className="h-6 w-6 text-accent-400" /><h2 className="break-all text-xl font-medium text-ink-100">{device.path}</h2><Badge tone="neutral">{device.type}</Badge>{device.protected && <Badge tone="yellow">Protected</Badge>}</div>
        <dl className="grid gap-4 text-sm sm:grid-cols-2">{[
          ['Capacity', bytes(device.size)], ['Model', device.model || '—'], ['Serial', device.serial || 'Not reported'], ['Filesystem', device.filesystem || 'None'], ['Label', device.label || '—'], ['UUID', device.uuid || '—'], ['Mountpoints', device.mountpoints.join(', ') || 'Not mounted'], ['Connection', device.transport || '—'],
        ].map(([label, value]) => <div key={label}><dt className="text-xs text-ink-500">{label}</dt><dd className="mt-1 break-all text-ink-200">{value}</dd></div>)}</dl>
        {device.reason && <Notice tone="info">{device.reason}. Basic disk actions are blocked. Eligible encryption/LVM operations are checked separately.</Notice>}
        <div className="flex flex-wrap gap-2">
          <Button disabled={!can('mount') || !!device.mountpoints.length || !device.filesystem} onClick={() => open('mount')}>Mount</Button>
          <Button disabled={!can('mount') || device.mountpoints.length !== 1 || device.mountpoints[0] === '[SWAP]'} onClick={() => open('unmount')}>Unmount</Button>
          <Button disabled={!can('automount') || !device.uuid || !device.filesystem} onClick={() => open('automount')}>Boot mount</Button>
          <Button variant="danger" disabled={!can('format') || mounted || !!device.children.length} onClick={() => open('format')}>Format</Button>
          <Button variant="danger" disabled={!can('wipe') || mounted} onClick={() => open('wipe')}>Wipe signatures</Button>
          <Button variant="danger" disabled={!can('partition') || mounted || device.type !== 'disk' || !!device.children.length || !!device.filesystem} onClick={() => open('partition')}>Create GPT partition</Button>
        </div><p className="text-xs text-ink-500">Root/system and Outpost data disks are protected. Destructive actions require a fresh device preview and typed confirmation. Wiping signatures does not securely erase disk contents.</p>
        <AdvancedDeviceControls device={device} permissions={state.permissions} busy={state.busy} lvm={state.lvm} onOpen={open} />
      </Card><Card className="space-y-3 p-5"><h3 className="font-medium text-ink-100">Persistent mounts · /etc/fstab</h3>{state.fstab.filter((e) => e.source === device.path || (!!device.uuid && e.source === `UUID=${device.uuid}`)).map((entry) => <div key={entry.source + entry.target} className="rounded-xl bg-surface-900 p-3 text-xs"><p className="break-all font-mono text-ink-200">{entry.target}</p><p className="mt-1 break-all text-ink-400">{entry.filesystem} · {entry.options}</p><p className="mt-1 text-ink-500">{entry.managed ? 'Managed by Outpost' : 'Existing system entry; edit outside Outpost'}</p></div>)}<p className="text-xs text-ink-400">Boot mounts use filesystem UUIDs, nofail, nodev and nosuid. Unmounting does not remove the boot entry. Remove it with Boot mount before formatting or wiping.</p></Card></div>}
    </div>}
    {state?.available && <LvmPanel lvm={state.lvm} permissions={state.permissions} busy={state.busy} onOpen={setOperation} />}
    {!!state?.jobs.length && <Card className="space-y-3 p-5"><h2 className="font-medium text-ink-100">Recent storage operations</h2>{state.jobs.map((job) => <div key={job.id} className="rounded-xl bg-surface-900 p-3"><div className="flex flex-wrap items-center gap-2"><span className="text-sm text-ink-200">{TITLES[job.action as Action] ?? job.action} · {job.device}</span><Badge tone={job.state === 'done' ? 'green' : job.state === 'failed' ? 'red' : 'blue'}>{job.state}</Badge></div><p className="mt-2 break-words text-xs text-ink-400">{job.message}</p></div>)}</Card>}
    <OperationModal operation={operation} permissions={state?.permissions ?? []} onClose={() => setOperation(null)} onStarted={() => { setOperation(null); void load(); }} />
  </div></Layout>;
}

function DeviceTree({ device, depth, selected, onSelect }: { device: Device; depth: number; selected: string | null; onSelect: (device: string) => void }) {
  return <><button className={`w-full rounded-xl p-3 text-left ${selected === device.path ? 'bg-secondary-container text-secondary-on-container' : 'text-ink-300 hover:bg-surface-700'}`} style={{ paddingLeft: `${12 + Math.min(depth, 5) * 14}px` }} aria-pressed={selected === device.path} onClick={() => onSelect(device.path)}><span className="block truncate text-sm font-medium">{device.path}</span><span className="mt-1 block text-xs opacity-75">{bytes(device.size)} · {device.filesystem || device.type}{device.mountpoints.length ? ' · mounted' : ''}{device.protected ? ' · protected' : ''}</span></button>{device.children.map((child) => <DeviceTree key={child.path} device={child} depth={depth + 1} selected={selected} onSelect={onSelect} />)}</>;
}
function OperationModal({ operation, permissions, onClose, onStarted }: { operation: Operation | null; permissions: StoragePermission[]; onClose: () => void; onStarted: () => void }) {
  const [draft, setDraft] = useState<Operation | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [secrets, setSecrets] = useState<{ passphrase?: string; newPassphrase?: string }>({});
  const [repeatPassphrase, setRepeatPassphrase] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { setDraft(operation); setPlan(null); setConfirmation(''); setError(''); setSecrets({}); setRepeatPassphrase(''); }, [operation]);
  async function preview() {
    setBusy(true); setError('');
    try { setPlan(await api.post<Plan>('/storage/preview', draft)); }
    catch (err) { setError(message(err)); } finally { setBusy(false); }
  }
  async function execute() {
    if (!plan) return;
    setBusy(true); setError('');
    try { await api.post('/storage/execute', { ticket: plan.ticket, confirmation: plan.destructive ? confirmation : plan.confirmation, secrets }); onStarted(); }
    catch (err) { setError(message(err)); } finally { setBusy(false); setSecrets({}); setRepeatPassphrase(''); }
  }
  const needsCurrent = !!draft && ['luksOpen', 'luksPassphrase', 'luksGrow'].includes(draft.action);
  const needsNew = !!draft && ['luksFormat', 'luksPassphrase'].includes(draft.action);
  const secretsReady = (!needsCurrent || !!secrets.passphrase) && (!needsNew || ((secrets.newPassphrase?.length ?? 0) >= 8 && secrets.newPassphrase === repeatPassphrase));
  return <Modal open={!!operation} onClose={() => !busy && onClose()} title={draft ? TITLES[draft.action] : 'Storage operation'} size="lg">
    {draft && <div className="space-y-4"><p className="font-mono text-sm text-ink-100">{draft.device}</p>
      {!plan && <>
        <AdvancedOperationFields op={draft} busy={busy} patch={(patch) => setDraft({ ...draft, ...patch })} />
        {['mount', 'automount'].includes(draft.action) && <><Field label="Mount folder"><Input value={draft.mountpoint ?? ''} disabled={busy} onChange={(e) => setDraft({ ...draft, mountpoint: e.target.value })} placeholder="/mnt/outpost/data" /></Field><p className="text-xs text-ink-500">Use an empty dedicated folder under /mnt, /media or /srv. Existing folders and parents must be root-owned and not writable by other users.</p><label className="flex items-center gap-2 text-sm text-ink-200"><input type="checkbox" checked={draft.readOnly ?? false} onChange={(e) => setDraft({ ...draft, readOnly: e.target.checked })} disabled={busy} />Read-only filesystem</label></>}
        {draft.action === 'mount' && permissions.includes('automount') && <label className="flex items-center gap-2 text-sm text-ink-200"><input type="checkbox" checked={draft.persistent ?? false} onChange={(e) => setDraft({ ...draft, persistent: e.target.checked })} disabled={busy} />Also mount at boot through /etc/fstab</label>}
        {draft.action === 'automount' && <label className="flex items-center gap-2 text-sm text-ink-200"><input type="checkbox" checked={draft.enabled ?? false} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} disabled={busy} />Enable mount at boot (uncheck to remove the Outpost entry)</label>}
        {draft.action === 'format' && <><Field label="New filesystem"><Select value={draft.filesystem} disabled={busy} onChange={(e) => setDraft({ ...draft, filesystem: e.target.value, label: '' })}><option value="ext4">ext4</option><option value="xfs">XFS</option><option value="btrfs">Btrfs</option><option value="vfat">FAT32</option><option value="exfat">exFAT</option></Select></Field><Field label="Filesystem label (optional)"><Input value={draft.label ?? ''} disabled={busy} onChange={(e) => setDraft({ ...draft, label: e.target.value })} /></Field><Notice tone="warning">Formatting destroys the selected filesystem’s existing data. Copy anything you need elsewhere first.</Notice></>}
        {draft.action === 'wipe' && <Notice tone="warning">This removes filesystem signatures and partition tables from the selected device and its partitions. It makes existing data inaccessible. It does not securely overwrite the disk.</Notice>}
        {draft.action === 'partition' && <Notice tone="warning">Creates a GPT partition table and one Linux partition on the selected empty disk. Format the new partition afterwards.</Notice>}
        {draft.action === 'unmount' && <p className="text-sm text-ink-300">Close files and stop programs using the filesystem first. This does not remove its boot-mount entry.</p>}
      </>}
      {plan && <><Notice tone={plan.destructive ? 'warning' : 'info'}>{plan.explanation}</Notice><div className="rounded-xl bg-surface-900 p-3 text-sm text-ink-300"><p>{plan.device.path} · {bytes(plan.device.size)} · {plan.device.model || plan.device.type}</p><p className="mt-1 text-xs text-ink-500">Serial: {plan.device.serial || 'not reported'}{draft.mountpoint ? ` · Mount: ${draft.mountpoint}` : ''}</p></div>{plan.destructive && <Field label={`Type ${plan.confirmation} to confirm`}><Input autoComplete="off" value={confirmation} disabled={busy} onChange={(e) => setConfirmation(e.target.value)} /></Field>}<p className="text-xs text-ink-500">The preview expires after two minutes. Device identity and permissions are checked again when the action starts.</p></>}
      {plan && <pre className="overflow-auto rounded-xl bg-surface-900 p-3 text-xs text-ink-300">{JSON.stringify(plan.operation, null, 2)}</pre>}
      {plan && needsCurrent && <Field label="Current LUKS passphrase"><Input type="password" autoComplete="off" value={secrets.passphrase ?? ''} disabled={busy} onChange={(e) => setSecrets({ ...secrets, passphrase: e.target.value })} /></Field>}
      {plan && needsNew && <><Field label="New LUKS passphrase"><Input type="password" autoComplete="new-password" value={secrets.newPassphrase ?? ''} disabled={busy} onChange={(e) => setSecrets({ ...secrets, newPassphrase: e.target.value })} /></Field><Field label="Repeat new passphrase"><Input type="password" autoComplete="new-password" value={repeatPassphrase} disabled={busy} onChange={(e) => setRepeatPassphrase(e.target.value)} /></Field></>}
      <ErrorText>{error}</ErrorText><div className="flex flex-wrap justify-end gap-2"><Button disabled={busy} onClick={onClose}>Cancel</Button>{plan ? <><Button disabled={busy} onClick={() => { setPlan(null); setConfirmation(''); }}>Edit / refresh preview</Button><Button variant={plan.destructive ? 'danger' : 'primary'} disabled={busy || !secretsReady || (plan.destructive && confirmation !== plan.confirmation)} onClick={execute}>{busy ? 'Starting…' : 'Apply operation'}</Button></> : <Button variant="primary" disabled={busy} onClick={preview}>{busy ? 'Checking device…' : 'Preview operation'}</Button>}</div>
    </div>}
  </Modal>;
}
