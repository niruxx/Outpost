import { useCallback, useEffect, useMemo, useState } from 'react';
import { HostLayout } from '../components/HostLayout.js';
import { Badge, Button, Card, ErrorText, Field, Input, Modal, Notice, Select, Spinner } from '../components/ui.js';
import { Icon } from '../components/icons.js';
import { useToast } from '../components/Toast.js';
import { useConfirm } from '../components/ConfirmDialog.js';
import { api, ApiError } from '../api/client.js';
import { hostApi, useHostAdmin } from '../state/hostTarget.js';

type UnitType = 'service' | 'timer' | 'socket' | 'target' | 'path' | 'mount';
type UnitAction = 'start' | 'stop' | 'restart' | 'reload' | 'enable' | 'disable' | 'enable-now' | 'disable-now' | 'mask' | 'unmask' | 'reset-failed';

interface UnitSummary {
  unit: string;
  description: string;
  load: string;
  active: string;
  sub: string;
  fileState: string | null;
  preset: string | null;
  nextRun?: string | null;
  lastRun?: string | null;
  triggers?: string | null;
  managed?: boolean;
}

interface ServicesResponse {
  available: boolean;
  reason: string | null;
  type: UnitType;
  units: UnitSummary[];
  ownUnit: string | null;
}

interface TimerDefinition {
  name: string;
  description: string;
  command: string;
  user: string;
  workingDirectory: string;
  onCalendar: string;
  onBootSec: string;
  onUnitActiveSec: string;
  persistent: boolean;
  randomizedDelaySec: string;
}

interface UnitDetails {
  unit: string;
  properties: Record<string, string>;
  file: string | null;
  managedTimer: TimerDefinition | null;
  protectedReason: string | null;
  isOwnUnit: boolean;
}

interface JournalEntry {
  time: string;
  priority: number;
  identifier: string | null;
  message: string;
}

const TYPES: Array<{ id: UnitType; label: string }> = [
  { id: 'service', label: 'Services' },
  { id: 'timer', label: 'Timers' },
  { id: 'socket', label: 'Sockets' },
  { id: 'target', label: 'Targets' },
  { id: 'path', label: 'Paths' },
  { id: 'mount', label: 'Mounts' },
];

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'running', label: 'Active' },
  { id: 'failed', label: 'Failed' },
  { id: 'inactive', label: 'Inactive' },
  { id: 'enabled', label: 'Enabled' },
  { id: 'disabled', label: 'Disabled' },
] as const;

const ACTION_LABEL: Record<UnitAction, string> = {
  start: 'Start',
  stop: 'Stop',
  restart: 'Restart',
  reload: 'Reload',
  enable: 'Enable',
  disable: 'Disable',
  'enable-now': 'Enable & start',
  'disable-now': 'Disable & stop',
  mask: 'Mask',
  unmask: 'Unmask',
  'reset-failed': 'Clear failure',
};

const ACTION_DONE: Record<UnitAction, string> = {
  start: 'Started',
  stop: 'Stopped',
  restart: 'Restarted',
  reload: 'Reloaded',
  enable: 'Enabled',
  disable: 'Disabled',
  'enable-now': 'Enabled and started',
  'disable-now': 'Disabled and stopped',
  mask: 'Masked',
  unmask: 'Unmasked',
  'reset-failed': 'Cleared failure state of',
};

function activeTone(active: string): 'green' | 'red' | 'yellow' | 'neutral' {
  if (active === 'active') return 'green';
  if (active === 'failed') return 'red';
  if (active === 'activating' || active === 'deactivating' || active === 'reloading') return 'yellow';
  return 'neutral';
}

function fileTone(state: string | null): 'green' | 'red' | 'blue' | 'neutral' {
  if (state === 'enabled' || state === 'enabled-runtime') return 'green';
  if (state === 'masked' || state === 'masked-runtime') return 'red';
  if (state === 'static' || state === 'generated' || state === 'indirect' || state === 'alias') return 'blue';
  return 'neutral';
}

function when(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const diff = d.getTime() - Date.now();
  const abs = Math.abs(diff);
  const rel = abs < 60_000 ? 'seconds' : abs < 3_600_000 ? `${Math.round(abs / 60_000)} min` : abs < 86_400_000 ? `${Math.round(abs / 3_600_000)} h` : `${Math.round(abs / 86_400_000)} d`;
  return `${d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} (${diff >= 0 ? 'in ' : ''}${rel}${diff < 0 ? ' ago' : ''})`;
}

function bytes(v: string | undefined): string | null {
  const n = Number(v);
  if (!v || !Number.isFinite(n) || n <= 0 || n >= 2 ** 63) return null;
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  let x = n;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i++;
  }
  return `${x.toFixed(x < 10 && i ? 1 : 0)} ${units[i]}`;
}

function cpu(v: string | undefined): string | null {
  const n = Number(v);
  if (!v || !Number.isFinite(n) || n <= 0 || n >= 2 ** 63) return null;
  const s = n / 1e9;
  return s < 60 ? `${s.toFixed(1)} s` : s < 3600 ? `${(s / 60).toFixed(1)} min` : `${(s / 3600).toFixed(1)} h`;
}

const PRIORITY_TONE = ['text-red-400', 'text-red-400', 'text-red-400', 'text-red-400', 'text-yellow-400', 'text-sky-300', 'text-ink-200', 'text-ink-500'];

export function ServicesPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const adminMode = useHostAdmin().active;
  const [type, setType] = useState<UnitType>('service');
  const [data, setData] = useState<ServicesResponse | null>(null);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['id']>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<TimerDefinition | 'new' | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get<ServicesResponse>(hostApi(`/services?type=${type}`)));
      setLoadError('');
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load services');
    } finally {
      setLoading(false);
    }
  }, [type]);

  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  const units = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.units ?? []).filter((u) => {
      if (q && !u.unit.toLowerCase().includes(q) && !u.description.toLowerCase().includes(q)) return false;
      switch (filter) {
        case 'running':
          return u.active === 'active' || u.active === 'activating' || u.active === 'reloading';
        case 'failed':
          return u.active === 'failed';
        case 'inactive':
          return u.active === 'inactive';
        case 'enabled':
          return u.fileState === 'enabled' || u.fileState === 'enabled-runtime';
        case 'disabled':
          return u.fileState === 'disabled';
        default:
          return true;
      }
    });
  }, [data, query, filter]);

  const counts = useMemo(() => {
    const all = data?.units ?? [];
    return { active: all.filter((u) => u.active === 'active').length, failed: all.filter((u) => u.active === 'failed').length, total: all.length };
  }, [data]);

  /** Runs an action; when the server asks for confirmation (SSH, Outpost itself…) asks first. */
  const runAction = useCallback(
    async (unit: string, action: UnitAction): Promise<UnitDetails | null> => {
      const send = (force: boolean) => api.post<{ ok: boolean; deferred?: boolean; details?: UnitDetails }>(hostApi(`/services/units/${encodeURIComponent(unit)}/action`), { action, force });
      try {
        let res;
        try {
          res = await send(false);
        } catch (err) {
          if (!(err instanceof ApiError && err.status === 409)) throw err;
          const ok = await confirm({ title: `${ACTION_LABEL[action]} ${unit}?`, message: err.message, confirmLabel: `${ACTION_LABEL[action]} anyway`, tone: 'danger' });
          if (!ok) return null;
          res = await send(true);
        }
        toast.success(res.deferred ? `${ACTION_DONE[action]} ${unit} — reconnecting shortly` : `${ACTION_DONE[action]} ${unit}`);
        void load();
        return res.details ?? null;
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : `Couldn’t ${action} ${unit}`);
        return null;
      }
    },
    [confirm, load, toast]
  );

  return (
    <HostLayout
      action={
            <div className="flex flex-wrap gap-2">
              {type === 'timer' && data?.available && (
                <Button variant="primary" onClick={() => setEditing('new')} disabled={!adminMode} title={adminMode ? undefined : 'Turn on Admin Mode first'}>
                  <Icon name="plus" className="h-4 w-4" /> New timer
                </Button>
              )}
              <Button variant="ghost" onClick={() => void load()} disabled={loading}>
                <Icon name="refresh" className="h-4 w-4" /> Refresh
              </Button>
            </div>
      }
    >
      <div className="space-y-5">

        {!adminMode && data?.available && (
          <Notice tone="info">
            You can browse services and logs with limited access. To start, stop, enable or schedule anything, turn on <b>Admin Mode</b> with the lock button above.
          </Notice>
        )}

        <nav aria-label="Unit types" className="inline-flex max-w-full flex-wrap gap-1 rounded-full border border-surface-700 bg-surface-900 p-1">
          {TYPES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setType(t.id)}
              className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${type === t.id ? 'bg-secondary-container text-secondary-on-container' : 'text-ink-400 hover:bg-surface-800 hover:text-ink-100'}`}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {loadError ? (
          <Notice tone="error">{loadError}</Notice>
        ) : !data ? (
          <Spinner />
        ) : !data.available ? (
          <Notice tone="warning">{data.reason}</Notice>
        ) : (
          <Card className="p-5">
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <div className="relative min-w-[14rem] flex-1">
                <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-500" />
                <Input className="pl-9" placeholder={`Filter ${TYPES.find((t) => t.id === type)!.label.toLowerCase()}…`} value={query} onChange={(e) => setQuery(e.target.value)} />
              </div>
              <Select className="w-auto" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} aria-label="State">
                {FILTERS.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </Select>
              <div className="flex gap-2 text-xs">
                <Badge tone="green">{counts.active} active</Badge>
                {counts.failed > 0 && (
                  <button type="button" onClick={() => setFilter('failed')}>
                    <Badge tone="red">{counts.failed} failed</Badge>
                  </button>
                )}
                <Badge tone="neutral">{counts.total} total</Badge>
              </div>
            </div>

            {units.length === 0 ? (
              <p className="py-6 text-center text-sm text-ink-500">Nothing matches.</p>
            ) : (
              <div className="divide-y divide-surface-700 overflow-hidden rounded-2xl bg-surface-900">
                {units.map((u) => (
                  <button
                    key={u.unit}
                    type="button"
                    onClick={() => setSelected(u.unit)}
                    className="state-layer flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 truncate font-mono text-sm text-ink-100">
                        {u.unit}
                        {u.unit === data.ownUnit && <Badge tone="blue">Outpost</Badge>}
                        {u.managed && <Badge tone="blue">Outpost timer</Badge>}
                      </p>
                      <p className="truncate text-xs text-ink-400">{u.description || '—'}</p>
                      {type === 'timer' && (
                        <p className="mt-0.5 truncate text-xs text-ink-500">
                          Next: {when(u.nextRun)} · Last: {when(u.lastRun)}
                          {u.triggers ? ` · runs ${u.triggers}` : ''}
                        </p>
                      )}
                    </div>
                    {u.fileState && <Badge tone={fileTone(u.fileState)}>{u.fileState}</Badge>}
                    <Badge tone={activeTone(u.active)} pulse={u.active === 'activating'}>
                      {u.active === 'active' ? u.sub : u.active}
                    </Badge>
                  </button>
                ))}
              </div>
            )}
          </Card>
        )}
      </div>

      {selected && (
        <UnitModal
          unit={selected}
          adminMode={adminMode}
          onClose={() => setSelected(null)}
          runAction={runAction}
          onEditTimer={(def) => {
            setSelected(null);
            setEditing(def);
          }}
          onDeleted={() => {
            setSelected(null);
            void load();
          }}
        />
      )}
      {editing && (
        <TimerEditor
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(unit) => {
            setEditing(null);
            if (type !== 'timer') setType('timer');
            else void load();
            toast.success(`Saved ${unit}`);
          }}
        />
      )}
    </HostLayout>
  );
}

function UnitModal({
  unit,
  adminMode,
  onClose,
  runAction,
  onEditTimer,
  onDeleted,
}: {
  unit: string;
  adminMode: boolean;
  onClose: () => void;
  runAction: (unit: string, action: UnitAction) => Promise<UnitDetails | null>;
  onEditTimer: (def: TimerDefinition) => void;
  onDeleted: () => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [details, setDetails] = useState<UnitDetails | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'logs' | 'file' | 'deps'>('logs');
  const [busy, setBusy] = useState<UnitAction | 'delete' | null>(null);

  const load = useCallback(async () => {
    try {
      setDetails(await api.get<UnitDetails>(hostApi(`/services/units/${encodeURIComponent(unit)}`)));
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load the unit');
    }
  }, [unit]);

  useEffect(() => {
    void load();
  }, [load]);

  const p = details?.properties ?? {};
  const active = p.ActiveState ?? '';
  const fileState = p.UnitFileState ?? '';
  const isTimer = unit.endsWith('.timer');
  const masked = fileState.startsWith('masked') || p.LoadState === 'masked';
  const canEnable = !!fileState && !['static', 'generated', 'transient', 'indirect', 'alias', 'bad', ''].includes(fileState) && !masked;

  async function act(action: UnitAction) {
    setBusy(action);
    const next = await runAction(unit, action);
    if (next) setDetails(next);
    else await load();
    setBusy(null);
  }

  async function deleteTimer() {
    if (!details?.managedTimer) return;
    const ok = await confirm({ title: 'Delete timer', message: `Stop and delete ${details.managedTimer.name}.timer and its service? The command will no longer run.`, confirmLabel: 'Delete', tone: 'danger' });
    if (!ok) return;
    setBusy('delete');
    try {
      await api.delete(hostApi(`/services/timers/${encodeURIComponent(details.managedTimer.name)}`));
      toast.success(`Deleted ${details.managedTimer.name}`);
      onDeleted();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Couldn’t delete the timer');
    } finally {
      setBusy(null);
    }
  }

  const facts: Array<[string, string | null]> = [
    ['Status', active ? `${active} (${p.SubState})` : null],
    ['Since', p.StateChangeTimestamp ? when(p.StateChangeTimestamp) : null],
    ['Main PID', p.MainPID && p.MainPID !== '0' ? p.MainPID : null],
    ['Memory', bytes(p.MemoryCurrent)],
    ['CPU time', cpu(p.CPUUsageNSec)],
    ['Tasks', p.TasksCurrent && Number(p.TasksCurrent) < 2 ** 32 ? p.TasksCurrent : null],
    ['Runs as', p.User || null],
    ['Restart policy', p.Restart && p.Restart !== 'no' ? p.Restart : null],
    ['Result', p.Result && p.Result !== 'success' ? p.Result : null],
    ['Next run', isTimer ? when(p.NextElapseUSecRealtime) : null],
    ['Last run', isTimer ? when(p.LastTriggerUSec) : null],
    ['Starts', p.Triggers || null],
    ['Started by', p.TriggeredBy || null],
    ['Listens on', p.Listen || null],
    ['Unit file', p.FragmentPath || null],
    ['Drop-ins', p.DropInPaths || null],
  ];

  const action = (a: UnitAction, variant: 'default' | 'primary' | 'danger' | 'outlined' | 'ghost' = 'default') => (
    <Button key={a} variant={variant} disabled={!adminMode || !!busy} onClick={() => void act(a)} title={adminMode ? undefined : 'Turn on Admin Mode first'}>
      {busy === a ? <Spinner /> : null}
      {ACTION_LABEL[a]}
    </Button>
  );

  return (
    <Modal open onClose={onClose} title={unit} size="xl">
      {error ? (
        <Notice tone="error">{error}</Notice>
      ) : !details ? (
        <Spinner />
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={activeTone(active)}>{active}</Badge>
            {fileState && <Badge tone={fileTone(fileState)}>{fileState}</Badge>}
            {details.isOwnUnit && <Badge tone="blue">This is Outpost</Badge>}
            {details.managedTimer && <Badge tone="blue">Created in Outpost</Badge>}
            <span className="text-sm text-ink-400">{p.Description}</span>
          </div>

          {details.protectedReason && <Notice tone="warning">{details.protectedReason}</Notice>}

          <div className="flex flex-wrap gap-2">
            {masked ? (
              action('unmask', 'primary')
            ) : (
              <>
                {active === 'active' || active === 'reloading' || active === 'activating'
                  ? [action('restart'), p.CanReload === 'yes' ? action('reload') : null, p.CanStop !== 'no' ? action('stop', 'danger') : null]
                  : p.CanStart !== 'no' && action('start', 'primary')}
                {canEnable && (fileState.startsWith('enabled') ? action('disable', 'outlined') : action('enable-now', 'outlined'))}
                {canEnable && !fileState.startsWith('enabled') && action('enable', 'ghost')}
                {active === 'failed' && action('reset-failed', 'ghost')}
                {!details.managedTimer && action('mask', 'ghost')}
              </>
            )}
            {details.managedTimer && (
              <>
                <Button variant="outlined" disabled={!adminMode || !!busy} onClick={() => onEditTimer(details.managedTimer!)}>
                  <Icon name="edit" className="h-4 w-4" /> Edit timer
                </Button>
                <Button variant="danger" disabled={!adminMode || !!busy} onClick={() => void deleteTimer()}>
                  <Icon name="trash" className="h-4 w-4" /> Delete
                </Button>
              </>
            )}
          </div>

          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 rounded-2xl bg-surface-900 p-4 text-sm sm:grid-cols-2">
            {facts
              .filter(([, v]) => v)
              .map(([k, v]) => (
                <div key={k} className="min-w-0">
                  <dt className="text-xs text-ink-500">{k}</dt>
                  <dd className="break-all font-mono text-xs text-ink-200">{v}</dd>
                </div>
              ))}
          </dl>

          <div className="flex gap-1 border-b border-surface-700">
            {(
              [
                ['logs', 'Logs'],
                ['file', 'Unit file'],
                ['deps', 'Relationships'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === id ? 'border-accent-400 text-ink-100' : 'border-transparent text-ink-400 hover:text-ink-200'}`}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === 'logs' && <UnitLogs unit={unit} />}
          {tab === 'file' &&
            (details.file ? (
              <pre className="max-h-[50vh] overflow-auto rounded-2xl bg-surface-1000 p-4 font-mono text-xs leading-relaxed text-ink-200">{details.file}</pre>
            ) : (
              <p className="text-sm text-ink-500">No unit file could be read (it may be generated, or need Admin Mode to read).</p>
            ))}
          {tab === 'deps' && (
            <dl className="space-y-3 text-sm">
              {(['Requires', 'Wants', 'After', 'Before', 'WantedBy', 'RequiredBy'] as const).map((k) => (
                <div key={k}>
                  <dt className="text-xs text-ink-500">{k}</dt>
                  <dd className="break-words font-mono text-xs text-ink-200">{p[k] || '—'}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
    </Modal>
  );
}

function UnitLogs({ unit }: { unit: string }) {
  const [entries, setEntries] = useState<JournalEntry[] | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [priority, setPriority] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ entries: JournalEntry[]; hint: string | null }>(hostApi(`/services/units/${encodeURIComponent(unit)}/logs?lines=300&priority=${priority}`));
      setEntries(res.entries);
      setHint(res.hint);
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load logs');
    } finally {
      setLoading(false);
    }
  }, [unit, priority]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select className="w-auto" value={priority} onChange={(e) => setPriority(e.target.value)} aria-label="Priority">
          <option value="">All messages</option>
          <option value="3">Errors and worse</option>
          <option value="4">Warnings and worse</option>
          <option value="5">Notices and worse</option>
          <option value="6">Info and worse</option>
        </Select>
        <Button variant="ghost" onClick={() => void load()} disabled={loading}>
          <Icon name="refresh" className="h-4 w-4" /> Refresh
        </Button>
      </div>
      {hint && <Notice tone="info">{hint}</Notice>}
      <ErrorText>{error}</ErrorText>
      {!entries ? (
        <Spinner />
      ) : entries.length === 0 ? (
        <p className="text-sm text-ink-500">No log entries.</p>
      ) : (
        <div className="max-h-[45vh] overflow-auto rounded-2xl bg-surface-1000 p-3 font-mono text-xs leading-relaxed">
          {entries.map((e, i) => (
            <div key={i} className="flex gap-3">
              <span className="shrink-0 text-ink-500">{e.time ? new Date(e.time).toLocaleString([], { dateStyle: 'short', timeStyle: 'medium' }) : ''}</span>
              <span className={`whitespace-pre-wrap break-all ${PRIORITY_TONE[e.priority] ?? 'text-ink-200'}`}>{e.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const CALENDAR_PRESETS = [
  ['hourly', 'Every hour'],
  ['daily', 'Every day at midnight'],
  ['*-*-* 04:00:00', 'Every day at 04:00'],
  ['Mon..Fri 09:00', 'Weekdays at 09:00'],
  ['weekly', 'Every Monday at midnight'],
  ['monthly', 'First of every month'],
  ['*:0/15', 'Every 15 minutes'],
] as const;

const EMPTY_TIMER: TimerDefinition = {
  name: '',
  description: '',
  command: '',
  user: '',
  workingDirectory: '',
  onCalendar: 'daily',
  onBootSec: '',
  onUnitActiveSec: '',
  persistent: true,
  randomizedDelaySec: '',
};

function TimerEditor({ initial, onClose, onSaved }: { initial: TimerDefinition | null; onClose: () => void; onSaved: (unit: string) => void }) {
  const [def, setDef] = useState<TimerDefinition>(initial ?? EMPTY_TIMER);
  const [mode, setMode] = useState<'calendar' | 'interval'>(initial && !initial.onCalendar ? 'interval' : 'calendar');
  const [check, setCheck] = useState<{ valid: boolean; normalized: string | null; next: string[]; error: string | null } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof TimerDefinition>(k: K, v: TimerDefinition[K]) => setDef((d) => ({ ...d, [k]: v }));

  useEffect(() => {
    if (mode !== 'calendar' || !def.onCalendar.trim()) {
      setCheck(null);
      return;
    }
    const timer = window.setTimeout(() => {
      api
        .post<typeof check>(hostApi('/services/calendar'), { expression: def.onCalendar })
        .then(setCheck)
        .catch(() => setCheck(null));
    }, 350);
    return () => window.clearTimeout(timer);
  }, [def.onCalendar, mode]);

  async function save() {
    setBusy(true);
    setError('');
    const definition =
      mode === 'calendar' ? { ...def, onBootSec: '', onUnitActiveSec: '' } : { ...def, onCalendar: '', persistent: false };
    try {
      const res = await api.post<{ unit: string }>(hostApi('/services/timers'), { definition, replace: !!initial, enable: true });
      onSaved(res.unit);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save the timer');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={initial ? `Edit ${initial.name}.timer` : 'New timer'} size="lg">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p className="text-sm text-ink-400">
          Creates a <code>.service</code> that runs your command and a <code>.timer</code> that starts it on schedule, in <code>/etc/systemd/system</code>. Output goes to the
          unit’s log.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <Input value={def.name} onChange={(e) => set('name', e.target.value)} placeholder="nightly-backup" disabled={!!initial} required pattern="[A-Za-z0-9][A-Za-z0-9_.@\-]*" />
          </Field>
          <Field label="Description">
            <Input value={def.description} onChange={(e) => set('description', e.target.value)} placeholder="Back up /srv every night" />
          </Field>
        </div>
        <Field label="Command">
          <Input className="font-mono" value={def.command} onChange={(e) => set('command', e.target.value)} placeholder="/usr/bin/rsync -a /srv/ /mnt/backup/srv/" required />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Run as user (empty = root)">
            <Input value={def.user} onChange={(e) => set('user', e.target.value)} placeholder="root" />
          </Field>
          <Field label="Working directory (optional)">
            <Input value={def.workingDirectory} onChange={(e) => set('workingDirectory', e.target.value)} placeholder="/srv" />
          </Field>
        </div>

        <div className="space-y-3 rounded-2xl bg-surface-900 p-4">
          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="radio" checked={mode === 'calendar'} onChange={() => setMode('calendar')} /> On a calendar schedule
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" checked={mode === 'interval'} onChange={() => setMode('interval')} /> At an interval
            </label>
          </div>
          {mode === 'calendar' ? (
            <>
              <div className="flex flex-wrap gap-2">
                {CALENDAR_PRESETS.map(([expr, label]) => (
                  <button
                    key={expr}
                    type="button"
                    onClick={() => set('onCalendar', expr)}
                    className={`rounded-full px-3 py-1 text-xs ${def.onCalendar === expr ? 'bg-secondary-container text-secondary-on-container' : 'bg-surface-800 text-ink-300 hover:text-ink-100'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <Field label="Calendar expression (systemd OnCalendar)">
                <Input className="font-mono" value={def.onCalendar} onChange={(e) => set('onCalendar', e.target.value)} />
              </Field>
              {check && (
                <p className={`text-xs ${check.valid ? 'text-ink-400' : 'text-red-400'}`}>
                  {check.valid
                    ? [check.normalized && `= ${check.normalized}`, check.next.length ? `Next: ${check.next.join(' · ')}` : null].filter(Boolean).join('  ')
                    : check.error}
                </p>
              )}
              <label className="flex items-center gap-2 text-sm text-ink-300">
                <input type="checkbox" checked={def.persistent} onChange={(e) => set('persistent', e.target.checked)} /> Catch up on a run missed while the host was off
              </label>
            </>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Every">
                <Input value={def.onUnitActiveSec} onChange={(e) => set('onUnitActiveSec', e.target.value)} placeholder="30min" />
              </Field>
              <Field label="First run after boot">
                <Input value={def.onBootSec} onChange={(e) => set('onBootSec', e.target.value)} placeholder="5min" />
              </Field>
            </div>
          )}
          <Field label="Random delay (optional, spreads load)">
            <Input value={def.randomizedDelaySec} onChange={(e) => set('randomizedDelaySec', e.target.value)} placeholder="5min" />
          </Field>
        </div>

        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !def.name || !def.command || (mode === 'calendar' && check?.valid === false)}>
            {busy ? 'Saving…' : initial ? 'Save & restart timer' : 'Create & start timer'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
