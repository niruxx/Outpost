import { Field, Input, Select } from './ui.js';
export interface NicOptions { model: string; mac: string; link: string }
export function VmNicFields({ value, onChange, fixedMac = false }: { value: NicOptions; onChange: (value: NicOptions) => void; fixedMac?: boolean }) {
  return <><Field label="Network adapter model"><Select value={value.model} onChange={e => onChange({ ...value, model: e.target.value })}><option value="virtio">Virtio</option><option value="e1000e">Intel e1000e</option><option value="rtl8139">Realtek rtl8139</option></Select></Field><Field label="MAC address (blank = automatic)"><Input value={value.mac} disabled={fixedMac} placeholder="52:54:00:12:34:56" onChange={e => onChange({ ...value, mac: e.target.value })} /></Field><Field label="Network link"><Select value={value.link} onChange={e => onChange({ ...value, link: e.target.value })}><option value="up">Connected</option><option value="down">Disconnected</option></Select></Field></>;
}
