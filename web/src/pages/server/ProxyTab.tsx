import { useEffect, useState } from 'react';
import { useServerDetail } from './ServerContext.js';
import { api, ApiError } from '../../api/client.js';
import type { ProxyBackend, ProxyCandidate, ProxyForwarding, ProxyNetwork } from '../../api/types.js';
import { Badge, Button, Card, CardTitle, Field, Input, Notice, Select, Spinner } from '../../components/ui.js';
import { Icon } from '../../components/icons.js';
import { useToast } from '../../components/Toast.js';

const FORWARDING_LABEL: Record<ProxyForwarding, string> = {
  none: 'None — backends see the proxy’s IP and offline UUIDs',
  legacy: 'Legacy (BungeeCord) — Spigot, Paper, Purpur',
  bungeeguard: 'BungeeGuard — legacy plus a token (needs the BungeeGuard plugin)',
  modern: 'Modern (Velocity) — Paper 1.13+, most secure',
};

const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'server';

/** Network: the proxy's backend servers, join order and forwarding — plus one-click linking of Outpost instances. */
export function ProxyTab() {
  const { serverId, can, running } = useServerDetail();
  const toast = useToast();
  const canEdit = can('settings');
  const base = `/servers/${serverId}/proxy`;
  const [network, setNetwork] = useState<ProxyNetwork | null>(null);
  const [candidates, setCandidates] = useState<ProxyCandidate[]>([]);
  const [backends, setBackends] = useState<ProxyBackend[]>([]);
  const [tryOrder, setTryOrder] = useState<string[]>([]);
  const [forwarding, setForwarding] = useState<ProxyForwarding>('none');
  const [onlineMode, setOnlineMode] = useState(true);
  const [linkId, setLinkId] = useState('');
  const [linkName, setLinkName] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [report, setReport] = useState<{ changes: string[]; warnings: string[] } | null>(null);

  const apply = (n: ProxyNetwork) => {
    setNetwork(n);
    setBackends(n.backends);
    setTryOrder(n.tryOrder);
    setForwarding(n.forwarding);
    setOnlineMode(n.onlineMode);
  };

  async function load() {
    try {
      const res = await api.get<{ network: ProxyNetwork; candidates: ProxyCandidate[] }>(base);
      apply(res.network);
      setCandidates(res.candidates);
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load the network settings');
    }
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);

  if (error && !network) return <Notice tone="error">{error}</Notice>;
  if (!network) return <Spinner />;

  const dirty =
    JSON.stringify(backends) !== JSON.stringify(network.backends) ||
    JSON.stringify(tryOrder) !== JSON.stringify(network.tryOrder) ||
    forwarding !== network.forwarding ||
    onlineMode !== network.onlineMode;
  const modes: ProxyForwarding[] = network.kind === 'velocity' ? ['none', 'legacy', 'bungeeguard', 'modern'] : ['none', 'legacy'];
  const linkedAddresses = new Set(backends.map((b) => b.address));

  function updateBackend(i: number, patch: Partial<ProxyBackend>) {
    setBackends((list) => {
      const next = list.map((b, j) => (j === i ? { ...b, ...patch } : b));
      if (patch.name !== undefined) setTryOrder((order) => order.map((n) => (n === list[i].name ? patch.name! : n)));
      return next;
    });
  }

  function removeBackend(i: number) {
    const name = backends[i].name;
    setBackends((list) => list.filter((_, j) => j !== i));
    setTryOrder((order) => order.filter((n) => n !== name));
  }

  function toggleTry(name: string) {
    setTryOrder((order) => (order.includes(name) ? order.filter((n) => n !== name) : [...order, name]));
  }

  function moveTry(name: string, delta: number) {
    setTryOrder((order) => {
      const i = order.indexOf(name);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= order.length) return order;
      const next = [...order];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  async function save() {
    setBusy('save');
    try {
      const res = await api.put<{ network: ProxyNetwork }>(base, { backends, tryOrder, forwarding, onlineMode });
      apply(res.network);
      toast.success(running ? 'Saved — restart the proxy to apply' : 'Network saved');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Save failed');
    } finally {
      setBusy('');
    }
  }

  async function link() {
    if (!linkId) return;
    setBusy('link');
    setReport(null);
    try {
      const res = await api.post<{ network: ProxyNetwork; changes: string[]; warnings: string[] }>(`${base}/link`, { backendId: linkId, name: linkName.trim() || undefined });
      apply(res.network);
      setReport({ changes: res.changes, warnings: res.warnings });
      setLinkId('');
      setLinkName('');
      toast.success('Linked — restart the proxy and the backend to apply');
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Link failed');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="space-y-5">
      {!network.configured && (
        <Notice tone="info">
          Start the proxy once so it writes <span className="font-mono">{network.configFile}</span> — then its servers, join order and forwarding can be set up here.
        </Notice>
      )}

      <Card className="p-5">
        <CardTitle
          action={
            canEdit &&
            network.configured && (
              <Button variant="primary" onClick={save} disabled={!dirty || busy !== ''}>
                {busy === 'save' ? <Spinner /> : null} Save
              </Button>
            )
          }
        >
          Backend servers
        </CardTitle>
        <p className="mb-4 text-sm text-ink-400">
          Players join the proxy and get sent to these servers. Names are what <span className="font-mono">/server</span> uses; saved to{' '}
          <span className="font-mono">{network.configFile}</span>.
        </p>

        {backends.length === 0 ? (
          <p className="text-sm text-ink-400">No backend servers yet.</p>
        ) : (
          <div className="space-y-2">
            {backends.map((b, i) => {
              const order = tryOrder.indexOf(b.name);
              return (
                <div key={i} className="flex flex-wrap items-center gap-2 rounded-xl bg-surface-900 p-2">
                  <div className="w-40">
                    <Input value={b.name} disabled={!canEdit} onChange={(e) => updateBackend(i, { name: e.target.value })} aria-label="Server name" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <Input className="font-mono" value={b.address} disabled={!canEdit} onChange={(e) => updateBackend(i, { address: e.target.value })} aria-label="Address" />
                  </div>
                  <button
                    disabled={!canEdit}
                    onClick={() => toggleTry(b.name)}
                    title="Send players here when they join (in order)"
                    className={`state-layer rounded-full px-3 py-1.5 text-xs font-medium ${order >= 0 ? 'bg-secondary-container text-secondary-on-container' : 'text-ink-400'}`}
                  >
                    {order >= 0 ? `Join #${order + 1}` : 'Not on join'}
                  </button>
                  {order >= 0 && canEdit && (
                    <span className="flex">
                      <Button variant="ghost" onClick={() => moveTry(b.name, -1)} disabled={order === 0} aria-label="Earlier">
                        <Icon name="chevronUp" className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" onClick={() => moveTry(b.name, 1)} disabled={order === tryOrder.length - 1} aria-label="Later">
                        <Icon name="chevronDown" className="h-4 w-4" />
                      </Button>
                    </span>
                  )}
                  {network.kind === 'bungee' && (
                    <label className="flex items-center gap-1.5 text-xs text-ink-300" title="Only players with bungeecord.server.<name> can join">
                      <input type="checkbox" disabled={!canEdit} checked={!!b.restricted} onChange={(e) => updateBackend(i, { restricted: e.target.checked })} />
                      Restricted
                    </label>
                  )}
                  {canEdit && (
                    <Button variant="ghost" onClick={() => removeBackend(i)} aria-label={`Remove ${b.name}`}>
                      <Icon name="trash" className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {canEdit && network.configured && (
          <Button
            className="mt-3"
            onClick={() => {
              let n = backends.length + 1;
              while (backends.some((b) => b.name === `server${n}`)) n++;
              setBackends([...backends, { name: `server${n}`, address: '127.0.0.1:25565' }]);
            }}
          >
            <Icon name="plus" className="h-4 w-4" /> Add server
          </Button>
        )}

        {network.configured && (
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <Field label="Player info forwarding">
              <Select value={forwarding} disabled={!canEdit} onChange={(e) => setForwarding(e.target.value as ProxyForwarding)}>
                {modes.map((m) => (
                  <option key={m} value={m}>
                    {FORWARDING_LABEL[m]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Authentication">
              <Select value={onlineMode ? 'online' : 'offline'} disabled={!canEdit} onChange={(e) => setOnlineMode(e.target.value === 'online')}>
                <option value="online">Online mode — the proxy checks Mojang accounts</option>
                <option value="offline">Offline mode — anyone can join with any name</option>
              </Select>
            </Field>
          </div>
        )}
        {!onlineMode && (
          <div className="mt-3">
            <Notice tone="warning">With online mode off, anyone can join as any player name — including your admins.</Notice>
          </div>
        )}
      </Card>

      {network.configured && canEdit && (
        <Card className="p-5">
          <CardTitle>Link an Outpost instance</CardTitle>
          <p className="mb-4 text-sm text-ink-400">
            Adds a Java server from this panel behind the proxy and configures it for you: offline mode (the proxy signs players in) plus{' '}
            {network.kind === 'velocity' ? 'Velocity modern forwarding on Paper/Purpur, or legacy forwarding on Spigot' : 'BungeeCord forwarding in spigot.yml'}.
          </p>
          {candidates.length === 0 ? (
            <p className="text-sm text-ink-400">No Java servers you can configure are on this node.</p>
          ) : (
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Instance">
                <Select
                  value={linkId}
                  onChange={(e) => {
                    setLinkId(e.target.value);
                    const c = candidates.find((x) => x.id === e.target.value);
                    setLinkName(c ? slugify(c.name) : '');
                  }}
                >
                  <option value="">Choose a server…</option>
                  {candidates.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} · {c.loader} {c.version} · {c.address}
                      {linkedAddresses.has(c.address) ? ' (linked)' : ''}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Name on the proxy">
                <Input value={linkName} onChange={(e) => setLinkName(e.target.value)} placeholder="survival" />
              </Field>
              <Button variant="primary" onClick={link} disabled={!linkId || busy !== '' || dirty} title={dirty ? 'Save or discard your edits first' : undefined}>
                {busy === 'link' ? <Spinner /> : <Icon name="node" className="h-4 w-4" />} Link
              </Button>
            </div>
          )}
          {report && (
            <div className="mt-4 space-y-2 text-sm">
              {report.changes.map((c) => (
                <p key={c} className="flex gap-2 text-ink-200">
                  <Badge tone="green">done</Badge> {c}
                </p>
              ))}
              {report.warnings.map((w) => (
                <Notice key={w} tone="warning">
                  {w}
                </Notice>
              ))}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
