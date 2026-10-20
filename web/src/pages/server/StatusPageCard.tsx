import { useEffect, useState } from 'react';
import { useServerDetail } from './ServerContext.js';
import { api, ApiError } from '../../api/client.js';
import { Badge, Button, Card, CardTitle, Field, Input } from '../../components/ui.js';
import { useToast } from '../../components/Toast.js';
import { useConfirm } from '../../components/ConfirmDialog.js';

interface StatusPageConfig {
  enabled: boolean;
  slug: string;
  description: string;
  address: string;
  showAddress: boolean;
  showPlayers: boolean;
  showVersion: boolean;
}

/** Configuration → Public status page: a link players can check without signing in. */
export function StatusPageCard() {
  const { serverId, server, can } = useServerDetail();
  const toast = useToast();
  const confirm = useConfirm();
  const [cfg, setCfg] = useState<StatusPageConfig | null>(null);
  const [draft, setDraft] = useState<Partial<StatusPageConfig>>({});
  const base = `/servers/${serverId}/status-page`;
  const canEdit = can('settings');

  useEffect(() => {
    api
      .get<{ config: StatusPageConfig | null }>(base)
      .then((r) => {
        setCfg(r.config);
        setDraft(r.config ?? { showAddress: true, showPlayers: true, showVersion: true, description: '', address: '' });
      })
      .catch(() => {});
  }, [base]);

  async function save(body: Record<string, unknown>, message?: string) {
    try {
      const r = await api.put<{ config: StatusPageConfig }>(base, body);
      setCfg(r.config);
      setDraft(r.config);
      if (message) toast.success(message);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to save');
    }
  }

  const url = cfg ? `${window.location.origin}/status/${cfg.slug}` : '';
  const badge = cfg ? `${window.location.origin}/api/public/status/${cfg.slug}/badge.svg` : '';
  const isMinecraft = server?.platform === 'java' || server?.platform === 'bedrock';

  return (
    <Card className="p-5">
      <CardTitle action={<Badge tone={cfg?.enabled ? 'green' : 'neutral'}>{cfg?.enabled ? 'On' : 'Off'}</Badge>}>Public status page</CardTitle>
      <p className="mb-3 text-sm text-ink-400">
        A page anyone with the link can open — no sign-in — showing whether the server is up, the address to join{isMinecraft ? ' and who’s playing' : ''}. Nothing else about the instance is shown.
      </p>
      <fieldset disabled={!canEdit} className="space-y-3">
        <label className="flex items-center gap-2 text-sm text-ink-200">
          <input type="checkbox" checked={!!cfg?.enabled} onChange={(e) => save({ ...draft, enabled: e.target.checked }, e.target.checked ? 'Status page is public' : 'Status page turned off')} />
          Publish a status page
        </label>
        {cfg?.enabled && (
          <div className="space-y-2 rounded-2xl bg-surface-900 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <a href={url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate font-mono text-xs text-accent-400 hover:underline">
                {url}
              </a>
              <Button variant="ghost" onClick={() => navigator.clipboard?.writeText(url).then(() => toast.success('Link copied'))}>
                Copy
              </Button>
              {canEdit && (
                <Button
                  variant="ghost"
                  onClick={async () => {
                    if (await confirm({ title: 'New link', message: 'Make a new link? The old one stops working.', confirmLabel: 'New link' })) save({ newLink: true }, 'New link made');
                  }}
                >
                  New link
                </Button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-ink-400">
              <img src={badge} alt="status badge" className="h-5" />
              <button type="button" className="font-medium text-accent-400" onClick={() => navigator.clipboard?.writeText(`![${server?.name ?? 'status'}](${badge})`).then(() => toast.success('Badge Markdown copied'))}>
                Copy badge Markdown
              </button>
            </div>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Description">
            <Input value={draft.description ?? ''} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="Rules, Discord link, schedule…" />
          </Field>
          <Field label="Address shown to players">
            <Input value={draft.address ?? ''} onChange={(e) => setDraft({ ...draft, address: e.target.value })} placeholder={`this host:${server?.server_port ?? ''}`} className="font-mono" />
          </Field>
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-ink-300">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={draft.showAddress !== false} onChange={(e) => setDraft({ ...draft, showAddress: e.target.checked })} />
            Show the address
          </label>
          {isMinecraft && (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={draft.showPlayers !== false} onChange={(e) => setDraft({ ...draft, showPlayers: e.target.checked })} />
              Show players
            </label>
          )}
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={draft.showVersion !== false} onChange={(e) => setDraft({ ...draft, showVersion: e.target.checked })} />
            Show the version
          </label>
        </div>
        {canEdit && (
          <Button onClick={() => save({ description: draft.description, address: draft.address, showAddress: draft.showAddress, showPlayers: draft.showPlayers, showVersion: draft.showVersion }, 'Status page saved')}>
            Save
          </Button>
        )}
      </fieldset>
    </Card>
  );
}
