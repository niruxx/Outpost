import { useCallback, useEffect, useMemo, useState } from 'react';
import { HostLayout, formatBytes } from '../components/HostLayout.js';
import { Badge, Card, CardTitle, Notice, Select, Spinner } from '../components/ui.js';
import { CHART, Sparkline, type ChartPoint } from '../components/charts.js';
import { api, ApiError } from '../api/client.js';
import { hostApi } from '../state/hostTarget.js';

type Point = Record<string, number | null> & { at: number };

interface History {
  range: string;
  from: number;
  to: number;
  host: Point[];
  anomalies: Record<string, number[]>;
  services: Array<{
    unit: string;
    avgCpu: number | null;
    maxCpu: number | null;
    avgMemMb: number | null;
    maxMemMb: number | null;
    avgIo: number | null;
    points: Point[];
    anomalies: number[];
  }>;
  perServiceAvailable: boolean;
  totalMemoryMb: number;
}

const RANGES = [
  ['1h', 'Last hour'],
  ['6h', 'Last 6 hours'],
  ['24h', 'Last 24 hours'],
  ['7d', 'Last 7 days'],
] as const;

const series = (points: Point[], field: string): ChartPoint[] => points.filter((p) => p[field] !== null).map((p) => ({ t: p.at, value: p[field] as number }));
const rate = (v: number) => `${formatBytes(v)}/s`;
const fmtT = (t: number) => new Date(t).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });

export function HostMetricsPage() {
  const [range, setRange] = useState('6h');
  const [data, setData] = useState<History | null>(null);
  const [error, setError] = useState('');
  const [sort, setSort] = useState<'cpu' | 'mem' | 'io' | 'anomalies'>('cpu');

  const load = useCallback(async () => {
    try {
      setData(await api.get<History>(hostApi(`/metrics?range=${range}`)));
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load metrics');
    }
  }, [range]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const services = useMemo(() => {
    const list = [...(data?.services ?? [])];
    const key = (s: History['services'][number]) => (sort === 'cpu' ? s.avgCpu ?? 0 : sort === 'mem' ? s.avgMemMb ?? 0 : sort === 'io' ? s.avgIo ?? 0 : s.anomalies.length);
    return list.sort((a, b) => key(b) - key(a));
  }, [data, sort]);

  const charts: Array<{ field: string; label: string; color: string; fmt: (v: number) => string; second?: { field: string; color: string; label: string } }> = [
    { field: 'cpu', label: 'CPU', color: CHART.cpu, fmt: (v) => `${v.toFixed(1)}%` },
    { field: 'mem_mb', label: 'Memory used', color: CHART.memory, fmt: (v) => formatBytes(v * 1048576) },
    { field: 'load1', label: 'Load (1 min)', color: CHART.neutral, fmt: (v) => v.toFixed(2) },
    { field: 'net_rx', label: 'Network in', color: CHART.netIn, fmt: rate },
    { field: 'net_tx', label: 'Network out', color: CHART.netOut, fmt: rate },
    { field: 'disk_read', label: 'Disk read', color: CHART.diskRead, fmt: rate },
    { field: 'disk_write', label: 'Disk write', color: CHART.diskWrite, fmt: rate },
  ];

  return (
    <HostLayout
      action={
        <Select className="w-auto" value={range} onChange={(e) => setRange(e.target.value)} aria-label="Range">
          {RANGES.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </Select>
      }
    >
      {error ? (
        <Notice tone="error">{error}</Notice>
      ) : !data ? (
        <Spinner />
      ) : (
        <>
          {data.host.length < 2 && <Notice tone="info">History is recorded once a minute while Outpost runs; charts fill in over the next few minutes.</Notice>}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {charts.map((c) => {
              const pts = series(data.host, c.field);
              const anomalies = data.anomalies[c.field] ?? [];
              const latest = pts[pts.length - 1]?.value;
              const peak = pts.reduce((m, p) => Math.max(m, p.value), 0);
              return (
                <Card key={c.field} className="p-4">
                  <div className="mb-2 flex items-baseline justify-between gap-2">
                    <span className="text-sm text-ink-300">{c.label}</span>
                    <span className="text-sm tabular-nums text-ink-100">{latest !== undefined ? c.fmt(latest) : '—'}</span>
                  </div>
                  <Sparkline data={pts} color={c.color} formatValue={c.fmt} emptyLabel="Not enough data yet" domain={[data.from, data.to]} gapMs={3 * 60_000} formatTime={fmtT} markers={new Set(anomalies)} />
                  <div className="mt-1 flex items-center justify-between text-xs text-ink-500">
                    <span>peak {pts.length ? c.fmt(peak) : '—'}</span>
                    {anomalies.length > 0 && <Badge tone="red">{anomalies.length} unusual</Badge>}
                  </div>
                </Card>
              );
            })}
          </div>

          <Card className="p-5">
            <CardTitle
              action={
                <Select className="w-auto" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort services">
                  <option value="cpu">By CPU</option>
                  <option value="mem">By memory</option>
                  <option value="io">By disk I/O</option>
                  <option value="anomalies">By unusual activity</option>
                </Select>
              }
            >
              Busiest services
            </CardTitle>
            {!data.perServiceAvailable ? (
              <p className="text-sm text-ink-500">Per-service figures come from systemd’s cgroups and are only available on Linux hosts running systemd.</p>
            ) : services.length === 0 ? (
              <p className="text-sm text-ink-500">No service history yet.</p>
            ) : (
              <div className="divide-y divide-surface-700 overflow-hidden rounded-2xl bg-surface-900">
                {services.map((s) => (
                  <div key={s.unit} className="grid grid-cols-1 items-center gap-3 px-4 py-3 md:grid-cols-[minmax(0,1.2fr)_1fr_1fr]">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 truncate font-mono text-sm text-ink-100">
                        {s.unit}
                        {s.anomalies.length > 0 && <Badge tone="red">{s.anomalies.length} unusual</Badge>}
                      </p>
                      <p className="text-xs text-ink-500">
                        CPU avg {s.avgCpu ?? '—'}% · peak {s.maxCpu !== null ? `${s.maxCpu.toFixed(1)}%` : '—'} · memory avg {s.avgMemMb !== null ? formatBytes(s.avgMemMb * 1048576) : '—'}
                        {s.avgIo ? ` · disk ${rate(s.avgIo)}` : ''}
                      </p>
                    </div>
                    <div>
                      <p className="text-[11px] text-ink-500">CPU</p>
                      <Sparkline data={series(s.points, 'cpu')} color={CHART.cpu} formatValue={(v) => `${v.toFixed(1)}%`} emptyLabel="—" height={32} domain={[data.from, data.to]} gapMs={3 * 60_000} formatTime={fmtT} markers={new Set(s.anomalies)} />
                    </div>
                    <div>
                      <p className="text-[11px] text-ink-500">Memory</p>
                      <Sparkline data={series(s.points, 'mem_mb')} color={CHART.memory} formatValue={(v) => formatBytes(v * 1048576)} emptyLabel="—" height={32} domain={[data.from, data.to]} gapMs={3 * 60_000} formatTime={fmtT} markers={new Set(s.anomalies)} />
                    </div>
                  </div>
                ))}
              </div>
            )}
            <p className="mt-3 text-xs text-ink-500">
              Red dots mark minutes more than three standard deviations above the average for the range shown. Network traffic is host-wide; Linux doesn’t attribute it to services without
              extra tracing.
            </p>
          </Card>
        </>
      )}
    </HostLayout>
  );
}
