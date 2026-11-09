/**
 * Host metrics history for the Metrics page, like Cockpit's PCP-backed history: one host-wide row
 * per minute (CPU, memory, load, network, disk) and per-service CPU, memory and disk I/O from the
 * systemd cgroup tree, kept for a week in the panel database. Unusual values (beyond three
 * standard deviations of the range shown) are flagged as anomalies.
 *
 * Network traffic can't be attributed to services from cgroups without eBPF, so network history
 * is host-wide only.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { prep } from '../db/db.js';
import { logger } from '../utils/logger.js';
import { getHostMetrics } from './hostMetricsService.js';

const MINUTE = 60_000;
const RETENTION_MS = 7 * 24 * 60 * MINUTE;
const TOP_SERVICES_PER_SAMPLE = 25;

// Tables: host_metrics and host_service_metrics (db/schema.ts).

interface CgroupSample {
  cpuUsec: number | null;
  memBytes: number | null;
  ioRead: number | null;
  ioWrite: number | null;
}

/** cgroup v2 io.stat: "8:0 rbytes=123 wbytes=456 …" per device. */
export function parseIoStat(text: string): { read: number; write: number } {
  let read = 0;
  let write = 0;
  for (const line of text.split('\n')) {
    read += Number(line.match(/rbytes=(\d+)/)?.[1] ?? 0);
    write += Number(line.match(/wbytes=(\d+)/)?.[1] ?? 0);
  }
  return { read, write };
}

export function parseCpuStat(text: string): number | null {
  const m = text.match(/^usage_usec (\d+)/m);
  return m ? Number(m[1]) : null;
}

const readNum = (file: string): number | null => {
  try {
    const v = Number(fs.readFileSync(file, 'utf8').trim());
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
};

const readText = (file: string): string | null => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

/** Every *.service cgroup under system.slice (cgroup v2), or cpuacct/memory controllers on v1. */
export function readServiceCgroups(root = '/sys/fs/cgroup'): Map<string, CgroupSample> {
  const out = new Map<string, CgroupSample>();
  const v2 = path.join(root, 'system.slice');
  if (fs.existsSync(path.join(root, 'cgroup.controllers'))) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(v2).filter((e) => e.endsWith('.service'));
    } catch {
      return out;
    }
    for (const unit of entries) {
      const dir = path.join(v2, unit);
      const cpu = readText(path.join(dir, 'cpu.stat'));
      const io = readText(path.join(dir, 'io.stat'));
      const ioParsed = io !== null ? parseIoStat(io) : null;
      out.set(unit, { cpuUsec: cpu !== null ? parseCpuStat(cpu) : null, memBytes: readNum(path.join(dir, 'memory.current')), ioRead: ioParsed?.read ?? null, ioWrite: ioParsed?.write ?? null });
    }
    return out;
  }
  // cgroup v1
  const cpuDir = ['cpu,cpuacct', 'cpuacct'].map((c) => path.join(root, c, 'system.slice')).find((d) => fs.existsSync(d));
  const memDir = path.join(root, 'memory', 'system.slice');
  if (!cpuDir) return out;
  for (const unit of fs.readdirSync(cpuDir).filter((e) => e.endsWith('.service'))) {
    const ns = readNum(path.join(cpuDir, unit, 'cpuacct.usage'));
    out.set(unit, { cpuUsec: ns !== null ? ns / 1000 : null, memBytes: readNum(path.join(memDir, unit, 'memory.usage_in_bytes')), ioRead: null, ioWrite: null });
  }
  return out;
}

let previous: { at: number; services: Map<string, CgroupSample> } | null = null;

function sample() {
  const at = Math.floor(Date.now() / MINUTE) * MINUTE;
  try {
    const m = getHostMetrics();
    prep('INSERT OR REPLACE INTO host_metrics (at, cpu, mem_mb, load1, net_rx, net_tx, disk_read, disk_write) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      at,
      m.cpu.percent,
      m.memory.usedMb,
      m.cpu.loadAvg?.[0] ?? null,
      m.network.rxRate,
      m.network.txRate,
      m.disk.readRate,
      m.disk.writeRate
    );
    if (process.platform === 'linux') {
      const now = Date.now();
      const services = readServiceCgroups();
      if (previous) {
        const seconds = (now - previous.at) / 1000;
        const cores = os.cpus().length || 1;
        const rows: Array<[string, number | null, number | null, number | null, number | null]> = [];
        for (const [unit, cur] of services) {
          const prev = previous.services.get(unit);
          const rate = (a: number | null, b: number | null | undefined) => (a !== null && b !== null && b !== undefined && seconds > 0 ? Math.max(0, (a - b) / seconds) : null);
          const cpuUsecPerSec = rate(cur.cpuUsec, prev?.cpuUsec);
          rows.push([
            unit,
            // % of the whole machine, matching the host CPU chart.
            cpuUsecPerSec !== null ? Math.round((cpuUsecPerSec / 1e6 / cores) * 1000) / 10 : null,
            cur.memBytes !== null ? Math.round((cur.memBytes / 1048576) * 10) / 10 : null,
            rate(cur.ioRead, prev?.ioRead),
            rate(cur.ioWrite, prev?.ioWrite),
          ]);
        }
        // Keep the busiest services by CPU or memory each minute.
        const busy = new Set([
          ...[...rows].sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0)).slice(0, TOP_SERVICES_PER_SAMPLE).map((r) => r[0]),
          ...[...rows].sort((a, b) => (b[2] ?? 0) - (a[2] ?? 0)).slice(0, TOP_SERVICES_PER_SAMPLE).map((r) => r[0]),
          ...[...rows].sort((a, b) => (b[3] ?? 0) + (b[4] ?? 0) - (a[3] ?? 0) - (a[4] ?? 0)).slice(0, 10).map((r) => r[0]),
        ]);
        const insert = prep('INSERT OR REPLACE INTO host_service_metrics (at, unit, cpu, mem_mb, io_read, io_write) VALUES (?, ?, ?, ?, ?, ?)');
        for (const r of rows) if (busy.has(r[0])) insert.run(at, ...r);
      }
      previous = { at: now, services };
    }
  } catch (err) {
    logger.warn(`Host metrics sample failed: ${err instanceof Error ? err.message : err}`);
  }
}

function prune() {
  const cutoff = Date.now() - RETENTION_MS;
  try {
    prep('DELETE FROM host_metrics WHERE at < ?').run(cutoff);
    prep('DELETE FROM host_service_metrics WHERE at < ?').run(cutoff);
  } catch {
    // table missing during early start
  }
}

export function startHostMetricsHistory() {
  // Prime the service counters so the first stored minute has rates.
  if (process.platform === 'linux') previous = { at: Date.now(), services: readServiceCgroups() };
  const align = MINUTE - (Date.now() % MINUTE) + 2000;
  setTimeout(() => {
    sample();
    setInterval(sample, MINUTE).unref();
  }, align).unref();
  setInterval(prune, 60 * MINUTE).unref();
}

export const RANGES: Record<string, number> = { '1h': 60 * MINUTE, '6h': 6 * 60 * MINUTE, '24h': 24 * 60 * MINUTE, '7d': 7 * 24 * 60 * MINUTE };
const MAX_POINTS = 360;

/** Averages rows into at most MAX_POINTS buckets. */
export function downsample<T extends { at: number }>(rows: T[], from: number, span: number, fields: Array<keyof T>): Array<Record<string, number | null>> {
  const step = Math.max(MINUTE, Math.ceil(span / MAX_POINTS / MINUTE) * MINUTE);
  const buckets = new Map<number, { n: Record<string, number>; sum: Record<string, number> }>();
  for (const r of rows) {
    const key = from + Math.floor((r.at - from) / step) * step;
    const b = buckets.get(key) ?? { n: {}, sum: {} };
    for (const f of fields) {
      const v = r[f] as unknown as number | null;
      if (v === null || v === undefined || !Number.isFinite(v)) continue;
      b.sum[f as string] = (b.sum[f as string] ?? 0) + v;
      b.n[f as string] = (b.n[f as string] ?? 0) + 1;
    }
    buckets.set(key, b);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([at, b]) => {
      const row: Record<string, number | null> = { at };
      for (const f of fields) row[f as string] = b.n[f as string] ? Math.round((b.sum[f as string] / b.n[f as string]) * 100) / 100 : null;
      return row;
    });
}

/** Timestamps whose value is more than three standard deviations above the mean (min. 30 points). */
export function anomalies(points: Array<Record<string, number | null>>, field: string, floor = 0): number[] {
  const values = points.map((p) => p[field]).filter((v): v is number => v !== null);
  if (values.length < 30) return [];
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
  if (sd === 0) return [];
  const limit = Math.max(mean + 3 * sd, floor);
  return points.filter((p) => p[field] !== null && (p[field] as number) > limit).map((p) => p.at as number);
}

export function metricsHistory(range: string) {
  const span = RANGES[range] ?? RANGES['6h'];
  const to = Date.now();
  const from = to - span;
  const hostRows = prep('SELECT * FROM host_metrics WHERE at >= ? ORDER BY at').all(from) as Array<{ at: number; cpu: number | null; mem_mb: number | null; load1: number | null; net_rx: number | null; net_tx: number | null; disk_read: number | null; disk_write: number | null }>;
  const host = downsample(hostRows, from, span, ['cpu', 'mem_mb', 'load1', 'net_rx', 'net_tx', 'disk_read', 'disk_write']);
  const serviceAvg = prep(
    'SELECT unit, AVG(cpu) AS cpu, AVG(mem_mb) AS mem, MAX(mem_mb) AS mem_max, MAX(cpu) AS cpu_max, AVG(COALESCE(io_read, 0) + COALESCE(io_write, 0)) AS io FROM host_service_metrics WHERE at >= ? GROUP BY unit'
  ).all(from) as Array<{ unit: string; cpu: number | null; mem: number | null; mem_max: number | null; cpu_max: number | null; io: number | null }>;
  const top = new Set([
    ...[...serviceAvg].sort((a, b) => (b.cpu ?? 0) - (a.cpu ?? 0)).slice(0, 8).map((s) => s.unit),
    ...[...serviceAvg].sort((a, b) => (b.mem ?? 0) - (a.mem ?? 0)).slice(0, 8).map((s) => s.unit),
    ...[...serviceAvg].sort((a, b) => (b.io ?? 0) - (a.io ?? 0)).slice(0, 4).map((s) => s.unit),
  ]);
  const services = [...top].map((unit) => {
    const rows = prep('SELECT at, cpu, mem_mb, io_read, io_write FROM host_service_metrics WHERE unit = ? AND at >= ? ORDER BY at').all(unit, from) as Array<{ at: number; cpu: number | null; mem_mb: number | null; io_read: number | null; io_write: number | null }>;
    const points = downsample(rows, from, span, ['cpu', 'mem_mb', 'io_read', 'io_write']);
    const avg = serviceAvg.find((s) => s.unit === unit)!;
    return {
      unit,
      avgCpu: avg.cpu !== null ? Math.round(avg.cpu * 10) / 10 : null,
      maxCpu: avg.cpu_max,
      avgMemMb: avg.mem !== null ? Math.round(avg.mem) : null,
      maxMemMb: avg.mem_max,
      avgIo: avg.io,
      points,
      anomalies: [...new Set([...anomalies(points, 'cpu', 5), ...anomalies(points, 'mem_mb')])].sort((a, b) => a - b),
    };
  });
  return {
    range,
    from,
    to,
    host,
    anomalies: {
      cpu: anomalies(host, 'cpu', 20),
      mem_mb: anomalies(host, 'mem_mb'),
      load1: anomalies(host, 'load1', os.cpus().length),
      net_rx: anomalies(host, 'net_rx', 1024 * 1024),
      net_tx: anomalies(host, 'net_tx', 1024 * 1024),
      disk_read: anomalies(host, 'disk_read', 1024 * 1024),
      disk_write: anomalies(host, 'disk_write', 1024 * 1024),
    },
    services,
    perServiceAvailable: process.platform === 'linux' && (fs.existsSync('/sys/fs/cgroup/system.slice') || fs.existsSync('/sys/fs/cgroup/cpuacct/system.slice') || fs.existsSync('/sys/fs/cgroup/cpu,cpuacct/system.slice')),
    totalMemoryMb: Math.round(os.totalmem() / 1048576),
  };
}
