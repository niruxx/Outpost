import { useCallback, useEffect, useState } from 'react';
import { setVisibleInterval } from '../../lib/perf.js';
import { AnimatePresence, motion } from 'framer-motion';
import { useServerDetail } from './ServerContext.js';
import { api, ApiError } from '../../api/client.js';
import type { WhitelistState } from '../../api/types.js';
import { useToast } from '../../components/Toast.js';
import { Badge, Button, Card, Field, Input } from '../../components/ui.js';

export function WhitelistTab() {
  const { serverId, can, server } = useServerDetail();
  const canWrite = can('players');
  const toast = useToast();
  const [state, setState] = useState<WhitelistState | null>(null);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get<WhitelistState>(`/servers/${serverId}/whitelist`);
      setState(res);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to load the allowlist');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  useEffect(() => {
    load();
    const interval = setVisibleInterval(load, 6000);
    return () => interval();
  }, [load]);

  async function toggleEnabled(enabled: boolean) {
    setBusy(true);
    try {
      const res = await api.put<WhitelistState>(`/servers/${serverId}/whitelist/enabled`, { enabled });
      setState(res);
      toast.success(enabled ? 'Allowlist enforcement enabled' : 'Allowlist enforcement disabled');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to update');
    } finally {
      setBusy(false);
    }
  }

  async function addPlayer() {
    if (!newName.trim()) return;
    setBusy(true);
    try {
      const res = await api.post<WhitelistState>(`/servers/${serverId}/whitelist/players`, { name: newName.trim() });
      setState(res);
      toast.success(`Added "${newName.trim()}"`);
      setNewName('');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to add player');
    } finally {
      setBusy(false);
    }
  }

  async function removePlayer(name: string) {
    setBusy(true);
    try {
      const res = await api.delete<WhitelistState>(`/servers/${serverId}/whitelist/players/${encodeURIComponent(name)}`);
      setState(res);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to remove player');
    } finally {
      setBusy(false);
    }
  }

  const label = server?.platform === 'bedrock' ? 'allowlist' : 'whitelist';

  return (
    <div className="stagger space-y-6">
      <Card className="p-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-medium text-ink-100">
              {label === 'allowlist' ? 'Allowlist' : 'Whitelist'} enforcement
            </h2>
            <p className="mt-1 text-xs text-ink-500">
              {state?.enabled
                ? `Only players on the list below can join.`
                : `Anyone can join — the ${label} is not currently enforced.`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {state && <Badge tone={state.enabled ? 'green' : 'neutral'}>{state.enabled ? 'Enabled' : 'Disabled'}</Badge>}
            {canWrite && state && (
              <Button disabled={busy} onClick={() => toggleEnabled(!state.enabled)}>
                {state.enabled ? 'Disable' : 'Enable'}
              </Button>
            )}
          </div>
        </div>
        {!state?.running && (
          <p className="mt-3 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-xs text-sky-400">
            The server is stopped — changes are written directly to {label === 'allowlist' ? 'allowlist.json' : 'whitelist.json'}{' '}
            and will apply next time it starts.
          </p>
        )}
      </Card>

      <Card className="p-5">
        <h2 className="mb-3 text-base font-medium text-ink-100">Players</h2>
        {canWrite && (
          <div className="mb-4 flex gap-2">
            <Field label="Player name">
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Notch"
                onKeyDown={(e) => e.key === 'Enter' && addPlayer()}
              />
            </Field>
            <Button className="mt-5" variant="primary" disabled={busy || !newName.trim()} onClick={addPlayer}>
              Add
            </Button>
          </div>
        )}

        {state === null ? (
          <p className="text-sm text-ink-500">Loading…</p>
        ) : state.players.length === 0 ? (
          <p className="text-sm text-ink-500">No players on the {label} yet.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            <AnimatePresence initial={false}>
              {state.players.map((name) => (
                <motion.span
                  key={name}
                  layout
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  className="inline-flex items-center gap-2 rounded-full border border-surface-600 bg-surface-800 py-1 pl-3 pr-1.5 text-sm text-ink-200"
                >
                  {name}
                  {canWrite && (
                    <button
                      disabled={busy}
                      onClick={() => removePlayer(name)}
                      className="rounded-full p-0.5 text-ink-500 hover:bg-surface-700 hover:text-red-400"
                    >
                      ✕
                    </button>
                  )}
                </motion.span>
              ))}
            </AnimatePresence>
          </div>
        )}
      </Card>
    </div>
  );
}
