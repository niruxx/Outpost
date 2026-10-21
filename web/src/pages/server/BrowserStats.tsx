import { useEffect, useState } from 'react';
import { setVisibleInterval } from '../../lib/perf.js';
import { useServerDetail } from './ServerContext.js';
import { api, ApiError } from '../../api/client.js';
import { Badge, Button, Card, CardTitle, Input, Notice, Spinner } from '../../components/ui.js';
import { Icon } from '../../components/icons.js';
import { Sparkline, type ChartPoint } from '../../components/charts.js';
import { useToast } from '../../components/Toast.js';
import { useConfirm } from '../../components/ConfirmDialog.js';

interface A2sInfo {
  name: string;
  map: string;
  game: string;
  players: number;
  maxPlayers: number;
  bots: number;
  passworded: boolean;
  vac: boolean;
  version: string | null;
  environment: string;
  pingMs: number;
}

interface QueryView {
  support: { supported: boolean; port: number | null; guessedPort: number | null; reason: string | null };
  running: boolean;
  snapshot: { at: string; info: A2sInfo | null; error: string | null } | null;
  history: { t: number; players: number; max: number | null }[];
}

interface LivePlayer {
  name: string;
  score: number | null;
  durationSec: number | null;
  ping: number | null;
  userId: number | null;
  steamId: string | null;
  bot: boolean;
}

interface PlayersView {
  players: LivePlayer[];
  info: A2sInfo | null;
  error: string | null;
  at: string;
  enriched: boolean;
  running: boolean;
  moderation: { kick: boolean; ban: boolean; rcon: boolean };
}

/** Steam games that don't answer server-browser queries, so get no stats card / players page. */
const NO_A2S = ['palworld', 'satisfactory', 'terraria', 'quake3'];
export const hasBrowserStats = (s: { platform: string; steam_preset?: string | null }) => s.platform === 'steam' && !NO_A2S.includes(s.steam_preset ?? '');

/** Max per bucket, so a short spike still shows on a week-long chart. */
function downsample(points: { t: number; players: number }[], buckets = 240): ChartPoint[] {
  if (points.length <= buckets) return points.map((p) => ({ t: p.t, value: p.players }));
  const size = Math.ceil(points.length / buckets);
  const out: ChartPoint[] = [];
  for (let i = 0; i < points.length; i += size) {
    const chunk = points.slice(i, i + size);
    out.push({ t: chunk[chunk.length - 1].t, value: Math.max(...chunk.map((p) => p.players)) });
  }
  return out;
}

function formatDuration(sec: number | null): string {
  if (sec === null) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m` : `${sec}s`;
}

/** Status → what the Steam server browser shows, plus player-count history. */
export function BrowserStatsCard() {
  const { serverId, server, can } = useServerDetail();
  const toast = useToast();
  const [hours, setHours] = useState(24);
  const [data, setData] = useState<QueryView | null>(null);
  const [editing, setEditing] = useState(false);
  const [port, setPort] = useState('');
  const base = `/servers/${serverId}/query`;

  async function load() {
    try {
      setData(await api.get<QueryView>(`${base}?hours=${hours}`));
    } catch {
      // keeps the last value
    }
  }
  useEffect(() => {
    load();
    const t = setVisibleInterval(load, 60_000);
    return () => t();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, hours]);

  if (!server || !hasBrowserStats(server) || !data) return null;
  if (!data.support.supported) return null;

  const info = data.snapshot?.info ?? null;
  const series = downsample(data.history);
  const peak = data.history.reduce((m, p) => Math.max(m, p.players), 0);

  async function savePort(value: number | null) {
    try {
      await api.put(base, { port: value });
      setEditing(false);
      toast.success(value ? `Querying port ${value}` : 'Using the automatic query port');
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Save failed');
    }
  }

  return (
    <Card className="p-5">
      <CardTitle
        action={
          <div className="flex rounded-full border border-surface-500 p-0.5" role="radiogroup" aria-label="History range">
            {[
              [24, '24h'],
              [168, '7d'],
            ].map(([h, label]) => (
              <button
                key={h}
                role="radio"
                aria-checked={hours === h}
                onClick={() => setHours(h as number)}
                className={`state-layer rounded-full px-3 py-1 text-xs font-medium ${hours === h ? 'bg-secondary-container text-secondary-on-container' : 'text-ink-300'}`}
              >
                {label}
              </button>
            ))}
          </div>
        }
      >
        Server browser
      </CardTitle>

      {!data.running ? (
        <p className="text-sm text-ink-400">Stopped — the server list shows nothing until it’s running.</p>
      ) : info ? (
        <div className="flex flex-wrap items-start gap-x-8 gap-y-3">
          <div className="min-w-0">
            <p className="truncate text-base text-ink-50">{info.name}</p>
            <p className="text-sm text-ink-400">
              <span className="font-mono text-ink-200">{info.map}</span> · {info.game}
              {info.version ? ` · v${info.version}` : ''}
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {info.vac && <Badge tone="green">VAC</Badge>}
              {info.passworded && <Badge tone="yellow">Password</Badge>}
              <Badge tone="neutral">{info.environment}</Badge>
              <Badge tone="neutral">{info.pingMs} ms</Badge>
            </div>
          </div>
          <div>
            <p className="text-3xl tabular-nums text-ink-50">
              {Math.max(0, info.players - info.bots)}
              <span className="text-lg text-ink-400">/{info.maxPlayers}</span>
            </p>
            <p className="text-xs text-ink-400">{info.bots ? `players + ${info.bots} bot${info.bots === 1 ? '' : 's'}` : 'players'}</p>
          </div>
        </div>
      ) : (
        <Notice tone="warning">{data.snapshot?.error ?? 'Waiting for the first answer…'}</Notice>
      )}

      <div className="mt-4">
        <div className="mb-1 flex justify-between text-xs text-ink-400">
          <span>Players, last {hours === 24 ? '24 hours' : '7 days'}</span>
          <span>Peak {peak}</span>
        </div>
        <Sparkline data={series} color="#8fd0a8" formatValue={(v) => `${v} player${v === 1 ? '' : 's'}`} emptyLabel="History builds up once a minute while the server runs." height={56} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-400">
        <span>
          Query port <span className="font-mono text-ink-200">{data.support.port}</span>
          {data.support.port !== data.support.guessedPort && ' (custom)'}
        </span>
        {can('settings') && !editing && (
          <button
            className="state-layer rounded-full px-2 py-0.5 text-accent-400"
            onClick={() => {
              setPort(String(data.support.port ?? ''));
              setEditing(true);
            }}
          >
            Change
          </button>
        )}
        {editing && (
          <span className="flex items-center gap-2">
            <span className="w-28">
              <Input type="number" value={port} onChange={(e) => setPort(e.target.value)} aria-label="Query port" />
            </span>
            <Button variant="primary" onClick={() => savePort(Number(port) || null)}>
              Save
            </Button>
            <Button variant="ghost" onClick={() => savePort(null)}>
              Automatic ({data.support.guessedPort})
            </Button>
          </span>
        )}
      </div>
    </Card>
  );
}

/** Players page for Steam games: who's on (A2S), with ping and kick/ban where RCON is set up. */
export function SteamPlayersTab() {
  const { serverId, can } = useServerDetail();
  const toast = useToast();
  const confirm = useConfirm();
  const [data, setData] = useState<PlayersView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const base = `/servers/${serverId}/query/players`;

  async function load() {
    try {
      setData(await api.get<PlayersView>(base));
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load players');
    }
  }
  useEffect(() => {
    load();
    const t = setVisibleInterval(load, 10_000);
    return () => t();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);

  async function act(action: 'kick' | 'ban', p: LivePlayer) {
    const ok = await confirm({
      title: `${action === 'kick' ? 'Kick' : 'Ban'} ${p.name}?`,
      message: action === 'ban' ? 'A permanent ban by their account — lift it later by editing banned_user.cfg (or the game’s ban list).' : 'They can rejoin straight away.',
      confirmLabel: action === 'kick' ? 'Kick' : 'Ban',
      tone: 'danger',
    });
    if (!ok) return;
    setBusy(`${action}:${p.name}`);
    try {
      await api.post(`${base}/${action}`, { name: p.name });
      toast.success(`${action === 'kick' ? 'Kicked' : 'Banned'} ${p.name}`);
      setTimeout(load, 1500);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : `${action} failed`);
    } finally {
      setBusy('');
    }
  }

  if (error && !data) return <Notice tone="error">{error}</Notice>;
  if (!data) return <Spinner />;
  const canModerate = can('console') && data.running;
  const people = data.players.filter((p) => !p.bot);
  const bots = data.players.length - people.length;

  return (
    <div className="space-y-5">
      {!data.running && <Notice tone="warning">The server is stopped.</Notice>}
      {data.error && data.running && <Notice tone="warning">{data.error}</Notice>}
      {data.running && !data.moderation.rcon && data.moderation.kick && (
        <Notice tone="info">Turn on RCON (Configuration → RCON) to see each player’s ping and to ban — kicking works without it.</Notice>
      )}
      <Card className="p-5">
        <CardTitle action={<Button variant="ghost" onClick={load}><Icon name="refresh" className="h-4 w-4" /> Refresh</Button>}>
          {people.length} player{people.length === 1 ? '' : 's'} online{bots ? ` · ${bots} bot${bots === 1 ? '' : 's'}` : ''}
          {data.info ? ` · ${data.info.map}` : ''}
        </CardTitle>
        {data.players.length === 0 ? (
          <p className="text-sm text-ink-400">Nobody’s on right now.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-ink-400">
                  <th className="py-2 pr-4 font-medium">Name</th>
                  <th className="py-2 pr-4 font-medium">Score</th>
                  <th className="py-2 pr-4 font-medium">Time</th>
                  <th className="py-2 pr-4 font-medium">Ping</th>
                  <th className="py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {data.players.map((p, i) => (
                  <tr key={`${p.name}-${i}`} className="border-t border-surface-700">
                    <td className="py-2 pr-4 text-ink-100">
                      {p.name} {p.bot && <Badge tone="neutral">bot</Badge>}
                      {p.steamId && <span className="ml-2 font-mono text-xs text-ink-500">{p.steamId}</span>}
                    </td>
                    <td className="py-2 pr-4 tabular-nums text-ink-300">{p.score ?? '—'}</td>
                    <td className="py-2 pr-4 tabular-nums text-ink-300">{formatDuration(p.durationSec)}</td>
                    <td className="py-2 pr-4 tabular-nums text-ink-300">{p.ping !== null ? `${p.ping} ms` : '—'}</td>
                    <td className="py-2 text-right">
                      {canModerate && !p.bot && (
                        <span className="inline-flex gap-1">
                          {data.moderation.kick && (
                            <Button variant="ghost" disabled={busy !== ''} onClick={() => act('kick', p)}>
                              Kick
                            </Button>
                          )}
                          {data.moderation.ban && (
                            <Button variant="ghost" disabled={busy !== ''} onClick={() => act('ban', p)}>
                              Ban
                            </Button>
                          )}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-ink-500">From the game’s server-browser answer{data.enriched ? ' and RCON status' : ''}, refreshed every 10 s.</p>
      </Card>
    </div>
  );
}
