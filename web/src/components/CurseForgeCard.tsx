import { useEffect, useState } from 'react';
import { api, ApiError } from '../api/client.js';
import { Badge, Button, Card, CardTitle, ErrorText, Field, Input } from './ui.js';
import { useToast } from './Toast.js';

/** Admin: the CurseForge API key behind Bedrock add-on (and extra Java plugin) search. */
export function CurseForgeCard() {
  const toast = useToast();
  const [status, setStatus] = useState<{ configured: boolean; keyHint: string | null } | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<{ configured: boolean; keyHint: string | null }>('/settings/curseforge').then(setStatus).catch(() => {});
  }, []);

  async function save(apiKey: string | null) {
    setBusy(true);
    setError('');
    try {
      setStatus(await api.put('/settings/curseforge', { apiKey }));
      setKey('');
      toast.success(apiKey ? 'CurseForge key saved — add-on search is on' : 'CurseForge key removed');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save the key');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5">
      <CardTitle action={status && <Badge tone={status.configured ? 'green' : 'neutral'}>{status.configured ? `Key ${status.keyHint}` : 'Not set up'}</Badge>}>
        CurseForge
      </CardTitle>
      <p className="mb-4 text-sm text-ink-400">
        Powers one-click search for Bedrock add-ons and texture packs, and adds CurseForge next to Modrinth for Java plugins and data packs. Get a free key at{' '}
        <a href="https://console.curseforge.com/" target="_blank" rel="noreferrer" className="text-accent-400 hover:underline">
          console.curseforge.com
        </a>{' '}
        (API keys). Outpost checks it before saving and never shows it again.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[16rem] flex-1">
          <Field label={status?.configured ? 'Replace the key' : 'API key'}>
            <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="$2a$10$…" autoComplete="off" className="font-mono" />
          </Field>
        </div>
        <Button variant="primary" disabled={busy || !key.trim()} onClick={() => save(key.trim())}>
          {busy ? 'Checking…' : 'Save key'}
        </Button>
        {status?.configured && (
          <Button variant="ghost" disabled={busy} onClick={() => save(null)}>
            Remove
          </Button>
        )}
      </div>
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}
