import { useCallback, useEffect, useState } from 'react';
import { setVisibleInterval } from '../lib/perf.js';
import { t } from '../i18n/index.js';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AnimatePresence, LayoutGroup, motion } from 'framer-motion';
import { Layout, PageHeader } from '../components/Layout.js';
import { StatusBadge, SuspendedBadge } from '../components/StatusBadge.js';
import { Button, Card, Input, Select, Notice, Skeleton, Spinner } from '../components/ui.js';
import { NewInstanceModal } from '../components/NewInstanceModal.js';
import { GameTile, gameKindOf, gameLabel, instanceCategory, type InstanceCategory } from '../components/GameArt.js';
import { HostOverview, formatBytes, formatDuration } from '../components/HostOverview.js';
import { CHART, MiniBar } from '../components/charts.js';
import { GameBanner } from '../components/GameBanner.js';
import { EMPHASIZED } from '../components/motion.js';
import { Icon, type IconName } from '../components/icons.js';
import { useToast } from '../components/Toast.js';
import { api, ApiError } from '../api/client.js';
import type { InstanceListMetrics, ServerRecord } from '../api/types.js';
import { useAuth } from '../state/AuthContext.js';
import { useConfirm } from '../components/ConfirmDialog.js';
import { usePinnedInstances } from '../lib/pins.js';
import { MoreButton, useContextMenu, type MenuItems } from '../components/ContextMenu.js';
import { instanceMenu } from '../components/instanceMenu.js';

type ViewMode = 'list' | 'grid' | 'box';
const VIEW_KEY = 'outpost_instances_view';
const VIEWS: { mode: ViewMode; icon: IconName; label: string }[] = [
  { mode: 'list', icon: 'list', label: 'List' },
  { mode: 'grid', icon: 'grid', label: 'Grid' },
  { mode: 'box', icon: 'box', label: 'Box' },
];

const FILTERS: { id: 'all' | InstanceCategory; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'game', label: '🎮 Games' },
  { id: 'app', label: '📦 Apps' },
  { id: 'container', label: '🐳 Containers' },
  { id: 'custom', label: '⌨️ Custom' },
];
const FILTER_KEY = 'outpost_instances_filter';

function readFilter(): 'all' | InstanceCategory {
  try {
    const v = localStorage.getItem(FILTER_KEY);
    return FILTERS.some((f) => f.id === v) ? (v as 'all' | InstanceCategory) : 'all';
  } catch {
    return 'all';
  }
}

function readView(): ViewMode {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === 'list' || v === 'grid' || v === 'box' ? v : 'grid';
  } catch {
    return 'grid';
  }
}

/** MD3 segmented button for the view mode. */
function ViewSwitcher({ mode, onChange }: { mode: ViewMode; onChange: (m: ViewMode) => void }) {
  return (
    <div className="flex rounded-full border border-surface-500 p-0.5" role="radiogroup" aria-label="View mode">
      {VIEWS.map((v) => (
        <button
          key={v.mode}
          role="radio"
          aria-checked={mode === v.mode}
          onClick={() => onChange(v.mode)}
          className={`state-layer relative flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium ${
            mode === v.mode ? 'text-secondary-on-container' : 'text-ink-300'
          }`}
        >
          {mode === v.mode && (
            <motion.span
              layoutId="view-switch-pill"
              className="absolute inset-0 rounded-full bg-secondary-container"
              transition={{ type: 'spring', stiffness: 500, damping: 38 }}
            />
          )}
          <span className="relative z-10 flex items-center gap-1.5">
            <Icon name={v.icon} className="h-4 w-4" />
            <span className="hidden sm:inline">{t(v.label)}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

/** MD3 filled-tonal icon button. */
export function IconAction({
  icon,
  label,
  onClick,
  disabled,
  danger = false,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <motion.button
      whileTap={{ scale: 0.9 }}
      onClick={onClick}
      disabled={disabled}
      title={t(label)}
      aria-label={t(label)}
      className={`state-layer flex h-9 w-9 items-center justify-center rounded-full disabled:opacity-[0.38] ${
        danger ? 'bg-error-container text-error-on-container' : 'bg-secondary-container text-secondary-on-container'
      }`}
    >
      <Icon name={icon} className="h-4 w-4" />
    </motion.button>
  );
}

interface RowProps {
  server: ServerRecord;
  metrics: InstanceListMetrics | undefined;
  hostMemMb: number | null;
  canAct: boolean;
  busy: boolean;
  act: (id: string, action: 'start' | 'stop' | 'restart' | 'retry-install') => void;
  pinned: boolean;
  togglePin: (id: string) => void;
  /** Selection mode: the card toggles selection instead of opening the instance. */
  selecting: boolean;
  selected: boolean;
  toggleSelect: (id: string) => void;
  /** Builds this instance's right-click / "⋯" menu. */
  menu: () => MenuItems;
}

function PinButton({ server, pinned, togglePin, className = '' }: Pick<RowProps, 'server' | 'pinned' | 'togglePin'> & { className?: string }) {
  const label = pinned ? 'Unpin' : 'Pin to top';
  return (
    <button
      type="button"
      onClick={() => togglePin(server.id)}
      title={t(label)}
      aria-label={`${t(label)}: ${server.name}`}
      aria-pressed={pinned}
      className={`ui-pin state-layer relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-opacity ${
        pinned ? 'text-accent-400' : 'text-ink-500 opacity-0 focus-visible:opacity-100 group-hover/card:opacity-100 [@media(hover:none)]:opacity-100'
      } ${className}`}
    >
      <Icon name="pin" className={`h-4 w-4 ${pinned ? 'fill-current' : ''}`} />
    </button>
  );
}

/** Hidden until the card is hovered/focused; always shown on touch screens. */
const HOVER_REVEAL = 'opacity-0 transition-opacity focus-visible:opacity-100 group-hover/card:opacity-100 [@media(hover:none)]:opacity-100';

/** Round check indicator shown on every card while selecting. */
function SelectMark({ selected }: { selected: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`pointer-events-none relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
        selected ? 'border-accent-400 bg-accent-400 text-accent-on' : 'border-surface-500 bg-surface-900'
      }`}
    >
      {selected && <Icon name="check" className="h-3.5 w-3.5" />}
    </span>
  );
}

/** CPU / RAM / players / uptime for one instance, computed once for every view. */
function useInstanceFigures({ server, metrics, hostMemMb }: Pick<RowProps, 'server' | 'metrics' | 'hostMemMb'>) {
  const stats = metrics?.runtime?.stats;
  const memLimit = server.platform === 'java' ? server.max_memory_mb : hostMemMb;
  return {
    live: !!metrics?.runtime,
    cpu: stats?.cpuPercent ?? null,
    memMb: stats?.memoryMb ?? null,
    memPct: stats?.memoryMb != null && memLimit ? (stats.memoryMb / memLimit) * 100 : null,
    memLimit,
    players: metrics?.playersOnline ?? null,
    uptime: metrics?.runtime ? formatDuration(metrics.runtime.uptimeMs / 1000) : null,
  };
}

function Actions({ server, canAct, busy, act, selecting }: Pick<RowProps, 'server' | 'canAct' | 'busy' | 'act' | 'selecting'>) {
  if (!canAct || server.suspended || selecting) return null;
  if (server.status === 'install_failed')
    return <IconAction icon="restart" label="Retry install" disabled={busy} onClick={() => act(server.id, 'retry-install')} />;
  if (server.status === 'stopped' || server.status === 'crashed')
    return <IconAction icon="play" label="Start" disabled={busy} onClick={() => act(server.id, 'start')} />;
  if (server.status === 'running')
    return (
      <>
        <IconAction icon="restart" label="Restart" disabled={busy} onClick={() => act(server.id, 'restart')} />
        <IconAction icon="stop" label="Stop" danger disabled={busy} onClick={() => act(server.id, 'stop')} />
      </>
    );
  return null;
}

/** Whole-card link without nesting buttons in an anchor: the link covers the card, actions sit above it.
 *  While selecting, it becomes a checkbox-like toggle instead. */
function StretchedLink({ server, selecting, selected, toggleSelect }: Pick<RowProps, 'server' | 'selecting' | 'selected' | 'toggleSelect'>) {
  if (selecting) {
    return (
      <button
        type="button"
        role="checkbox"
        aria-checked={selected}
        aria-label={`${t('Select')} ${server.name}`}
        onClick={() => toggleSelect(server.id)}
        className="absolute inset-0 z-0 rounded-[inherit]"
      />
    );
  }
  return <Link to={`/instances/${server.id}`} aria-label={`Open ${server.name}`} className="absolute inset-0 z-0 rounded-[inherit]" />;
}

/** Selected cards get an accent ring. */
const selectedRing = (props: RowProps) => (props.selecting && props.selected ? 'ring-2 ring-accent-400' : '');

function Badge({ server }: { server: ServerRecord }) {
  return server.suspended ? <SuspendedBadge /> : <StatusBadge status={server.status} />;
}

function subtitle(server: ServerRecord) {
  const kind = gameKindOf(server);
  if (server.platform === 'docker') return `${gameLabel(kind)} · ${server.version.replace(/^docker\.io\/(library\/)?/, '')} · port ${server.server_port}`;
  const version = server.platform === 'java' || server.platform === 'bedrock' ? ` · ${server.loader} ${server.version}` : '';
  return `${gameLabel(kind)}${version} · port ${server.server_port}`;
}

function Metric({ icon, value, title }: { icon: IconName; value: string; title: string }) {
  return (
    <span className="inline-flex items-center gap-1 tabular-nums" title={t(title)}>
      <Icon name={icon} className="h-3.5 w-3.5 text-ink-500" />
      {value}
    </span>
  );
}

function ListRow(props: RowProps) {
  const { server } = props;
  const f = useInstanceFigures(props);
  const contextMenu = useContextMenu(props.menu);
  return (
    <div {...contextMenu} className={`group/card state-layer relative grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-2xl px-3 py-2.5 md:grid-cols-[auto_minmax(0,2fr)_110px_90px_90px_70px_80px_auto] ${selectedRing(props)}`}>
      <StretchedLink {...props} />
      {props.selecting ? <span className="flex h-9 w-9 items-center justify-center"><SelectMark selected={props.selected} /></span> : <GameTile kind={gameKindOf(server)} className="h-9 w-9 !rounded-xl" running={server.status === 'running'} />}
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-ink-50">{server.name}</p>
        <p className="truncate text-xs text-ink-400">{subtitle(server)}</p>
      </div>
      <div className="hidden md:block">
        <Badge server={server} />
      </div>
      <span className="hidden text-xs text-ink-300 md:block">{f.cpu !== null ? `${f.cpu}% CPU` : '—'}</span>
      <span className="hidden text-xs text-ink-300 md:block">{f.memMb !== null ? formatBytes(f.memMb * 1048576) : '—'}</span>
      <span className="hidden text-xs text-ink-300 md:block">{f.players !== null && f.live ? `${f.players} online` : '—'}</span>
      <span className="hidden text-xs text-ink-300 md:block">{f.uptime ?? '—'}</span>
      <div className="relative z-10 flex gap-1">
        <span className="md:hidden">
          <Badge server={server} />
        </span>
        {!props.selecting && <PinButton {...props} />}
        <Actions {...props} />
        {!props.selecting && <MoreButton items={props.menu} className={HOVER_REVEAL} />}
      </div>
    </div>
  );
}

function GridCard(props: RowProps) {
  const { server } = props;
  const f = useInstanceFigures(props);
  const contextMenu = useContextMenu(props.menu);
  return (
    <Card {...contextMenu} hover className={`ui-instance-card group/card relative flex h-full flex-col gap-5 p-5 ${selectedRing(props)}`}>
      <StretchedLink {...props} />
        <div className="flex items-center gap-3">
          {props.selecting && <SelectMark selected={props.selected} />}
          <GameTile kind={gameKindOf(server)} className="h-12 w-12" running={server.status === 'running'} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-base font-medium text-ink-50">{server.name}</h2>
              <Badge server={server} />
            </div>
            <p className="mt-0.5 truncate text-xs text-ink-400">{subtitle(server)}</p>
          </div>
          <div className="relative z-10 flex shrink-0 items-center gap-1">
            {!props.selecting && <PinButton {...props} />}
            <Actions {...props} />
            {!props.selecting && <MoreButton items={props.menu} className={HOVER_REVEAL} />}
          </div>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-surface-700 pt-3 text-xs text-ink-300">
          {f.live ? (
            <>
              <Metric icon="cpu" title="CPU" value={f.cpu !== null ? `${f.cpu}%` : '…'} />
              <Metric icon="memory" title="Memory" value={f.memMb !== null ? formatBytes(f.memMb * 1048576) : '…'} />
              {f.players !== null && <Metric icon="player" title="Players online" value={`${f.players} online`} />}
              <Metric icon="clock" title="Uptime" value={f.uptime ?? '…'} />
            </>
          ) : (
            <span className="text-ink-500">{t('Not running')}</span>
          )}
        </div>
    </Card>
  );
}

function BoxCard(props: RowProps) {
  const { server } = props;
  const f = useInstanceFigures(props);
  const kind = gameKindOf(server);
  const contextMenu = useContextMenu(props.menu);
  return (
    <Card {...contextMenu} hover className={`group/card relative flex h-full flex-col overflow-hidden ${selectedRing(props)}`}>
      <StretchedLink {...props} />
        <div className="relative flex h-28 items-center justify-center bg-surface-900">
          <GameBanner kind={kind} seed={server.id} serverId={server.id} artwork={server.banner} fade={false} />
          <div className="absolute left-2 top-2">
            {props.selecting ? <span className="m-1 block"><SelectMark selected={props.selected} /></span> : <PinButton {...props} />}
          </div>
          <GameTile kind={kind} className="h-16 w-16 !rounded-3xl shadow-card ring-4 ring-black/10" running={server.status === 'running'} />
          <div className="absolute right-3 top-3">
            <Badge server={server} />
          </div>
        </div>
        <div className="flex flex-1 flex-col gap-3 p-4">
          <div className="min-w-0">
            <h2 className="truncate text-base font-medium text-ink-50">{server.name}</h2>
            <p className="truncate text-xs text-ink-400">{subtitle(server)}</p>
          </div>
          <div className="space-y-2 text-xs text-ink-300">
            <div>
              <div className="mb-1 flex justify-between">
                <span>CPU</span>
                <span className="tabular-nums">{f.cpu !== null ? `${f.cpu}%` : '—'}</span>
              </div>
              <MiniBar percent={f.cpu} color={CHART.cpu} />
            </div>
            <div>
              <div className="mb-1 flex justify-between">
                <span>Memory</span>
                <span className="tabular-nums">
                  {f.memMb !== null ? formatBytes(f.memMb * 1048576) : '—'}
                  {f.memLimit ? ` / ${formatBytes(f.memLimit * 1048576)}` : ''}
                </span>
              </div>
              <MiniBar percent={f.memPct} color={CHART.memory} />
            </div>
            <div className="flex justify-between pt-1 text-ink-400">
              <span>{f.players !== null && f.live ? `${f.players} players online` : f.live ? 'Running' : 'Offline'}</span>
              <span className="tabular-nums">{f.uptime ?? ''}</span>
            </div>
          </div>
          <div className="relative z-10 mt-auto flex items-center justify-end gap-1">
            <Actions {...props} />
            {!props.selecting && <MoreButton items={props.menu} className={HOVER_REVEAL} />}
          </div>
        </div>
    </Card>
  );
}

const CONTAINER: Record<ViewMode, string> = {
  list: 'flex flex-col gap-1 rounded-3xl bg-surface-850 p-2',
  grid: 'grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3',
  box: 'grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4',
};

type BulkAction = 'start' | 'restart' | 'stop' | 'backup';

const BULK: Record<BulkAction, { label: string; icon: IconName; doing: string; done: string; eligible: (s: ServerRecord) => boolean; skipReason: string }> = {
  start: { label: 'Start', icon: 'play', doing: 'Starting', done: 'Started', eligible: (s) => s.status === 'stopped' || s.status === 'crashed', skipReason: 'already running or busy' },
  restart: { label: 'Restart', icon: 'restart', doing: 'Restarting', done: 'Restarted', eligible: (s) => s.status === 'running' || s.status === 'starting', skipReason: 'not running' },
  stop: { label: 'Stop', icon: 'stop', doing: 'Stopping', done: 'Stopped', eligible: (s) => s.status === 'running' || s.status === 'starting', skipReason: 'not running' },
  backup: { label: 'Back up', icon: 'backup', doing: 'Backing up', done: 'Backed up', eligible: (s) => !['installing', 'updating', 'install_failed'].includes(s.status), skipReason: 'installing or updating' },
};

/** Runs `task` over `items`, at most `limit` at a time; never rejects. */
async function runLimited<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await task(item);
  }));
}

/** Sticky bar shown while selecting instances. */
function BulkBar({
  count, visibleCount, busy, progress, onSelectAll, onClear, onRun, onDone,
}: {
  count: number; visibleCount: number; busy: BulkAction | null; progress: { done: number; total: number } | null;
  onSelectAll: () => void; onClear: () => void; onRun: (a: BulkAction) => void; onDone: () => void;
}) {
  const allSelected = visibleCount > 0 && count >= visibleCount;
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 16 }}
      transition={{ duration: 0.25, ease: EMPHASIZED }}
      className="ui-bulk-bar sticky bottom-4 z-20 mx-auto mt-6 flex w-fit max-w-full flex-wrap items-center gap-2 rounded-[1.75rem] bg-surface-800 py-2 pl-5 pr-2 shadow-card ring-1 ring-surface-600"
      role="toolbar"
      aria-label={t('Bulk actions')}
    >
      <span className="text-sm font-medium tabular-nums text-ink-100" aria-live="polite">
        {busy && progress ? `${t(BULK[busy].doing)} ${progress.done}/${progress.total}…` : `${count} ${t('selected')}`}
      </span>
      <button type="button" onClick={allSelected ? onClear : onSelectAll} disabled={!!busy || !visibleCount} className="state-layer rounded-full px-3 py-1.5 text-xs font-medium text-accent-400 disabled:opacity-40">
        {allSelected ? t('Clear') : `${t('Select all')} (${visibleCount})`}
      </button>
      <span className="mx-1 hidden h-6 w-px bg-surface-600 sm:block" />
      {(Object.keys(BULK) as BulkAction[]).map((a) => (
        <Button key={a} variant={a === 'stop' ? 'danger' : 'default'} disabled={!count || !!busy} onClick={() => onRun(a)} className="!px-3 !py-1.5" title={t(BULK[a].label)}>
          {busy === a ? <Spinner className="h-4 w-4" /> : <Icon name={BULK[a].icon} className="h-4 w-4" />}
          <span className="hidden sm:inline">{t(BULK[a].label)}</span>
        </Button>
      ))}
      <button type="button" onClick={onDone} disabled={!!busy} aria-label={t('Done selecting')} title={t('Done selecting')} className="state-layer ml-1 rounded-full p-2 text-ink-300 disabled:opacity-40">
        <Icon name="close" className="h-4 w-4" />
      </button>
    </motion.div>
  );
}

export function InstancesPage() {
  const { user, creation, refreshCreation } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [servers, setServers] = useState<ServerRecord[] | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [metrics, setMetrics] = useState<Record<string, InstanceListMetrics>>({});
  const [hostMemMb, setHostMemMb] = useState<number | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>(readView);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [filter, setFilter] = useState<'all' | InstanceCategory>(readFilter);
  const [params, setParams] = useSearchParams();
  const confirm = useConfirm();
  const { isPinned, toggle: togglePin } = usePinnedInstances();
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState<BulkAction | null>(null);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function stopSelecting() {
    setSelecting(false);
    setSelected(new Set());
  }

  // Esc leaves selection mode (unless a bulk action is still running).
  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !bulkBusy) stopSelecting();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selecting, bulkBusy]);

  // `/?new=1` (the command palette's "New instance") opens the create dialog once.
  useEffect(() => {
    if (params.get('new') !== '1' || !creation) return;
    if (creation.canCreate && !(creation.maxInstances && creation.owned >= creation.maxInstances)) setCreateOpen(true);
    else toast.error(creation.canCreate ? 'You’ve reached your instance limit' : 'Your account can’t create instances');
    setParams((prev) => { const next = new URLSearchParams(prev); next.delete('new'); return next; }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, creation]);

  function changeFilter(next: 'all' | InstanceCategory) {
    setFilter(next);
    try {
      localStorage.setItem(FILTER_KEY, next);
    } catch {
      // per-viewer preference only
    }
  }

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ servers: ServerRecord[]; metrics: Record<string, InstanceListMetrics> }>('/servers');
      setServers(res.servers);
      setUnreachable(false);
      setMetrics(res.metrics ?? {});
    } catch (err) {
      // A network failure (no HTTP response) means the panel server itself isn't reachable.
      if (err instanceof ApiError) toast.error(err.message);
      else setUnreachable(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
    api.get<{ totalMemMb: number }>('/system').then((s) => setHostMemMb(s.totalMemMb)).catch(() => {});
    const interval = setVisibleInterval(load, 4000);
    return () => interval();
  }, [load]);

  function changeView(next: ViewMode) {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // per-viewer preference only
    }
  }

  const canAct = user?.role === 'admin' || user?.role === 'moderator';
  const canCreate = !!creation?.canCreate;
  const atQuota = !!creation?.maxInstances && creation.owned >= creation.maxInstances;

  async function act(id: string, action: 'start' | 'stop' | 'restart' | 'retry-install') {
    setBusyId(id);
    try {
      await api.post(`/servers/${id}/${action}`);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : `Failed to ${action.replace('-', ' ')} instance`);
    } finally {
      setBusyId(null);
    }
  }

  async function runBulk(action: BulkAction) {
    const chosen = (servers ?? []).filter((s) => selected.has(s.id));
    const eligible = chosen.filter((s) => !s.suspended && BULK[action].eligible(s));
    const skipped = chosen.length - eligible.length;
    if (!eligible.length) {
      toast.error(`${t('Nothing to do')} — ${chosen.length === 1 ? chosen[0].name : `${chosen.length} ${t('instances')}`}: ${t(BULK[action].skipReason)}`);
      return;
    }
    if (action === 'stop' || action === 'restart') {
      const ok = await confirm({
        title: `${t(BULK[action].label)} ${eligible.length} ${eligible.length === 1 ? t('instance') : t('instances')}?`,
        message: `${eligible.map((s) => s.name).join(', ')}. ${t('Anyone connected will be disconnected.')}`,
        confirmLabel: t(BULK[action].label),
        tone: action === 'stop' ? 'danger' : undefined,
      });
      if (!ok) return;
    }
    setBulkBusy(action);
    setBulkProgress({ done: 0, total: eligible.length });
    const failures: string[] = [];
    // Backups are disk-heavy, so fewer at once.
    await runLimited(eligible, action === 'backup' ? 2 : 4, async (s) => {
      try {
        if (action === 'backup') await api.post(`/servers/${s.id}/backups`, { label: 'Bulk backup' });
        else await api.post(`/servers/${s.id}/${action}`);
      } catch (err) {
        failures.push(`${s.name}: ${err instanceof ApiError ? err.message : t('failed')}`);
      }
      setBulkProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
    });
    setBulkBusy(null);
    setBulkProgress(null);
    const succeeded = eligible.length - failures.length;
    const summary = [
      succeeded ? `${t(BULK[action].done)} ${succeeded}` : '',
      skipped ? `${t('skipped')} ${skipped} (${t(BULK[action].skipReason)})` : '',
    ].filter(Boolean).join(' · ');
    if (failures.length) toast.error(`${summary ? `${summary} · ` : ''}${failures.length} ${t('failed')} — ${failures.join('; ')}`);
    else toast.success(summary);
    await load();
  }

  const Row = view === 'list' ? ListRow : view === 'grid' ? GridCard : BoxCard;
  const counts = (servers ?? []).reduce<Partial<Record<InstanceCategory, number>>>((acc, s) => {
    const c = instanceCategory(s);
    acc[c] = (acc[c] ?? 0) + 1;
    return acc;
  }, {});
  // If the remembered filter no longer matches anything, fall back to everything.
  const activeFilter = filter !== 'all' && !counts[filter] ? 'all' : filter;
  const visible = (servers ?? []).filter((s) =>
    (activeFilter === 'all' || instanceCategory(s) === activeFilter) &&
    (statusFilter === 'all' || (statusFilter === 'running' ? s.status === 'running' : s.status !== 'running')) &&
    `${s.name} ${subtitle(s)}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  // Pinned instances first; otherwise keep the server's order (Array.sort is stable).
  ).sort((a, b) => Number(isPinned(b.id)) - Number(isPinned(a.id)));
  const canActOn = (s: ServerRecord) => canAct || s.created_by === user?.id;
  const selectableVisible = visible.filter((s) => canActOn(s) && !s.suspended);
  const selectedCount = (servers ?? []).filter((s) => selected.has(s.id)).length;

  const menuFor = (server: ServerRecord) => () =>
    instanceMenu({
      server,
      navigate,
      notify: toast,
      pinned: isPinned(server.id),
      togglePin,
      power: canActOn(server) ? { busy: busyId === server.id || !!bulkBusy, act } : undefined,
      extra: [
        canActOn(server) && !server.suspended && {
          label: selecting && selected.has(server.id) ? 'Deselect' : 'Select',
          icon: 'checklist',
          onSelect: () => {
            if (selecting) toggleSelect(server.id);
            else {
              setSelecting(true);
              setSelected(new Set([server.id]));
            }
          },
        },
      ],
    });

  return (
    <Layout>
      <div className="ui-dashboard mx-auto max-w-7xl px-4 py-6 sm:px-8 sm:py-8">
        <PageHeader
          title="Instances"
          subtitle="Games, apps, containers and services on this host — at a glance."
          action={
            canCreate && (
              <div className="flex items-center gap-3">
                {creation?.maxInstances ? (
                  <span className={`text-xs ${atQuota ? 'text-yellow-400' : 'text-ink-400'}`}>
                    {creation.owned} of {creation.maxInstances} instances used
                  </span>
                ) : null}
                <Button variant="primary" onClick={() => setCreateOpen(true)} disabled={atQuota} title={atQuota ? 'You’ve reached your instance limit' : undefined}>
                  <Icon name="plus" className="h-4 w-4" />
                  New instance
                </Button>
              </div>
            )
          }
        />

        {unreachable && (
          <div className="mb-5">
            <Notice tone="error">
              Can't reach the Outpost server — it may have stopped or be restarting. Start it with <span className="font-mono">npm start</span> (or{' '}
              <span className="font-mono">sudo systemctl start outpost</span>), then this page reconnects by itself.
            </Notice>
          </div>
        )}

        <section aria-label={t('Host overview')} className="mb-8">
          <div className="mb-3 flex items-center gap-2 text-sm font-medium text-ink-300">
            <Icon name="cpu" className="h-4 w-4" />{t('Host overview')}
          </div>
          <HostOverview />
        </section>

        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-normal text-ink-50">{t('Your instances')}</h2>
          <span className="text-xs text-ink-400" aria-live="polite">{visible.length} / {servers?.length ?? 0} {t('instances')}</span>
        </div>
        <div className="ui-instance-tools mb-4 flex flex-col gap-3 rounded-3xl bg-surface-850 p-3 sm:flex-row">
          <div className="relative min-w-0 flex-1">
            <Icon name="search" className="pointer-events-none absolute left-4 top-3.5 h-4 w-4 text-ink-400" />
            <Input type="search" aria-label={t('Search instances')} placeholder={t('Search by name, game or port…')} value={query} onChange={(e) => setQuery(e.target.value)} className="!rounded-full !border-transparent !bg-surface-900 !py-3 !pl-11" />
          </div>
          <Select aria-label={t('Filter by status')} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="!w-auto !rounded-full !border-transparent !px-4 !py-3">
            <option value="all">{t('All statuses')}</option>
            <option value="running">{t('Running')}</option>
            <option value="offline">{t('Not running')}</option>
          </Select>
        </div>

        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Filter instances">
            {FILTERS.filter((f) => f.id === 'all' || counts[f.id]).map((f) => (
              <button
                key={f.id}
                role="tab"
                aria-selected={activeFilter === f.id}
                onClick={() => changeFilter(f.id)}
                className={`state-layer relative rounded-lg border px-3 py-1.5 text-xs font-medium ${
                  activeFilter === f.id ? 'border-transparent text-secondary-on-container' : 'border-surface-500 text-ink-300'
                }`}
              >
                {activeFilter === f.id && (
                  <motion.span layoutId="instance-filter" className="absolute inset-0 rounded-lg bg-secondary-container" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />
                )}
                <span className="relative z-10">
                  {t(f.label)} <span className="opacity-70">{f.id === 'all' ? servers?.length ?? 0 : counts[f.id]}</span>
                </span>
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            {(servers ?? []).some((s) => canActOn(s) && !s.suspended) && (
              <button
                type="button"
                onClick={() => (selecting ? stopSelecting() : setSelecting(true))}
                aria-pressed={selecting}
                className={`state-layer flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium ${
                  selecting ? 'border-transparent bg-secondary-container text-secondary-on-container' : 'border-surface-500 text-ink-300'
                }`}
              >
                <Icon name="checklist" className="h-4 w-4" />
                {t(selecting ? 'Done' : 'Select')}
              </button>
            )}
            <ViewSwitcher mode={view} onChange={changeView} />
          </div>
        </div>

        {servers === null ? (
          <div className={CONTAINER.grid}>
            {[0, 1, 2, 3].map((i) => (
              <Card key={i} className="flex items-center gap-4 p-4">
                <Skeleton className="h-12 w-12 shrink-0 rounded-2xl" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-1/3" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </Card>
            ))}
          </div>
        ) : servers.length === 0 ? (
          <Card className="p-12 text-center">
            <div className="mx-auto mb-4 flex w-fit gap-2">
              {(['app:web', 'app:database', 'minecraft-java', 'app:manager', 'custom'] as const).map((k, i) => (
                <motion.div key={k} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.08, ease: EMPHASIZED }}>
                  <GameTile kind={k} className="h-12 w-12" />
                </motion.div>
              ))}
            </div>
            <p className="mb-1 text-base font-medium text-ink-100">{t('No instances yet')}</p>
            <p className="mb-5 text-sm text-ink-400">{t('Run a game server, a web app, a database, Portainer or any container — in a couple of clicks.')}</p>
            {canCreate && !atQuota && (
              <Button variant="primary" onClick={() => setCreateOpen(true)}>
                Create your first instance
              </Button>
            )}
          </Card>
        ) : visible.length === 0 ? (
          <Card className="p-10 text-center">
            <Icon name="search" className="mx-auto mb-3 h-8 w-8 text-ink-400" />
            <h3 className="mb-2 text-lg font-medium text-ink-100">{t('No matching instances')}</h3>
            <p className="mb-5 text-sm text-ink-400">{t('Try another search or clear your filters.')}</p>
            <Button onClick={() => { setQuery(''); setStatusFilter('all'); changeFilter('all'); }}>{t('Clear filters')}</Button>
          </Card>
        ) : (
          <LayoutGroup>
            <motion.div layout className={CONTAINER[view]} transition={{ duration: 0.35, ease: EMPHASIZED }}>
              <AnimatePresence mode="popLayout">
                {visible.map((server, i) => (
                  <motion.div
                    key={`${view}-${server.id}`}
                    layout
                    initial={{ opacity: 0, y: 12, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.98 }}
                    transition={{ duration: 0.35, ease: EMPHASIZED, delay: Math.min(i, 12) * 0.035 }}
                  >
                    <Row
                      server={server}
                      metrics={metrics[server.id]}
                      hostMemMb={hostMemMb}
                      canAct={canActOn(server)}
                      busy={busyId === server.id}
                      act={act}
                      pinned={isPinned(server.id)}
                      togglePin={togglePin}
                      selecting={selecting && canActOn(server) && !server.suspended}
                      selected={selected.has(server.id)}
                      toggleSelect={toggleSelect}
                      menu={menuFor(server)}
                    />
                  </motion.div>
                ))}
              </AnimatePresence>
            </motion.div>
          </LayoutGroup>
        )}
        <AnimatePresence>
          {selecting && (
            <BulkBar
              count={selectedCount}
              visibleCount={selectableVisible.length}
              busy={bulkBusy}
              progress={bulkProgress}
              onSelectAll={() => setSelected(new Set(selectableVisible.map((s) => s.id)))}
              onClear={() => setSelected(new Set())}
              onRun={runBulk}
              onDone={stopSelecting}
            />
          )}
        </AnimatePresence>
      </div>

      <NewInstanceModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          load();
          refreshCreation();
        }}
      />
    </Layout>
  );
}
