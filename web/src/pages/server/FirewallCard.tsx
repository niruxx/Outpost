import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client.js';
import type { InstanceFirewallInfo, InstanceFirewallResult } from '../../api/types.js';
import { Button, Card, CardTitle, ErrorText, Notice } from '../../components/ui.js';
import { useToast } from '../../components/Toast.js';
import { useAuth } from '../../state/AuthContext.js';
import { useServerDetail } from './ServerContext.js';

export function FirewallCard() {
  const { server } = useServerDetail();
  const { user } = useAuth();
  const toast = useToast();
  const visible = user?.role === 'admin' || !!user?.firewall && user.firewall !== 'none';
  const [info, setInfo] = useState<InstanceFirewallInfo | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setInfo(null); setError('');
    if (!server || !visible) return;
    api.get<InstanceFirewallInfo>(`/firewall/instances/${server.id}`)
      .then(value => { if (active) setInfo(value); })
      .catch(error => { if (active) setError(error instanceof Error ? error.message : 'Could not read server firewall ports'); });
    return () => { active = false; };
  }, [server?.id, server?.server_port, server?.launch_config, server?.extra_args, visible, revision]);

  async function allow() {
    if (!server || busy) return;
    const id = server.id;
    setBusy(true); setError('');
    try {
      const result = await api.post<InstanceFirewallResult>(`/firewall/instances/${id}/allow`);
      setInfo(previous => previous ? { ...previous, status: result.status, ports: result.ports } : null);
      if (result.failed.length) setError(result.failed.map(p => `${p.port}/${p.protocol}: ${p.error}`).join('; '));
      else toast.success(result.added.length ? `Server allow rules ${result.status.active ? 'applied' : 'saved'} in ${result.status.backend === 'ufw' ? 'UFW' : 'firewalld'}` : 'Server allow rules are already configured');
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not allow server ports');
    } finally { setBusy(false); }
  }

  if (!server || !visible) return null;
  const status = info?.status;
  const canChange = info?.access === 'manage' || info?.access === 'instances';
  return <Card aria-label="Server firewall" className="space-y-3 p-5">
    <CardTitle action={<Button variant="ghost" disabled={busy} onClick={() => setRevision(value => value + 1)}>Refresh ports</Button>}>Server firewall</CardTitle>
    {!info && !error && <p className="text-sm text-ink-400">Detecting UFW or firewalld and reading server ports…</p>}
    {info && <>
      <p className="text-sm text-ink-300">{status?.backend === 'ufw' ? 'UFW' : status?.backend === 'firewalld' ? `firewalld${status.zone ? ` — zone ${status.zone}` : ''}` : 'No supported firewall detected'}</p>
      <div className="space-y-2">{info.ports.map(p => <div key={`${p.port}/${p.protocol}`} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm">
        <span><code>{p.port}/{p.protocol}</code><span className="ml-2 text-xs text-ink-400">{p.source}</span></span>
        <span className="text-xs text-ink-400">{p.configured ? 'Allow rule present' : 'No allow rule yet'}</span>
      </div>)}</div>
      {status?.reason && <Notice tone="info">{status.reason}</Notice>}
      {status?.backend === 'ufw' && status.available && !status.active && <Notice tone="info">UFW is inactive. This saves allow rules for when it is enabled.</Notice>}
      {canChange && <Button variant="primary" disabled={busy || !status?.available || status.backend === 'firewalld' && !status.active} onClick={allow}>{busy ? 'Allowing ports…' : 'Allow server ports'}</Button>}
      {!canChange && <p className="text-xs text-ink-400">Your account can view firewall rules. Ask an admin for permission to allow server ports.</p>}
      <p className="text-xs text-ink-400">Uses the current saved server configuration when clicked. Changes apply to this host; internet access may also need router forwarding.</p>
    </>}
    <ErrorText>{error}</ErrorText>
    <Link to="/firewall" className="inline-block text-sm text-accent-500 hover:underline">Manage firewall rules</Link>
  </Card>;
}
