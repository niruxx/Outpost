import { useEffect, useState } from 'react';
import { api, ApiError } from '../api/client.js';
import type { NotifyEvent, ServerRecord, Webhook } from '../api/types.js';
import { Badge, Button, Card, CardTitle, ErrorText, Field, Input, Modal, Spinner } from './ui.js';
import { Icon } from './icons.js';
import { useToast } from './Toast.js';
import { useConfirm } from './ConfirmDialog.js';

const EVENT_LABEL: Record<NotifyEvent, string> = {
  'server.started': 'Instance started',
  'server.stopped': 'Instance stopped',
  'server.crashed': 'Instance crashed',
  'server.restart_gave_up': 'Auto-restart gave up',
  'backup.failed': 'Scheduled snapshot failed',
  'task.failed': 'Scheduled task failed',
};
const ALL_EVENTS = Object.keys(EVENT_LABEL) as NotifyEvent[];
const DEFAULT_EVENTS: NotifyEvent[] = ['server.crashed', 'server.restart_gave_up', 'backup.failed', 'task.failed'];

const isDiscord = (url: string) => /^https:\/\/(\w+\.)?discord(app)?\.com\/api\/webhooks\//.test(url.trim());

function WebhookModal({
  open,
  editing,
  servers,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: Webhook | null;
  servers: ServerRecord[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<NotifyEvent[]>(DEFAULT_EVENTS);
  const [allServers, setAllServers] = useState(true);
  const [serverIds, setServerIds] = useState<string[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? '');
    setUrl(editing?.url ?? '');
    setEvents(editing?.events ?? DEFAULT_EVENTS);
    setAllServers(!editing?.serverIds);
    setServerIds(editing?.serverIds ?? []);
    setEnabled(editing?.enabled ?? true);
    setError('');
  }, [open, editing]);

  const toggle = <T,>(list: T[], item: T) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);

  async function save() {
    setBusy(true);
    setError('');
    const body = { name, url, events, serverIds: allServers ? null : serverIds, enabled };
    try {
      if (editing) await api.put(`/notifications/${editing.id}`, body);
      else await api.post('/notifications', body);
      toast.success(editing ? 'Webhook saved' : 'Webhook added');
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save webhook');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={editing ? 'Edit webhook' : 'Add webhook'} size="lg">
      <div className="space-y-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. #server-alerts" autoFocus />
        </Field>
        <Field label="Webhook URL">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://discord.com/api/webhooks/…" className="font-mono" />
        </Field>
        <p className="-mt-2 text-xs text-ink-500">
          {url && isDiscord(url)
            ? 'Discord webhook — messages arrive as embeds.'
            : 'In Discord: channel settings → Integrations → Webhooks → Copy Webhook URL. Any other URL receives a JSON POST.'}
        </p>

        <div>
          <p className="mb-2 text-xs font-medium text-ink-300">Send a message when…</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {ALL_EVENTS.map((ev) => (
              <label key={ev} className="flex items-center gap-2 text-sm text-ink-200">
                <input type="checkbox" checked={events.includes(ev)} onChange={() => setEvents((e) => toggle(e, ev))} />
                {EVENT_LABEL[ev]}
              </label>
            ))}
          </div>
        </div>

        <div>
          <p className="mb-2 text-xs font-medium text-ink-300">For</p>
          <label className="mb-2 flex items-center gap-2 text-sm text-ink-200">
            <input type="checkbox" checked={allServers} onChange={(e) => setAllServers(e.target.checked)} />
            Every instance, including new ones
          </label>
          {!allServers && (
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-2xl bg-surface-900 p-3">
              {servers.length === 0 && <p className="text-xs text-ink-500">No instances yet.</p>}
              {servers.map((s) => (
                <label key={s.id} className="flex items-center gap-2 text-sm text-ink-200">
                  <input type="checkbox" checked={serverIds.includes(s.id)} onChange={() => setServerIds((ids) => toggle(ids, s.id))} />
                  {s.name}
                </label>
              ))}
            </div>
          )}
        </div>

        <label className="flex items-center gap-2 text-sm text-ink-200">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled
        </label>

        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !name.trim() || !url.trim() || !events.length || (!allServers && !serverIds.length)} onClick={save}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Discord / webhook alerts for instance and backup events. Admin only. */
export function NotificationsCard() {
  const toast = useToast();
  const confirm = useConfirm();
  const [webhooks, setWebhooks] = useState<Webhook[] | null>(null);
  const [servers, setServers] = useState<ServerRecord[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Webhook | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  async function load() {
    try {
      const [hooks, list] = await Promise.all([
        api.get<{ webhooks: Webhook[] }>('/notifications'),
        api.get<{ servers: ServerRecord[] }>('/servers'),
      ]);
      setWebhooks(hooks.webhooks);
      setServers(list.servers);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to load webhooks');
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function test(hook: Webhook) {
    setTesting(hook.id);
    try {
      await api.post(`/notifications/${hook.id}/test`);
      toast.success(`Test sent to ${hook.name}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Test failed');
    } finally {
      setTesting(null);
    }
  }

  async function remove(hook: Webhook) {
    const ok = await confirm({ title: 'Remove webhook', message: `Stop sending notifications to “${hook.name}”?`, confirmLabel: 'Remove', tone: 'danger' });
    if (!ok) return;
    try {
      await api.delete(`/notifications/${hook.id}`);
      toast.success(`Removed ${hook.name}`);
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to remove webhook');
    }
  }

  const scope = (hook: Webhook) =>
    !hook.serverIds ? 'every instance' : hook.serverIds.length === 1 ? servers.find((s) => s.id === hook.serverIds![0])?.name ?? '1 instance' : `${hook.serverIds.length} instances`;

  return (
    <Card className="p-5">
      <CardTitle
        action={
          <Button
            variant="primary"
            onClick={() => {
              setEditing(null);
              setModalOpen(true);
            }}
          >
            <Icon name="plus" className="h-4 w-4" /> Add webhook
          </Button>
        }
      >
        Notifications
      </CardTitle>
      <p className="mb-4 text-sm text-ink-400">Post to Discord (or any webhook) when instances start, stop or crash, or when a scheduled snapshot or task fails.</p>
      {webhooks === null ? (
        <Spinner />
      ) : webhooks.length === 0 ? (
        <p className="py-4 text-center text-sm text-ink-500">No webhooks yet.</p>
      ) : (
        <div className="divide-y divide-surface-700 overflow-hidden rounded-2xl bg-surface-900">
          {webhooks.map((hook) => (
            <div key={hook.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate text-sm font-medium text-ink-100">{hook.name}</p>
                  {isDiscord(hook.url) ? <Badge tone="blue">Discord</Badge> : <Badge tone="neutral">Webhook</Badge>}
                  {!hook.enabled && <Badge tone="yellow">Paused</Badge>}
                </div>
                <p className="text-xs text-ink-400">
                  {hook.events.map((e) => EVENT_LABEL[e]).join(', ')} · {scope(hook)}
                </p>
              </div>
              <div className="flex w-full flex-wrap justify-end gap-2 sm:w-auto">
              <Button variant="ghost" disabled={testing === hook.id} onClick={() => test(hook)}>
                {testing === hook.id ? 'Sending…' : 'Test'}
              </Button>
              <Button
                onClick={() => {
                  setEditing(hook);
                  setModalOpen(true);
                }}
              >
                Edit
              </Button>
              <Button variant="danger" onClick={() => remove(hook)}>
                Remove
              </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      <WebhookModal open={modalOpen} editing={editing} servers={servers} onClose={() => setModalOpen(false)} onSaved={load} />
    </Card>
  );
}
