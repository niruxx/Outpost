import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { t } from '../i18n/index.js';
import type { HostTemperatures as HostTemps, SensorCategory, TemperatureSensor } from '../api/types.js';
import { Card } from './ui.js';
import { Icon, type IconName } from './icons.js';
import { MiniBar } from './charts.js';
import { AnimatedNumber, EMPHASIZED } from './motion.js';

/** Fallback warn/critical thresholds (°C) for chips that don't publish their own. */
const DEFAULTS: Record<SensorCategory, [number, number]> = {
  cpu: [85, 95],
  memory: [75, 85],
  chipset: [80, 95],
  drive: [60, 70],
  gpu: [85, 95],
  motherboard: [70, 85],
  other: [80, 95],
};

const CATEGORY_LABEL: Record<SensorCategory, string> = {
  cpu: 'CPU',
  memory: 'RAM',
  chipset: 'Chipset',
  drive: 'Drive',
  gpu: 'GPU',
  motherboard: 'Motherboard',
  other: 'Other',
};

type Level = 'ok' | 'warm' | 'hot';
const LEVEL_TEXT: Record<Level, string> = { ok: 'text-success-400', warm: 'text-yellow-400', hot: 'text-red-400' };
const LEVEL_COLOR: Record<Level, string> = { ok: 'rgb(var(--success-400))', warm: 'rgb(var(--yellow-400))', hot: 'rgb(var(--red-400))' };

function limits(s: TemperatureSensor): [number, number] {
  const [warn, crit] = DEFAULTS[s.category];
  const critical = s.critical ?? crit;
  // Some chips publish a "max" equal to (or above) critical; warn a little earlier in that case.
  const high = s.high !== null && s.high < critical ? s.high : Math.min(warn, critical - 5);
  return [high, critical];
}

function level(s: TemperatureSensor): Level {
  const [high, critical] = limits(s);
  if (s.celsius >= critical) return 'hot';
  if (s.celsius >= high) return 'warm';
  return 'ok';
}

/** How far the reading is towards its critical point, for the bar. */
function heat(s: TemperatureSensor): number {
  const [, critical] = limits(s);
  return Math.max(0, Math.min(100, ((s.celsius - 20) / Math.max(1, critical - 20)) * 100));
}

const fmt = (c: number) => `${c.toFixed(c % 1 === 0 ? 0 : 1)} °C`;

function hottest(list: TemperatureSensor[]): TemperatureSensor | null {
  return list.reduce<TemperatureSensor | null>((a, s) => (!a || s.celsius > a.celsius ? s : a), null);
}

function staleNote(s: TemperatureSensor): string | undefined {
  if (!s.readAt) return undefined;
  return t('Last read {time} — the drive has been idle since, so it is not polled (lets it spin down).', { time: new Date(s.readAt).toLocaleTimeString() });
}

function SensorRow({ s, name }: { s: TemperatureSensor; name: string }) {
  const lv = level(s);
  const [high, critical] = limits(s);
  return (
    <li className="min-w-0" title={`${s.device} · ${s.label} (${s.chip})\n${t('warn')} ${fmt(high)} · ${t('critical')} ${fmt(critical)}${s.readAt ? `\n${staleNote(s)}` : ''}`}>
      <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
        <span className="truncate text-ink-300">{name}</span>
        <span className={`shrink-0 font-medium tabular-nums ${LEVEL_TEXT[lv]}`}>
          {s.readAt && <span className="mr-1 text-ink-500">⏸</span>}
          {fmt(s.celsius)}
        </span>
      </div>
      <MiniBar percent={heat(s)} color={LEVEL_COLOR[lv]} />
    </li>
  );
}

const MAX_ROWS = 5;

function CategoryCard({
  icon,
  title,
  sensors,
  empty,
  nameOf,
  summary,
}: {
  icon: IconName;
  title: string;
  sensors: TemperatureSensor[];
  empty: string;
  nameOf: (s: TemperatureSensor) => string;
  summary?: TemperatureSensor | null;
}) {
  const top = summary ?? hottest(sensors);
  const lv = top ? level(top) : 'ok';
  const rows = [...sensors].sort((a, b) => b.celsius - a.celsius);
  const shown = rows.slice(0, MAX_ROWS);
  return (
    <Card hover className="flex h-full flex-col p-4">
      <div className="mb-3 flex items-start justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-medium text-ink-300">
          <Icon name={icon} className="h-4 w-4" />
          {t(title)}
        </p>
        {top && (
          <span className={`text-lg font-medium tabular-nums ${LEVEL_TEXT[lv]}`} title={`${top.device} · ${top.label}`}>
            <AnimatedNumber value={top.celsius} format={(v) => `${Math.round(v)} °C`} />
          </span>
        )}
      </div>
      {sensors.length === 0 ? (
        <p className="mt-auto text-xs text-ink-400">{t(empty)}</p>
      ) : (
        <ul className="space-y-2.5">
          {shown.map((s) => (
            <SensorRow key={s.id} s={s} name={nameOf(s)} />
          ))}
          {rows.length > shown.length && <li className="text-[11px] text-ink-400">{t('+{n} more in All sensors', { n: rows.length - shown.length })}</li>}
        </ul>
      )}
    </Card>
  );
}

const isCore = (s: TemperatureSensor) => /^(core|cpu)\s*\d+$/i.test(s.label.trim());
const isPackage = (s: TemperatureSensor) => /package|tctl|tdie|^cpu$|x86_pkg_temp|soc/i.test(s.label) || s.chip === 'x86_pkg_temp';

function CpuCard({ sensors, multiSocket }: { sensors: TemperatureSensor[]; multiSocket: boolean }) {
  const packages = sensors.filter((s) => !isCore(s));
  const cores = sensors.filter(isCore);
  const summary = hottest(sensors.filter(isPackage)) ?? hottest(sensors);
  const prefix = (s: TemperatureSensor) => (multiSocket ? `${s.device} · ` : '');
  return (
    <Card hover className="flex h-full flex-col p-4">
      <div className="mb-3 flex items-start justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-medium text-ink-300">
          <Icon name="cpu" className="h-4 w-4" />
          {t('CPU temperatures')}
        </p>
        {summary && (
          <span className={`text-lg font-medium tabular-nums ${LEVEL_TEXT[level(summary)]}`} title={`${summary.device} · ${summary.label}`}>
            <AnimatedNumber value={summary.celsius} format={(v) => `${Math.round(v)} °C`} />
          </span>
        )}
      </div>
      {sensors.length === 0 ? (
        <p className="mt-auto text-xs text-ink-400">{t('No CPU sensors detected.')}</p>
      ) : (
        <>
          <ul className="space-y-2.5">
            {packages.slice(0, MAX_ROWS).map((s) => (
              <SensorRow key={s.id} s={s} name={`${prefix(s)}${s.label}`} />
            ))}
          </ul>
          {cores.length > 0 && (
            <div className="mt-auto pt-3">
              <p className="mb-1.5 flex justify-between text-[11px] text-ink-400">
                <span>{t('Per-core')}</span>
                <span className="tabular-nums">
                  {fmt(Math.min(...cores.map((c) => c.celsius)))} – {fmt(Math.max(...cores.map((c) => c.celsius)))}
                </span>
              </p>
              <div className="flex h-8 items-end gap-0.5">
                {cores.map((c) => {
                  const lv = level(c);
                  return (
                    <div
                      key={c.id}
                      className="flex-1 rounded-t-sm"
                      style={{ backgroundColor: LEVEL_COLOR[lv], opacity: 0.45 + (heat(c) / 100) * 0.55, height: `${Math.max(8, heat(c))}%`, transition: 'height 400ms cubic-bezier(0.2, 0, 0, 1)' }}
                      title={`${prefix(c)}${c.label}: ${fmt(c.celsius)}`}
                    />
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

const ORDER: SensorCategory[] = ['cpu', 'memory', 'chipset', 'drive', 'gpu', 'motherboard', 'other'];

function AllSensors({ sensors }: { sensors: TemperatureSensor[] }) {
  const groups = new Map<string, TemperatureSensor[]>();
  const sorted = [...sensors].sort((a, b) => ORDER.indexOf(a.category) - ORDER.indexOf(b.category) || a.device.localeCompare(b.device));
  for (const s of sorted) {
    const key = `${s.device}\u0000${s.chip}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  return (
    <Card className="p-5">
      <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2 xl:grid-cols-3">
        {[...groups.values()].map((list) => (
          <div key={`${list[0].device}-${list[0].chip}`} className="min-w-0">
            <p className="mb-2 flex items-baseline justify-between gap-2">
              <span className="truncate text-sm font-medium text-ink-100" title={list[0].device}>
                {list[0].device}
              </span>
              <span className="shrink-0 text-[11px] text-ink-400">
                {t(CATEGORY_LABEL[list[0].category])} · <span className="font-mono">{list[0].chip}</span>
              </span>
            </p>
            <table className="w-full text-xs">
              <thead className="sr-only">
                <tr>
                  <th>{t('Sensor')}</th>
                  <th>{t('Temperature')}</th>
                  <th>{t('Warn')}</th>
                  <th>{t('Critical')}</th>
                </tr>
              </thead>
              <tbody>
                {list.map((s) => {
                  const lv = level(s);
                  return (
                    <tr key={s.id} className="border-t border-surface-700/60" title={staleNote(s)}>
                      <td className="max-w-0 truncate py-1 pr-2 text-ink-300">{s.label}</td>
                      <td className={`whitespace-nowrap py-1 pr-2 text-right font-medium tabular-nums ${LEVEL_TEXT[lv]}`}>
                        {s.readAt && <span className="mr-1 text-ink-500">⏸</span>}
                        {fmt(s.celsius)}
                      </td>
                      <td className="whitespace-nowrap py-1 pr-2 text-right tabular-nums text-ink-400" title={t('Warning threshold')}>
                        {s.high !== null ? fmt(s.high) : '—'}
                      </td>
                      <td className="whitespace-nowrap py-1 text-right tabular-nums text-ink-400" title={t('Critical threshold')}>
                        {s.critical !== null ? fmt(s.critical) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
      </div>
      <p className="mt-4 text-[11px] text-ink-500">{t('Columns: reading · warning threshold · critical threshold, as published by each chip. ⏸ marks an idle drive showing its last reading.')}</p>
    </Card>
  );
}

/** Temperature sensors for the host overview: per-category cards plus a full per-sensor list. */
export function HostTemperatures({ data }: { data: HostTemps | undefined }) {
  const [showAll, setShowAll] = useState(() => {
    try {
      return localStorage.getItem('outpost_host_sensors') === '1';
    } catch {
      return false;
    }
  });

  function toggle() {
    setShowAll((v) => {
      try {
        localStorage.setItem('outpost_host_sensors', v ? '0' : '1');
      } catch {
        // per-viewer preference only
      }
      return !v;
    });
  }

  if (!data) return null;
  const sensors = data.sensors;
  const by = (c: SensorCategory) => sensors.filter((s) => s.category === c);
  const cpu = by('cpu');
  const ram = by('memory');
  const chipset = by('chipset');
  const drives = by('drive');
  const peak = hottest(sensors);
  const multiSocket = new Set(cpu.map((s) => s.device)).size > 1;
  const driveCount = new Set(drives.map((s) => s.device)).size;
  // One row per drive: NVMe's "Composite" stands in for its extra sub-sensors (all still in All sensors).
  const driveRows = drives.filter((s) => {
    const same = drives.filter((d) => d.device === s.device);
    return same.length === 1 || !same.some((d) => /composite/i.test(d.label)) || /composite/i.test(s.label);
  });
  const driveName = (s: TemperatureSensor) => (driveRows.filter((d) => d.device === s.device).length > 1 ? `${s.device} · ${s.label}` : s.device);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
        <h3 className="flex items-center gap-1.5 text-sm font-medium text-ink-100">
          <Icon name="thermometer" className="h-4 w-4" />
          {t('Temperatures')}
          {peak && (
            <span className="ml-1 text-xs font-normal text-ink-400">
              {t('{n} sensors · hottest {temp}', { n: sensors.length, temp: fmt(peak.celsius) })}
            </span>
          )}
        </h3>
        {sensors.length > 0 && (
          <button onClick={toggle} className="state-layer rounded-full px-3 py-1.5 text-xs font-medium text-accent-400" aria-expanded={showAll}>
            {t(showAll ? 'Hide all sensors' : 'All sensors')}
          </button>
        )}
      </div>

      {!data.supported ? (
        <Card className="p-4 text-xs text-ink-400">{t('Temperature sensors are read from Linux hwmon/thermal sysfs and are not available on this platform.')}</Card>
      ) : sensors.length === 0 ? (
        <Card className="p-4 text-xs text-ink-400">
          {t('This host exposes no temperature sensors. Virtual machines and containers usually have none; on bare metal, install lm-sensors and run sensors-detect, and load the drivetemp module for SATA drive temperatures.')}
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <CpuCard sensors={cpu} multiSocket={multiSocket} />
          <CategoryCard icon="memory" title="RAM temperatures" sensors={ram} empty="No DIMM sensors detected (needs jc42 or spd5118 support)." nameOf={(s) => s.device} />
          <CategoryCard icon="grid" title="Chipset temperatures" sensors={chipset} empty="No chipset sensors detected." nameOf={(s) => (s.label === s.chip || s.label === 'Temperature' ? s.device : `${s.device} · ${s.label}`)} />
          <CategoryCard
            icon="disk"
            title={driveCount ? t('Drive temperatures ({n})', { n: driveCount }) : 'Drive temperatures'}
            sensors={driveRows}
            empty="No drive sensors detected (NVMe reports natively; SATA needs the drivetemp module)."
            nameOf={driveName}
          />
        </div>
      )}

      <AnimatePresence initial={false}>
        {showAll && sensors.length > 0 && (
          <motion.div
            key="all-sensors"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.35, ease: EMPHASIZED }}
            className="overflow-hidden"
          >
            <AllSensors sensors={sensors} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
