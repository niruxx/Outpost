import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client.js';
import { isMinecraftPlatform, isProxyLoader, type PlayerInfo } from '../../api/types.js';
import { setVisibleInterval } from '../../lib/perf.js';
import { t } from '../../i18n/index.js';
import { Card, CardTitle, Skeleton } from '../../components/ui.js';
import { Icon } from '../../components/icons.js';
import { EventItem, type EventPage, type PanelEvent } from '../../components/EventList.js';
import type { LogLine } from '../../hooks/useConsoleSocket.js';
import { useServerDetail } from './ServerContext.js';
import { lineColor } from './ConsoleTab.js';

// Strips terminal color/cursor escape codes for the plain-text preview.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

/** The last few console lines, with a jump into the full console. */
function ConsolePreview({ lines, connected }: { lines: LogLine[]; connected: boolean }) {
  const recent = lines.slice(-9);
  return (
    <Card className="flex min-w-0 flex-col p-5">
      <CardTitle
        action={
          <Link to="../console" className="state-layer inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium text-accent-400">
            {t('Open console')} <Icon name="back" className="h-3.5 w-3.5 rotate-180" />
          </Link>
        }
      >
        Latest console output
      </CardTitle>
      <div className="ui-terminal console-view min-h-[11rem] flex-1 overflow-hidden rounded-2xl bg-surface-1000 px-4 py-3 text-[12px] leading-5">
        {recent.length === 0 ? (
          <p className="text-slate-500">{connected ? t('Nothing printed yet.') : t('Connecting…')}</p>
        ) : (
          recent.map((l) => (
            <p
              key={l.id}
              className={`truncate ${lineColor(l.stream, l.line)}`}
              title={l.line.replace(ANSI, '')}
            >
              {l.line.replace(ANSI, '') || ' '}
            </p>
          ))
        )}
      </div>
    </Card>
  );
}

/** Who's online right now (Minecraft rosters; Steam games have the server-browser card). */
function OnlinePlayers({ serverId, running }: { serverId: string; running: boolean }) {
  const [players, setPlayers] = useState<PlayerInfo[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .get<{ players: PlayerInfo[] }>(`/servers/${serverId}/players`)
        .then((r) => !cancelled && setPlayers(r.players))
        .catch(() => !cancelled && setPlayers([]));
    load();
    const stop = setVisibleInterval(load, 15_000);
    return () => {
      cancelled = true;
      stop();
    };
  }, [serverId]);
  const online = (players ?? []).filter((p) => p.online);
  return (
    <Card className="p-5">
      <CardTitle action={<Link to="../players" className="text-xs font-medium text-accent-400 hover:underline">{t('All players')}</Link>}>
        Online now
      </CardTitle>
      {players === null ? (
        <Skeleton className="h-8 w-2/3" />
      ) : !running ? (
        <p className="text-sm text-ink-400">{t('Start the server to see who’s playing.')}</p>
      ) : online.length === 0 ? (
        <p className="text-sm text-ink-400">{t('Nobody is online.')}</p>
      ) : (
        <>
          <p className="mb-3 text-2xl font-normal text-ink-50">
            {online.length} <span className="text-sm text-ink-400">{online.length === 1 ? t('player') : t('players')}</span>
          </p>
          <ul className="flex flex-wrap gap-1.5">
            {online.slice(0, 24).map((p) => (
              <li key={p.name} className="inline-flex items-center gap-1.5 rounded-full bg-surface-900 py-1 pl-1 pr-2.5 text-xs text-ink-200">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent-container text-[10px] font-semibold text-accent-on-container">
                  {p.name.slice(0, 1).toUpperCase()}
                </span>
                {p.name}
                {p.op && <Icon name="shield" className="h-3 w-3 text-yellow-400" />}
              </li>
            ))}
            {online.length > 24 && <li className="px-2 py-1 text-xs text-ink-400">+{online.length - 24}</li>}
          </ul>
        </>
      )}
    </Card>
  );
}

/** This instance's slice of the panel event log: crashes, restarts, failed backups, updates. */
function RecentActivity({ serverId }: { serverId: string }) {
  const [events, setEvents] = useState<PanelEvent[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .get<EventPage>(`/events?serverId=${serverId}&limit=6`)
        .then((r) => !cancelled && setEvents(r.events))
        .catch(() => !cancelled && setEvents([]));
    load();
    const stop = setVisibleInterval(load, 30_000);
    return () => {
      cancelled = true;
      stop();
    };
  }, [serverId]);
  return (
    <Card className="p-5">
      <CardTitle>Recent activity</CardTitle>
      {events === null ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : events.length === 0 ? (
        <p className="text-sm text-ink-400">{t('Starts, stops, crashes, failed backups and updates will appear here.')}</p>
      ) : (
        <ul className="-mx-3 space-y-0.5">
          {events.map((e) => <EventItem key={e.id} event={e} showServer={false} />)}
        </ul>
      )}
    </Card>
  );
}

export function StatusOverview({ lines, connected }: { lines: LogLine[]; connected: boolean }) {
  const { serverId, server, running } = useServerDetail();
  if (!server) return null;
  // Proxies have no world or roster of their own.
  const roster = isMinecraftPlatform(server.platform) && !isProxyLoader(server.loader);
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="min-w-0 lg:col-span-2">
        <ConsolePreview lines={lines} connected={connected} />
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        {roster && <OnlinePlayers serverId={serverId} running={running} />}
        <RecentActivity serverId={serverId} />
      </div>
    </div>
  );
}
