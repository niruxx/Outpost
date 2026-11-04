import { useCallback, useEffect, useState } from 'react';
import { setVisibleInterval } from '../../lib/perf.js';
import { AnimatePresence, motion } from 'framer-motion';
import { useServerDetail } from './ServerContext.js';
import { api, ApiError } from '../../api/client.js';
import type { PlayerDataSummary, PlayerInfo } from '../../api/types.js';
import { PlayerDataEditor } from './PlayerDataEditor.js';
import { Badge, Button, Card, ErrorText, Field, Input } from '../../components/ui.js';

export function PlayersTab() {
  const { serverId, server, running, can } = useServerDetail();
  const isJava = server?.platform === 'java';
  const canWrite = can('players');
  const [players, setPlayers] = useState<PlayerInfo[] | null>(null);
  const [error, setError] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [saved, setSaved] = useState<PlayerDataSummary[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const loadSaved = useCallback(async () => {
    if (!isJava) return;
    try {
      const res = await api.get<{ players: PlayerDataSummary[] }>(`/servers/${serverId}/playerdata`);
      setSaved(res.players);
    } catch {
      setSaved([]);
    }
  }, [serverId, isJava]);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ players: PlayerInfo[] }>(`/servers/${serverId}/players`);
      setPlayers(res.players);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load players');
    }
  }, [serverId]);

  useEffect(() => {
    load();
    loadSaved();
    const interval = setVisibleInterval(() => { load(); loadSaved(); }, 4000);
    return () => interval();
  }, [load, loadSaved]);

  async function act(name: string, action: string, reason?: string) {
    setBusyKey(`${name}:${action}`);
    setError('');
    try {
      await api.post(`/servers/${serverId}/players/${encodeURIComponent(name)}/${action}`, reason ? { reason } : undefined);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Failed to ${action} ${name}`);
    } finally {
      setBusyKey(null);
    }
  }

  const online = players?.filter((p) => p.online) ?? [];
  const offline = players?.filter((p) => !p.online) ?? [];

  return (
    <div className="stagger space-y-6">
      {!running && (
        <p className="rounded-md bg-yellow-500/10 border border-yellow-500/30 px-3 py-2 text-sm text-yellow-400">
          Start the server to op, whitelist, kick, or ban players — these actions run through the live console.
        </p>
      )}
      <ErrorText>{error}</ErrorText>

      {canWrite && (
        <Card className="p-5">
          <h3 className="mb-2 text-sm font-semibold text-ink-200">Whitelist a player</h3>
          <div className="flex gap-2">
            <Field label="Player name">
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Notch" />
            </Field>
            <Button
              className="mt-5"
              disabled={!running || !newName.trim() || busyKey === `${newName}:whitelist-add`}
              onClick={() => act(newName.trim(), 'whitelist-add').then(() => setNewName(''))}
            >
              Add
            </Button>
          </div>
        </Card>
      )}

      <section>
        <h2 className="mb-2 text-base font-medium text-ink-100">
          Online ({online.length})
        </h2>
        <PlayerTable players={online} canWrite={canWrite} running={running} busyKey={busyKey} onAction={act} />
      </section>

      <section>
        <h2 className="mb-2 text-base font-medium text-ink-100">
          Known players ({offline.length})
        </h2>
        <PlayerTable players={offline} canWrite={canWrite} running={running} busyKey={busyKey} onAction={act} />
      </section>

      {isJava && (
        <section>
          <h2 className="mb-1 text-base font-medium text-ink-100">Player data ({saved?.length ?? 0})</h2>
          <p className="mb-2 text-xs text-ink-400">Inventory, XP, health, location and abilities stored in the world's playerdata files.</p>
          {saved && saved.length === 0 ? (
            <p className="text-sm text-ink-500">No saved player files yet — players appear here after joining once.</p>
          ) : (
            <Card className="divide-y divide-surface-700/80 overflow-hidden">
              {saved?.map((p) => (
                <div key={p.uuid} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <span className="font-medium text-ink-100">{p.name ?? 'Unknown player'}</span>
                  <span className="font-mono text-xs text-ink-500">{p.uuid}</span>
                  {p.online && <Badge tone="green" pulse>online</Badge>}
                  <span className="text-xs text-ink-500">saved {new Date(p.modified).toLocaleString()}</span>
                  <Button className="ml-auto" onClick={() => setEditing(p.uuid)}>
                    {canWrite ? 'Edit data' : 'View data'}
                  </Button>
                </div>
              ))}
            </Card>
          )}
        </section>
      )}

      <PlayerDataEditor serverId={serverId} uuid={editing} running={running} canWrite={canWrite} onClose={() => { setEditing(null); loadSaved(); }} />
    </div>
  );
}

function PlayerTable({
  players,
  canWrite,
  running,
  busyKey,
  onAction,
}: {
  players: PlayerInfo[];
  canWrite: boolean;
  running: boolean;
  busyKey: string | null;
  onAction: (name: string, action: string, reason?: string) => void;
}) {
  if (players.length === 0) return <p className="text-sm text-ink-500">Nothing to show.</p>;
  return (
    <Card className="divide-y divide-surface-700/80 overflow-hidden">
      <AnimatePresence initial={false}>
        {players.map((p) => (
          <motion.div
            key={p.name}
            layout
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ type: 'spring', stiffness: 400, damping: 34 }}
            className="flex flex-wrap items-center gap-3 px-4 py-3"
          >
            <span className="font-medium text-ink-100">{p.name}</span>
            <div className="flex gap-1.5">
              {p.online && <Badge tone="green" pulse>online</Badge>}
              {p.op && <Badge tone="blue">op</Badge>}
              {p.whitelisted && <Badge tone="neutral">whitelisted</Badge>}
              {p.banned && <Badge tone="red">banned</Badge>}
            </div>
            {canWrite && (
              <div className="ml-auto flex flex-wrap gap-1.5">
                <Button disabled={!running} onClick={() => onAction(p.name, p.op ? 'deop' : 'op')}>
                  {p.op ? 'De-op' : 'Op'}
                </Button>
                <Button disabled={!running} onClick={() => onAction(p.name, p.whitelisted ? 'whitelist-remove' : 'whitelist-add')}>
                  {p.whitelisted ? 'Unwhitelist' : 'Whitelist'}
                </Button>
                {p.online && (
                  <Button disabled={!running} onClick={() => onAction(p.name, 'kick')}>
                    Kick
                  </Button>
                )}
                <Button
                  variant="danger"
                  disabled={!running || busyKey === `${p.name}:${p.banned ? 'pardon' : 'ban'}`}
                  onClick={() => onAction(p.name, p.banned ? 'pardon' : 'ban')}
                >
                  {p.banned ? 'Pardon' : 'Ban'}
                </Button>
              </div>
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </Card>
  );
}
