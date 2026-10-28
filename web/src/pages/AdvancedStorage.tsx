import { Button, Card, Field, Input, Notice, Select } from '../components/ui.js';
import type { StoragePermission } from '../api/types.js';

export const ADVANCED_TITLES = {
  luksFormat: 'Create LUKS2 encryption', luksOpen: 'Unlock LUKS', luksClose: 'Lock LUKS mapping', luksPassphrase: 'Change LUKS passphrase', luksGrow: 'Grow encrypted mapping',
  pvCreate: 'Create physical volume', pvRemove: 'Remove physical volume', pvGrow: 'Grow physical volume',
  vgCreate: 'Create volume group', vgRename: 'Rename volume group', vgExtend: 'Add physical volumes', vgReduce: 'Remove unused physical volume', vgRemove: 'Remove empty volume group',
  lvCreate: 'Create logical volume', lvRename: 'Rename logical volume', lvResize: 'Resize logical volume', lvRemove: 'Remove logical volume', lvSnapshot: 'Create LV snapshot', lvActivate: 'Activate logical volume', lvDeactivate: 'Deactivate logical volume',
  partitionGrow: 'Grow partition', partitionShrink: 'Shrink ext4 partition', filesystemGrow: 'Grow filesystem',
} as const;
export type AdvancedAction = keyof typeof ADVANCED_TITLES;
export interface AdvancedFields { name?: string; vg?: string; lv?: string; sizeMb?: number; devices?: string[]; layout?: 'linear' | 'thin-pool' | 'thin'; pool?: string }
export interface LvmState {
  available: boolean; error: string | null;
  pvs: { path: string; uuid: string; vg: string; size: number; free: number; used: number }[];
  vgs: { name: string; uuid: string; size: number; free: number }[];
  lvs: { name: string; uuid: string; vg: string; path: string; size: number; attributes: string; kind: string; pool: string; origin: string }[];
}
interface Device { path: string; type: string; filesystem: string; critical?: boolean; readOnly?: boolean; children: Device[] }
export function AdvancedDeviceControls({ device, permissions, busy, onOpen, lvm }: { device: Device; permissions: StoragePermission[]; busy: boolean; lvm?: LvmState; onOpen: (action: AdvancedAction) => void }) {
  const disabled = busy || device.critical || device.readOnly;
  const encrypt = permissions.includes('encrypt'), resize = permissions.includes('resize'), logical = permissions.includes('lvm');
  const pv = lvm?.pvs.find((p) => p.path === device.path);
  return <div className="space-y-3 border-t border-surface-600 pt-4">
    <h3 className="text-sm font-medium text-ink-100">Encryption and volume management</h3>
    <div className="flex flex-wrap gap-2">
      {encrypt && !device.filesystem && <Button variant="danger" disabled={disabled} onClick={() => onOpen('luksFormat')}>Encrypt blank device</Button>}
      {encrypt && device.filesystem === 'crypto_LUKS' && <><Button disabled={disabled || !!device.children.length} onClick={() => onOpen('luksOpen')}>Unlock</Button><Button disabled={disabled} onClick={() => onOpen('luksPassphrase')}>Change passphrase</Button></>}
      {encrypt && device.type === 'crypt' && <><Button disabled={disabled} onClick={() => onOpen('luksClose')}>Lock</Button><Button disabled={disabled || !resize} onClick={() => onOpen('luksGrow')}>Grow mapping</Button></>}
      {logical && !device.filesystem && <Button variant="danger" disabled={disabled || !lvm?.available} onClick={() => onOpen('pvCreate')}>Create LVM PV</Button>}
      {logical && pv && <><Button disabled={disabled || !resize} onClick={() => onOpen('pvGrow')}>Grow PV</Button>{!pv.vg && <><Button disabled={disabled} onClick={() => onOpen('vgCreate')}>Create volume group</Button><Button variant="danger" disabled={disabled} onClick={() => onOpen('pvRemove')}>Remove PV</Button></>}</>}
      {resize && device.type === 'part' && <><Button disabled={disabled} onClick={() => onOpen('partitionGrow')}>Grow partition to available space</Button>{device.filesystem === 'ext4' && <Button variant="danger" disabled={disabled} onClick={() => onOpen('partitionShrink')}>Shrink ext4 partition</Button>}</>}
      {resize && ['ext2', 'ext3', 'ext4', 'xfs', 'btrfs'].includes(device.filesystem) && <Button disabled={disabled} onClick={() => onOpen('filesystemGrow')}>Grow filesystem</Button>}
    </div><p className="text-xs text-ink-500">Create encryption only on a blank device. Resize layers from outside inward: partition, LUKS mapping, PV/LV, then filesystem. The backend checks holders, mounts, capacity and protected storage again.</p>
  </div>;
}
export function LvmPanel({ lvm, permissions, busy, onOpen }: { lvm?: LvmState; permissions: StoragePermission[]; busy: boolean; onOpen: (op: { action: AdvancedAction; device: string } & AdvancedFields) => void }) {
  if (!lvm) return null;
  const can = permissions.includes('lvm') && !busy;
  return <Card className="space-y-4 p-5"><h2 className="text-lg font-medium text-ink-100">LVM physical volumes and volume groups</h2>
    {!lvm.available ? <Notice tone="info">{lvm.error}</Notice> : <>
      {!lvm.vgs.length && <p className="text-sm text-ink-400">No volume groups. Select a blank disk/partition, create a physical volume, then create a volume group.</p>}
      {lvm.vgs.map((vg) => {
        const members = lvm.pvs.filter((p) => p.vg === vg.name), representative = members[0]?.path;
        const open = (action: AdvancedAction, extra: AdvancedFields = {}) => representative && onOpen({ action, device: representative, vg: vg.name, ...extra });
        return <div key={vg.uuid} className="space-y-3 rounded-xl bg-surface-900 p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-medium text-ink-100">{vg.name}</h3><p className="text-xs text-ink-500">{Math.round(vg.size / 1048576)} MiB total · {Math.round(vg.free / 1048576)} MiB free</p></div><div className="flex flex-wrap gap-2"><Button disabled={!can || !representative} onClick={() => open('vgRename')}>Rename group</Button><Button disabled={!can || !representative} onClick={() => open('vgExtend', { devices: [] })}>Add PVs</Button><Button disabled={!can || !representative} onClick={() => open('lvCreate', { layout: 'linear', sizeMb: 1024 })}>Create LV / thin pool</Button><Button variant="danger" disabled={!can || !representative} onClick={() => open('vgRemove')}>Remove empty group</Button></div></div>
          {members.map((pv) => <div key={pv.uuid} className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-300"><span>{pv.path} · {Math.round(pv.used / 1048576)} MiB allocated</span><Button disabled={!can || pv.used > 0} onClick={() => onOpen({ action: 'vgReduce', device: pv.path, vg: vg.name })}>Detach unused PV</Button></div>)}
          {lvm.lvs.filter((lv) => lv.vg === vg.name).map((lv) => <div key={lv.uuid} className="space-y-2 rounded-xl bg-surface-850 p-3"><p className="break-all text-sm text-ink-100">{lv.name} <span className="text-xs text-ink-500">{lv.kind} · {Math.round(lv.size / 1048576)} MiB{lv.pool ? ` · pool ${lv.pool}` : ''}{lv.origin ? ` · snapshot of ${lv.origin}` : ''}</span></p><div className="flex flex-wrap gap-2">{(['lvActivate', 'lvDeactivate', 'lvRename', 'lvResize', 'lvSnapshot', 'lvRemove'] as AdvancedAction[]).map((action) => <Button key={action} variant={action === 'lvRemove' ? 'danger' : 'ghost'} disabled={!can || !representative || (action === 'lvResize' && !permissions.includes('resize'))} onClick={() => open(action, { lv: lv.name, sizeMb: Math.max(16, Math.round(lv.size / 1048576)) })}>{ADVANCED_TITLES[action]}</Button>)}</div></div>)}
        </div>;
      })}
      {!!lvm.pvs.filter((p) => !p.vg).length && <p className="break-all text-xs text-ink-400">Unassigned PVs: {lvm.pvs.filter((p) => !p.vg).map((p) => p.path).join(', ')}</p>}
    </>}
  </Card>;
}
export function AdvancedOperationFields({ op, patch, busy }: { op: AdvancedFields & { action: string }; patch: (update: Partial<AdvancedFields>) => void; busy: boolean }) {
  return <>
    {['luksOpen', 'vgCreate', 'vgRename', 'lvCreate', 'lvRename', 'lvSnapshot'].includes(op.action) && <Field label="New mapping / volume name"><Input autoComplete="off" value={op.name ?? ''} disabled={busy} onChange={(e) => patch({ name: e.target.value })} /></Field>}
    {['vgCreate', 'vgExtend'].includes(op.action) && <Field label={op.action === 'vgCreate' ? 'PV paths, comma separated (blank = selected device)' : 'Unassigned PV paths, comma separated'}><Input value={op.devices?.join(', ') ?? ''} disabled={busy} onChange={(e) => patch({ devices: e.target.value.split(',').map((v) => v.trim()).filter(Boolean) })} /></Field>}
    {op.action === 'lvCreate' && <Field label="Layout"><Select disabled={busy} value={op.layout ?? 'linear'} onChange={(e) => patch({ layout: e.target.value as AdvancedFields['layout'] })}><option value="linear">Linear logical volume</option><option value="thin-pool">Thin pool</option><option value="thin">Thin-provisioned logical volume</option></Select></Field>}
    {op.action === 'lvCreate' && op.layout === 'thin' && <Field label="Existing thin pool name"><Input value={op.pool ?? ''} disabled={busy} onChange={(e) => patch({ pool: e.target.value })} /></Field>}
    {['lvCreate', 'lvResize', 'lvSnapshot', 'partitionShrink'].includes(op.action) && <Field label={op.action === 'lvSnapshot' ? 'Classic snapshot COW size, MiB (ignored for thin snapshots)' : 'Target size, MiB'}><Input type="number" min={16} value={op.sizeMb ?? 1024} disabled={busy} onChange={(e) => patch({ sizeMb: Number(e.target.value) })} /></Field>}
    {op.action === 'luksFormat' && <Notice tone="warning">Creates a new LUKS2 container. This is destructive encryption initialization, not in-place conversion of existing data. Unlock it afterwards and create a filesystem or LVM inside.</Notice>}
    {op.action === 'luksPassphrase' && <Notice tone="info">Changes the keyslot matching the supplied current passphrase. Other passphrases/keyslots are not revoked automatically. Secrets are requested only after preview.</Notice>}
    {op.action === 'lvResize' && <Notice tone="warning">Linear ext4 LVs can shrink while unmounted; filesystem resizing runs before any reduction. XFS shrinking, raw encrypted-layer shrinking and shrinking other partition/filesystem types are refused.</Notice>}
    {op.action === 'partitionShrink' && <Notice tone="warning">Unmount every partition on the disk first. Outpost shrinks and verifies the ext4 filesystem before shortening only this partition; its start offset stays unchanged. Encrypted and LVM-containing partitions cannot be shrunk here.</Notice>}
    {op.action === 'partitionGrow' && <Notice tone="info">Expands the selected partition into adjacent available space. Then grow any inner encryption, LVM and filesystem layers separately.</Notice>}
    {['vgRename', 'lvRename'].includes(op.action) && <Notice tone="info">Unmount affected LVs first. UUID-based filesystem entries remain valid. Device-path references must be changed to UUIDs before renaming; update external application references yourself.</Notice>}
    {op.vg && <p className="text-sm text-ink-300">Volume group: {op.vg}{op.lv ? ` · Logical volume: ${op.lv}` : ''}</p>}
  </>;
}
