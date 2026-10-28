import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { Button, Card, ErrorText, Field, Input, Select } from '../components/ui.js';
import { useConfirm } from '../components/ConfirmDialog.js';
import { setVisibleInterval } from '../lib/perf.js';

const message = (error: unknown) => error instanceof Error ? error.message : 'Request failed';
export function VmConsole({ uuid, active }: { uuid: string; active: boolean }) {
  const [protocol, setProtocol] = useState<'vnc' | 'spice'>('vnc');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState('Disconnected');
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const screen = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const client = useRef<{ stop: () => void; cad: () => void } | null>(null);
  const generation = useRef(0);
  const id = `vm-screen-${useId().replace(/:/g, '')}`;
  function disconnect() { generation.current++; client.current?.stop(); client.current = null; screen.current?.replaceChildren(); if (screen.current) screen.current.style.height = ''; setConnected(false); setPassword(''); setStatus('Disconnected'); }
  useEffect(() => () => { generation.current++; client.current?.stop(); }, [uuid]);
  useEffect(() => { if (!active) disconnect(); }, [active]);
  async function connect() {
    disconnect(); const current = generation.current;
    // Capture before clearing the form; the display password goes only to the guest protocol.
    const credential = password; setError(''); setStatus('Connecting'); setConnected(true);
    try {
      const { ticket } = await api.post<{ ticket: string }>(`/libvirt/vms/${uuid}/console-ticket`, { protocol });
      if (current !== generation.current || !screen.current) return;
      const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/vm-console?ticket=${encodeURIComponent(ticket)}`;
      if (protocol === 'vnc') {
        const { default: RFB } = await import('@novnc/novnc');
        if (current !== generation.current || !screen.current) return;
        const rfb = new RFB(screen.current, url, { credentials: { password: credential } });
        rfb.scaleViewport = true; rfb.resizeSession = true;
        rfb.addEventListener('connect', () => { if (current === generation.current) setStatus('Connected'); });
        rfb.addEventListener('credentialsrequired', () => { if (current === generation.current) { setError('A display password is required. Disconnect and enter it before reconnecting.'); disconnect(); } });
        rfb.addEventListener('securityfailure', () => { if (current === generation.current) setError('Display authentication failed'); });
        rfb.addEventListener('disconnect', () => { if (current === generation.current) disconnect(); });
        client.current = { stop: () => rfb.disconnect(), cad: () => rfb.sendCtrlAltDel() };
      } else {
        const { SpiceMainConn, sendCtrlAltDel } = await import('@spice-project/spice-html5');
        if (current !== generation.current || !screen.current) return;
        const spice = new SpiceMainConn({ uri: url, password: credential, screen_id: id, onsuccess: () => { if (current === generation.current) setStatus('Connected'); }, onerror: err => { if (current === generation.current) { setError(message(err)); disconnect(); } } });
        client.current = { stop: () => spice.stop(), cad: () => sendCtrlAltDel(spice) };
      }
    } catch (err) { if (current === generation.current) { setError(message(err)); disconnect(); } }
  }
  return <Card className="space-y-4 p-5"><h3 className="font-medium text-ink-100">Interactive console</h3><p role="status" className="text-xs text-ink-400">{status}. Click the display to send keyboard and mouse input.</p><div className="flex flex-wrap items-end gap-3"><Field label="Protocol"><Select value={protocol} disabled={connected} onChange={e => setProtocol(e.target.value as 'vnc' | 'spice')}><option value="vnc">VNC</option><option value="spice">SPICE</option></Select></Field><Field label="Display password (if configured)"><Input type="password" autoComplete="off" value={password} disabled={connected} onChange={e => setPassword(e.target.value)} /></Field><Button disabled={!active} onClick={connected ? disconnect : connect}>{connected ? 'Disconnect' : 'Connect'}</Button><Button disabled={status !== 'Connected'} onClick={() => client.current?.cad()}>Ctrl+Alt+Delete</Button><Button disabled={!connected} onClick={() => frame.current?.requestFullscreen().catch(err => setError(message(err)))}>Fullscreen</Button></div><div ref={frame} className="overflow-auto rounded-xl bg-black"><div ref={screen} id={id} className="min-h-72 h-[60vh] min-w-0" /></div><ErrorText>{error}</ErrorText><p className="text-xs text-ink-500">Display traffic passes through Outpost. Remote hosts use the service account's verified SSH connection. TCP displays must listen on loopback or a wildcard address; Unix sockets and display TLS are not supported by this browser bridge.</p></Card>;
}

export function VmSnapshots({ uuid, stopped, onRefresh }: { uuid: string; stopped: boolean; onRefresh: () => Promise<void> }) {
  const [names, setNames] = useState<string[]>([]), [name, setName] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const confirm = useConfirm();
  async function load() { try { setNames((await api.get<{ snapshots: string[] }>(`/libvirt/vms/${uuid}/snapshots`)).snapshots); setError(''); } catch (err) { setError(message(err)); } }
  useEffect(() => { void load(); }, [uuid]);
  async function action(action: string, name: string) {
    if (action !== 'create' && !await confirm({ title: `${action === 'revert' ? 'Restore' : 'Delete'} snapshot ${name}?`, message: action === 'revert' ? 'Replaces guest disk state with this snapshot. Later guest data will be lost.' : 'Permanently removes this restore point.', tone: 'danger' })) return;
    setBusy(true); setError('');
    try { await api.post(`/libvirt/vms/${uuid}/snapshots`, { action, name }); setName(''); await load(); await onRefresh(); } catch (err) { setError(message(err)); } finally { setBusy(false); }
  }
  return <Card className="space-y-3 p-5"><h3 className="font-medium text-ink-100">Snapshots</h3><p className="text-xs text-ink-400">Shut down a persistent VM first. Internal snapshots need disks/storage supported by libvirt (normally qcow2). Snapshots share the original storage and are not independent backups.</p><div className="flex gap-2"><Input aria-label="Snapshot name" value={name} onChange={e => setName(e.target.value)} placeholder="before-update" /><Button disabled={!stopped || busy || !name} onClick={() => action('create', name)}>Create snapshot</Button><Button disabled={busy} onClick={load}>Refresh</Button></div>{names.map(n => <div key={n} className="flex flex-wrap items-center gap-2 text-sm text-ink-200"><span className="mr-auto">{n}</span><Button disabled={!stopped || busy} onClick={() => action('revert', n)}>Restore</Button><Button variant="danger" disabled={!stopped || busy} onClick={() => action('delete', n)}>Delete</Button></div>)}<ErrorText>{error}</ErrorText></Card>;
}

interface MigrationJob { id: string; uuid: string; destination: string; status: string; error?: string }
export function VmMigration({ uuid }: { uuid: string }) {
  const [destination, setDestination] = useState(''), [live, setLive] = useState(true), [copyStorage, setCopyStorage] = useState(false), [undefineSource, setUndefineSource] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false), [jobs, setJobs] = useState<MigrationJob[]>([]);
  const confirm = useConfirm();
  async function load() { try { setJobs((await api.get<{ jobs: MigrationJob[] }>('/libvirt/migrations')).jobs); } catch (err) { setError(message(err)); } }
  useEffect(() => { void load(); return setVisibleInterval(load, 3000); }, []);
  async function migrate() {
    if (!await confirm({ title: 'Migrate virtual machine?', message: `Destination: ${destination}. ${live ? 'The running guest will move to the destination host.' : 'Only the stopped VM definition is transferred; disks must already be available at the destination.'} ${undefineSource ? 'The source definition will be removed after success.' : 'The source definition is retained. Do not start both copies against the same disks.'}` })) return;
    setBusy(true); setError('');
    try { await api.post(`/libvirt/vms/${uuid}/migrate`, { destination, live, copyStorage, undefineSource }); await load(); } catch (err) { setError(message(err)); } finally { setBusy(false); }
  }
  return <Card className="space-y-3 p-5"><h3 className="font-medium text-ink-100">Migration</h3><Field label="Destination libvirt URI"><Input value={destination} placeholder="qemu+ssh://user@destination/system" onChange={e => setDestination(e.target.value)} /></Field><div className="flex flex-wrap gap-4 text-xs text-ink-300"><label><input type="checkbox" checked={live} onChange={e => { setLive(e.target.checked); if (!e.target.checked) setCopyStorage(false); }} /> Live migration</label><label><input type="checkbox" checked={copyStorage} disabled={!live} onChange={e => setCopyStorage(e.target.checked)} /> Copy non-shared disks</label><label><input type="checkbox" checked={undefineSource} onChange={e => setUndefineSource(e.target.checked)} /> Remove source definition after success</label></div><p className="text-xs text-ink-400">Hosts need compatible CPUs, networks and storage paths. SSH keys/known hosts must work for the service account. Live disk copying may require destination images/pools prepared in advance. A one-hour live timeout suspends the guest to finish migration. Jobs continue when this page closes.</p><Button disabled={busy || !destination || jobs.some(j => j.status === 'running')} onClick={migrate}>Start migration</Button>{jobs.filter(j => j.uuid === uuid).map(j => <div key={j.id} className="space-y-2"><p className="break-all text-xs text-ink-300">{j.status}: {j.destination}{j.error ? ` — ${j.error}` : ''}</p>{j.status === 'running' && <Button variant="danger" onClick={async () => { if (!await confirm({ title: 'Abort migration?', message: 'Ask libvirt to abort this migration. Check guest state on both hosts afterward.', tone: 'danger' })) return; try { await api.post(`/libvirt/migrations/${j.id}/abort`); await load(); } catch (err) { setError(message(err)); } }}>Abort migration</Button>}</div>)}<ErrorText>{error}</ErrorText></Card>;
}
