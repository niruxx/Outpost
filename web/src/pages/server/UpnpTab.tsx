import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useServerDetail } from './ServerContext.js';
import { api, ApiError } from '../../api/client.js';
import type { UpnpConfig, UpnpGatewayInfo, UpnpMappingState, UpnpProtocol, UpnpRule } from '../../api/types.js';
import { Badge, Button, Card, CardTitle, ErrorText, Field, Input, Notice, Select, Spinner } from '../../components/ui.js';
import { Icon } from '../../components/icons.js';
import { EMPHASIZED } from '../../components/motion.js';
import { useToast } from '../../components/Toast.js';
import { PortTestCard } from './PortTestCard.js';

const LEASES = [
  { value: 1800, label: '30 minutes' },
  { value: 3600, label: '1 hour' },
  { value: 21600, label: '6 hours' },
  { value: 86400, label: '24 hours' },
  { value: 0, label: 'Permanent (until removed)' },
];

// crypto.randomUUID() needs a secure context, and panels are often opened over plain HTTP on the LAN.
const localId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const newRule = (port: number, protocol: UpnpProtocol): UpnpRule => ({
  id: localId(),
  label: '',
  protocol,
  externalStart: port,
  externalEnd: port,
  internalStart: port,
  enabled: true,
});

function RouterCard({ info, loading, onRefresh }: { info: UpnpGatewayInfo | null; loading: boolean; onRefresh: () => void }) {
  return (
    <Card className="p-5">
      <CardTitle
        action={
          <Button variant="ghost" onClick={onRefresh} disabled={loading}>
            {loading ? <Spinner /> : <Icon name="refresh" className="h-4 w-4" />} Search again
          </Button>
        }
      >
        Router
      </CardTitle>
      {loading && !info ? (
        <div className="flex items-center gap-2 text-sm text-ink-400">
          <Spinner /> Looking for a UPnP router on your network…
        </div>
      ) : info?.gateway ? (
        <div className="flex flex-wrap items-center gap-6">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-container text-accent-on-container">
            <Icon name="router" className="h-6 w-6" />
          </span>
          <div className="min-w-0">
            <p className="text-base text-ink-50">{info.gateway.friendlyName}</p>
            <p className="text-xs text-ink-400">{[info.gateway.manufacturer, info.gateway.modelName].filter(Boolean).join(' · ') || 'UPnP Internet Gateway Device'}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3 font-mono text-sm">
            <span className="rounded-lg bg-surface-900 px-3 py-1.5 text-ink-200" title="This host on your LAN">
              {info.gateway.localAddress}
            </span>
            <Icon name="network" className="h-4 w-4 text-ink-500" />
            <span className="rounded-lg bg-surface-900 px-3 py-1.5 text-accent-400" title="Your public IP, as the router reports it">
              {info.externalIp ?? 'public IP unknown'}
            </span>
          </div>
        </div>
      ) : (
        <Notice tone="warning">{info?.error ?? 'No router found.'}</Notice>
      )}
    </Card>
  );
}

function RuleRow({ rule, onChange, onRemove, disabled }: { rule: UpnpRule; onChange: (r: UpnpRule) => void; onRemove: () => void; disabled: boolean }) {
  const count = Math.max(1, rule.externalEnd - rule.externalStart + 1);
  const internalEnd = rule.internalStart + count - 1;
  const set = (patch: Partial<UpnpRule>) => onChange({ ...rule, ...patch });
  const num = (v: string) => (v === '' ? 0 : Math.round(Number(v)));
  return (
    <motion.div
      layout
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.25, ease: EMPHASIZED }}
      className="overflow-hidden"
    >
      <div className={`mb-2 rounded-2xl p-3 ${rule.enabled ? 'bg-surface-900' : 'bg-surface-900/50 opacity-70'}`}>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-[minmax(0,1.4fr)_110px_100px_100px_100px_auto]">
          <Field label="Label">
            <Input value={rule.label} onChange={(e) => set({ label: e.target.value })} placeholder="e.g. Game port" maxLength={40} disabled={disabled} />
          </Field>
          <Field label="Protocol">
            <Select value={rule.protocol} onChange={(e) => set({ protocol: e.target.value as UpnpProtocol })} disabled={disabled}>
              <option value="TCP">TCP</option>
              <option value="UDP">UDP</option>
              <option value="BOTH">TCP + UDP</option>
            </Select>
          </Field>
          <Field label="External from">
            <Input
              type="number"
              min={1}
              max={65535}
              value={rule.externalStart || ''}
              onChange={(e) => {
                const start = num(e.target.value);
                // Keep the range length when moving the start; keep internal aligned if it was.
                set({ externalStart: start, externalEnd: start + (count - 1), internalStart: rule.internalStart === rule.externalStart ? start : rule.internalStart });
              }}
              disabled={disabled}
            />
          </Field>
          <Field label="External to">
            <Input type="number" min={1} max={65535} value={rule.externalEnd || ''} onChange={(e) => set({ externalEnd: num(e.target.value) })} disabled={disabled} />
          </Field>
          <Field label="To local port">
            <Input type="number" min={1} max={65535} value={rule.internalStart || ''} onChange={(e) => set({ internalStart: num(e.target.value) })} disabled={disabled} />
          </Field>
          <div className="col-span-2 flex items-end justify-end gap-1 md:col-span-1">
            <label className="flex h-[38px] items-center gap-2 px-2 text-xs text-ink-300">
              <input type="checkbox" checked={rule.enabled} onChange={(e) => set({ enabled: e.target.checked })} disabled={disabled} />
              On
            </label>
            {!disabled && (
              <button onClick={onRemove} aria-label="Remove rule" className="state-layer mb-0.5 rounded-full p-2 text-ink-400">
                <Icon name="trash" className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
        <p className="mt-2 text-xs text-ink-500">
          {count === 1 ? `Port ${rule.externalStart}` : `Ports ${rule.externalStart}–${rule.externalEnd} (${count})`} on the router →{' '}
          {count === 1 ? `port ${rule.internalStart}` : `ports ${rule.internalStart}–${internalEnd}`} on this machine ·{' '}
          {rule.protocol === 'BOTH' ? 'TCP and UDP' : rule.protocol}
        </p>
      </div>
    </motion.div>
  );
}

export function UpnpTab() {
  const { server, can, isAdmin } = useServerDetail();
  const toast = useToast();
  const [config, setConfig] = useState<UpnpConfig | null>(null);
  const [saved, setSaved] = useState<string>('');
  const [configured, setConfigured] = useState(false);
  const [states, setStates] = useState<UpnpMappingState[]>([]);
  const [info, setInfo] = useState<UpnpGatewayInfo | null>(null);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState<'' | 'save' | 'apply' | 'remove'>('');
  const [error, setError] = useState('');
  const editable = can('network');
  const base = server ? `/servers/${server.id}/upnp` : '';

  const loadGateway = useCallback(
    async (refresh = false) => {
      if (!base) return;
      setSearching(true);
      try {
        setInfo(await api.get<UpnpGatewayInfo>(`${base}/gateway${refresh ? '?refresh=1' : ''}`));
      } finally {
        setSearching(false);
      }
    },
    [base]
  );

  useEffect(() => {
    if (!base) return;
    api
      .get<{ config: UpnpConfig; configured: boolean; states: UpnpMappingState[] }>(base)
      .then((res) => {
        setConfig(res.config);
        setSaved(JSON.stringify(res.config));
        setConfigured(res.configured);
        setStates(res.states);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load UPnP settings'));
    loadGateway();
  }, [base, loadGateway]);

  if (!server || !config) return error ? <ErrorText>{error}</ErrorText> : <Spinner />;

  const dirty = JSON.stringify(config) !== saved;
  const portCount = config.rules
    .filter((r) => r.enabled)
    .reduce((n, r) => n + Math.max(1, r.externalEnd - r.externalStart + 1) * (r.protocol === 'BOTH' ? 2 : 1), 0);

  async function save(): Promise<boolean> {
    setBusy('save');
    setError('');
    try {
      const res = await api.put<{ config: UpnpConfig }>(base, { config });
      setConfig(res.config);
      setSaved(JSON.stringify(res.config));
      setConfigured(true);
      toast.success('Port rules saved');
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save');
      return false;
    } finally {
      setBusy('');
    }
  }

  async function apply() {
    if (dirty && !(await save())) return;
    setBusy('apply');
    setError('');
    try {
      const res = await api.post<{ states: UpnpMappingState[] }>(`${base}/apply`);
      setStates(res.states);
      const ok = res.states.filter((s) => s.ok).length;
      if (ok === res.states.length) toast.success(`Forwarded ${ok} port mapping${ok === 1 ? '' : 's'}`);
      else toast.error(`${res.states.length - ok} of ${res.states.length} mappings failed — see below`);
      loadGateway();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to forward ports');
    } finally {
      setBusy('');
    }
  }

  async function remove() {
    setBusy('remove');
    setError('');
    try {
      const res = await api.post<{ removed: number }>(`${base}/remove`);
      setStates([]);
      toast.success(`Removed ${res.removed} port mapping${res.removed === 1 ? '' : 's'}`);
      loadGateway();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to remove mappings');
    } finally {
      setBusy('');
    }
  }

  const failed = states.filter((s) => !s.ok);

  return (
    <div className="stagger space-y-5">
      <RouterCard info={info} loading={searching} onRefresh={() => loadGateway(true)} />

      <Card className="p-5">
        <CardTitle>Port forwarding rules</CardTitle>
        <p className="mb-4 text-sm text-ink-400">
          Ask your router to forward ports (or port ranges) to this machine so players outside your network can connect. Ranges map one to
          one, e.g. external 27015–27020 → local 27015–27020.
        </p>

        {!editable && (
          <div className="mb-4">
            <Notice tone="info">
              Forwarding opens ports on your router to this machine, so it needs the “UPnP port forwarding” permission, which an admin has to
              grant you.
            </Notice>
          </div>
        )}

        <AnimatePresence initial={false}>
          {config.rules.map((rule, i) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              disabled={!editable}
              onChange={(r) => setConfig({ ...config, rules: config.rules.map((x, j) => (j === i ? r : x)) })}
              onRemove={() => setConfig({ ...config, rules: config.rules.filter((_, j) => j !== i) })}
            />
          ))}
        </AnimatePresence>
        {config.rules.length === 0 && <p className="mb-3 text-sm text-ink-500">No rules yet.</p>}

        {editable && (
          <button
            onClick={() => {
              const last = config.rules[config.rules.length - 1];
              const port = last ? last.externalEnd + 1 : server.server_port;
              setConfig({ ...config, rules: [...config.rules, newRule(Math.min(port, 65535), last?.protocol ?? 'TCP')] });
            }}
            className="state-layer mb-5 inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium text-accent-400"
          >
            <Icon name="plus" className="h-4 w-4" /> Add port or range
          </button>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex items-start gap-3 rounded-2xl bg-surface-900 p-3 text-sm text-ink-200">
            <input type="checkbox" className="mt-1" checked={config.autoMap} onChange={(e) => setConfig({ ...config, autoMap: e.target.checked })} disabled={!editable} />
            <span>
              <span className="font-medium">Forward automatically while running</span>
              <span className="block text-xs text-ink-400">Opens the ports when the instance starts and closes them when it stops.</span>
            </span>
          </label>
          <Field label="Lease (renewed automatically)">
            <Select value={config.leaseSeconds} onChange={(e) => setConfig({ ...config, leaseSeconds: Number(e.target.value) })} disabled={!editable}>
              {LEASES.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <p className="mt-3 text-xs text-ink-500">
          A timed lease means the router drops the forwarding by itself if this panel goes away — safer than permanent.
          {!isAdmin && ' Ports below 1024 and the panel’s own port can only be forwarded by an admin.'}
        </p>

        <ErrorText>{error}</ErrorText>
        {editable && (
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={apply} disabled={!!busy || !info?.gateway || portCount === 0}>
              {busy === 'apply' ? <Spinner /> : <Icon name="router" className="h-4 w-4" />} {dirty ? 'Save & forward now' : 'Forward now'}
            </Button>
            <Button onClick={save} disabled={!!busy || !dirty}>
              {busy === 'save' ? 'Saving…' : 'Save rules'}
            </Button>
            <Button variant="ghost" onClick={remove} disabled={!!busy || !info?.gateway || (!configured && !states.length)}>
              {busy === 'remove' ? <Spinner /> : <Icon name="close" className="h-4 w-4" />} Remove forwarding
            </Button>
            <span className="text-xs text-ink-500">
              {portCount} mapping{portCount === 1 ? '' : 's'}
            </span>
          </div>
        )}
      </Card>

      <PortTestCard base={base} config={config} defaultPort={server.server_port} canTestOutside={editable} />

      {states.length > 0 && (
        <Card className="p-5">
          <CardTitle
            action={
              <Badge tone={failed.length ? 'red' : 'green'}>
                {states.length - failed.length}/{states.length} active
              </Badge>
            }
          >
            Last result
          </CardTitle>
          {failed.length > 0 && (
            <div className="mb-3 space-y-1">
              {failed.slice(0, 8).map((s) => (
                <p key={`${s.protocol}${s.externalPort}`} className="text-xs text-red-400">
                  {s.protocol} {s.externalPort}: {s.error}
                </p>
              ))}
              {failed.length > 8 && <p className="text-xs text-ink-500">…and {failed.length - 8} more</p>}
            </div>
          )}
          <div className="flex flex-wrap gap-1.5">
            {states.slice(0, 120).map((s) => (
              <span
                key={`${s.protocol}${s.externalPort}`}
                title={s.error ?? `→ ${s.internalPort}`}
                className={`rounded-lg px-2 py-0.5 font-mono text-xs ${s.ok ? 'bg-success-500/15 text-success-400' : 'bg-red-500/15 text-red-400'}`}
              >
                {s.protocol} {s.externalPort}
              </span>
            ))}
          </div>
        </Card>
      )}

      {info?.gateway && (
        <Card className="p-5">
          <CardTitle>Forwarded to this machine right now</CardTitle>
          {info.routerMappings.length === 0 ? (
            <p className="text-sm text-ink-500">The router isn’t forwarding anything to {info.gateway.localAddress} via UPnP.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-ink-400">
                    <th className="py-1.5 pr-4 font-medium">Protocol</th>
                    <th className="py-1.5 pr-4 font-medium">External</th>
                    <th className="py-1.5 pr-4 font-medium">Local</th>
                    <th className="py-1.5 pr-4 font-medium">Lease</th>
                    <th className="py-1.5 font-medium">Description</th>
                  </tr>
                </thead>
                <tbody>
                  {info.routerMappings.slice(0, 200).map((m) => (
                    <tr key={`${m.protocol}${m.externalPort}`} className="border-t border-surface-700 text-ink-200">
                      <td className="py-1.5 pr-4 font-mono">{m.protocol}</td>
                      <td className="py-1.5 pr-4 font-mono">{m.externalPort}</td>
                      <td className="py-1.5 pr-4 font-mono">{m.internalPort}</td>
                      <td className="py-1.5 pr-4 text-ink-400">{m.leaseSeconds ? `${Math.round(m.leaseSeconds / 60)} min left` : 'permanent'}</td>
                      <td className="py-1.5 text-ink-400">{m.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
