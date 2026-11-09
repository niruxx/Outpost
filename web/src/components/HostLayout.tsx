import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Layout } from './Layout.js';
import { Icon } from './icons.js';
import { Button, ErrorText, Field, Input, Modal, Notice, Select } from './ui.js';
import { useToast } from './Toast.js';
import { api, ApiError } from '../api/client.js';
import { setHostTarget, useHostAdmin, useHostTarget } from '../state/hostTarget.js';

export const HOST_TABS = [
  { to: '/host', label: 'Overview', icon: 'monitor', subtitle: 'Identity, time, power and performance profile of this host.' },
  { to: '/host/metrics', label: 'Metrics', icon: 'cpu', subtitle: 'Resource history for the host and its busiest services.' },
  { to: '/host/services', label: 'Services', icon: 'list', subtitle: 'Start, stop and enable systemd services, and schedule commands with timers.' },
  { to: '/host/software', label: 'Software', icon: 'apps', subtitle: 'Install updates and add or remove software from your distribution’s repositories.' },
  { to: '/host/accounts', label: 'Accounts', icon: 'users', subtitle: 'Operating-system users, groups, SSH keys and login sessions.' },
  { to: '/host/network', label: 'Networking', icon: 'network', subtitle: 'Interfaces, addresses, bonds, bridges and VLANs through NetworkManager.' },
  { to: '/host/security', label: 'Security', icon: 'shieldCheck', subtitle: 'SELinux or AppArmor, crypto policy and the panel’s HTTPS certificate.' },
  { to: '/host/diagnostics', label: 'Diagnostics', icon: 'warning', subtitle: 'Diagnostic reports and kernel crash dumps.' },
] as const;

interface NodeSummary {
  id: string;
  name: string;
  url: string;
}

/** Picks the host the Host pages act on: this one or a linked node. */
function HostSwitcher() {
  const target = useHostTarget();
  const [nodes, setNodes] = useState<NodeSummary[] | null>(null);
  useEffect(() => {
    api
      .get<{ nodes: NodeSummary[] }>('/nodes')
      .then((r) => setNodes(r.nodes))
      .catch(() => setNodes([]));
  }, []);
  if (!nodes?.length && !target.nodeId) return null;
  return (
    <Select
      aria-label="Host"
      className="w-auto min-w-[10rem]"
      value={target.nodeId ?? ''}
      onChange={(e) => {
        const node = nodes?.find((n) => n.id === e.target.value);
        setHostTarget(node ? { nodeId: node.id, name: node.name } : { nodeId: null, name: null });
      }}
    >
      <option value="">This host</option>
      {(nodes ?? []).map((n) => (
        <option key={n.id} value={n.id}>
          {n.name}
        </option>
      ))}
    </Select>
  );
}

/** Admin Mode for the selected host (the top-bar button only covers this host). */
export function HostAdminButton() {
  const toast = useToast();
  const admin = useHostAdmin();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const status = admin.status;
  const where = admin.target.name ?? 'this host';

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (admin.active) await admin.disable();
      else await admin.enable(password);
      toast.success(admin.active ? `Limited access on ${where}` : `Admin Mode on for ${where}`);
      setOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t switch Admin Mode');
    } finally {
      setBusy(false);
      setPassword('');
    }
  }

  if (admin.error) return <span className="text-xs text-red-400">{admin.error}</span>;
  if (!status) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`state-layer flex h-9 items-center gap-1.5 rounded-full px-3 text-xs font-medium ${admin.active ? 'bg-yellow-500/20 text-yellow-300 ring-1 ring-yellow-500/40' : 'text-ink-300 ring-1 ring-surface-600'}`}
      >
        <Icon name={admin.active ? 'unlock' : 'lock'} className="h-4 w-4" />
        {admin.active ? 'Admin Mode' : 'Limited access'}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={admin.active ? `Administrative access — ${where}` : `Administrative access for ${where}`}>
        {status.admin.alwaysOn ? (
          <Notice tone="warning">Outpost on {where} runs with administrative rights, so changes always run as root.</Notice>
        ) : !status.admin.available && !admin.active ? (
          <Notice tone="info">{status.admin.reason ?? 'Admin Mode is unavailable on this host.'}</Notice>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            {admin.active ? (
              <p className="text-sm text-ink-300">Changes on {where} run as root in this browser session. Switch back to limited access when you’re done.</p>
            ) : (
              <>
                <p className="text-sm text-ink-300">
                  Changes on {where} will run as <b>root</b> through sudo as <b>{status.serviceUser}</b>. Every change is audited.
                </p>
                {status.admin.needsPassword ? (
                  <Field label={`Password for ${status.serviceUser} on ${where}`}>
                    <Input type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                  </Field>
                ) : (
                  <Notice tone="info">This account can use sudo without a password.</Notice>
                )}
              </>
            )}
            <ErrorText>{error}</ErrorText>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={busy || (!admin.active && status.admin.needsPassword && !password)}>
                {busy ? 'Working…' : admin.active ? 'Limit access' : 'Authenticate'}
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}

/** Shell for the Host area: title, host switcher, Admin Mode for the target, and section tabs. */
export function HostLayout({ children, action }: { children: ReactNode; action?: ReactNode }) {
  const { pathname } = useLocation();
  const target = useHostTarget();
  const current = HOST_TABS.find((t) => t.to === pathname.replace(/\/$/, '')) ?? HOST_TABS[0];
  return (
    <Layout>
      <div className="mx-auto max-w-6xl space-y-5 px-4 py-8 sm:px-8">
        <motion.header initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="ui-page-header flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="ui-page-title text-[28px] font-normal leading-9 text-ink-50">
              {current.label}
              {target.name && <span className="ml-2 text-base text-ink-400">on {target.name}</span>}
            </h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ink-400">{current.subtitle}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {action}
            <HostSwitcher />
            <HostAdminButton />
          </div>
        </motion.header>
        <nav aria-label="Host sections" className="flex max-w-full flex-wrap gap-1 rounded-3xl border border-surface-700 bg-surface-900 p-1">
          {HOST_TABS.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              end
              className={({ isActive }) =>
                `inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${isActive ? 'bg-secondary-container text-secondary-on-container' : 'text-ink-400 hover:bg-surface-800 hover:text-ink-100'}`
              }
            >
              <Icon name={tab.icon} className="h-4 w-4" />
              {tab.label}
            </NavLink>
          ))}
        </nav>
        {/* Re-mount on host change so every page reloads its data for the new target. */}
        <div key={target.nodeId ?? 'local'} className="space-y-5">
          {children}
        </div>
      </div>
    </Layout>
  );
}

/** Small shared bits for Host pages. */
export function AdminNotice({ active, what }: { active: boolean; what: string }) {
  if (active) return null;
  return (
    <Notice tone="info">
      You can look around with limited access. To {what}, turn on <b>Admin Mode</b> with the lock button above.
    </Notice>
  );
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let x = n;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i++;
  }
  return `${x.toFixed(x < 10 && i ? 1 : 0)} ${units[i]}`;
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}
