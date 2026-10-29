import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { Button, Card, ErrorText, Field, Input, Select } from './ui.js';

export interface VmImages { directory: string; images: { name: string; path: string }[] }
export function VmImageLibrary() {
  const [data, setData] = useState<VmImages>({ directory: '', images: [] });
  const [directory, setDirectory] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  async function load(save = false) {
    setBusy(true); setError('');
    try { const result = save ? await api.put<VmImages>('/libvirt/images', { directory }) : await api.get<VmImages>('/libvirt/images'); setData(result); setDirectory(result.directory); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not load image library'); } finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, []);
  return <Card className="space-y-4 p-5"><h3 className="font-medium text-ink-100">VM Images directory</h3><p className="text-sm text-ink-400">Choose an existing directory on this hypervisor. Its ISO files will appear when creating a VM or changing installation media. Each connection remembers its own directory.</p><Field label="Images directory on hypervisor"><Input value={directory} placeholder="/var/lib/libvirt/isos" onChange={e => setDirectory(e.target.value)} disabled={busy} /></Field><div className="flex flex-wrap gap-2"><Button disabled={busy || !directory} onClick={() => load(true)}>Save images directory</Button><Button disabled={busy} onClick={() => load()}>Refresh ISOs</Button></div><p className="text-xs text-ink-400">{data.images.length} ISO image(s). Files are indexed directly inside the directory; subdirectories are not scanned. Changing the directory retains previous pools and files.</p><ul className="space-y-2">{data.images.map(i => <li key={i.path} className="break-all rounded-xl bg-surface-900 p-3 text-sm text-ink-200">{i.name}</li>)}</ul><ErrorText>{error}</ErrorText></Card>;
}
export function VmIsoSelect({ value, onChange, disabled = false }: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const [data, setData] = useState<VmImages>({ directory: '', images: [] }), [error, setError] = useState('');
  async function load() { setError(''); try { setData(await api.get<VmImages>('/libvirt/images')); } catch (err) { setError(err instanceof Error ? err.message : 'Image discovery failed'); } }
  useEffect(() => { void load(); }, []);
  return <div className="space-y-2"><Field label="ISO from VM Images directory"><Select value={data.images.some(i => i.path === value) ? value : ''} disabled={disabled} onChange={e => onChange(e.target.value)}><option value="">{data.directory ? 'Choose ISO or enter a path below' : 'Configure VM Images directory or enter a path below'}</option>{data.images.map(i => <option key={i.path} value={i.path}>{i.name}</option>)}</Select></Field><Button type="button" disabled={disabled} onClick={load}>Refresh image list</Button><ErrorText>{error}</ErrorText></div>;
}
