import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../api/client.js';
import { Badge, Button, Card, CardTitle, Select, Spinner } from '../../components/ui.js';
import { useToast } from '../../components/Toast.js';
import { formatBytes } from './StatusTab.js';

export interface OffsiteState {
  destinations: { id: string; name: string; type: 's3' | 'sftp'; enabled: boolean }[];
  copies: { fileName: string; destinationId: string; status: 'pending' | 'uploading' | 'done' | 'failed'; error: string | null }[];
}

/** Off-site copy status for one instance, refreshed while uploads are in flight. */
export function useOffsite(serverId: string) {
  const [state, setState] = useState<OffsiteState | null>(null);
  const load = useCallback(() => api.get<OffsiteState>(`/servers/${serverId}/offsite`).then(setState).catch(() => setState(null)), [serverId]);
  useEffect(() => {
    load();
  }, [load]);
  const busy = state?.copies.some((c) => c.status === 'pending' || c.status === 'uploading');
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [busy, load]);
  return { state, reload: load };
}

const TONE = { pending: 'neutral', uploading: 'blue', done: 'green', failed: 'red' } as const;
const LABEL = { pending: 'queued', uploading: 'copying…', done: 'copied', failed: 'failed' } as const;

/** Per-snapshot chips: where it's been copied. */
export function OffsiteChips({ state, fileName }: { state: OffsiteState | null; fileName: string }) {
  if (!state?.destinations.length) return null;
  const copies = state.copies.filter((c) => c.fileName === fileName);
  return (
    <span className="flex flex-wrap gap-1">
      {copies.map((c) => {
        const d = state.destinations.find((x) => x.id === c.destinationId);
        if (!d) return null;
        return (
          <span key={c.destinationId} title={c.error ?? undefined}>
            <Badge tone={TONE[c.status]}>
              {d.name}: {LABEL[c.status]}
            </Badge>
          </span>
        );
      })}
    </span>
  );
}

/** Backups tab → Off-site copies: browse a destination and bring a snapshot back. */
export function OffsiteRestoreCard({ serverId, state, onFetched, canRestore }: { serverId: string; state: OffsiteState | null; onFetched: () => void; canRestore: boolean }) {
  const toast = useToast();
  const [dest, setDest] = useState('');
  const [objects, setObjects] = useState<{ name: string; sizeBytes: number; modifiedAt: string }[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState('');
  if (!state?.destinations.length || !canRestore) return null;

  async function browse(id: string) {
    setDest(id);
    setObjects(null);
    if (!id) return;
    setLoading(true);
    try {
      setObjects((await api.get<{ objects: { name: string; sizeBytes: number; modifiedAt: string }[] }>(`/servers/${serverId}/offsite/${id}/remote`)).objects);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Couldn’t list that destination');
    } finally {
      setLoading(false);
    }
  }
  async function fetchBack(name: string) {
    setFetching(name);
    try {
      await api.post(`/servers/${serverId}/offsite/fetch`, { destinationId: dest, fileName: name });
      toast.success(`${name} is back in this instance’s snapshots — restore it from the list above`);
      onFetched();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Download failed');
    } finally {
      setFetching('');
    }
  }

  return (
    <Card className="p-5">
      <CardTitle>Off-site copies</CardTitle>
      <p className="mb-3 text-sm text-ink-400">Lost a snapshot here (or the whole machine)? Bring one back from off-site storage, then restore it as usual.</p>
      <Select value={dest} onChange={(e) => browse(e.target.value)} className="!w-auto">
        <option value="">Choose a destination…</option>
        {state.destinations.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
      </Select>
      {loading && <Spinner />}
      {objects && (
        <div className="mt-3 divide-y divide-surface-700 overflow-hidden rounded-2xl bg-surface-900">
          {objects.length === 0 && <p className="px-4 py-3 text-sm text-ink-500">No copies of this instance there yet.</p>}
          {objects.map((o) => (
            <div key={o.name} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-200">{o.name}</span>
              <span className="text-xs text-ink-400">{formatBytes(o.sizeBytes)}</span>
              <Button disabled={!!fetching} onClick={() => fetchBack(o.name)}>
                {fetching === o.name ? 'Downloading…' : 'Bring back'}
              </Button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
