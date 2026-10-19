import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Layout, PageHeader } from '../components/Layout.js';
import { Badge, Button, Card, CardTitle, ErrorText, Field, Input, Notice, Select, Spinner } from '../components/ui.js';
import { Icon } from '../components/icons.js';
import { useToast } from '../components/Toast.js';
import { useConfirm } from '../components/ConfirmDialog.js';
import { api, ApiError } from '../api/client.js';
import type { FirewallAccess, FirewallInstancePort, FirewallRule, FirewallStatus } from '../api/types.js';

interface FirewallResponse {
  status: FirewallStatus;
  access: FirewallAccess;
  isAdmin: boolean;
  instancePorts: FirewallInstancePort[];
}

const BACKEND_LABEL = { ufw: 'UFW', firewalld: 'firewalld' } as const;

function ruleTitle(rule: FirewallRule): string {
  if (!rule.port) return rule.label ?? 'rule';
  return `${rule.port}${rule.protocol === 'any' ? '' : `/${rule.protocol}`}`;
}

/** Rules that open exactly this instance port to everyone — what "Close" removes. */
function exactRules(rules: FirewallRule[], port: number, protocol: 'tcp' | 'udp') {
  return rules.filter(
    (r) => (r.action === 'allow' || r.action === 'limit') && !r.source && r.direction === 'in' && r.port === String(port) && (r.protocol === protocol || r.protocol === 'any')
  );
}

export function FirewallPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [data, setData] = useState<FirewallResponse | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  // New-rule form
  const [port, setPort] = useState('');
  const [protocol, setProtocol] = useState<'tcp' | 'udp' | 'any'>('tcp');
  const [action, setAction] = useState<'allow' | 'deny'>('allow');
  const [source, setSource] = useState('');
  const [comment, setComment] = useState('');
  const [formError, setFormError] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await api.get<FirewallResponse>('/firewall'));
      setLoadError('');
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load the firewall');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /** Runs a change; when the server asks for confirmation (SSH/panel ports) asks the admin and retries with force. */
  async function change(key: string, fn: (force: boolean) => Promise<unknown>, done: string) {
    setBusy(key);
    try {
      try {
        await fn(false);
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 409)) throw err;
        const ok = await confirm({ title: 'Risk of locking yourself out', message: err.message, confirmLabel: 'Do it anyway', tone: 'danger' });
        if (!ok) return;
        await fn(true);
      }
      toast.success(done);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Firewall change failed');
    } finally {
      setBusy(null);
    }
  }

  async function addRule() {
    setFormError('');
    const body = { port, protocol, action, source: source || null, comment: comment || null };
    setBusy('add');
    try {
      try {
        await api.post('/firewall/rules', body);
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 409)) throw err;
        const ok = await confirm({ title: 'Risk of locking yourself out', message: err.message, confirmLabel: 'Block it anyway', tone: 'danger' });
        if (!ok) return;
        await api.post('/firewall/rules', { ...body, force: true });
      }
      toast.success(`${action === 'allow' ? 'Allowed' : 'Blocked'} ${port}`);
      setPort('');
      setSource('');
      setComment('');
      await load();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Failed to add the rule');
    } finally {
      setBusy(null);
    }
  }

  async function removeRule(rule: FirewallRule) {
    const ok = await confirm({
      title: 'Remove firewall rule',
      message: `Remove “${rule.action} ${ruleTitle(rule)}${rule.source ? ` from ${rule.source}` : ''}”?`,
      confirmLabel: 'Remove',
      tone: 'danger',
    });
    if (!ok) return;
    await change(rule.id, (force) => api.post('/firewall/rules/delete', { id: rule.id, force }), `Removed ${ruleTitle(rule)}`);
  }

  async function toggleInstancePort(p: FirewallInstancePort) {
    if (!data) return;
    if (!p.open) {
      await change(`inst-${p.serverId}`, () => api.post('/firewall/rules', { port: p.port, protocol: p.protocol, action: 'allow', comment: p.name }), `Opened ${p.port}/${p.protocol} for ${p.name}`);
      return;
    }
    const rules = exactRules(data.status.rules, p.port, p.protocol);
    if (!rules.length) {
      toast.error(`${p.port}/${p.protocol} is open through a wider rule (a range, or the default policy) — change that rule below instead`);
      return;
    }
    const ok = await confirm({ title: 'Close port', message: `Close ${p.port}/${p.protocol}? Players won’t be able to reach ${p.name} from outside this machine.`, confirmLabel: 'Close port', tone: 'danger' });
    if (!ok) return;
    await change(
      `inst-${p.serverId}`,
      async (force) => {
        for (const r of rules) await api.post('/firewall/rules/delete', { id: r.id, force });
      },
      `Closed ${p.port}/${p.protocol}`
    );
  }

  async function setEnabled(enabled: boolean) {
    if (!enabled) {
      const ok = await confirm({ title: 'Turn off the firewall', message: 'Every port on this machine becomes reachable from the network.', confirmLabel: 'Turn off', tone: 'danger' });
      if (!ok) return;
    }
    setBusy('toggle');
    try {
      const res = await api.post<{ added: string[] }>('/firewall/enabled', { enabled });
      toast.success(enabled ? `Firewall on${res.added.length ? ` — also allowed ${res.added.join(', ')}` : ''}` : 'Firewall off');
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to switch the firewall');
    } finally {
      setBusy(null);
    }
  }

  const status = data?.status;
  const canChange = data?.access === 'instances' || data?.access === 'manage';
  const canManage = data?.access === 'manage';

  return (
    <Layout>
      <div className="mx-auto max-w-5xl space-y-5 px-4 py-8 sm:px-8">
        <PageHeader title="Firewall" subtitle="Open and close ports on this machine’s firewall." />

        {loadError ? (
          <Notice tone="error">{loadError}</Notice>
        ) : !data || !status ? (
          <Spinner />
        ) : (
          <>
            <Card className="p-5">
              <CardTitle
                action={
                  status.backend && (
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="neutral">{BACKEND_LABEL[status.backend]}</Badge>
                      {status.available && <Badge tone={status.active ? 'green' : 'yellow'}>{status.active ? 'Active' : 'Off'}</Badge>}
                    </div>
                  )
                }
              >
                Status
              </CardTitle>
              {status.reason && (
                <div className="mb-3 space-y-2">
                  <Notice tone="warning">{status.reason}</Notice>
                  {status.sudoersHint && (
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="min-w-0 flex-1 break-all rounded-lg bg-surface-1000 px-3 py-2 font-mono text-xs text-ink-100">{status.sudoersHint}</code>
                      <Button
                        variant="ghost"
                        onClick={() =>
                          navigator.clipboard
                            ?.writeText(status.sudoersHint!)
                            .then(() => toast.success('Copied'))
                            .catch(() => toast.error('Clipboard unavailable'))
                        }
                      >
                        <Icon name="copy" className="h-4 w-4" /> Copy
                      </Button>
                    </div>
                  )}
                </div>
              )}
              {status.available && (
                <div className="space-y-3 text-sm text-ink-300">
                  <p>
                    {status.active
                      ? `${BACKEND_LABEL[status.backend!]} is filtering incoming connections${status.defaults ? ` — ${status.defaults}` : ''}.`
                      : 'The firewall is off: every port on this machine is reachable from the network.'}
                  </p>
                  <p className="text-xs text-ink-500">
                    Always kept reachable: {status.protectedPorts.map((p) => `${p.port}/tcp (${p.why})`).join(', ')}.{' '}
                    {data.isAdmin ? 'Changing these asks for confirmation.' : 'Only admins can change rules for these.'}
                  </p>
                  {data.isAdmin && status.canToggle && (
                    <Button variant={status.active ? 'danger' : 'primary'} disabled={busy === 'toggle'} onClick={() => setEnabled(!status.active)}>
                      {status.active ? 'Turn firewall off' : 'Turn firewall on'}
                    </Button>
                  )}
                </div>
              )}
            </Card>

            {status.available && (
              <Card className="p-5">
                <CardTitle>Your instances</CardTitle>
                {data.instancePorts.length === 0 ? (
                  <p className="text-sm text-ink-500">No instances to show.</p>
                ) : (
                  <div className="divide-y divide-surface-700 overflow-hidden rounded-2xl bg-surface-900">
                    {data.instancePorts.map((p) => (
                      <div key={p.serverId} className="flex flex-wrap items-center gap-3 px-4 py-3">
                        <div className="min-w-0 flex-1">
                          <Link to={`/instances/${p.serverId}`} className="block truncate text-sm font-medium text-ink-100 hover:underline">
                            {p.name}
                          </Link>
                          <p className="font-mono text-xs text-ink-400">
                            {p.port}/{p.protocol}
                          </p>
                        </div>
                        <Badge tone={p.open ? 'green' : 'neutral'}>{p.open ? 'Reachable' : 'Blocked'}</Badge>
                        {canChange && status.active && (
                          <Button variant={p.open ? 'danger' : 'primary'} disabled={busy === `inst-${p.serverId}`} onClick={() => toggleInstancePort(p)}>
                            {p.open ? 'Close' : 'Open port'}
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            )}

            {status.available && status.active !== false && (
              <Card className="p-5">
                <CardTitle>Rules</CardTitle>
                {status.rules.length === 0 ? (
                  <p className="mb-4 text-sm text-ink-500">No rules yet.</p>
                ) : (
                  <div className="mb-5 divide-y divide-surface-700 overflow-hidden rounded-2xl bg-surface-900">
                    {status.rules.map((rule) => (
                      <div key={rule.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="break-all font-mono text-sm text-ink-100">{ruleTitle(rule)}</span>
                            <Badge tone={rule.action === 'allow' || rule.action === 'limit' ? 'green' : 'red'}>{rule.action}</Badge>
                            {rule.direction === 'out' && <Badge tone="neutral">outgoing</Badge>}
                          </div>
                          <p className="break-words text-xs text-ink-400">
                            {rule.source ? `from ${rule.source}` : 'from anywhere'}
                            {rule.port && rule.label ? ` · ${rule.label}` : ''}
                            {rule.comment ? ` · ${rule.comment}` : ''}
                          </p>
                        </div>
                        {canChange && (canManage || (rule.port && !rule.port.includes('-'))) && (
                          <Button variant="ghost" disabled={busy === rule.id} onClick={() => removeRule(rule)}>
                            <Icon name="trash" className="h-4 w-4" /> Remove
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {canManage && (
                  <div className="space-y-3 rounded-2xl bg-surface-900 p-4">
                    <p className="text-sm font-medium text-ink-100">Add a rule</p>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <Field label="Port or range">
                        <Input value={port} onChange={(e) => setPort(e.target.value)} placeholder="27015 or 27015-27020" className="font-mono" />
                      </Field>
                      <Field label="Protocol">
                        <Select value={protocol} onChange={(e) => setProtocol(e.target.value as 'tcp' | 'udp' | 'any')}>
                          <option value="tcp">TCP</option>
                          <option value="udp">UDP</option>
                          <option value="any">TCP + UDP</option>
                        </Select>
                      </Field>
                      <Field label="Action">
                        <Select value={action} onChange={(e) => setAction(e.target.value as 'allow' | 'deny')}>
                          <option value="allow">Allow</option>
                          <option value="deny">Block</option>
                        </Select>
                      </Field>
                      <Field label="From (optional)">
                        <Input value={source} onChange={(e) => setSource(e.target.value)} placeholder="anywhere" className="font-mono" />
                      </Field>
                    </div>
                    {status.backend === 'ufw' && (
                      <Field label="Note (optional)">
                        <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="e.g. Zomboid" maxLength={60} />
                      </Field>
                    )}
                    <p className="text-xs text-ink-500">“From” takes an IP address or a range like 192.168.1.0/24 — leave it empty to allow everyone.</p>
                    <ErrorText>{formError}</ErrorText>
                    <div className="flex justify-end">
                      <Button variant="primary" disabled={!port.trim() || busy === 'add'} onClick={addRule}>
                        <Icon name="plus" className="h-4 w-4" /> {busy === 'add' ? 'Adding…' : 'Add rule'}
                      </Button>
                    </div>
                  </div>
                )}
              </Card>
            )}
          </>
        )}
      </div>
    </Layout>
  );
}
