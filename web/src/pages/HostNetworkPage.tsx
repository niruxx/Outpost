import { useCallback, useEffect, useMemo, useState } from 'react';
import { AdminNotice, HostLayout, formatBytes } from '../components/HostLayout.js';
import { Badge, Button, Card, CardTitle, ErrorText, Field, Input, Modal, Notice, Select, Spinner } from '../components/ui.js';
import { Icon } from '../components/icons.js';
import { useToast } from '../components/Toast.js';
import { useConfirm } from '../components/ConfirmDialog.js';
import { api, ApiError } from '../api/client.js';
import { hostApi, useHostAdmin } from '../state/hostTarget.js';

interface Device {
  device: string;
  type: string;
  state: string;
  connection: string | null;
  uuid: string | null;
}
interface Connection {
  name: string;
  uuid: string;
  type: string;
  device: string | null;
  active: boolean;
  autoconnect: boolean;
}
interface Iface {
  name: string;
  mac: string | null;
  mtu: number | null;
  up: boolean;
  addresses: string[];
  rxBytes: number | null;
  txBytes: number | null;
  master: string | null;
}
interface Overview {
  available: boolean;
  reason: string | null;
  devices: Device[];
  connections: Connection[];
  interfaces: Iface[];
}
interface IpConfig {
  method: string;
  addresses: string[];
  gateway: string;
  dns: string[];
  ignoreAutoDns: boolean;
}
interface Details {
  uuid: string;
  name: string;
  type: string;
  interfaceName: string | null;
  autoconnect: boolean;
  master: string | null;
  portType: string | null;
  ipv4: IpConfig;
  ipv6: IpConfig;
  mtu: number | null;
  bondOptions: string | null;
  vlan: { id: number; parent: string } | null;
  bridgeStp: boolean | null;
  live: { state: string | null; ipv4: string[]; gateway4: string | null; dns4: string[]; ipv6: string[]; gateway6: string | null; dns6: string[] };
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

/**
 * Applies a change inside a NetworkManager checkpoint, then confirms it from the browser. If the
 * browser can't reach the panel afterwards, NetworkManager rolls the change back by itself.
 */
function useNetworkChange(onDone: () => void) {
  const toast = useToast();
  const [phase, setPhase] = useState<null | { label: string; until: number }>(null);
  const apply = useCallback(
    async (change: Record<string, unknown>, label: string) => {
      let res: { checkpoint: string; rollbackSec: number };
      try {
        res = await api.post(hostApi('/network/changes'), { change, rollbackSec: 60 });
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : 'The change failed and was undone');
        return false;
      }
      const until = Date.now() + res.rollbackSec * 1000 - 5000;
      setPhase({ label, until });
      await sleep(2500);
      while (Date.now() < until) {
        try {
          await api.post(hostApi('/network/changes/confirm'), { checkpoint: res.checkpoint });
          setPhase(null);
          toast.success(`${label} — kept`);
          onDone();
          return true;
        } catch (err) {
          if (err instanceof ApiError && err.status !== 0 && err.status < 500) {
            setPhase(null);
            toast.error(err.message);
            onDone();
            return false;
          }
          await sleep(3000);
        }
      }
      setPhase(null);
      toast.error('The panel couldn’t be reached after the change, so NetworkManager is rolling it back.');
      window.setTimeout(onDone, 8000);
      return false;
    },
    [onDone, toast]
  );
  return { apply, phase };
}

export function HostNetworkPage() {
  const adminMode = useHostAdmin().active;
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState<'bond' | 'bridge' | 'vlan' | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get<Overview>(hostApi('/network')));
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load the network');
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const { apply, phase } = useNetworkChange(() => void load());
  const ifaceByName = useMemo(() => new Map((data?.interfaces ?? []).map((i) => [i.name, i])), [data]);
  const inactive = (data?.connections ?? []).filter((c) => !c.active);
  const dis = !adminMode || !!phase;
  const title = adminMode ? undefined : 'Turn on Admin Mode first';

  return (
    <HostLayout
      action={
        data?.available && (
          <div className="flex gap-2">
            {(['bond', 'bridge', 'vlan'] as const).map((k) => (
              <Button key={k} variant="outlined" onClick={() => setCreating(k)} disabled={dis} title={title}>
                <Icon name="plus" className="h-4 w-4" /> {k === 'vlan' ? 'VLAN' : k[0].toUpperCase() + k.slice(1)}
              </Button>
            ))}
          </div>
        )
      }
    >
      {phase && (
        <Notice tone="warning">
          <div className="flex items-center gap-3">
            <Spinner />
            <span>
              {phase.label}: checking the panel is still reachable… If it isn’t, the change is rolled back automatically within a minute.
            </span>
          </div>
        </Notice>
      )}
      {error ? (
        <Notice tone="error">{error}</Notice>
      ) : !data ? (
        <Spinner />
      ) : (
        <>
          {!data.available && <Notice tone="warning">{data.reason}</Notice>}
          {data.available && <AdminNotice active={adminMode} what="change addresses or create bonds, bridges and VLANs" />}
          <Card className="p-5">
            <CardTitle>Interfaces</CardTitle>
            <div className="divide-y divide-surface-700 overflow-hidden rounded-2xl bg-surface-900">
              {(data.available ? data.devices.map((d) => ({ name: d.device, device: d })) : data.interfaces.map((i) => ({ name: i.name, device: null as Device | null }))).map(({ name, device }) => {
                const info = ifaceByName.get(name);
                const clickable = !!device?.uuid;
                return (
                  <button
                    key={name}
                    type="button"
                    disabled={!clickable}
                    onClick={() => device?.uuid && setSelected(device.uuid)}
                    className={`flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left ${clickable ? 'state-layer' : ''}`}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 text-sm text-ink-100">
                        <span className="font-mono">{name}</span>
                        {device && <span className="text-xs text-ink-500">{device.type}</span>}
                        {device?.connection && <span className="text-xs text-ink-400">“{device.connection}”</span>}
                        {info?.master && <Badge tone="blue">in {info.master}</Badge>}
                      </p>
                      <p className="truncate font-mono text-xs text-ink-400">{info?.addresses.join(', ') || 'no address'}</p>
                      <p className="text-xs text-ink-500">
                        {[info?.mac, info?.mtu ? `MTU ${info.mtu}` : null, info?.rxBytes !== null && info?.rxBytes !== undefined ? `↓ ${formatBytes(info.rxBytes)} ↑ ${formatBytes(info.txBytes)}` : null].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                    <Badge tone={device ? (device.state === 'connected' ? 'green' : device.state.startsWith('unavailable') || device.state === 'unmanaged' ? 'neutral' : 'yellow') : info?.up ? 'green' : 'neutral'}>
                      {device?.state ?? (info?.up ? 'up' : 'down')}
                    </Badge>
                  </button>
                );
              })}
            </div>
          </Card>

          {data.available && inactive.length > 0 && (
            <Card className="p-5">
              <CardTitle>Other connection profiles</CardTitle>
              <div className="divide-y divide-surface-700 overflow-hidden rounded-2xl bg-surface-900">
                {inactive.map((c) => (
                  <button key={c.uuid} type="button" onClick={() => setSelected(c.uuid)} className="state-layer flex w-full items-center gap-3 px-4 py-3 text-left">
                    <span className="flex-1 text-sm text-ink-100">{c.name}</span>
                    <span className="text-xs text-ink-500">{c.type}</span>
                    <Badge tone="neutral">{c.autoconnect ? 'auto' : 'manual'}</Badge>
                  </button>
                ))}
              </div>
            </Card>
          )}
        </>
      )}

      {selected && <ConnectionModal uuid={selected} disabled={dis} onClose={() => setSelected(null)} apply={apply} />}
      {creating && data && (
        <CreateModal
          kind={creating}
          devices={data.devices.filter((d) => d.type === 'ethernet' || d.type === 'bond' || d.type === 'vlan')}
          onClose={() => setCreating(null)}
          apply={async (change, label) => {
            setCreating(null);
            await apply(change, label);
          }}
        />
      )}
    </HostLayout>
  );
}

function IpEditor({ family, value, onChange }: { family: 4 | 6; value: IpConfig; onChange: (v: IpConfig) => void }) {
  const methods = family === 4 ? ['auto', 'manual', 'link-local', 'shared', 'disabled'] : ['auto', 'dhcp', 'manual', 'link-local', 'ignore', 'disabled'];
  const label: Record<string, string> = { auto: family === 4 ? 'Automatic (DHCP)' : 'Automatic (SLAAC/DHCPv6)', dhcp: 'DHCPv6 only', manual: 'Manual', 'link-local': 'Link-local only', shared: 'Shared to other computers', disabled: 'Disabled', ignore: 'Ignore' };
  return (
    <div className="space-y-3 rounded-2xl bg-surface-900 p-4">
      <p className="text-sm font-medium text-ink-200">IPv{family}</p>
      <Select value={value.method} onChange={(e) => onChange({ ...value, method: e.target.value })}>
        {methods.map((m) => (
          <option key={m} value={m}>
            {label[m]}
          </option>
        ))}
      </Select>
      {value.method === 'manual' && (
        <>
          <Field label="Addresses with prefix (comma-separated)">
            <Input className="font-mono" value={value.addresses.join(', ')} onChange={(e) => onChange({ ...value, addresses: e.target.value.split(',').map((s) => s.trim()) })} placeholder={family === 4 ? '192.168.1.10/24' : '2001:db8::10/64'} />
          </Field>
          <Field label="Gateway">
            <Input className="font-mono" value={value.gateway} onChange={(e) => onChange({ ...value, gateway: e.target.value.trim() })} placeholder={family === 4 ? '192.168.1.1' : ''} />
          </Field>
        </>
      )}
      {value.method !== 'disabled' && value.method !== 'ignore' && (
        <>
          <Field label="DNS servers (comma-separated)">
            <Input className="font-mono" value={value.dns.join(', ')} onChange={(e) => onChange({ ...value, dns: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} placeholder={family === 4 ? '1.1.1.1, 9.9.9.9' : ''} />
          </Field>
          {value.method !== 'manual' && (
            <label className="flex items-center gap-2 text-sm text-ink-300">
              <input type="checkbox" checked={value.ignoreAutoDns} onChange={(e) => onChange({ ...value, ignoreAutoDns: e.target.checked })} /> Use only these DNS servers
            </label>
          )}
        </>
      )}
    </div>
  );
}

function ConnectionModal({ uuid, disabled, onClose, apply }: { uuid: string; disabled: boolean; onClose: () => void; apply: (change: Record<string, unknown>, label: string) => Promise<boolean> }) {
  const confirm = useConfirm();
  const [d, setD] = useState<Details | null>(null);
  const [error, setError] = useState('');
  const [ipv4, setIpv4] = useState<IpConfig | null>(null);
  const [ipv6, setIpv6] = useState<IpConfig | null>(null);
  const [mtu, setMtu] = useState('');

  useEffect(() => {
    api
      .get<Details>(hostApi(`/network/connections/${uuid}`))
      .then((r) => {
        setD(r);
        setIpv4(r.ipv4);
        setIpv6(r.ipv6);
        setMtu(r.mtu ? String(r.mtu) : '');
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load the connection'));
  }, [uuid]);

  async function run(change: Record<string, unknown>, label: string) {
    onClose();
    await apply(change, label);
  }

  return (
    <Modal open onClose={onClose} title={d ? `${d.name}${d.interfaceName ? ` (${d.interfaceName})` : ''}` : 'Connection'} size="lg">
      {error ? (
        <Notice tone="error">{error}</Notice>
      ) : !d || !ipv4 || !ipv6 ? (
        <Spinner />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge tone="neutral">{d.type}</Badge>
            {d.live.state && <Badge tone={d.live.state === 'activated' ? 'green' : 'neutral'}>{d.live.state}</Badge>}
            {d.master && <Badge tone="blue">port of {d.master}</Badge>}
            {d.vlan && <Badge tone="blue">VLAN {d.vlan.id} on {d.vlan.parent}</Badge>}
            {d.bondOptions && <Badge tone="blue">{d.bondOptions}</Badge>}
          </div>
          {(d.live.ipv4.length > 0 || d.live.ipv6.length > 0) && (
            <p className="font-mono text-xs text-ink-400">
              Now: {[...d.live.ipv4, ...d.live.ipv6].join(', ')}
              {d.live.gateway4 ? ` · gw ${d.live.gateway4}` : ''}
              {d.live.dns4.length ? ` · dns ${d.live.dns4.join(', ')}` : ''}
            </p>
          )}
          {d.master ? (
            <Notice tone="info">This interface is a port of {d.master}; its addresses are configured on {d.master}.</Notice>
          ) : (
            <>
              <div className="grid gap-4 md:grid-cols-2">
                <IpEditor family={4} value={ipv4} onChange={setIpv4} />
                <IpEditor family={6} value={ipv6} onChange={setIpv6} />
              </div>
              {d.type === '802-3-ethernet' && (
                <Field label="MTU (empty = automatic)">
                  <Input type="number" min={576} max={9216} value={mtu} onChange={(e) => setMtu(e.target.value)} />
                </Field>
              )}
              <Button
                variant="primary"
                disabled={disabled}
                onClick={() =>
                  void run(
                    { kind: 'ip', uuid, ipv4: { ...ipv4, addresses: ipv4.addresses.filter(Boolean) }, ipv6: { ...ipv6, addresses: ipv6.addresses.filter(Boolean) }, ...(d.type === '802-3-ethernet' ? { mtu: mtu ? Number(mtu) : null } : {}) },
                    `Updated ${d.name}`
                  )
                }
              >
                Apply
              </Button>
            </>
          )}
          <div className="flex flex-wrap gap-2 border-t border-surface-700 pt-4">
            <Button variant="outlined" disabled={disabled} onClick={() => void run({ kind: 'state', uuid, up: d.live.state !== 'activated' }, d.live.state === 'activated' ? `Disconnected ${d.name}` : `Connected ${d.name}`)}>
              {d.live.state === 'activated' ? 'Disconnect' : 'Connect'}
            </Button>
            <Button variant="ghost" disabled={disabled} onClick={() => void run({ kind: 'autoconnect', uuid, enabled: !d.autoconnect }, d.autoconnect ? 'Autoconnect off' : 'Autoconnect on')}>
              {d.autoconnect ? 'Don’t connect automatically' : 'Connect automatically'}
            </Button>
            <Button
              variant="danger"
              disabled={disabled}
              onClick={async () => {
                if (await confirm({ title: 'Delete connection profile', message: `Delete “${d.name}”? If it is in use, the interface goes down (and is restored automatically if that cuts the panel off).`, confirmLabel: 'Delete', tone: 'danger' }))
                  void run({ kind: 'delete', uuid }, `Deleted ${d.name}`);
              }}
            >
              Delete
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function CreateModal({ kind, devices, onClose, apply }: { kind: 'bond' | 'bridge' | 'vlan'; devices: Device[]; onClose: () => void; apply: (change: Record<string, unknown>, label: string) => Promise<void> }) {
  const [name, setName] = useState(kind === 'bond' ? 'bond0' : kind === 'bridge' ? 'br0' : '');
  const [ports, setPorts] = useState<string[]>([]);
  const [mode, setMode] = useState('active-backup');
  const [stp, setStp] = useState(false);
  const [parent, setParent] = useState(devices[0]?.device ?? '');
  const [vlanId, setVlanId] = useState('');
  const [ipv4, setIpv4] = useState<IpConfig>({ method: 'auto', addresses: [], gateway: '', dns: [], ignoreAutoDns: false });
  const [error, setError] = useState('');
  const effectiveName = kind === 'vlan' && !name && parent && vlanId ? `${parent}.${vlanId}` : name;

  return (
    <Modal open onClose={onClose} title={`New ${kind === 'vlan' ? 'VLAN' : kind}`} size="lg">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (kind !== 'vlan' && !ports.length) return setError('Pick at least one port');
          const base = { name: effectiveName, ipv4, ipv6: { method: 'auto', addresses: [], gateway: '', dns: [] } };
          void apply(
            kind === 'bond' ? { kind, ...base, mode, ports } : kind === 'bridge' ? { kind, ...base, stp, ports } : { kind, ...base, parent, id: Number(vlanId) },
            `Created ${effectiveName}`
          );
        }}
      >
        {kind !== 'vlan' && (
          <Notice tone="warning">Moving the interface the panel is reached through into a {kind} briefly interrupts it; if the panel stays unreachable, the change is undone automatically.</Notice>
        )}
        <Field label="Interface name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === 'vlan' ? `${parent || 'eth0'}.${vlanId || '10'}` : ''} />
        </Field>
        {kind === 'vlan' ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Parent interface">
              <Select value={parent} onChange={(e) => setParent(e.target.value)}>
                {devices.map((d) => (
                  <option key={d.device}>{d.device}</option>
                ))}
              </Select>
            </Field>
            <Field label="VLAN ID (1–4094)">
              <Input type="number" min={1} max={4094} value={vlanId} onChange={(e) => setVlanId(e.target.value)} required />
            </Field>
          </div>
        ) : (
          <>
            <div>
              <p className="mb-2 text-xs font-medium text-ink-300">Ports</p>
              <div className="flex flex-wrap gap-3">
                {devices
                  .filter((d) => d.type === 'ethernet')
                  .map((d) => (
                    <label key={d.device} className="flex items-center gap-2 text-sm text-ink-200">
                      <input type="checkbox" checked={ports.includes(d.device)} onChange={(e) => setPorts((p) => (e.target.checked ? [...p, d.device] : p.filter((x) => x !== d.device)))} />
                      {d.device}
                    </label>
                  ))}
              </div>
            </div>
            {kind === 'bond' ? (
              <Field label="Mode">
                <Select value={mode} onChange={(e) => setMode(e.target.value)}>
                  <option value="active-backup">Active backup (failover)</option>
                  <option value="802.3ad">802.3ad / LACP (needs switch support)</option>
                  <option value="balance-alb">Adaptive load balancing</option>
                  <option value="balance-tlb">Adaptive transmit load balancing</option>
                  <option value="balance-rr">Round robin</option>
                  <option value="balance-xor">XOR</option>
                  <option value="broadcast">Broadcast</option>
                </Select>
              </Field>
            ) : (
              <label className="flex items-center gap-2 text-sm text-ink-300">
                <input type="checkbox" checked={stp} onChange={(e) => setStp(e.target.checked)} /> Spanning Tree Protocol (STP)
              </label>
            )}
          </>
        )}
        <IpEditor family={4} value={ipv4} onChange={setIpv4} />
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!effectiveName}>
            Create
          </Button>
        </div>
      </form>
    </Modal>
  );
}
