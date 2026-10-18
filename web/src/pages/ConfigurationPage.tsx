import { useEffect, useState } from 'react';
import { Layout, PageHeader } from '../components/Layout.js';
import { Badge, Button, Card, CardTitle, ErrorText, Field, Input, Modal, Notice, Spinner } from '../components/ui.js';
import { Icon } from '../components/icons.js';
import { useToast } from '../components/Toast.js';
import { useConfirm } from '../components/ConfirmDialog.js';
import { EnvironmentBackupCard } from '../components/EnvironmentBackupCard.js';
import { SteamCmdSettingsCard } from '../components/SteamCmdSettingsCard.js';
import { FactoryResetCard } from '../components/FactoryResetCard.js';
import { TwoFactorCard } from '../components/TwoFactorCard.js';
import { NotificationsCard } from '../components/NotificationsCard.js';
import { api, ApiError } from '../api/client.js';
import type { NodeInfo, PanelNode, SandboxStatus, SystemInfo } from '../api/types.js';
import { useAuth } from '../state/AuthContext.js';
import { THEMES, saveTheme, storedTheme, type ThemeOption } from '../lib/theme.js';

function formatUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function HostCard() {
  const [system, setSystem] = useState<SystemInfo | null>(null);
  useEffect(() => {
    api.get<SystemInfo>('/system').then(setSystem).catch(() => setSystem(null));
  }, []);

  const rows: [string, string][] = system
    ? [
        ['Hostname', system.hostname],
        ['Primary address', system.primaryAddress ?? 'Unknown'],
        ['Operating system', `${system.platformLabel} (${system.arch})`],
        ['CPU cores', String(system.cpuCores)],
        ['Memory', `${(system.totalMemMb / 1024).toFixed(1)} GB`],
        ['Host uptime', formatUptime(system.uptimeSec)],
        ['Node.js', system.nodeVersion],
        ['Java', system.java.available ? system.java.version ?? 'Detected' : 'Not found'],
      ]
    : [];

  return (
    <Card className="p-5">
      <CardTitle>This host</CardTitle>
      {!system ? (
        <Spinner />
      ) : (
        <>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
            {rows.map(([k, v]) => (
              <div key={k}>
                <dt className="text-xs text-ink-400">{k}</dt>
                <dd className="mt-0.5 truncate text-sm text-ink-100" title={v}>
                  {v}
                </dd>
              </div>
            ))}
          </dl>
          {system.addresses.length > 0 && (
            <p className="mt-4 text-xs text-ink-500">
              Network addresses:{' '}
              {system.addresses.map((a, i) => (
                <span key={a.address} className="font-mono text-ink-400">
                  {i > 0 && ', '}
                  {a.address} ({a.interface})
                </span>
              ))}
            </p>
          )}
        </>
      )}
    </Card>
  );
}

/** A tiny mock window in the theme's own colors: sidebar, panel, accent button, text lines. */
function ThemePreview({ theme }: { theme: ThemeOption }) {
  const [page, panel, accent, text] = theme.swatch;
  const square = theme.id === 'minecraft';
  const radius = square ? 0 : theme.id === 'xp' ? 3 : 8;
  return (
    <div className="flex h-20 overflow-hidden rounded-xl" style={{ background: page }} aria-hidden="true">
      <div className="w-1/4" style={{ background: theme.id === 'xp' ? 'linear-gradient(#7ba2e7, #6375d6)' : theme.id === 'minecraft' ? '#4a3524' : panel }} />
      <div className="flex-1 p-2">
        <div className="h-full p-2" style={{ background: panel, borderRadius: radius, border: square ? '2px solid #000' : undefined }}>
          <div className="mb-1.5 h-1.5 w-1/2" style={{ background: text, opacity: 0.8, borderRadius: radius }} />
          <div className="mb-2 h-1.5 w-3/4" style={{ background: text, opacity: 0.4, borderRadius: radius }} />
          <div className="h-3 w-10" style={{ background: accent, borderRadius: radius }} />
        </div>
      </div>
    </div>
  );
}

function AppearanceCard() {
  const [current, setCurrent] = useState(storedTheme);
  function choose(id: ThemeOption['id']) {
    saveTheme(id);
    setCurrent(id);
  }
  return (
    <Card className="p-5">
      <CardTitle>Appearance</CardTitle>
      <p className="mb-4 text-sm text-ink-400">Changes the look of the whole panel. Saved in this browser only.</p>
      <div className="grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Theme">
        {THEMES.map((t) => {
          const active = current === t.id;
          return (
            <button
              key={t.id}
              role="radio"
              aria-checked={active}
              onClick={() => choose(t.id)}
              className={`state-layer rounded-2xl p-2 text-left transition-colors ${active ? 'bg-secondary-container ring-2 ring-accent-400' : 'bg-surface-900'}`}
            >
              <ThemePreview theme={t} />
              <p className={`mt-2 px-1 text-sm font-medium ${active ? 'text-secondary-on-container' : 'text-ink-100'}`}>{t.label}</p>
              <p className={`px-1 pb-1 text-xs ${active ? 'text-secondary-on-container opacity-80' : 'text-ink-400'}`}>{t.description}</p>
            </button>
          );
        })}
      </div>
    </Card>
  );
}

function SecurityCard() {
  const toast = useToast();
  const [sandbox, setSandbox] = useState<SandboxStatus | null>(null);
  useEffect(() => {
    api.get<{ sandbox: SandboxStatus }>('/settings/security').then((r) => setSandbox(r.sandbox)).catch(() => {});
  }, []);

  async function toggle(enabled: boolean) {
    try {
      const r = await api.put<{ sandbox: SandboxStatus }>('/settings/security', { sandboxEnabled: enabled });
      setSandbox(r.sandbox);
      toast.success(enabled ? 'Sandbox on — applies from each instance’s next start' : 'Sandbox off — applies from each instance’s next start');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to change the sandbox setting');
    }
  }

  const active = sandbox?.available && sandbox.enabled;
  return (
    <Card className="p-5">
      <CardTitle action={sandbox && <Badge tone={active ? 'green' : 'yellow'}>{active ? 'Protected' : sandbox.available ? 'Off' : 'Unavailable'}</Badge>}>Security</CardTitle>
      <div className="space-y-3 text-sm text-ink-300">
        <p>Every instance is kept to its own folder:</p>
        <ul className="space-y-1.5">
          <li>🛡️ <b className="text-ink-100">Process sandbox</b> — instance processes run under bubblewrap: their folder is the only writable place, system folders are read-only, and home folders, other instances and the panel’s data are hidden.</li>
          <li>🔗 <b className="text-ink-100">Symlink-proof file access</b> — the panel never follows a link out of an instance folder (files, uploads, plugins, snapshots).</li>
          <li>🧹 <b className="text-ink-100">Clean environment</b> — instances never inherit the panel’s environment variables or secrets.</li>
          <li>🐳 <b className="text-ink-100">Docker instances</b> — containers only see their mounted folder, with memory/process limits and no-new-privileges.</li>
        </ul>
        {sandbox && !sandbox.available && <Notice tone="warning">{sandbox.reason}</Notice>}
        {sandbox?.available && (
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={sandbox.enabled} onChange={(e) => toggle(e.target.checked)} />
            Sandbox instance processes ({sandbox.version})
          </label>
        )}
      </div>
    </Card>
  );
}

function NodeRow({ node, onRemoved }: { node: PanelNode; onRemoved: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [status, setStatus] = useState<{ online: boolean; info: NodeInfo | null; error: string | null } | null>(null);

  async function check() {
    setStatus(null);
    try {
      setStatus(await api.get(`/nodes/${node.id}/status`));
    } catch (err) {
      setStatus({ online: false, info: null, error: err instanceof ApiError ? err.message : 'Check failed' });
    }
  }

  useEffect(() => {
    check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]);

  async function remove() {
    const ok = await confirm({
      title: 'Remove node',
      message: `Remove “${node.name}” from this panel? Nothing on that host is changed.`,
      confirmLabel: 'Remove',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api.delete(`/nodes/${node.id}`);
      toast.success(`Removed ${node.name}`);
      onRemoved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to remove node');
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3">
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-700 text-ink-300">
        <Icon name="node" className="h-[18px] w-[18px]" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium text-ink-100">{node.name}</p>
          {status === null ? (
            <Badge tone="neutral">Checking…</Badge>
          ) : status.online ? (
            <Badge tone="green" pulse>
              Online
            </Badge>
          ) : (
            <Badge tone="red">Offline</Badge>
          )}
        </div>
        <p className="truncate text-xs text-ink-400">
          {node.url} · key {node.keyHint}
          {status?.info && ` · ${status.info.hostname} · ${status.info.instances} instances (${status.info.running} running)`}
          {status && !status.online && status.error && ` · ${status.error}`}
        </p>
      </div>
      <Button variant="ghost" onClick={check}>
        <Icon name="refresh" className="h-4 w-4" /> Check
      </Button>
      <Button variant="danger" onClick={remove}>
        Remove
      </Button>
    </div>
  );
}

function NodesCard() {
  const toast = useToast();
  const confirm = useConfirm();
  const [nodes, setNodes] = useState<PanelNode[] | null>(null);
  const [localKey, setLocalKey] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  async function load() {
    try {
      const [n, local] = await Promise.all([
        api.get<{ nodes: PanelNode[] }>('/nodes'),
        api.get<{ nodeKey: string }>('/nodes/local'),
      ]);
      setNodes(n.nodes);
      setLocalKey(local.nodeKey);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to load nodes');
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function regenerate() {
    const ok = await confirm({
      title: 'Regenerate node key',
      message: 'Other panels using the current key will no longer be able to send instances here until you update the key on them.',
      confirmLabel: 'Regenerate',
      tone: 'danger',
    });
    if (!ok) return;
    const res = await api.post<{ nodeKey: string }>('/nodes/local/regenerate');
    setLocalKey(res.nodeKey);
    setShowKey(true);
    toast.success('Node key regenerated');
  }

  return (
    <Card className="p-5">
      <CardTitle
        action={
          <Button variant="primary" onClick={() => setAddOpen(true)}>
            <Icon name="plus" className="h-4 w-4" /> Add node
          </Button>
        }
      >
        Nodes
      </CardTitle>
      <p className="mb-4 text-sm text-ink-400">
        Link other hosts running Outpost so instances can be transferred between them — from an instance's Configuration page.
      </p>

      <div className="mb-4 rounded-2xl bg-surface-900 p-4">
        <p className="mb-2 text-xs font-medium text-ink-300">This node's key — paste it into another panel to let it send instances here</p>
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-lg bg-surface-1000 px-3 py-2 font-mono text-xs text-ink-100">
            {localKey ? (showKey ? localKey : `${localKey.slice(0, 6)}${'•'.repeat(24)}`) : '…'}
          </code>
          <Button variant="ghost" onClick={() => setShowKey((v) => !v)}>
            <Icon name="eye" className="h-4 w-4" /> {showKey ? 'Hide' : 'Show'}
          </Button>
          <Button
            variant="ghost"
            onClick={() =>
              localKey &&
              navigator.clipboard
                ?.writeText(localKey)
                .then(() => toast.success('Node key copied'))
                .catch(() => toast.error('Clipboard unavailable'))
            }
          >
            <Icon name="copy" className="h-4 w-4" /> Copy
          </Button>
          <Button variant="ghost" onClick={regenerate}>
            <Icon name="key" className="h-4 w-4" /> Regenerate
          </Button>
        </div>
      </div>

      {nodes === null ? (
        <Spinner />
      ) : nodes.length === 0 ? (
        <p className="py-4 text-center text-sm text-ink-500">No other nodes linked yet.</p>
      ) : (
        <div className="divide-y divide-surface-700 overflow-hidden rounded-2xl bg-surface-900">
          {nodes.map((n) => (
            <NodeRow key={n.id} node={n} onRemoved={load} />
          ))}
        </div>
      )}

      <AddNodeModal open={addOpen} onClose={() => setAddOpen(false)} onAdded={load} />
    </Card>
  );
}

function AddNodeModal({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError('');
    try {
      const res = await api.post<{ node: PanelNode; info: NodeInfo }>('/nodes', { name, url, apiKey });
      toast.success(`Linked ${res.node.name} (${res.info.hostname})`);
      setName('');
      setUrl('');
      setApiKey('');
      onAdded();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to add node');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add node">
      <div className="space-y-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Frankfurt box" autoFocus />
        </Field>
        <Field label="Panel URL">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://10.0.0.5:8642" />
        </Field>
        <Field label="That panel's node key">
          <Input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="mcn_…" className="font-mono" />
        </Field>
        <p className="text-xs text-ink-500">
          Find the key on the other panel under Configuration → Nodes. Outpost checks the connection before saving. Use HTTPS
          (or a private network/VPN) between nodes — instance files are sent over this connection.
        </p>
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !name || !url || !apiKey} onClick={submit}>
            {busy ? 'Connecting…' : 'Add node'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function ConfigurationPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  return (
    <Layout>
      <div className="stagger mx-auto max-w-5xl space-y-5 px-4 py-8 sm:px-8">
        <PageHeader title="Configuration" subtitle="Panel-wide settings for this Outpost host." />
        <AppearanceCard />
        <TwoFactorCard />
        <HostCard />
        {isAdmin ? (
          <>
            <SecurityCard />
            <NotificationsCard />
            <NodesCard />
            <EnvironmentBackupCard />
            <SteamCmdSettingsCard />
            <FactoryResetCard />
          </>
        ) : (
          <p className="text-sm text-ink-400">Panel-wide settings are only available to admins. Per-instance settings live in each instance's Configuration page.</p>
        )}
      </div>
    </Layout>
  );
}
