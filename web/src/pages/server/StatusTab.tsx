import { useEffect, useState, type ReactNode } from 'react';
import { setVisibleInterval } from '../../lib/perf.js';
import { useServerDetail } from './ServerContext.js';
import { useConsoleSocket } from '../../hooks/useConsoleSocket.js';
import { useEndpoint } from '../../hooks/useEndpoint.js';
import { api, ApiError } from '../../api/client.js';
import type { ResourcesInfo } from '../../api/types.js';
import { Card, CardTitle, Notice, Skeleton } from '../../components/ui.js';
import { Icon, type IconName } from '../../components/icons.js';
import { CHART, Sparkline, tint, type ChartPoint } from '../../components/charts.js';
import { BrowserStatsCard } from './BrowserStats.js';
import { StatusOverview } from './StatusOverview.js';
import { t } from '../../i18n/index.js';

type Range = 'live' | '1h' | '24h' | '7d';
const RANGES: { id: Range; label: string }[] = [
  { id: 'live', label: 'Live' },
  { id: '1h', label: '1h' },
  { id: '24h', label: '24h' },
  { id: '7d', label: '7d' },
];
const RANGE_KEY = 'outpost_status_range';
const RANGE_LABEL: Record<Exclude<Range, 'live'>, string> = { '1h': 'the last hour', '24h': 'the last 24 hours', '7d': 'the last 7 days' };

interface HistoryPoint {
  t: number;
  cpu: number | null;
  cpuMax: number | null;
  memoryMb: number | null;
  memoryMaxMb: number | null;
  netRx: number | null;
  netTx: number | null;
  diskRead: number | null;
  diskWrite: number | null;
}
interface History {
  range: Exclude<Range, 'live'>;
  bucketMs: number;
  from: number;
  to: number;
  points: HistoryPoint[];
}

function readRange(): Range {
  try {
    const v = localStorage.getItem(RANGE_KEY);
    return RANGES.some((r) => r.id === v) ? (v as Range) : 'live';
  } catch {
    return 'live';
  }
}

/** Saved per-minute history for the chosen range, refreshed every minute while visible. */
function useMetricsHistory(serverId: string, range: Range): { history: History | null; error: string } {
  const [history, setHistory] = useState<History | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (range === 'live') return;
    let cancelled = false;
    setHistory(null);
    setError('');
    const load = () =>
      api
        .get<History>(`/servers/${serverId}/metrics/history?range=${range}`)
        .then((h) => !cancelled && setHistory(h))
        .catch((err) => !cancelled && setError(err instanceof ApiError ? err.message : 'Failed to load history'));
    load();
    const stop = setVisibleInterval(load, 60_000);
    return () => {
      cancelled = true;
      stop();
    };
  }, [serverId, range]);
  return { history, error };
}

function RangeSwitch({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  return (
    <div className="flex rounded-full border border-surface-500 p-0.5" role="radiogroup" aria-label={t('Time range')}>
      {RANGES.map((r) => (
        <button
          key={r.id}
          type="button"
          role="radio"
          aria-checked={value === r.id}
          onClick={() => onChange(r.id)}
          className={`state-layer relative rounded-full px-3 py-1 text-xs font-medium ${value === r.id ? 'bg-secondary-container text-secondary-on-container' : 'text-ink-300'}`}
        >
          {r.id === 'live' && <span className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle ${value === 'live' ? 'bg-success-400' : 'bg-ink-500'}`} />}
          {t(r.label)}
        </button>
      ))}
    </div>
  );
}

function shortTime(range: Exclude<Range, 'live'>) {
  return (ms: number) =>
    new Date(ms).toLocaleString(undefined, range === '7d' ? { weekday: 'short', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value < 10 ? 2 : 1)} ${units[i]}`;
}

const formatRate = (bps: number) => `${formatBytes(bps)}/s`;

// MD3 dark-scheme hues, one per metric so the charts stay distinguishable.
const COLORS = {
  cpu: CHART.cpu,
  memory: CHART.memory,
  netIn: CHART.netIn,
  netOut: CHART.netOut,
  diskRead: CHART.diskRead,
  diskWrite: CHART.diskWrite,
};

type LiveSample = ReturnType<typeof useConsoleSocket>['statsHistory'][number];
type MetricKey = 'cpu' | 'memory' | 'uptime' | 'netIn' | 'netOut' | 'diskRead' | 'diskWrite';

/** The resource cards, in display order. Uptime has no history, so it only uses its key. */
const METRICS: {
  key: MetricKey;
  icon: IconName;
  label: string;
  color: string;
  format: (v: number) => string;
  live: (s: LiveSample) => number | null;
  history: (p: HistoryPoint) => number | null;
  peak?: (p: HistoryPoint) => number | null;
}[] = [
  { key: 'cpu', icon: 'cpu', label: 'CPU load', color: COLORS.cpu, format: (v) => `${v.toFixed(1)}%`, live: (s) => s.cpuPercent, history: (p) => p.cpu, peak: (p) => p.cpuMax },
  { key: 'memory', icon: 'memory', label: 'Memory load', color: COLORS.memory, format: (v) => formatBytes(v * 1024 * 1024), live: (s) => s.memoryMb, history: (p) => p.memoryMb, peak: (p) => p.memoryMaxMb },
  { key: 'uptime', icon: 'clock', label: 'Total uptime', color: CHART.neutral, format: String, live: () => null, history: () => null },
  { key: 'netIn', icon: 'network', label: 'Network inbound', color: COLORS.netIn, format: (v) => formatRate(v), live: (s) => s.netRxRate, history: (p) => p.netRx },
  { key: 'netOut', icon: 'network', label: 'Network outbound', color: COLORS.netOut, format: (v) => formatRate(v), live: (s) => s.netTxRate, history: (p) => p.netTx },
  { key: 'diskRead', icon: 'disk', label: 'Disk read', color: COLORS.diskRead, format: (v) => formatRate(v), live: (s) => s.diskReadRate, history: (p) => p.diskRead },
  { key: 'diskWrite', icon: 'disk', label: 'Disk write', color: COLORS.diskWrite, format: (v) => formatRate(v), live: (s) => s.diskWriteRate, history: (p) => p.diskWrite },
];

/** MD3 metric card: icon + label, headline value, supporting line, optional sparkline. */
function MetricCard({
  icon,
  label,
  value,
  sub,
  chart,
  accent,
}: {
  icon: IconName;
  label: string;
  value: string;
  sub?: ReactNode;
  chart?: ReactNode;
  accent: string;
}) {
  return (
    <Card className="flex min-w-0 flex-col p-4 sm:p-5">
      <div className="mb-3 flex items-center gap-2">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full" style={{ backgroundColor: tint(accent, 14), color: accent }}>
          <Icon name={icon} className="h-4 w-4" />
        </span>
        <p className="min-w-0 text-sm font-medium leading-tight text-ink-300">{label}</p>
      </div>
      <p className="truncate text-2xl font-normal leading-8 text-ink-50 sm:text-[28px] sm:leading-9">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-ink-400">{sub}</p>}
      {chart && <div className="mt-auto pt-3">{chart}</div>}
    </Card>
  );
}

function ConnectionCard() {
  const { server, running } = useServerDetail();
  const endpoint = useEndpoint(server?.id, server?.server_port);
  if (!server) return null;
  const others = endpoint?.addresses.filter((a) => a.address !== endpoint.host) ?? [];
  return (
    <Card className="p-5">
      <CardTitle>Connection</CardTitle>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <p className="text-xs text-ink-400">Primary endpoint</p>
          <p className="mt-1 font-mono text-lg text-ink-50">{endpoint ? `${endpoint.host}:${endpoint.port}` : '…'}</p>
          <p className="text-xs text-ink-500">{running ? 'Accepting connections' : 'Available once the server is running'}</p>
        </div>
        <div>
          <p className="text-xs text-ink-400">Port</p>
          <p className="mt-1 font-mono text-lg text-ink-50">
            {server.server_port}
            <span className="ml-1.5 text-sm text-ink-400">{endpoint?.protocol.toUpperCase()}</span>
          </p>
          <p className="text-xs text-ink-500">Open this port in your firewall/router for players</p>
        </div>
        <div>
          <p className="text-xs text-ink-400">Listening on</p>
          <p className="mt-1 font-mono text-lg text-ink-50">{endpoint?.bindAddress ?? '…'}</p>
          <p className="text-xs text-ink-500">
            {endpoint?.bindAddress === '0.0.0.0' ? 'All interfaces' : 'Bound to one address (server-ip)'} on {endpoint?.hostname ?? 'host'}
          </p>
        </div>
      </div>
      {others.length > 0 && (
        <p className="mt-4 text-xs text-ink-500">
          Also reachable at:{' '}
          {others.map((a, i) => (
            <span key={a.address} className="font-mono text-ink-400">
              {i > 0 && ', '}
              {a.family === 'IPv6' ? `[${a.address}]` : a.address} ({a.interface})
            </span>
          ))}
        </p>
      )}
    </Card>
  );
}

export function StatusTab() {
  const { serverId, server, running, runtime } = useServerDetail();
  const { stats, statsHistory, connected, lines } = useConsoleSocket(serverId);
  const [info, setInfo] = useState<ResourcesInfo | null>(null);
  const [error, setError] = useState('');
  const [uptimeAnchor, setUptimeAnchor] = useState<{ uptimeMs: number; at: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [range, setRangeState] = useState<Range>(readRange);
  const { history, error: historyError } = useMetricsHistory(serverId, range);
  function setRange(next: Range) {
    setRangeState(next);
    try {
      localStorage.setItem(RANGE_KEY, next);
    } catch {
      // per-viewer preference only
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await api.get<ResourcesInfo>(`/servers/${serverId}/resources`);
        if (!cancelled) setInfo(res);
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Failed to load resource info');
      }
    }
    load();
    const interval = setVisibleInterval(load, 15000);
    return () => {
      cancelled = true;
      interval();
    };
  }, [serverId]);

  // Tick the uptime locally between the 3s context refreshes so it counts smoothly.
  useEffect(() => {
    setUptimeAnchor(runtime ? { uptimeMs: runtime.uptimeMs, at: Date.now() } : null);
  }, [runtime]);
  useEffect(() => {
    const t = setVisibleInterval(() => setNow(Date.now()), 1000);
    return () => t();
  }, []);

  const series = (pick: (s: LiveSample) => number | null): ChartPoint[] =>
    statsHistory.filter((s) => pick(s) !== null).map((s) => ({ t: s.t, value: pick(s) as number }));

  if (error) return <Notice tone="error">{error}</Notice>;

  const isJava = server?.platform === 'java';
  const memLimitMb = isJava ? server?.max_memory_mb : info?.host.totalMemMb;
  const memPct = stats.memoryMb !== null && memLimitMb ? Math.min(100, Math.round((stats.memoryMb / memLimitMb) * 100)) : null;
  const uptimeMs = uptimeAnchor ? uptimeAnchor.uptimeMs + (now - uptimeAnchor.at) : null;
  const dash = '—';
  const liveFigures: Record<Exclude<MetricKey, 'uptime'>, { value: string; sub?: string }> = {
    cpu: {
      value: stats.cpuPercent !== null ? `${stats.cpuPercent}%` : dash,
      sub: info ? `of ${info.host.cpuCores} cores${info.host.loadAvg !== null ? ` · host load ${info.host.loadAvg.toFixed(2)}` : ''}` : undefined,
    },
    memory: {
      value: stats.memoryMb !== null ? formatBytes(stats.memoryMb * 1024 * 1024) : dash,
      sub:
        memPct !== null
          ? `${memPct}% of ${isJava ? `${server?.max_memory_mb} MB allocated` : 'host RAM'}`
          : memLimitMb
            ? `${isJava ? 'Allocated' : 'Host RAM'}: ${formatBytes(memLimitMb * 1024 * 1024)}`
            : undefined,
    },
    netIn: {
      value: stats.netRxRate !== null ? formatRate(stats.netRxRate) : dash,
      sub: stats.netRxBytes !== null ? `${formatBytes(stats.netRxBytes)} received since start · host-wide` : 'Linux hosts only',
    },
    netOut: {
      value: stats.netTxRate !== null ? formatRate(stats.netTxRate) : dash,
      sub: stats.netTxBytes !== null ? `${formatBytes(stats.netTxBytes)} sent since start · host-wide` : 'Linux hosts only',
    },
    diskRead: {
      value: stats.diskReadRate !== null ? formatRate(stats.diskReadRate) : dash,
      sub: stats.diskReadBytes !== null ? `${formatBytes(stats.diskReadBytes)} read since start` : 'Linux hosts only',
    },
    diskWrite: {
      value: stats.diskWriteRate !== null ? formatRate(stats.diskWriteRate) : dash,
      sub: stats.diskWriteBytes !== null ? `${formatBytes(stats.diskWriteBytes)} written since start` : 'Linux hosts only',
    },
  };

  return (
    <div className="stagger space-y-5">
      {!running && (
        <Notice tone="warning">The server is stopped — live metrics populate once it's running. Storage figures below are still current.</Notice>
      )}

      <StatusOverview lines={lines} connected={connected} />
      <ConnectionCard />
      <BrowserStatsCard />

      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <div>
          <h2 className="text-base font-medium text-ink-100">{t('Resources')}</h2>
          <p className="text-xs text-ink-400">
            {range === 'live' ? t('Live samples every few seconds, from when you opened this page.') : `${t('Averages over')} ${t(RANGE_LABEL[range])}, ${t('saved while the instance runs.')}`}
          </p>
        </div>
        <RangeSwitch value={range} onChange={setRange} />
      </div>
      {range !== 'live' && historyError && <Notice tone="error">{historyError}</Notice>}

      <div className="stagger grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-3">
        {METRICS.map((m) => {
          if (m.key === 'uptime') {
            return (
              <MetricCard
                key={m.key}
                icon="clock"
                label="Total uptime"
                accent={CHART.neutral}
                value={uptimeMs !== null ? formatUptime(uptimeMs) : dash}
                sub={runtime?.pid ? `PID ${runtime.pid}` : 'Not running'}
              />
            );
          }
          if (range === 'live') {
            const live = liveFigures[m.key];
            return (
              <MetricCard
                key={m.key}
                icon={m.icon}
                label={m.label}
                accent={m.color}
                value={live.value}
                sub={live.sub}
                chart={<Sparkline data={series(m.live)} color={m.color} formatValue={m.format} emptyLabel="Collecting samples…" />}
              />
            );
          }
          const points = history?.points ?? [];
          const values = points.map(m.history).filter((v): v is number => v !== null);
          const peaks = points.map(m.peak ?? m.history).filter((v): v is number => v !== null);
          const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
          const peak = peaks.length ? Math.max(...peaks) : null;
          return (
            <MetricCard
              key={m.key}
              icon={m.icon}
              label={m.label}
              accent={m.color}
              value={history ? (avg !== null ? m.format(avg) : dash) : '…'}
              sub={history ? (peak !== null ? `${t('avg')} · ${t('peak')} ${m.format(peak)}` : t('No samples in this range')) : t('Loading history…')}
              chart={
                <Sparkline
                  data={points.flatMap((p) => { const v = m.history(p); return v === null ? [] : [{ t: p.t, value: v }]; })}
                  color={m.color}
                  formatValue={m.format}
                  formatTime={shortTime(range)}
                  domain={history ? [history.from, history.to] : undefined}
                  gapMs={history ? history.bucketMs * 2.5 : undefined}
                  emptyLabel={history ? 'Not enough history yet' : 'Loading…'}
                />
              }
            />
          );
        })}
        {info ? (
          <>
            <MetricCard icon="folder" label="World + files" accent={CHART.memory} value={formatBytes(info.disk.serverBytes)} sub="On disk" />
            <MetricCard icon="backup" label="Backups" accent={CHART.memory} value={formatBytes(info.disk.backupsBytes)} sub="On disk" />
          </>
        ) : (
          [0, 1].map((i) => (
            <Card key={i} className="p-5">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="mt-3 h-8 w-28" />
            </Card>
          ))
        )}
      </div>

      <p className="text-xs text-ink-500">
        {server?.platform === 'docker'
          ? 'Network and disk figures are this container’s own.'
          : "Network figures are the whole machine's traffic — the OS doesn't count network bytes per process. Disk figures are this instance's processes only."} {connected ? 'Live.' : 'Reconnecting…'}
      </p>
    </div>
  );
}
