import { useEffect, useState } from 'react';
import { saveEffects, useEffectsMode } from '../lib/perf.js';
import { DbHostsCard } from '../components/DbHostsCard.js';
import { ApiKeysCard } from '../components/ApiKeysCard.js';
import { OffsiteCard } from '../components/OffsiteCard.js';
import { SftpCard } from '../components/SftpCard.js';
import { TemplatesCard } from '../components/TemplatesCard.js';
import { LanguageSelect, t } from '../i18n/index.js';
import { ConsoleLogRetentionCard } from '../components/ConsoleLogRetentionCard.js';
import { JavaRuntimesCard } from '../components/JavaRuntimesCard.js';
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
import { CurseForgeCard } from '../components/CurseForgeCard.js';
import { UserThemesPanel } from '../components/UserThemesPanel.js';
import { AuditRetentionCard } from '../components/AuditRetentionCard.js';
import { api, ApiError } from '../api/client.js';
import type { NodeInfo, PanelNode, SandboxStatus, SystemInfo, WineStatus } from '../api/types.js';
import { useAuth } from '../state/AuthContext.js';
import { THEMES, saveTheme, saveWallpaper, storedTheme, storedWallpaper, type ThemeOption } from '../lib/theme.js';

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
  const { radius, border } = theme.preview;
  return (
    <div className="flex h-20 overflow-hidden rounded-xl" style={{ background: theme.preview.page ?? page }} aria-hidden="true">
      <div className="w-1/4" style={{ background: theme.preview.sidebar }} />
      <div className="flex-1 p-2">
        <div className="h-full p-2" style={{ background: panel, borderRadius: radius, border }}>
          <div className="mb-1.5 h-1.5 w-1/2" style={{ background: text, opacity: 0.8, borderRadius: radius }} />
          <div className="mb-2 h-1.5 w-3/4" style={{ background: text, opacity: 0.4, borderRadius: radius }} />
          <div className="h-3 w-10" style={{ background: accent, borderRadius: radius }} />
        </div>
      </div>
    </div>
  );
}

function AppearanceCard({ isAdmin }: { isAdmin: boolean }) {
  const [current, setCurrent] = useState(storedTheme);
  const [animated, setAnimated] = useState(() => storedWallpaper() === 'animated');
  const effects = useEffectsMode();
  function choose(id: ThemeOption['id']) {
    saveTheme(id);
    setCurrent(id);
  }
  return (
    <Card className="p-5">
      <CardTitle action={<LanguageSelect className="!w-auto !py-1 text-xs" />}>Appearance</CardTitle>
      <p className="mb-4 text-sm text-ink-400">
        Changes the look of the whole panel for you. Saved in this browser{isAdmin ? '.' : ' — an admin can also give your account a theme.'}
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" role="radiogroup" aria-label="Theme">
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
      <label className="mt-4 flex items-center gap-3 rounded-2xl bg-surface-900 p-3 text-sm text-ink-200">
        <input
          type="checkbox"
          checked={animated}
          onChange={(e) => {
            setAnimated(e.target.checked);
            saveWallpaper(e.target.checked ? 'animated' : 'static');
          }}
        />
        <span>
          <span className="font-medium">Animated wallpaper</span>
          <span className="block text-xs text-ink-400">Each theme has its own background. Turn this off for a still picture (it’s also still when your device asks for reduced motion).</span>
        </span>
      </label>
      <label className="mt-3 flex cursor-pointer items-start gap-3 text-sm text-ink-200">
        <input type="checkbox" className="mt-1" checked={effects === 'reduced'} onChange={(e) => saveEffects(e.target.checked ? 'reduced' : 'full')} />
        <span>
          <span className="font-medium">{t('Reduce effects')}</span>
          <span className="block text-xs text-ink-400">
            {t('Turns off animations, glass blur and pulsing status dots — much lighter on laptops and older GPUs. On automatically when your device asks for reduced motion.')}
          </span>
        </span>
      </label>
      {isAdmin && <UserThemesPanel />}
    </Card>
  );
}

function WineCard() {
  const [wine, setWine] = useState<WineStatus | null>(null);
  useEffect(() => {
    api.get<WineStatus>('/servers/wine/status').then(setWine).catch(() => setWine(null));
  }, []);
  if (!wine) return null;
  const tone = (!wine.supported ? 'neutral' : wine.available ? 'green' : 'yellow') as 'neutral' | 'green' | 'yellow';
  return (
    <Card className="p-5">
      <CardTitle action={<Badge tone={tone}>{!wine.supported ? 'Not needed' : wine.available ? 'Installed' : 'Not installed'}</Badge>}>Wine</CardTitle>
      <div className="space-y-2 text-sm text-ink-300">
        <p>Runs Windows-only dedicated servers (Call of Duty: Black Ops III and others) on Linux. Each instance gets its own Wine prefix, and its launch settings choose whether Wine is used automatically, always or never.</p>
        {wine.available && (
          <ul className="space-y-1 text-xs">
            <li>Version: <span className="font-mono text-ink-100">{wine.version ?? 'unknown'}</span></li>
            <li>Binary: <span className="font-mono text-ink-100">{wine.path}</span></li>
            <li>Virtual screen (xvfb-run): {wine.xvfb ? 'available' : 'not installed'}</li>
          </ul>
        )}
        {wine.hint && <Notice tone={wine.supported ? 'warning' : 'info'}>{wine.hint}</Notice>}
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
      <div className="flex w-full flex-wrap justify-end gap-2 sm:w-auto">
        <Button variant="ghost" onClick={check}>
          <Icon name="refresh" className="h-4 w-4" /> Check
        </Button>
        <Button variant="danger" onClick={remove}>
          Remove
        </Button>
      </div>
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
        <AppearanceCard isAdmin={isAdmin} />
        <TwoFactorCard />
        <SftpCard isAdmin={isAdmin} />
        <ApiKeysCard isAdmin={isAdmin} />
        <HostCard />
        {isAdmin ? (
          <>
            <SecurityCard />
            <WineCard />
            <JavaRuntimesCard />
            <NotificationsCard />
            <AuditRetentionCard />
            <ConsoleLogRetentionCard />
            <TemplatesCard isAdmin />
            <OffsiteCard />
            <DbHostsCard />
            <NodesCard />
            <EnvironmentBackupCard />
            <CurseForgeCard />
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
