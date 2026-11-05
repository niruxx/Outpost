import { prep } from '../db/db.js';
import { logger } from '../utils/logger.js';
import type { ProcessStats } from './statsService.js';

/**
 * Persisted resource history. The process manager samples every running instance every few
 * seconds for the live view; here those samples are averaged into one row per instance per
 * minute (peaks kept for CPU and memory) and kept for a week, so the Status page can show
 * trends across restarts and page visits.
 */
const MINUTE_MS = 60_000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

type Field = 'cpu' | 'memoryMb' | 'netRx' | 'netTx' | 'diskRead' | 'diskWrite';
const FIELDS: Field[] = ['cpu', 'memoryMb', 'netRx', 'netTx', 'diskRead', 'diskWrite'];

interface Bucket {
  at: number;
  sum: Record<Field, number>;
  count: Record<Field, number>;
  cpuMax: number | null;
  memMax: number | null;
}

const buckets = new Map<string, Bucket>();

function emptyBucket(at: number): Bucket {
  const zero = () => Object.fromEntries(FIELDS.map((f) => [f, 0])) as Record<Field, number>;
  return { at, sum: zero(), count: zero(), cpuMax: null, memMax: null };
}

function writeBucket(serverId: string, b: Bucket): void {
  const avg = (f: Field) => (b.count[f] ? b.sum[f] / b.count[f] : null);
  if (!FIELDS.some((f) => b.count[f])) return;
  try {
    prep(
      `INSERT OR REPLACE INTO server_metrics (server_id, at, cpu, cpu_max, memory_mb, memory_max_mb, net_rx, net_tx, disk_read, disk_write)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(serverId, b.at, avg('cpu'), b.cpuMax, avg('memoryMb'), b.memMax, avg('netRx'), avg('netTx'), avg('diskRead'), avg('diskWrite'));
  } catch (err) {
    // The instance may have just been deleted (foreign key) — history is best-effort.
    logger.debug(`Could not store metrics for ${serverId}: ${(err as Error).message}`);
  }
}

/** Called with every live stats sample. Writes the previous minute once a new one starts. */
export function recordStats(serverId: string, stats: ProcessStats, now = Date.now()): void {
  const minute = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  let bucket = buckets.get(serverId);
  if (bucket && bucket.at !== minute) {
    writeBucket(serverId, bucket);
    bucket = undefined;
  }
  if (!bucket) {
    bucket = emptyBucket(minute);
    buckets.set(serverId, bucket);
  }
  const values: Record<Field, number | null> = {
    cpu: stats.cpuPercent,
    memoryMb: stats.memoryMb,
    netRx: stats.netRxRate,
    netTx: stats.netTxRate,
    diskRead: stats.diskReadRate,
    diskWrite: stats.diskWriteRate,
  };
  for (const f of FIELDS) {
    const v = values[f];
    if (v === null || !Number.isFinite(v)) continue;
    bucket.sum[f] += v;
    bucket.count[f] += 1;
  }
  if (stats.cpuPercent !== null) bucket.cpuMax = Math.max(bucket.cpuMax ?? 0, stats.cpuPercent);
  if (stats.memoryMb !== null) bucket.memMax = Math.max(bucket.memMax ?? 0, stats.memoryMb);
}

/** Writes whatever has been collected for an instance — call when its process exits. */
export function flushStats(serverId: string): void {
  const bucket = buckets.get(serverId);
  if (bucket) writeBucket(serverId, bucket);
  buckets.delete(serverId);
}

export type HistoryRange = '1h' | '24h' | '7d';
const RANGES: Record<HistoryRange, { spanMs: number; bucketMs: number }> = {
  '1h': { spanMs: 60 * MINUTE_MS, bucketMs: MINUTE_MS }, // 60 points
  '24h': { spanMs: 24 * 60 * MINUTE_MS, bucketMs: 5 * MINUTE_MS }, // 288 points
  '7d': { spanMs: 7 * 24 * 60 * MINUTE_MS, bucketMs: 30 * MINUTE_MS }, // 336 points
};

export function isHistoryRange(value: unknown): value is HistoryRange {
  return typeof value === 'string' && value in RANGES;
}

export interface HistoryPoint {
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

const round = (v: number | null, digits = 1) => (v === null ? null : Math.round(v * 10 ** digits) / 10 ** digits);

/** Downsampled history: averages per bucket, with the highest CPU/memory seen in each. */
export function metricsHistory(serverId: string, range: HistoryRange, now = Date.now()): { range: HistoryRange; bucketMs: number; from: number; to: number; points: HistoryPoint[] } {
  const { spanMs, bucketMs } = RANGES[range];
  const from = now - spanMs;
  // Include the minute still being collected so the newest point isn't up to a minute stale.
  const pending = buckets.get(serverId);
  if (pending) writeBucket(serverId, pending);
  const rows = prep(
    // node:sqlite binds JS numbers as REAL; cast so the division floors to the bucket start.
    `SELECT (at / CAST(? AS INTEGER)) * CAST(? AS INTEGER) AS t,
            AVG(cpu) AS cpu, MAX(cpu_max) AS cpuMax,
            AVG(memory_mb) AS memoryMb, MAX(memory_max_mb) AS memoryMaxMb,
            AVG(net_rx) AS netRx, AVG(net_tx) AS netTx,
            AVG(disk_read) AS diskRead, AVG(disk_write) AS diskWrite
       FROM server_metrics
      WHERE server_id = ? AND at >= ?
      GROUP BY t
      ORDER BY t`
  ).all(bucketMs, bucketMs, serverId, from) as unknown as HistoryPoint[];
  return {
    range,
    bucketMs,
    from,
    to: now,
    points: rows.map((r) => ({
      t: Number(r.t),
      cpu: round(r.cpu),
      cpuMax: round(r.cpuMax),
      memoryMb: round(r.memoryMb, 0),
      memoryMaxMb: round(r.memoryMaxMb, 0),
      netRx: round(r.netRx, 0),
      netTx: round(r.netTx, 0),
      diskRead: round(r.diskRead, 0),
      diskWrite: round(r.diskWrite, 0),
    })),
  };
}

function prune(): void {
  try {
    prep('DELETE FROM server_metrics WHERE at < ?').run(Date.now() - RETENTION_MS);
  } catch (err) {
    logger.warn(`Pruning resource history failed: ${(err as Error).message}`);
  }
}

let started = false;

/** Prunes week-old history now and hourly. */
export function startMetricsHistory(): void {
  if (started) return;
  started = true;
  prune();
  setInterval(prune, 60 * MINUTE_MS).unref();
}
