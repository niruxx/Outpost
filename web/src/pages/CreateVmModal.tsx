import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { VmIsoSelect } from '../components/VmImageLibrary.js';
import { VmNicFields, type NicOptions } from '../components/VmNicFields.js';
import { Button, ErrorText, Field, Input, Modal, Notice, Select, Spinner } from '../components/ui.js';

interface Infrastructure { pools: { name: string; active: boolean; volumes: string[] }[]; networks: { name: string; info: string }[] }
export function CreateVmModal({ onClose, onCreated }: { onClose: () => void; onCreated: (uuid: string, warning?: string) => Promise<void> }) {
  const [data, setData] = useState<Infrastructure | null>(null);
  const [name, setName] = useState(''), [cpus, setCpus] = useState(2), [memoryMb, setMemory] = useState(2048), [diskGb, setDisk] = useState(20);
  const [pool, setPool] = useState(''), [network, setNetwork] = useState(''), [iso, setIso] = useState('');
  const [nic, setNic] = useState<NicOptions>({ model: 'virtio', mac: '', link: 'up' }), [boot, setBoot] = useState('hd'), [extraVolume, setExtraVolume] = useState('');
  const [start, setStart] = useState(true), [autostart, setAutostart] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    api.get<Infrastructure>('/libvirt/infrastructure').then(result => {
      setData(result); setPool(result.pools.find(p => p.active)?.name ?? '');
      setNetwork(result.networks.find(n => /^Active:\s+yes\s*$/m.test(n.info))?.name ?? '');
    }).catch(err => setError(err instanceof Error ? err.message : 'Could not load hypervisor resources'));
  }, []);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (busy) return; setBusy(true); setError('');
    try {
      const result = await api.post<{ uuid: string; warning?: string }>('/libvirt/vms/create', { name, cpus, memoryMb, diskMb: diskGb * 1024, pool, network, iso, start, autostart, ...nic, boot, extraVolume });
      await onCreated(result.uuid, result.warning); onClose();
    } catch (err) { setError(err instanceof Error ? err.message : 'VM creation failed'); } finally { setBusy(false); }
  }
  return <Modal title="New virtual machine" open onClose={() => !busy && onClose()} size="lg">
    <form onSubmit={submit} className="space-y-5">
      <p className="text-sm text-ink-300">Create an x86_64 QEMU/KVM guest with a new virtual disk. Use a Linux installer ISO already available on the connected hypervisor, then finish installing the OS in the VM console.</p>
      {!data && !error && <Spinner />}
      {data && <>
        {(!pool || !network) && <Notice tone="warning">An active directory storage pool and virtual network are required. <Link to="/libvirt/configuration" className="underline">Manage hypervisor resources</Link></Notice>}
        <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2"><Field label="VM name"><Input required pattern="[a-zA-Z0-9_][a-zA-Z0-9_.-]*" maxLength={128} placeholder="my-linux-vm" value={name} onChange={e => setName(e.target.value)} /></Field></div>
          <Field label="Virtual CPUs"><Input required type="number" min={1} max={256} value={cpus} onChange={e => setCpus(Number(e.target.value))} /></Field>
          <Field label="Memory (MiB)"><Input required type="number" min={256} max={1048576} value={memoryMb} onChange={e => setMemory(Number(e.target.value))} /></Field>
          <Field label="Disk capacity (GiB)"><Input required type="number" min={1} max={16384} value={diskGb} onChange={e => setDisk(Number(e.target.value))} /></Field>
          <Field label="Storage pool"><Select required value={pool} onChange={e => { setPool(e.target.value); setExtraVolume(''); }}><option value="">Choose active pool</option>{data.pools.filter(p => p.active).map(p => <option key={p.name}>{p.name}</option>)}</Select></Field>
          <Field label="Additional existing disk (optional)"><Select value={extraVolume} onChange={e => setExtraVolume(e.target.value)}><option value="">No additional disk</option>{data.pools.find(p => p.name === pool)?.volumes?.filter(v => /\.(qcow2|raw|img)$/i.test(v)).map(v => <option key={v}>{v}</option>)}</Select></Field>
          <Field label="Virtual network"><Select required value={network} onChange={e => setNetwork(e.target.value)}><option value="">Choose active network</option>{data.networks.filter(n => /^Active:\s+yes\s*$/m.test(n.info)).map(n => <option key={n.name}>{n.name}</option>)}</Select></Field>
          <VmNicFields value={nic} onChange={setNic} />
          <Field label="First boot device"><Select value={boot} onChange={e => setBoot(e.target.value)}><option value="hd">Virtual disk</option><option value="cdrom">Installer ISO</option><option value="network">Network (PXE)</option></Select></Field>
          <div className="sm:col-span-2"><VmIsoSelect value={iso} onChange={setIso} disabled={busy} /></div>
          <Field label="Installer ISO path on hypervisor"><Input required={boot === 'cdrom'} placeholder="Optional for disk / PXE boot" value={iso} onChange={e => setIso(e.target.value)} /></Field>
          <label className="flex items-center gap-2 text-sm text-ink-200"><input type="checkbox" checked={start} onChange={e => setStart(e.target.checked)} />Start after creation</label>
          <label className="flex items-center gap-2 text-sm text-ink-200"><input type="checkbox" checked={autostart} onChange={e => setAutostart(e.target.checked)} />Start when hypervisor boots</label>
        </fieldset>
        <p className="text-xs text-ink-400">Uses BIOS boot and virtio disk/network devices. The hypervisor must support x86_64 KVM and be able to read the ISO. Disk capacity is allocated as a sparse qcow2 volume.</p>
      </>}
      <ErrorText>{error}</ErrorText>
      <div className="flex justify-end gap-2"><Button type="button" disabled={busy} onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" disabled={busy || !data || !pool || !network}>{busy ? 'Creating VM…' : 'Create virtual machine'}</Button></div>
    </form>
  </Modal>;
}
