import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client.js';
import { isMinecraftPlatform, isProxyLoader, type PlayerInfo } from '../../api/types.js';
import { setVisibleInterval } from '../../lib/perf.js';
import { Badge, Button, Card, CardTitle, Skeleton } from '../../components/ui.js';
import { hasBrowserStats } from './BrowserStats.js';
import { useServerDetail } from './ServerContext.js';

interface OnlinePlayer { name: string; op?: boolean; whitelisted?: boolean; bot?: boolean; ping?: number | null; score?: number | null; durationSec?: number | null }
interface Roster { players: OnlinePlayer[]; count: number; max: number | null; at: number }
interface QueryRoster {
  players: OnlinePlayer[];
  info: { players: number; maxPlayers: number } | null;
  error: string | null;
  running: boolean;
  at: string;
}

export function ConnectedPlayersCard() {
  const { serverId, server, running } = useServerDetail();
  if (!server || server.id !== serverId) return null;
  const mode = isMinecraftPlatform(server.platform) && !isProxyLoader(server.loader) ? 'minecraft' : hasBrowserStats(server) ? 'query' : null;
  return <PlayerRoster key={`${serverId}:${mode}:${running}`} serverId={serverId} running={running} mode={mode} />;
}

function PlayerRoster({ serverId, running, mode }: { serverId: string; running: boolean; mode: 'minecraft' | 'query' | null }) {
  const [roster, setRoster] = useState<Roster | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!mode || !running) return;
    let active = true, loading = false;
    async function load() {
      if (loading) return;
      loading = true; setBusy(true);
      try {
        let next: Roster;
        if (mode === 'minecraft') {
          const result = await api.get<{ players: PlayerInfo[] }>(`/servers/${serverId}/players`);
          const online = result.players.filter(p => p.online);
          next = { players: online, count: online.length, max: null, at: Date.now() };
        } else {
          const result = await api.get<QueryRoster>(`/servers/${serverId}/query/players`);
          if (result.error) throw new Error(result.error);
          if (!result.running) throw new Error('The server is no longer running.');
          next = { players: result.players, count: result.info?.players ?? result.players.length, max: result.info?.maxPlayers ?? null, at: Date.parse(result.at) || Date.now() };
        }
        if (active) { setRoster(next); setError(''); }
      } catch (e) { if (active) setError(e instanceof Error ? e.message : 'Could not refresh connected players.'); }
      finally { loading = false; if (active) setBusy(false); }
    }
    void load();
    const stop = setVisibleInterval(() => void load(), 10_000);
    return () => { active = false; stop(); };
  }, [serverId, mode, running, retry]);

  return <Card className="min-w-0 p-5" aria-label="Connected players">
    <CardTitle action={mode ? <Link to={`/instances/${serverId}/players`} className="shrink-0 text-xs font-medium text-accent-400 hover:underline">View players</Link> : undefined}>Connected players</CardTitle>
    {!mode ? <p className="text-sm text-ink-400">A live player list is not available for this instance type. Game-specific player tools may be available in its game settings.</p>
      : !running ? <p className="text-sm text-ink-400">The instance is stopped. Start it to see connected players.</p>
      : <>
        {error && <div role="status" className="mb-3 space-y-1 text-xs text-amber-400"><p>Player list unavailable{roster ? ' — showing the last successful snapshot' : ''}.</p><p className="break-words">{error}</p></div>}
        {!roster && !error ? <Skeleton className="h-14 w-full" /> : roster && <>
          <p className="mb-3 text-3xl tabular-nums text-ink-50">{roster.count}{roster.max !== null && <span className="text-base text-ink-400"> / {roster.max}</span>} <span className="text-sm text-ink-400">online{error ? ' at last update' : ''}</span></p>
          {roster.players.length ? <ul className="max-h-72 space-y-2 overflow-y-auto pr-1" aria-label="Player roster">{roster.players.map((p, i) => <li key={`${p.name}:${i}`} className="flex min-w-0 items-start gap-2 rounded-xl bg-surface-900 p-2.5">
            <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-container text-xs font-medium text-accent-on-container">{(p.name || '?').slice(0, 1).toUpperCase()}</span>
            <div className="min-w-0 flex-1"><p className="break-all text-sm font-medium text-ink-100">{p.name || 'Unnamed player'}</p><div className="mt-1 flex flex-wrap gap-1 text-xs text-ink-400">{p.op && <Badge>Operator</Badge>}{p.whitelisted && <Badge>Whitelisted</Badge>}{p.bot && <Badge>Bot</Badge>}{p.ping != null && <span>{p.ping} ms</span>}{p.score != null && <span>Score {p.score}</span>}{p.durationSec != null && <span>Session {Math.floor(p.durationSec / 60)}m</span>}</div></div>
          </li>)}</ul> : <p className="text-sm text-ink-400">{roster.count > 0 ? 'The server reports connected players but does not expose their names.' : 'Nobody is online.'}</p>}
          {roster.count > roster.players.length && roster.players.length > 0 && <p className="mt-2 text-xs text-ink-400">The server returned {roster.players.length} names for {roster.count} reported connections.</p>}
          <p className="mt-3 text-xs text-ink-500">Updated {new Date(roster.at).toLocaleTimeString()}{mode === 'minecraft' ? ' · Server roster' : ' · Server query'}</p>
        </>}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-ink-500">Refreshes every 10 seconds</span><Button className="shrink-0 whitespace-nowrap" variant="ghost" disabled={busy} onClick={() => setRetry(n => n + 1)}>{busy ? 'Refreshing…' : 'Refresh players'}</Button></div>
      </>}
  </Card>;
}
