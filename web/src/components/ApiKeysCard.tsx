import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client.js';
import { Badge, Button, Card, CardTitle, Field, Input, Notice, Select } from './ui.js';
import { useToast } from './Toast.js';
import { useConfirm } from './ConfirmDialog.js';

interface ApiKey {
  id: string;
  userId: string;
  username?: string;
  name: string;
  hint: string;
  readOnly: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : '—');

/** Configuration → API keys: personal keys for scripts, bots and integrations. */
export function ApiKeysCard({ isAdmin }: { isAdmin: boolean }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [name, setName] = useState('');
  const [readOnly, setReadOnly] = useState(false);
  const [expiry, setExpiry] = useState('90');
  const [fresh, setFresh] = useState<string | null>(null);

  const load = useCallback(() => api.get<{ keys: ApiKey[] }>(`/keys${showAll ? '?all=1' : ''}`).then((r) => setKeys(r.keys)).catch(() => setKeys([])), [showAll]);
  useEffect(() => {
    load();
  }, [load]);
  if (!keys) return null;

  async function create() {
    try {
      const r = await api.post<{ key: string; keys: ApiKey[] }>('/keys', { name, readOnly, expiresInDays: expiry === 'never' ? null : Number(expiry) });
      setFresh(r.key);
      setName('');
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to create the key');
    }
  }
  async function revoke(k: ApiKey) {
    if (!(await confirm({ title: 'Revoke API key', message: `Revoke “${k.name}”? Anything using it stops working immediately.`, confirmLabel: 'Revoke', tone: 'danger' }))) return;
    try {
      setKeys((await api.delete<{ keys: ApiKey[] }>(`/keys/${k.id}${showAll ? '?all=1' : ''}`)).keys);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to revoke');
    }
  }

  return (
    <Card className="p-5">
      <CardTitle
        action={
          isAdmin && (
            <label className="flex items-center gap-2 text-xs text-ink-300">
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
              Everyone’s keys
            </label>
          )
        }
      >
        API keys
      </CardTitle>
      <p className="mb-3 text-sm text-ink-400">
        For scripts, bots and Discord integrations. A key acts as you — same role and instance permissions — and works everywhere the panel’s API does. Send it as{' '}
        <span className="font-mono text-ink-200">Authorization: Bearer opk_…</span>. Keys can’t change keys, passwords or 2FA.
      </p>
      {fresh && (
        <div className="mb-3">
          <Notice tone="warning">
            <span className="block font-medium">Copy your new key now — it won’t be shown again.</span>
            <span className="mt-1 flex items-center gap-2">
              <span className="break-all font-mono text-xs">{fresh}</span>
              <Button variant="ghost" onClick={() => navigator.clipboard?.writeText(fresh).then(() => toast.success('Copied'))}>
                Copy
              </Button>
              <Button variant="ghost" onClick={() => setFresh(null)}>
                Done
              </Button>
            </span>
            <span className="mt-1 block font-mono text-[11px] text-ink-300">
              curl -H "Authorization: Bearer {fresh.slice(0, 12)}…" {window.location.origin}/api/servers
            </span>
          </Notice>
        </div>
      )}
      {keys.length > 0 && (
        <div className="mb-3 divide-y divide-surface-700 overflow-hidden rounded-2xl bg-surface-900">
          {keys.map((k) => (
            <div key={k.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-ink-100">
                  {k.name}
                  {showAll && k.username ? <span className="text-ink-400"> · {k.username}</span> : null}
                </span>
                <span className="block font-mono text-[11px] text-ink-500">
                  {k.hint}… · created {when(k.createdAt)} · last used {when(k.lastUsedAt)} · {k.expiresAt ? `expires ${when(k.expiresAt)}` : 'never expires'}
                </span>
              </span>
              {k.readOnly && <Badge>read-only</Badge>}
              {k.expiresAt && Date.parse(k.expiresAt) < Date.now() && <Badge tone="red">expired</Badge>}
              <Button variant="ghost" onClick={() => revoke(k)}>
                Revoke
              </Button>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[12rem] flex-1">
          <Field label="New key — what’s it for?">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Discord bot" />
          </Field>
        </div>
        <div className="w-36">
          <Field label="Expires">
            <Select value={expiry} onChange={(e) => setExpiry(e.target.value)}>
              <option value="30">in 30 days</option>
              <option value="90">in 90 days</option>
              <option value="365">in a year</option>
              <option value="never">never</option>
            </Select>
          </Field>
        </div>
        <label className="flex items-center gap-2 pb-2 text-sm text-ink-300">
          <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
          Read-only
        </label>
        <Button variant="primary" disabled={!name.trim()} onClick={create}>
          Create key
        </Button>
      </div>
    </Card>
  );
}
