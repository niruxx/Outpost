import { useEffect, useState } from 'react';
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

const emptyConsole = (): ConsoleState => ({ lines: [], status: null, stats: { ...EMPTY_STATS }, statsHistory: [], connected: false, installProgress: null });

export function useConsoleSocket(serverId: string | undefined): ConsoleState {
  const [snapshot, setSnapshot] = useState<ConsoleState & { serverId?: string }>(() => ({ ...emptyConsole(), serverId }));
  useEffect(() => {
    setSnapshot({ ...emptyConsole(), serverId });
    if (!serverId) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let currentSocket: WebSocket | null = null;
    const pending: LogLine[] = [];
    function clearPending() { clearTimeout(flushTimer); flushTimer = undefined; pending.length = 0; }
    function connect() {
      if (cancelled) return;
      const ws = new WebSocket(wsUrl(`/ws/console/${serverId}`));
      currentSocket = ws;
      const current = () => !cancelled && currentSocket === ws;
      ws.onopen = () => { if (current()) setSnapshot(old => ({ ...old, connected: true })); };
      ws.onclose = () => {
        if (!current()) return;
        setSnapshot(old => ({ ...old, connected: false }));
        retryTimer = setTimeout(connect, 2000);
      };
      ws.onerror = () => { if (current()) ws.close(); };
      ws.onmessage = event => {
        if (!current()) return;
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'hello') {
          // Reconnect history supersedes any buffered lines from the disconnected socket.
          clearPending();
          setSnapshot(old => ({ ...old, status: msg.status,
            stats: { ...EMPTY_STATS, ...msg.runtime?.stats }, installProgress: null,
            lines: (Array.isArray(msg.history) ? msg.history : []).filter((line: unknown): line is string => typeof line === 'string').slice(-MAX_LINES).map((line: string) => ({ id: counter++, stream: 'stdout' as const, line, at: Date.now() })) }));
        } else if (msg.type === 'log' && typeof msg.line === 'string') {
          pending.push({ id: counter++, stream: msg.stream, line: msg.line, at: msg.at });
          if (!flushTimer) flushTimer = setTimeout(() => {
            flushTimer = undefined;
            if (!current()) { pending.length = 0; return; }
            const batch = pending.splice(0);
            setSnapshot(old => ({ ...old, lines: old.lines.concat(batch).slice(-MAX_LINES) }));
          }, 200);
        } else if (msg.type === 'status') {
          setSnapshot(old => ({ ...old, status: msg.status, installProgress: ['installing', 'updating'].includes(msg.status) ? old.installProgress : null }));
        } else if (msg.type === 'stats') {
          const { type: _type, ...rest } = msg;
          const sample: Stats = { ...EMPTY_STATS, ...rest };
          setSnapshot(old => ({ ...old, stats: sample, statsHistory: [...old.statsHistory, { ...sample, t: Date.now() }].slice(-MAX_STATS_SAMPLES) }));
        } else if (msg.type === 'install_progress' && typeof msg.pct === 'number' && typeof msg.message === 'string') {
          setSnapshot(old => ({ ...old, installProgress: { pct: Math.max(0, Math.min(100, msg.pct)), message: msg.message } }));
        }
      };
    }
    connect();
    return () => { cancelled = true; clearPending(); clearTimeout(retryTimer); currentSocket?.close(); };
  }, [serverId]);
  return snapshot.serverId === serverId ? snapshot : emptyConsole();
}
