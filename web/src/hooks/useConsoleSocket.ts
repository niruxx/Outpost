import { useEffect, useRef, useState } from 'react';
import { wsUrl } from '../api/client.js';
import type { ProcessStats, ServerStatus } from '../api/types.js';

export interface LogLine {
  id: number;
  stream: 'stdout' | 'stderr' | 'system';
  line: string;
  at: number;
}

export type Stats = ProcessStats;

export const EMPTY_STATS: Stats = {
  memoryMb: null,
  cpuPercent: null,
  diskReadBytes: null,
  diskWriteBytes: null,
  diskReadRate: null,
  diskWriteRate: null,
  netRxBytes: null,
  netTxBytes: null,
  netRxRate: null,
  netTxRate: null,
};

export interface StatsSample extends Stats {
  t: number;
}

interface ConsoleState {
  lines: LogLine[];
  status: ServerStatus | null;
  stats: Stats;
  statsHistory: StatsSample[];
  connected: boolean;
  installProgress: { pct: number; message: string } | null;
}

const MAX_LINES = 4000;
const MAX_STATS_SAMPLES = 150; // ~10 minutes at the 4s server-side poll interval
let counter = 0;

export function useConsoleSocket(serverId: string | undefined): ConsoleState {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);
  const [statsHistory, setStatsHistory] = useState<StatsSample[]>([]);
  const [connected, setConnected] = useState(false);
  const [installProgress, setInstallProgress] = useState<{ pct: number; message: string } | null>(null);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!serverId) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout>;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const pending: LogLine[] = [];

    function connect() {
      const ws = new WebSocket(wsUrl(`/ws/console/${serverId}`));
      socketRef.current = ws;

      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!cancelled) retryTimer = setTimeout(connect, 2000);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'hello') {
          setStatus(msg.status);
          if (msg.runtime?.stats) setStats({ ...EMPTY_STATS, ...msg.runtime.stats });
          setLines(
            (msg.history as string[]).map((line) => ({ id: counter++, stream: 'stdout' as const, line, at: Date.now() }))
          );
        } else if (msg.type === 'log') {
          // A busy server prints dozens of lines a second; render them in batches.
          pending.push({ id: counter++, stream: msg.stream, line: msg.line, at: msg.at });
          if (!flushTimer) {
            flushTimer = setTimeout(() => {
              flushTimer = undefined;
              const batch = pending.splice(0);
              setLines((prev) => {
                const next = prev.concat(batch);
                return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
              });
            }, 200);
          }
        } else if (msg.type === 'status') {
          setStatus(msg.status);
          if (msg.status !== 'installing') setInstallProgress(null);
        } else if (msg.type === 'stats') {
          const { type: _type, ...rest } = msg;
          const sample: Stats = { ...EMPTY_STATS, ...rest };
          setStats(sample);
          setStatsHistory((prev) => {
            const next = [...prev, { ...sample, t: Date.now() }];
            return next.length > MAX_STATS_SAMPLES ? next.slice(next.length - MAX_STATS_SAMPLES) : next;
          });
        } else if (msg.type === 'install_progress') {
          setInstallProgress({ pct: msg.pct, message: msg.message });
        }
      };
    }

    connect();
    return () => {
      cancelled = true;
      clearTimeout(flushTimer);
      clearTimeout(retryTimer);
      socketRef.current?.close();
    };
  }, [serverId]);

  return { lines, status, stats, statsHistory, connected, installProgress };
}
