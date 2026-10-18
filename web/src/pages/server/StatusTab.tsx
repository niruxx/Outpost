import { useEffect, useState, type ReactNode } from 'react';
import { useServerDetail } from './ServerContext.js';
import { useConsoleSocket } from '../../hooks/useConsoleSocket.js';
import { useEndpoint } from '../../hooks/useEndpoint.js';
import { api, ApiError } from '../../api/client.js';
import type { ResourcesInfo } from '../../api/types.js';
import { Card, CardTitle, Notice, Skeleton } from '../../components/ui.js';
import { Icon, type IconName } from '../../components/icons.js';
import { Sparkline, type ChartPoint } from '../../components/charts.js';

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
  cpu: '#78dc77',
  memory: '#a1ced7',
  netIn: '#9ecaff',
  netOut: '#ecc65c',
  diskRead: '#c3c0ff',
  diskWrite: '#ffb4ab',
};

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
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full" style={{ backgroundColor: `${accent}22`, color: accent }}>
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
  const { stats, statsHistory, connected } = useConsoleSocket(serverId);
  const [info, setInfo] = useState<ResourcesInfo | null>(null);
  const [error, setError] = useState('');
  const [uptimeAnchor, setUptimeAnchor] = useState<{ uptimeMs: number; at: number } | null>(null);
  const [now, setNow] = useState(Date.now());

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
    const interval = setInterval(load, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [serverId]);

  // Tick the uptime locally between the 3s context refreshes so it counts smoothly.
  useEffect(() => {
    setUptimeAnchor(runtime ? { uptimeMs: runtime.uptimeMs, at: Date.now() } : null);
  }, [runtime]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const series = (pick: (s: (typeof statsHistory)[number]) => number | null): ChartPoint[] =>
    statsHistory.filter((s) => pick(s) !== null).map((s) => ({ t: s.t, value: pick(s) as number }));

  if (error) return <Notice tone="error">{error}</Notice>;

  const isJava = server?.platform === 'java';
  const memLimitMb = isJava ? server?.max_memory_mb : info?.host.totalMemMb;
  const memPct = stats.memoryMb !== null && memLimitMb ? Math.min(100, Math.round((stats.memoryMb / memLimitMb) * 100)) : null;
  const uptimeMs = uptimeAnchor ? uptimeAnchor.uptimeMs + (now - uptimeAnchor.at) : null;
  const dash = '—';

  return (
    <div className="stagger space-y-5">
      {!running && (
        <Notice tone="warning">The server is stopped — live metrics populate once it's running. Storage figures below are still current.</Notice>
      )}

      <ConnectionCard />

      <div className="stagger grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-3">
        <MetricCard
          icon="cpu"
          label="CPU load"
          accent={COLORS.cpu}
          value={stats.cpuPercent !== null ? `${stats.cpuPercent}%` : dash}
          sub={info ? `of ${info.host.cpuCores} cores${info.host.loadAvg !== null ? ` · host load ${info.host.loadAvg.toFixed(2)}` : ''}` : undefined}
          chart={<Sparkline data={series((s) => s.cpuPercent)} color={COLORS.cpu} formatValue={(v) => `${v.toFixed(1)}%`} emptyLabel="Collecting samples…" />}
        />
        <MetricCard
          icon="memory"
          label="Memory load"
          accent={COLORS.memory}
          value={stats.memoryMb !== null ? formatBytes(stats.memoryMb * 1024 * 1024) : dash}
          sub={
            memPct !== null
              ? `${memPct}% of ${isJava ? `${server?.max_memory_mb} MB allocated` : 'host RAM'}`
              : memLimitMb
                ? `${isJava ? 'Allocated' : 'Host RAM'}: ${formatBytes(memLimitMb * 1024 * 1024)}`
                : undefined
          }
          chart={<Sparkline data={series((s) => s.memoryMb)} color={COLORS.memory} formatValue={(v) => formatBytes(v * 1024 * 1024)} emptyLabel="Collecting samples…" />}
        />
        <MetricCard
          icon="clock"
          label="Total uptime"
          accent="#d6c7a0"
          value={uptimeMs !== null ? formatUptime(uptimeMs) : dash}
          sub={runtime?.pid ? `PID ${runtime.pid}` : 'Not running'}
        />
        <MetricCard
          icon="network"
          label="Network inbound"
          accent={COLORS.netIn}
          value={stats.netRxRate !== null ? formatRate(stats.netRxRate) : dash}
          sub={stats.netRxBytes !== null ? `${formatBytes(stats.netRxBytes)} received since start · host-wide` : 'Linux hosts only'}
          chart={<Sparkline data={series((s) => s.netRxRate)} color={COLORS.netIn} formatValue={formatRate} emptyLabel="Collecting samples…" />}
        />
        <MetricCard
          icon="network"
          label="Network outbound"
          accent={COLORS.netOut}
          value={stats.netTxRate !== null ? formatRate(stats.netTxRate) : dash}
          sub={stats.netTxBytes !== null ? `${formatBytes(stats.netTxBytes)} sent since start · host-wide` : 'Linux hosts only'}
          chart={<Sparkline data={series((s) => s.netTxRate)} color={COLORS.netOut} formatValue={formatRate} emptyLabel="Collecting samples…" />}
        />
        <MetricCard
          icon="disk"
          label="Disk read"
          accent={COLORS.diskRead}
          value={stats.diskReadRate !== null ? formatRate(stats.diskReadRate) : dash}
          sub={stats.diskReadBytes !== null ? `${formatBytes(stats.diskReadBytes)} read since start` : 'Linux hosts only'}
          chart={<Sparkline data={series((s) => s.diskReadRate)} color={COLORS.diskRead} formatValue={formatRate} emptyLabel="Collecting samples…" />}
        />
        <MetricCard
          icon="disk"
          label="Disk write"
          accent={COLORS.diskWrite}
          value={stats.diskWriteRate !== null ? formatRate(stats.diskWriteRate) : dash}
          sub={stats.diskWriteBytes !== null ? `${formatBytes(stats.diskWriteBytes)} written since start` : 'Linux hosts only'}
          chart={<Sparkline data={series((s) => s.diskWriteRate)} color={COLORS.diskWrite} formatValue={formatRate} emptyLabel="Collecting samples…" />}
        />
        {info ? (
          <>
            <MetricCard icon="folder" label="World + files" accent="#b5ccb9" value={formatBytes(info.disk.serverBytes)} sub="On disk" />
            <MetricCard icon="backup" label="Backups" accent="#b5ccb9" value={formatBytes(info.disk.backupsBytes)} sub="On disk" />
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
