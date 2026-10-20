import { useEffect, useRef, useState, type ReactNode } from 'react';
import { setVisibleInterval } from '../lib/perf.js';
import { t } from '../i18n/index.js';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '../api/client.js';
import type { SystemInfo, SystemMetrics } from '../api/types.js';
import { Card } from './ui.js';
import { Icon, type IconName } from './icons.js';
import { Gauge, Sparkline, type ChartPoint } from './charts.js';
import { AnimatedNumber, EMPHASIZED } from './motion.js';

const HISTORY = 45; // ~90s at the 2s poll
const COLORS = { cpu: '#78dc77', memory: '#a1ced7', disk: '#ecc65c', rx: '#9ecaff', tx: '#ffb4ab', read: '#c3c0ff', write: '#f5b971' };

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
}
const formatRate = (v: number) => `${formatBytes(v)}/s`;

export function formatDuration(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${Math.floor(sec % 60)}s`;
}

function GaugeCard({ icon, label, percent, color, primary, secondary }: { icon: IconName; label: string; percent: number | null; color: string; primary: ReactNode; secondary: ReactNode }) {
  return (
    <Card hover className="flex h-full items-center gap-4 p-4">
      <Gauge percent={percent} color={color}>
        <span className="text-lg font-medium text-ink-50">
          <AnimatedNumber value={percent} format={(v) => `${Math.round(v)}%`} />
        </span>
      </Gauge>
      <div className="min-w-0 flex-1">
        <p className="mb-1 flex items-center gap-1.5 text-sm font-medium text-ink-300">
          <Icon name={icon} className="h-4 w-4" style={{ color }} />
          {t(label)}
        </p>
        <p className="truncate text-base text-ink-50">{primary}</p>
        <p className="truncate text-xs text-ink-400">{secondary}</p>
      </div>
    </Card>
  );
}

function RateCard({ icon, label, a, b, series }: { icon: IconName; label: string; a: { label: string; value: number | null; color: string }; b: { label: string; value: number | null; color: string }; series: [ChartPoint[], ChartPoint[]] }) {
  return (
    <Card hover className="flex h-full flex-col p-4">
      <p className="mb-3 flex items-center gap-1.5 text-sm font-medium text-ink-300">
        <Icon name={icon} className="h-4 w-4" />
        {t(label)}
      </p>
      <div className="mb-2 grid grid-cols-2 gap-3">
        {[a, b].map((x) => (
          <div key={x.label}>
            <p className="text-[11px] font-medium uppercase tracking-wide" style={{ color: x.color }}>
              {t(x.label)}
            </p>
            <p className="text-lg text-ink-50">
              <AnimatedNumber value={x.value} format={formatRate} />
            </p>
          </div>
        ))}
      </div>
      <div className="mt-auto grid grid-cols-2 gap-3">
        <Sparkline data={series[0]} color={a.color} formatValue={formatRate} emptyLabel={t('Sampling…')} height={32} />
        <Sparkline data={series[1]} color={b.color} formatValue={formatRate} emptyLabel={t('Sampling…')} height={32} />
      </div>
    </Card>
  );
}

function StatusPill({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-2xl bg-surface-900 px-3 py-2">
      <p className="text-xl text-ink-50">
        <AnimatedNumber value={value} />
      </p>
      <p className={`text-[11px] font-medium ${tone}`}>{t(label)}</p>
    </div>
  );
}

/** Live host + fleet metrics shown above the instance list. */
export function HostOverview() {
  const [metrics, setMetrics] = useState<SystemMetrics | null>(null);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [showDetails, setShowDetails] = useState(() => {
    try {
      return localStorage.getItem('outpost_host_details') === '1';
    } catch {
      return false;
    }
  });
  const history = useRef<{ t: number; rx: number | null; tx: number | null; read: number | null; write: number | null }[]>([]);
  const [, force] = useState(0);

  useEffect(() => {
    api.get<SystemInfo>('/system').then(setSystem).catch(() => {});
    let cancelled = false;
    async function poll() {
      try {
        const m = await api.get<SystemMetrics>('/system/metrics');
        if (cancelled) return;
        setMetrics(m);
        history.current = [
          ...history.current,
          { t: Date.now(), rx: m.host.network.rxRate, tx: m.host.network.txRate, read: m.host.disk.readRate, write: m.host.disk.writeRate },
        ].slice(-HISTORY);
        force((n) => n + 1);
      } catch {
        // transient; next poll retries
      }
    }
    poll();
    const t = setVisibleInterval(poll, 4000);
    return () => {
      cancelled = true;
      t();
    };
  }, []);

  function toggleDetails() {
    setShowDetails((v) => {
      try {
        localStorage.setItem('outpost_host_details', v ? '0' : '1');
      } catch {
        // per-viewer preference only
      }
      return !v;
    });
  }

  const series = (key: 'rx' | 'tx' | 'read' | 'write'): ChartPoint[] =>
    history.current.filter((h) => h[key] !== null).map((h) => ({ t: h.t, value: h[key] as number }));

  if (!metrics) {
    return (
      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Card key={i} className="h-[128px] animate-pulse-soft" />
        ))}
      </div>
    );
  }

  const { host, instances } = metrics;
  const memPct = host.memory.totalMb ? (host.memory.usedMb / host.memory.totalMb) * 100 : null;
  const diskPct = host.disk.totalBytes && host.disk.usedBytes !== null ? (host.disk.usedBytes / host.disk.totalBytes) * 100 : null;

  const details: [string, string][] = [
    ['Hostname', system?.hostname ?? '…'],
    ['Primary address', system?.primaryAddress ?? '…'],
    ['Operating system', system ? `${system.platformLabel} ${system.osRelease ?? ''} (${system.arch})` : '…'],
    ['CPU', `${host.cpu.model} · ${host.cpu.cores} threads`],
    ['Load average', host.cpu.loadAvg ? host.cpu.loadAvg.join(' / ') : 'n/a'],
    ['Swap', host.memory.swapTotalMb ? `${formatBytes((host.memory.swapUsedMb ?? 0) * 1048576)} of ${formatBytes(host.memory.swapTotalMb * 1048576)}` : 'none'],
    ['Host uptime', formatDuration(host.uptimeSec)],
    ['Panel uptime', formatDuration(host.panelUptimeSec)],
    ['Network since boot', host.network.rxTotal !== null ? `↓ ${formatBytes(host.network.rxTotal)} · ↑ ${formatBytes(host.network.txTotal ?? 0)}` : 'n/a'],
    ['Data folder', host.disk.path],
    ['Node.js', system?.nodeVersion ?? '…'],
    ['Java', system ? (system.java.available ? system.java.version ?? 'detected' : 'not found') : '…'],
  ];

  return (
    <section className="mb-8 space-y-3" aria-label="Host metrics">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-medium text-ink-100">{t('This host')}</h2>
        <button onClick={toggleDetails} className="state-layer rounded-full px-3 py-1.5 text-xs font-medium text-accent-400">
          {t(showDetails ? 'Hide details' : 'Show details')}
        </button>
      </div>

      <motion.div
        className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
        initial="hidden"
        animate="show"
        variants={{ show: { transition: { staggerChildren: 0.06 } } }}
      >
        {[
          <GaugeCard
            key="cpu"
            icon="cpu"
            label="CPU"
            percent={host.cpu.percent}
            color={COLORS.cpu}
            primary={t('{n} threads', { n: host.cpu.cores })}
            secondary={host.cpu.loadAvg ? t('load {load} · instances {pct}%', { load: host.cpu.loadAvg[0], pct: instances.cpuPercent }) : t('instances {pct}%', { pct: instances.cpuPercent })}
          />,
          <GaugeCard
            key="mem"
            icon="memory"
            label="Memory"
            percent={memPct}
            color={COLORS.memory}
            primary={t('{used} of {total}', { used: formatBytes(host.memory.usedMb * 1048576), total: formatBytes(host.memory.totalMb * 1048576) })}
            secondary={t('instances use {mem}', { mem: formatBytes(instances.memoryMb * 1048576) })}
          />,
          <GaugeCard
            key="disk"
            icon="disk"
            label="Storage"
            percent={diskPct}
            color={COLORS.disk}
            primary={host.disk.usedBytes !== null ? t('{used} of {total}', { used: formatBytes(host.disk.usedBytes), total: formatBytes(host.disk.totalBytes ?? 0) }) : 'n/a'}
            secondary={host.disk.freeBytes !== null ? t('{free} free', { free: formatBytes(host.disk.freeBytes) }) : ''}
          />,
          <RateCard
            key="net"
            icon="network"
            label="Network"
            a={{ label: 'Inbound', value: host.network.rxRate, color: COLORS.rx }}
            b={{ label: 'Outbound', value: host.network.txRate, color: COLORS.tx }}
            series={[series('rx'), series('tx')]}
          />,
          <RateCard
            key="io"
            icon="disk"
            label="Disk I/O"
            a={{ label: 'Read', value: host.disk.readRate, color: COLORS.read }}
            b={{ label: 'Write', value: host.disk.writeRate, color: COLORS.write }}
            series={[series('read'), series('write')]}
          />,
          <Card key="inst" hover className="flex h-full flex-col p-4">
            <p className="mb-3 flex items-center gap-1.5 text-sm font-medium text-ink-300">
              <Icon name="instances" className="h-4 w-4" />
              {t('Instances')}
            </p>
            <div className="mt-auto grid grid-cols-3 gap-2">
              <StatusPill label="Running" value={instances.running} tone="text-success-400" />
              <StatusPill label="Stopped" value={instances.stopped} tone="text-ink-400" />
              <StatusPill label="Crashed" value={instances.crashed} tone="text-red-400" />
              <StatusPill label="Busy" value={instances.starting + instances.installing} tone="text-sky-400" />
              <StatusPill label="Suspended" value={instances.suspended} tone="text-yellow-400" />
              <StatusPill label="Total" value={instances.total} tone="text-ink-300" />
            </div>
          </Card>,
        ].map((card) => (
          <motion.div key={card.key} className="h-full" variants={{ hidden: { opacity: 0, y: 14, scale: 0.98 }, show: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.45, ease: EMPHASIZED } } }}>
            {card}
          </motion.div>
        ))}
      </motion.div>

      <AnimatePresence initial={false}>
        {showDetails && (
          <motion.div
            key="details"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.35, ease: EMPHASIZED }}
            className="overflow-hidden"
          >
            <Card className="p-5">
              <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
                {details.map(([k, v]) => (
                  <div key={k} className="min-w-0">
                    <dt className="text-xs text-ink-400">{k}</dt>
                    <dd className="truncate text-sm text-ink-100" title={v}>
                      {v}
                    </dd>
                  </div>
                ))}
              </dl>
              {host.cpu.perCore.length > 1 && (
                <div className="mt-5">
                  <p className="mb-2 text-xs text-ink-400">{t('Per-thread CPU')}</p>
                  <div className="flex h-12 items-end gap-1">
                    {host.cpu.perCore.map((p, i) => (
                      <div
                        key={i}
                        className="flex-1 rounded-t-sm"
                        style={{ backgroundColor: COLORS.cpu, opacity: 0.35 + (p / 100) * 0.65, height: `${Math.max(4, p)}%`, transition: 'height 400ms cubic-bezier(0.2, 0, 0, 1)' }}
                        title={`Thread ${i}: ${p}%`}
                      />
                    ))}
                  </div>
                </div>
              )}
            </Card>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
