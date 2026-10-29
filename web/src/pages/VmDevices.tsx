import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { Badge, Button, Card, ErrorText, Field, Input, Select } from '../components/ui.js';
import { VmIsoSelect } from '../components/VmImageLibrary.js';
import { VmNicFields, type NicOptions } from '../components/VmNicFields.js';
import { useConfirm } from '../components/ConfirmDialog.js';
interface Nic extends NicOptions { network: string; type: string; boot: number | null; originalMac?: string }
interface Devices { disks: { target: string; source: string; device: string; boot: number | null }[]; interfaces: Nic[] }
export function VmDevices({ uuid, stopped }: { uuid: string; stopped: boolean }) {
  const [data, setData] = useState<Devices>({ disks: [], interfaces: [] }), [networks, setNetworks] = useState<string[]>([]);
  const [iso, setIso] = useState(''), [error, setError] = useState(''), [feedback, setFeedback] = useState(''), [busy, setBusy] = useState(false);
  const [nic, setNic] = useState<NicOptions>({ model: 'virtio', mac: '', link: 'up' }), [network, setNetwork] = useState('');
  const [cdTarget, setCdTarget] = useState('sdb');
  const confirm = useConfirm();
  async function load() {
    try { const [devices, infra] = await Promise.all([api.get<Devices>(`/libvirt/vms/${uuid}/devices`), api.get<{ networks: { name: string }[] }>('/libvirt/infrastructure')]); setData({ ...devices, interfaces: devices.interfaces.map(n => ({ ...n, originalMac: n.mac })) }); setNetworks(infra.networks.map(n => n.name)); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not load VM devices'); }
  }
  useEffect(() => { void load(); }, [uuid, stopped]);
  async function run(operation: string, body: unknown, question?: string) {
    if (question && !await confirm({ title: 'Change VM devices?', message: question })) return;
    setBusy(true); setError(''); setFeedback('');
    try { await api.post(`/libvirt/vms/${uuid}/${operation}`, body); setFeedback('VM devices saved. Changes apply at the next start.'); }
    catch (err) { setError(err instanceof Error ? err.message : 'Device change failed'); }
    finally { await load(); setBusy(false); }
  }
  return <Card className="space-y-5 p-5"><div><h3 className="font-medium text-ink-100">Disks, installation media and boot</h3><p className="mt-1 text-xs text-ink-400">Shut down the VM to edit devices. Selecting a boot device makes it first in the boot order; it does not install a bootloader or OS.</p></div>
    <fieldset disabled={busy || !stopped} className="space-y-4">
      <VmIsoSelect value={iso} onChange={setIso} disabled={busy || !stopped} /><Field label="ISO path on hypervisor"><Input value={iso} onChange={e => setIso(e.target.value)} placeholder="/var/lib/libvirt/isos/linux.iso" /></Field>
      <div className="flex flex-wrap items-end gap-3"><Field label="New CD-ROM target"><Input value={cdTarget} onChange={e => setCdTarget(e.target.value)} placeholder="sdb" /></Field><Button onClick={() => run('media', { target: cdTarget, iso, add: true })}>Add CD-ROM drive</Button></div>
      {data.disks.map(d => <div key={d.target} className="space-y-3 rounded-2xl border border-surface-700 p-4"><div className="flex flex-wrap items-center gap-2"><h4 className="font-medium text-ink-200">{d.target}</h4><Badge>{d.device === 'cdrom' ? 'CD-ROM' : 'Disk'}</Badge>{d.boot && <Badge tone="blue">Boot priority {d.boot}</Badge>}</div><p className="break-all text-xs text-ink-400">{d.source || 'No media inserted'}</p><div className="flex flex-wrap gap-2"><Button disabled={d.device === 'cdrom' && !d.source} onClick={() => run('boot', { target: d.target })}>Boot from this device</Button>{d.device === 'cdrom' ? <><Button disabled={!iso} onClick={() => run('media', { target: d.target, iso })}>Insert / replace ISO</Button><Button disabled={!d.source} onClick={() => run('media', { target: d.target, iso: '' })}>Eject ISO</Button></> : <Button onClick={() => run('detach-disk', { target: d.target }, `Detach ${d.target}? Its image file is retained. The VM may no longer boot if this is its system disk.`)}>Detach disk</Button>}</div></div>)}
      <h3 className="font-medium text-ink-100">Network interfaces</h3>
      {data.interfaces.map(n => <div key={n.originalMac} className="space-y-3 rounded-2xl border border-surface-700 p-4"><p className="text-sm text-ink-200">{n.mac} · {n.network || n.type}{n.boot ? ` · boot priority ${n.boot}` : ''}</p>{n.type === 'network' ? <><div className="grid gap-3 sm:grid-cols-2"><Field label="Interface network"><Select value={n.network} onChange={e => setData({ ...data, interfaces: data.interfaces.map(v => v.originalMac === n.originalMac ? { ...v, network: e.target.value } : v) })}>{[...new Set([n.network, ...networks])].map(name => <option key={name}>{name}</option>)}</Select></Field><VmNicFields value={n} onChange={value => setData({ ...data, interfaces: data.interfaces.map(v => v.originalMac === n.originalMac ? { ...v, ...value } : v) })} /></div><div className="flex flex-wrap gap-2"><Button onClick={() => run('interface', n)}>Save interface</Button><Button onClick={() => run('boot', { mac: n.originalMac })}>Boot from network</Button><Button onClick={() => run('interface', { mac: n.originalMac, remove: true }, 'Remove this network interface?')}>Remove interface</Button></div></> : <p className="text-xs text-ink-400">Use the XML editor to customize this interface type.</p>}</div>)}
      <div className="space-y-3 rounded-2xl bg-surface-900 p-4"><h4 className="text-sm font-medium text-ink-200">Attach network interface</h4><div className="grid gap-3 sm:grid-cols-2"><Field label="New interface network"><Select value={network} onChange={e => setNetwork(e.target.value)}><option value="">Choose network</option>{networks.map(n => <option key={n}>{n}</option>)}</Select></Field><VmNicFields value={nic} onChange={setNic} /></div><Button disabled={!network} onClick={() => run('networks', { network, ...nic })}>Attach interface</Button></div>
    </fieldset><Button disabled={busy} onClick={load}>Refresh devices</Button>{feedback && <p role="status" className="text-sm text-ink-300">{feedback}</p>}<ErrorText>{error}</ErrorText>
  </Card>;
}
