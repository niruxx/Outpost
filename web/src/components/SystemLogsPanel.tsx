import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api/client.js';
import { Button, Card, Input, Notice, Select, Spinner } from './ui.js';
import { Icon } from './icons.js';

interface JournalEntry {
  time: string;
  unit: string | null;
  identifier: string | null;
  priority: number;
  pid: string | null;
  hostname: string | null;
  message: string;
}
interface LogFile {
  path: string;
  size: number;
  modifiedAt: string;
  readable: boolean;
  compressed: boolean;
}
interface Status {
  available: boolean;
  reason: string | null;
  journal: boolean;
  hint: string | null;
  units: { unit: string; active: string; sub: string; description: string }[];
}

const PRIORITIES = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];
const PRIORITY_TONE = (p: number) => (p <= 3 ? 'text-red-400' : p === 4 ? 'text-yellow-400' : p === 7 ? 'text-ink-500' : 'text-ink-200');

function size(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function Journal({ status }: { status: Status }) {
  const [unit, setUnit] = useState('outpost.service');
  const [priority, setPriority] = useState('');
  const [since, setSince] = useState('1h');
  const [grep, setGrep] = useState('');
  const [query, setQuery] = useState('');
  const [lines, setLines] = useState(300);
  const [follow, setFollow] = useState(false);
  const [entries, setEntries] = useState<JournalEntry[] | null>(null);
  const [hint, setHint] = useState<string | null>(status.hint);
  const [error, setError] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setQuery(grep.trim()), 400);
    return () => clearTimeout(t);
  }, [grep]);

  // The panel's own unit may be named differently (or not be a unit at all).
  useEffect(() => {
    if (status.units.length && !status.units.some((u) => u.unit === 'outpost.service')) setUnit('');
  }, [status.units]);

  const load = useCallback(
    async (refresh = false) => {
      const p = new URLSearchParams({ lines: String(lines) });
      if (unit) p.set('unit', unit);
      if (priority) p.set('priority', priority);
      if (since) p.set('since', since);
      if (query) p.set('grep', query);
      if (refresh) p.set('refresh', '1');
      try {
        const res = await api.get<{ entries: JournalEntry[]; hint: string | null }>(`/audit/system/journal?${p}`);
        setEntries(res.entries);
        setHint(res.hint);
        setError('');
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Failed to read the journal');
      }
    },
    [unit, priority, since, query, lines]
  );

  useEffect(() => {
    setEntries(null);
    load();
  }, [load]);
  useEffect(() => {
    if (!follow) return;
    const t = setInterval(() => load(true), 5000);
    return () => clearInterval(t);
  }, [follow, load]);

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <Select value={unit} onChange={(e) => setUnit(e.target.value)} aria-label="Service">
          <option value="">All services</option>
          {status.units.map((u) => (
            <option key={u.unit} value={u.unit}>
              {u.unit} {u.active !== 'active' ? `(${u.active})` : ''}
            </option>
          ))}
        </Select>
        <Select value={priority} onChange={(e) => setPriority(e.target.value)} aria-label="Priority">
          <option value="">Any priority</option>
          {PRIORITIES.slice(0, 7).map((p, i) => (
            <option key={p} value={i}>
              {p} and worse
            </option>
          ))}
        </Select>
        <Select value={since} onChange={(e) => setSince(e.target.value)} aria-label="Period">
          <option value="15m">Last 15 minutes</option>
          <option value="1h">Last hour</option>
          <option value="6h">Last 6 hours</option>
          <option value="24h">Last 24 hours</option>
          <option value="7d">Last 7 days</option>
          <option value="">Everything</option>
        </Select>
        <Select value={lines} onChange={(e) => setLines(Number(e.target.value))} aria-label="Lines">
          {[100, 300, 1000, 2000].map((n) => (
            <option key={n} value={n}>
              Newest {n}
            </option>
          ))}
        </Select>
        <Input value={grep} onChange={(e) => setGrep(e.target.value)} placeholder="Search messages…" aria-label="Search" />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" onClick={() => load()}>
          <Icon name="refresh" className="h-4 w-4" /> Refresh
        </Button>
        <label className="flex items-center gap-2 text-sm text-ink-300">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow (every 5s)
        </label>
      </div>
      {hint && <Notice tone="warning">{hint}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="ui-terminal max-h-[60vh] overflow-auto rounded-2xl bg-surface-1000 p-3 font-mono text-[12px] leading-5">
        {entries === null ? (
          <Spinner />
        ) : entries.length === 0 ? (
          <p className="text-slate-500">No entries.</p>
        ) : (
          entries.map((e, i) => (
            <div key={i} className="whitespace-pre-wrap break-words">
              <span className="text-slate-500">{new Date(e.time).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })} </span>
              <span className="text-sky-400">{e.identifier ?? e.unit ?? ''}{e.pid ? `[${e.pid}]` : ''}: </span>
              <span className={PRIORITY_TONE(e.priority)}>{e.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function Files() {
  const [files, setFiles] = useState<LogFile[] | null>(null);
  const [selected, setSelected] = useState('');
  const [filter, setFilter] = useState('');
  const [grep, setGrep] = useState('');
  const [query, setQuery] = useState('');
  const [lines, setLines] = useState<string[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState('');
  const viewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .get<{ files: LogFile[] }>('/audit/system/files')
      .then((r) => {
        setFiles(r.files);
        const first = r.files.find((f) => f.readable && /^(syslog|messages|auth\.log|secure|kern\.log)$/.test(f.path)) ?? r.files.find((f) => f.readable);
        if (first) setSelected(first.path);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to list /var/log'));
  }, []);
  useEffect(() => {
    const t = setTimeout(() => setQuery(grep.trim()), 400);
    return () => clearTimeout(t);
  }, [grep]);

  const load = useCallback(
    async (refresh = false) => {
      if (!selected) return;
      const p = new URLSearchParams({ path: selected, lines: '1000' });
      if (query) p.set('grep', query);
      if (refresh) p.set('refresh', '1');
      try {
        const res = await api.get<{ lines: string[]; truncated: boolean }>(`/audit/system/file?${p}`);
        setLines(res.lines);
        setTruncated(res.truncated);
        setError('');
        requestAnimationFrame(() => viewRef.current && (viewRef.current.scrollTop = viewRef.current.scrollHeight));
      } catch (err) {
        setLines(null);
        setError(err instanceof ApiError ? err.message : 'Failed to read the file');
      }
    },
    [selected, query]
  );
  useEffect(() => {
    setLines(null);
    load();
  }, [load]);

  const shown = (files ?? []).filter((f) => !filter || f.path.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="grid gap-3 lg:grid-cols-[260px_minmax(0,1fr)]">
      <div className="space-y-2">
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter files…" aria-label="Filter files" />
        {/* Phones: a dropdown; larger screens: the list. */}
        <Select value={selected} onChange={(e) => setSelected(e.target.value)} className="lg:hidden" aria-label="Log file">
          {shown.map((f) => (
            <option key={f.path} value={f.path} disabled={!f.readable}>
              {f.path} {f.readable ? '' : '(no permission)'}
            </option>
          ))}
        </Select>
        <div className="hidden max-h-[60vh] overflow-y-auto rounded-2xl bg-surface-900 p-1 lg:block">
          {files === null ? (
            <Spinner />
          ) : (
            shown.map((f) => (
              <button
                key={f.path}
                disabled={!f.readable}
                onClick={() => setSelected(f.path)}
                title={f.readable ? `${f.path} · ${size(f.size)}` : `${f.path} — no permission to read`}
                className={`state-layer flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-xs disabled:opacity-40 ${
                  selected === f.path ? 'bg-secondary-container text-secondary-on-container' : 'text-ink-200'
                }`}
              >
                <span className="min-w-0 truncate font-mono">{f.path}</span>
                <span className="shrink-0 text-ink-500">{f.readable ? size(f.size) : '🔒'}</span>
              </button>
            ))
          )}
        </div>
      </div>
      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-mono text-sm text-ink-200">/var/log/{selected}</span>
          <Input value={grep} onChange={(e) => setGrep(e.target.value)} placeholder="Search this file…" className="!w-auto min-w-[10rem] flex-1" aria-label="Search file" />
          <Button variant="ghost" onClick={() => load(true)}>
            <Icon name="refresh" className="h-4 w-4" /> Refresh
          </Button>
        </div>
        {error && <Notice tone="error">{error}</Notice>}
        <div ref={viewRef} className="ui-terminal max-h-[60vh] min-h-[12rem] overflow-auto rounded-2xl bg-surface-1000 p-3 font-mono text-[12px] leading-5 text-slate-300">
          {lines === null ? (
            !error && <Spinner />
          ) : lines.length === 0 ? (
            <p className="text-slate-500">{query ? 'No matching lines.' : 'The file is empty.'}</p>
          ) : (
            <>
              {truncated && <p className="mb-2 text-slate-500">… showing the newest {lines.length} lines</p>}
              {lines.map((l, i) => (
                <div key={i} className="whitespace-pre-wrap break-words">
                  {l}
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** The host's journal and /var/log, for admins (Linux only). */
export function SystemLogsPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [view, setView] = useState<'journal' | 'files'>('journal');
  const [error, setError] = useState('');
  useEffect(() => {
    api
      .get<Status>('/audit/system/status')
      .then((s) => {
        setStatus(s);
        if (!s.journal) setView('files');
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load'));
  }, []);

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!status) return <Spinner />;
  if (!status.available) return <Notice tone="info">{status.reason}</Notice>;
  return (
    <Card className="p-4 sm:p-5">
      <div className="mb-4 flex w-fit rounded-full border border-surface-500 p-0.5" role="tablist" aria-label="Log source">
        {(['journal', 'files'] as const).map((v) => (
          <button
            key={v}
            role="tab"
            aria-selected={view === v}
            onClick={() => setView(v)}
            disabled={v === 'journal' && !status.journal}
            className={`state-layer rounded-full px-3 py-1.5 text-xs font-medium disabled:opacity-40 ${view === v ? 'bg-secondary-container text-secondary-on-container' : 'text-ink-300'}`}
          >
            {v === 'journal' ? 'Journal (systemd)' : 'Files (/var/log)'}
          </button>
        ))}
      </div>
      {view === 'journal' ? <Journal status={status} /> : <Files />}
    </Card>
  );
}
