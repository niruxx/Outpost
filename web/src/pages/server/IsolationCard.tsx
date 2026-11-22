import { useEffect, useState } from 'react';
import { useServerDetail } from './ServerContext.js';
import { api, ApiError } from '../../api/client.js';
import type { SandboxStatus } from '../../api/types.js';
import { Badge, Card, CardTitle, Notice } from '../../components/ui.js';
import { Icon } from '../../components/icons.js';
import { useToast } from '../../components/Toast.js';

/** Shows whether this instance runs sandboxed, with an admin-only opt-out. */
export function IsolationCard() {
  const { server, isAdmin, refresh } = useServerDetail();
  const toast = useToast();
  const [sandbox, setSandbox] = useState<SandboxStatus | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    api
      .get<{ sandbox: SandboxStatus }>('/settings/security')
      .then((res) => setSandbox(res.sandbox))
      .catch(() => {});
  }, [isAdmin]);

  if (!server) return null;

  const optedOut = server.isolation === 'off';
  const active = !!sandbox?.available && !!sandbox.enabled && !optedOut;

  async function setIsolation(isolation: 'inherit' | 'off') {
    try {
      await api.patch(`/servers/${server!.id}`, { isolation });
      await refresh();
      toast.success(isolation === 'off' ? 'Sandbox turned off for this instance' : 'Sandbox turned back on');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to change isolation');
    }
  }

  return (
    <Card className="p-5">
      <CardTitle
        action={
          isAdmin && sandbox ? (
            active ? <Badge tone="green">Sandboxed</Badge> : <Badge tone={optedOut ? 'yellow' : 'neutral'}>{optedOut ? 'Opted out' : 'Not sandboxed'}</Badge>
          ) : undefined
        }
      >
        Isolation
      </CardTitle>
      <div className="flex items-start gap-3 text-sm text-ink-300">
        <Icon name="shieldCheck" className="mt-0.5 h-5 w-5 text-accent-400" />
        <div className="space-y-2">
          <p>
            The server process can only write inside this instance's folder. System folders are read-only, and your home folder, other instances and
            the panel's own data are hidden from it. Its environment carries no panel secrets.
          </p>
          {isAdmin && sandbox && !sandbox.available && <Notice tone="warning">{sandbox.reason}</Notice>}
          {isAdmin && sandbox?.available && !sandbox.enabled && <Notice tone="warning">Sandboxing is turned off for the whole panel (Configuration → Security).</Notice>}
          {isAdmin && sandbox?.available && (
            <label className="flex items-center gap-2 text-sm text-ink-300">
              <input type="checkbox" checked={optedOut} onChange={(e) => setIsolation(e.target.checked ? 'off' : 'inherit')} />
              Run this instance without the sandbox (only if it truly needs files outside its folder)
            </label>
          )}
        </div>
      </div>
    </Card>
  );
}
