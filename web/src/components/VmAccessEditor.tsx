import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import type { VirtualMachine, VmGrant, VmPermission } from '../api/types.js';
import { Button, ErrorText } from './ui.js';

const permissions: [VmPermission, string][] = [['view', 'View / preview'], ['power', 'Power controls'], ['console', 'Interactive console'], ['configure', 'CPU / memory / autostart'], ['snapshots', 'Create / restore / delete snapshots']];
export function VmAccessEditor({ value, onChange }: { value: VmGrant[]; onChange: (value: VmGrant[]) => void }) {
  const [machines, setMachines] = useState<VirtualMachine[]>([]), [uri, setUri] = useState(''), [error, setError] = useState('');
  useEffect(() => { let cancelled = false; api.get<{ machines: VirtualMachine[]; connection: string }>('/libvirt/vms').then(data => { if (!cancelled) { setMachines(data.machines); setUri(data.connection); } }).catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load VMs'); }); return () => { cancelled = true; }; }, []);
  const rows = [...machines.map(vm => ({ uuid: vm.uuid, uri, name: vm.name })), ...value.filter(g => g.uri !== uri || !machines.some(vm => vm.uuid === g.uuid)).map(g => ({ ...g, name: g.uuid }))];
  function toggle(row: { uri: string; uuid: string }, permission: VmPermission, checked: boolean) {
    const current = value.find(g => g.uri === row.uri && g.uuid === row.uuid);
    const rest = value.filter(g => g !== current);
    if (permission === 'view' && !checked) { onChange(rest); return; }
    const next = checked ? [...new Set<VmPermission>(['view', ...(current?.permissions ?? []), permission])] : (current?.permissions ?? []).filter(p => p !== permission);
    onChange([...rest, { uri: row.uri, uuid: row.uuid, permissions: next }]);
  }
  return <div className="space-y-3 rounded-2xl bg-surface-850 p-4"><p className="text-xs font-medium text-ink-300">Virtual machine access</p><p className="text-xs text-ink-500">Grants apply to a VM UUID on a specific libvirt connection. Console access controls the guest keyboard and mouse. Shared host resources, migration and raw XML remain administrator-only.</p><ErrorText>{error}</ErrorText>{!rows.length && <p className="text-xs text-ink-500">No virtual machines available. Enable libvirt and define a VM first.</p>}{rows.map(row => {
    const grant = value.find(g => g.uri === row.uri && g.uuid === row.uuid);
    return <div key={`${row.uri}/${row.uuid}`} className="space-y-2 border-t border-surface-700 pt-3"><p className="break-all text-xs text-ink-200">{row.name}</p><p className="break-all text-xs text-ink-500">{row.uri}</p><div className="flex flex-wrap gap-3">{permissions.map(([key, label]) => <label key={key} className="flex items-center gap-2 text-xs text-ink-300"><input type="checkbox" checked={grant?.permissions.includes(key) ?? false} onChange={e => toggle(row, key, e.target.checked)} />{label}</label>)}</div>{grant && <Button variant="ghost" onClick={() => onChange(value.filter(g => g !== grant))}>Revoke VM access</Button>}</div>;
  })}</div>;
}
