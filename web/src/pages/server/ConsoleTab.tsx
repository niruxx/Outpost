import { useEffect, useRef, useState, type FormEvent } from 'react';
import { t } from '../../i18n/index.js';
import { motion } from 'framer-motion';
import { useServerDetail } from './ServerContext.js';
import { useConsoleSocket } from '../../hooks/useConsoleSocket.js';
import { api } from '../../api/client.js';
import { Button, Card, Input, Spinner } from '../../components/ui.js';
import { ConsoleHistory } from './ConsoleHistory.js';

// Terminal palette: status hues follow the MD3 scheme; plain output stays a neutral light gray.
function lineColor(stream: string, line: string): string {
  if (stream === 'stderr') return 'text-red-400';
  if (stream === 'system') return 'text-sky-400';
  if (/\bWARN\b/.test(line)) return 'text-yellow-400';
  if (/\bERROR\b/.test(line)) return 'text-red-400';
  return 'text-slate-300';
}

export function ConsoleTab() {
  const { serverId, can } = useServerDetail();
  const canWrite = can('console');
  const { lines, status, stats, connected, installProgress } = useConsoleSocket(serverId);
  const [command, setCommand] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines, autoScroll]);

  async function submitCommand(e: FormEvent) {
    e.preventDefault();
    const trimmed = command.trim();
    if (!trimmed) return;
    setHistory((h) => [...h, trimmed]);
    setHistoryIdx(-1);
    setCommand('');
    try {
      await api.post(`/servers/${serverId}/command`, { command: trimmed });
    } catch {
      // errors already appear in the console output stream
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (history.length === 0) return;
      const next = historyIdx === -1 ? history.length - 1 : Math.max(0, historyIdx - 1);
      setHistoryIdx(next);
      setCommand(history[next]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIdx === -1) return;
      const next = historyIdx + 1;
      if (next >= history.length) {
        setHistoryIdx(-1);
        setCommand('');
      } else {
        setHistoryIdx(next);
        setCommand(history[next]);
      }
    }
  }

  const isRunningLike = status === 'running' || status === 'starting';

  return (
    <div className="flex h-full min-h-[420px] flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex w-full items-center justify-end gap-4 text-xs text-ink-400">
          {canWrite && (
            <button type="button" onClick={() => setShowHistory(true)} className="state-layer mr-auto rounded-full px-3 py-1 font-medium text-accent-400">
              {t('Log history')}
            </button>
          )}
          <span className="inline-flex items-center gap-1.5">
            <span className="relative flex h-2 w-2">
              {connected && (
                <span className="absolute inline-flex h-full w-full animate-ping-slow rounded-full bg-success-400" />
              )}
              <span className={`relative inline-flex h-2 w-2 rounded-full ${connected ? 'bg-success-400' : 'bg-red-400'}`} />
            </span>
            <span className={connected ? 'text-success-500' : 'text-red-400'}>{t(connected ? 'live' : 'reconnecting')}</span>
          </span>
          {stats.memoryMb !== null && <span>RAM {stats.memoryMb} MB</span>}
          {stats.cpuPercent !== null && <span>CPU {stats.cpuPercent}%</span>}
        </div>
      </div>

      {installProgress && (
        <Card className="p-3">
          <div className="mb-1 flex justify-between text-xs text-ink-400">
            <span className="inline-flex items-center gap-1.5">
              <Spinner className="h-3 w-3 text-accent-400" />
              {installProgress.message}
            </span>
            <span>{installProgress.pct}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-surface-700">
            <motion.div
              className="h-full bg-gradient-to-r from-accent-500 to-accent-400"
              animate={{ width: `${installProgress.pct}%` }}
              transition={{ type: 'spring', stiffness: 120, damping: 20 }}
            />
          </div>
        </Card>
      )}

      <Card className="ui-terminal min-h-0 flex-1 overflow-hidden !rounded-2xl !bg-surface-1000">
        <div
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
          }}
          className="console-view h-full overflow-y-auto px-4 py-3 text-[13px] leading-relaxed"
        >
          {lines.length === 0 ? (
            <p className="text-slate-500">{t('No console output yet.')}</p>
          ) : (
            // The newest 1,000 lines stay on screen (everything is in Log history).
            lines.slice(-1000).map((l) => (
              <div key={l.id} className={`console-line whitespace-pre-wrap break-all ${lineColor(l.stream, l.line)}`}>
                {l.line}
              </div>
            ))
          )}
        </div>
      </Card>

      <ConsoleHistory serverId={serverId} open={showHistory} onClose={() => setShowHistory(false)} canDelete={can('settings')} />

      {canWrite && (
        <form onSubmit={submitCommand} className="flex gap-2">
          <Input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t(isRunningLike ? 'Type a command…' : 'Server is not running')}
            disabled={!isRunningLike}
            className="console-view"
          />
          <Button type="submit" disabled={!isRunningLike || !command.trim()}>
            Send
          </Button>
        </form>
      )}
    </div>
  );
}
