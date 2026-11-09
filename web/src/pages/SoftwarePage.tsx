import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HostLayout } from '../components/HostLayout.js';
import { Badge, Button, Card, CardTitle, ErrorText, Input, Modal, Notice, Select, Spinner } from '../components/ui.js';
import { Icon } from '../components/icons.js';
import { useToast } from '../components/Toast.js';
import { useConfirm } from '../components/ConfirmDialog.js';
import { api, ApiError } from '../api/client.js';
import { hostApi, useHostAdmin } from '../state/hostTarget.js';

type Manager = 'apt' | 'dnf' | 'pacman';
type Verb = 'refresh' | 'install' | 'remove' | 'upgrade' | 'upgrade-all';

interface Job {
  id: string;
  verb: Verb;
  packages: string[];
  state: 'running' | 'succeeded' | 'failed';
  output: string;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  startedBy: string;
}

interface SoftwareStatus {
  available: boolean;
  reason: string | null;
  manager: Manager | null;
  distro: string | null;
  reboot: { required: boolean | null; packages: string[] };
  autoUpdates: { supported: boolean; installed: boolean; enabled: boolean; packageName: string | null } | null;
  job: Job | null;
}

interface UpdateItem {
  name: string;
  current: string | null;
  available: string;
  repo: string | null;
  security: boolean;
}

interface PackageItem {
  name: string;
  version: string | null;
  summary: string;
  category: string;
  installed: boolean;
  repo?: string | null;
  size?: number | null;
  manual?: boolean | null;
}

interface CatalogApp {
  id: string;
  label: string;
  summary: string;
  category: string;
  package: string | null;
  installed: boolean;
}

interface Category {
  id: string;
  label: string;
}

const MANAGER_LABEL: Record<Manager, string> = { apt: 'APT', dnf: 'DNF', pacman: 'pacman' };
const VERB_LABEL: Record<Verb, string> = {
  refresh: 'Checking for updates',
  install: 'Installing',
  remove: 'Removing',
  upgrade: 'Updating',
  'upgrade-all': 'Installing all updates',
};

function size(n: number | null | undefined): string {
  if (!n) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let x = n;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i++;
  }
  return `${x.toFixed(x < 10 && i ? 1 : 0)} ${units[i]}`;
}

export function SoftwarePage() {
  const toast = useToast();
  const confirm = useConfirm();
  const adminMode = useHostAdmin().active;
  const [status, setStatus] = useState<SoftwareStatus | null>(null);
  const [loadError, setLoadError] = useState('');
  const [tab, setTab] = useState<'updates' | 'apps' | 'installed'>('updates');
  const [job, setJob] = useState<Job | null>(null);
  const [jobOpen, setJobOpen] = useState(false);
  const [preview, setPreview] = useState<{ verb: Verb; packages: string[]; output: string | null; error: string } | null>(null);
  const [revision, setRevision] = useState(0); // bumps after each finished job so lists reload

  const loadStatus = useCallback(async () => {
    try {
      const s = await api.get<SoftwareStatus>(hostApi('/packages'));
      setStatus(s);
      setJob(s.job);
      setLoadError('');
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load software status');
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // Follow a running job's output.
  const running = job?.state === 'running';
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(async () => {
      try {
        const res = await api.get<{ job: Job | null }>(hostApi('/packages/jobs/current'));
        setJob(res.job);
        if (res.job && res.job.state !== 'running') {
          if (res.job.state === 'succeeded') toast.success(`${VERB_LABEL[res.job.verb]} finished`);
          else toast.error(res.job.error ?? 'The package operation failed');
          setRevision((r) => r + 1);
          void loadStatus();
        }
      } catch {
        // transient; keep polling
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [running, loadStatus, toast]);

  const startJob = useCallback(
    async (verb: Verb, packages: string[] = []) => {
      try {
        const res = await api.post<{ job: Job }>(hostApi('/packages/jobs'), { verb, packages });
        setJob(res.job);
        setJobOpen(true);
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : 'Couldn’t start the package operation');
      }
    },
    [toast]
  );

  /** Install/remove: show the package manager's own summary of what changes first. */
  const reviewThenRun = useCallback(
    async (verb: 'install' | 'remove', packages: string[]) => {
      setPreview({ verb, packages, output: null, error: '' });
      try {
        const res = await api.post<{ output: string }>(hostApi('/packages/preview'), { verb, packages });
        setPreview({ verb, packages, output: res.output, error: '' });
      } catch (err) {
        setPreview({ verb, packages, output: '', error: err instanceof ApiError ? err.message : 'Couldn’t preview the change' });
      }
    },
    []
  );

  async function setAutoUpdates(enabled: boolean) {
    try {
      await api.post(hostApi('/packages/auto-updates'), { enabled });
      toast.success(enabled ? 'Automatic updates on' : 'Automatic updates off');
      void loadStatus();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Couldn’t change automatic updates');
    }
  }

  const busy = running;
  const actionsDisabled = !adminMode || busy;
  const disabledTitle = !adminMode ? 'Turn on Admin Mode first' : busy ? 'Another package operation is running' : undefined;

  return (
    <HostLayout
      action={
            status?.manager && (
              <div className="flex flex-wrap items-center gap-2">
                {status.distro && <Badge tone="neutral">{status.distro}</Badge>}
                <Badge tone="blue">{MANAGER_LABEL[status.manager]}</Badge>
              </div>
            )
      }
    >
      <div className="space-y-5">

        {loadError ? (
          <Notice tone="error">{loadError}</Notice>
        ) : !status ? (
          <Spinner />
        ) : !status.available ? (
          <Notice tone="warning">{status.reason}</Notice>
        ) : (
          <>
            {!adminMode && (
              <Notice tone="info">
                You can browse updates and packages with limited access. To install, update or remove anything, turn on <b>Admin Mode</b> with the lock button above.
              </Notice>
            )}
            {status.reboot.required && (
              <Notice tone="warning">
                <b>Restart required.</b> Updates were installed that only take effect after the host restarts
                {status.reboot.packages.length ? ` (${status.reboot.packages.slice(0, 6).join(', ')}${status.reboot.packages.length > 6 ? '…' : ''})` : ''}. Restart from the Host Console when it’s
                convenient.
              </Notice>
            )}

            {job && (
              <JobBar
                job={job}
                onOpen={() => setJobOpen(true)}
                onDismiss={() => setJob(null)}
              />
            )}

            <nav aria-label="Software sections" className="inline-flex max-w-full flex-wrap gap-1 rounded-full border border-surface-700 bg-surface-900 p-1">
              {(
                [
                  ['updates', 'Updates', 'update'],
                  ['apps', 'Browse & install', 'apps'],
                  ['installed', 'Installed', 'box'],
                ] as const
              ).map(([id, label, icon]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setTab(id)}
                  className={`inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${tab === id ? 'bg-secondary-container text-secondary-on-container' : 'text-ink-400 hover:bg-surface-800 hover:text-ink-100'}`}
                >
                  <Icon name={icon} className="h-4 w-4" />
                  {label}
                </button>
              ))}
            </nav>

            {tab === 'updates' && (
              <UpdatesTab
                status={status}
                revision={revision}
                actionsDisabled={actionsDisabled}
                disabledTitle={disabledTitle}
                onRun={(verb, pkgs) => void startJob(verb, pkgs)}
                onAutoUpdates={(on) => void setAutoUpdates(on)}
                onInstallAuto={(pkg) => void reviewThenRun('install', [pkg])}
                confirm={confirm}
              />
            )}
            {tab === 'apps' && (
              <AppsTab revision={revision} actionsDisabled={actionsDisabled} disabledTitle={disabledTitle} onInstall={(p) => void reviewThenRun('install', p)} onRemove={(p) => void reviewThenRun('remove', p)} />
            )}
            {tab === 'installed' && (
              <InstalledTab revision={revision} actionsDisabled={actionsDisabled} disabledTitle={disabledTitle} onRemove={(p) => void reviewThenRun('remove', p)} />
            )}
          </>
        )}
      </div>

      {job && jobOpen && <JobModal job={job} onClose={() => setJobOpen(false)} />}

      {preview && (
        <Modal open onClose={() => setPreview(null)} title={`${preview.verb === 'install' ? 'Install' : 'Remove'} ${preview.packages.join(', ')}`} size="lg">
          <div className="space-y-4">
            {preview.output === null ? (
              <div className="flex items-center gap-2 text-sm text-ink-400">
                <Spinner /> Asking {status?.manager ? MANAGER_LABEL[status.manager] : 'the package manager'} what would change…
              </div>
            ) : (
              <>
                <ErrorText>{preview.error}</ErrorText>
                {preview.output && (
                  <>
                    <p className="text-sm text-ink-300">
                      Review what the package manager will do{preview.verb === 'remove' ? ' — removing a package can also remove software that depends on it' : ''}:
                    </p>
                    <pre className="max-h-[45vh] overflow-auto whitespace-pre-wrap rounded-2xl bg-surface-1000 p-4 font-mono text-xs leading-relaxed text-ink-200">{preview.output}</pre>
                  </>
                )}
              </>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setPreview(null)}>
                Cancel
              </Button>
              <Button
                variant={preview.verb === 'remove' ? 'danger' : 'primary'}
                disabled={preview.output === null || !!preview.error || actionsDisabled}
                onClick={() => {
                  const p = preview;
                  setPreview(null);
                  void startJob(p.verb, p.packages);
                }}
              >
                {preview.verb === 'install' ? 'Install' : 'Remove'}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </HostLayout>
  );
}

function JobBar({ job, onOpen, onDismiss }: { job: Job; onOpen: () => void; onDismiss: () => void }) {
  const last = job.output.trim().split('\n').filter(Boolean).pop() ?? '';
  const what = `${VERB_LABEL[job.verb]}${job.packages.length ? ` ${job.packages.slice(0, 4).join(', ')}${job.packages.length > 4 ? '…' : ''}` : ''}`;
  return (
    <Card className="flex flex-wrap items-center gap-3 p-4">
      {job.state === 'running' ? <Spinner /> : <Icon name={job.state === 'succeeded' ? 'check' : 'warning'} className={`h-5 w-5 ${job.state === 'succeeded' ? 'text-success-400' : 'text-red-400'}`} />}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink-100">
          {what}
          {job.state === 'succeeded' ? ' — done' : job.state === 'failed' ? ' — failed' : '…'}
        </p>
        <p className="truncate font-mono text-xs text-ink-500">{job.state === 'failed' ? job.error : last}</p>
      </div>
      <Button variant="ghost" onClick={onOpen}>
        <Icon name="terminal" className="h-4 w-4" /> Output
      </Button>
      {job.state !== 'running' && (
        <Button variant="ghost" onClick={onDismiss} aria-label="Dismiss">
          <Icon name="close" className="h-4 w-4" />
        </Button>
      )}
    </Card>
  );
}

function JobModal({ job, onClose }: { job: Job; onClose: () => void }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [job.output]);
  return (
    <Modal open onClose={onClose} title={VERB_LABEL[job.verb]} size="xl">
      <div className="space-y-3">
        <p className="text-xs text-ink-500">
          Started by {job.startedBy} at {new Date(job.startedAt).toLocaleTimeString()}
          {job.finishedAt ? ` · finished ${new Date(job.finishedAt).toLocaleTimeString()}` : ' · still running — you can close this and keep working'}
        </p>
        <pre ref={ref} className="h-[55vh] overflow-auto whitespace-pre-wrap rounded-2xl bg-surface-1000 p-4 font-mono text-xs leading-relaxed text-ink-200">
          {job.output || 'Waiting for output…'}
        </pre>
      </div>
    </Modal>
  );
}

function UpdatesTab({
  status,
  revision,
  actionsDisabled,
  disabledTitle,
  onRun,
  onAutoUpdates,
  onInstallAuto,
  confirm,
}: {
  status: SoftwareStatus;
  revision: number;
  actionsDisabled: boolean;
  disabledTitle?: string;
  onRun: (verb: Verb, packages?: string[]) => void;
  onAutoUpdates: (on: boolean) => void;
  onInstallAuto: (pkg: string) => void;
  confirm: ReturnType<typeof useConfirm>;
}) {
  const [data, setData] = useState<{ checkedAt: string; updates: UpdateItem[]; error: string | null; individual: boolean } | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [checking, setChecking] = useState(false);
  const firstLoad = useRef(true);

  const load = useCallback(async (recheck: boolean) => {
    setChecking(true);
    try {
      setData(await api.get(hostApi(`/packages/updates${recheck ? '?recheck=1' : ''}`)));
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to list updates');
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void load(!firstLoad.current);
    firstLoad.current = false;
    setSelected(new Set());
  }, [load, revision]);

  const updates = data?.updates ?? [];
  const security = updates.filter((u) => u.security).length;
  const auto = status.autoUpdates;

  async function installAll() {
    const ok = await confirm({
      title: 'Install all updates',
      message: `Install ${updates.length} update${updates.length === 1 ? '' : 's'}${status.manager === 'pacman' ? ' (a full system upgrade)' : ''}? Services may restart while packages are replaced.`,
      confirmLabel: 'Install updates',
    });
    if (ok) onRun('upgrade-all');
  }

  return (
    <div className="space-y-5">
      <Card className="p-5">
        <CardTitle
          action={
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" onClick={() => onRun('refresh')} disabled={actionsDisabled} title={disabledTitle ?? 'Download the latest package lists, then list updates'}>
                <Icon name="refresh" className="h-4 w-4" /> Check for updates
              </Button>
              {data?.individual && selected.size > 0 && (
                <Button onClick={() => onRun('upgrade', [...selected])} disabled={actionsDisabled} title={disabledTitle}>
                  Install selected ({selected.size})
                </Button>
              )}
              {updates.length > 0 && (
                <Button variant="primary" onClick={() => void installAll()} disabled={actionsDisabled} title={disabledTitle}>
                  <Icon name="download" className="h-4 w-4" /> Install all
                </Button>
              )}
            </div>
          }
        >
          Available updates
        </CardTitle>
        <ErrorText>{error}</ErrorText>
        {!data ? (
          <div className="flex items-center gap-2 text-sm text-ink-400">
            <Spinner /> Looking for updates…
          </div>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-ink-500">
              {updates.length === 0 ? (
                <Badge tone="green">Up to date</Badge>
              ) : (
                <>
                  <Badge tone="yellow">{updates.length} available</Badge>
                  {security > 0 && <Badge tone="red">{security} security</Badge>}
                </>
              )}
              <span>Checked {new Date(data.checkedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} against the current package lists.</span>
              {checking && <Spinner className="h-3 w-3" />}
            </div>
            {data.error && <Notice tone="warning">{data.error}</Notice>}
            {!data.individual && updates.length > 0 && <p className="mb-3 text-xs text-ink-500">Arch Linux only supports upgrading everything at once.</p>}
            {updates.length > 0 && (
              <div className="max-h-[55vh] divide-y divide-surface-700 overflow-auto rounded-2xl bg-surface-900">
                {updates.map((u) => (
                  <label key={u.name} className="flex cursor-pointer flex-wrap items-center gap-3 px-4 py-2.5">
                    {data.individual && (
                      <input
                        type="checkbox"
                        checked={selected.has(u.name)}
                        onChange={(e) =>
                          setSelected((s) => {
                            const next = new Set(s);
                            if (e.target.checked) next.add(u.name);
                            else next.delete(u.name);
                            return next;
                          })
                        }
                      />
                    )}
                    <span className="min-w-0 flex-1 truncate font-mono text-sm text-ink-100">{u.name}</span>
                    {u.security && <Badge tone="red">Security</Badge>}
                    <span className="font-mono text-xs text-ink-500">
                      {u.current ?? '?'} → <span className="text-ink-200">{u.available}</span>
                    </span>
                    {u.repo && <span className="hidden text-xs text-ink-500 sm:inline">{u.repo}</span>}
                  </label>
                ))}
              </div>
            )}
          </>
        )}
      </Card>

      {auto?.supported && (
        <Card className="p-5">
          <CardTitle>Automatic updates</CardTitle>
          {!auto.installed ? (
            <div className="flex flex-wrap items-center gap-3 text-sm text-ink-300">
              <p className="flex-1">
                Install <code>{auto.packageName}</code> to have the host install {status.manager === 'apt' ? 'security ' : ''}updates by itself every day.
              </p>
              <Button onClick={() => onInstallAuto(auto.packageName!)} disabled={actionsDisabled} title={disabledTitle}>
                Install {auto.packageName}
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3 text-sm text-ink-300">
              <p className="flex-1">
                {auto.enabled
                  ? status.manager === 'apt'
                    ? 'unattended-upgrades refreshes the package lists and installs security updates daily.'
                    : 'dnf-automatic downloads and installs updates daily.'
                  : 'Off. Updates are only installed when you choose to.'}
              </p>
              <Badge tone={auto.enabled ? 'green' : 'neutral'}>{auto.enabled ? 'On' : 'Off'}</Badge>
              <Button variant={auto.enabled ? 'outlined' : 'primary'} onClick={() => onAutoUpdates(!auto.enabled)} disabled={actionsDisabled} title={disabledTitle}>
                {auto.enabled ? 'Turn off' : 'Turn on'}
              </Button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

function useCategories() {
  const [catalog, setCatalog] = useState<{ categories: Category[]; apps: CatalogApp[] } | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      setCatalog(await api.get(hostApi('/packages/catalog')));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load the catalog');
    }
  }, []);
  return { catalog, error, load };
}

/** Category chips with counts; "all" first. */
function GroupChips({ categories, counts, value, onChange }: { categories: Category[]; counts: Map<string, number>; value: string; onChange: (id: string) => void }) {
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  return (
    <div className="flex flex-wrap gap-2">
      {[{ id: 'all', label: 'All groups' }, ...categories]
        .filter((c) => c.id === 'all' || counts.get(c.id))
        .map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => onChange(c.id)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${value === c.id ? 'bg-secondary-container text-secondary-on-container' : 'bg-surface-800 text-ink-300 hover:text-ink-100'}`}
          >
            {c.label} <span className="opacity-60">{c.id === 'all' ? total : counts.get(c.id)}</span>
          </button>
        ))}
    </div>
  );
}

function grouped<T extends { category: string }>(items: T[], categories: Category[]): Array<{ category: Category; items: T[] }> {
  return categories.map((category) => ({ category, items: items.filter((i) => i.category === category.id) })).filter((g) => g.items.length);
}

function AppsTab({
  revision,
  actionsDisabled,
  disabledTitle,
  onInstall,
  onRemove,
}: {
  revision: number;
  actionsDisabled: boolean;
  disabledTitle?: string;
  onInstall: (packages: string[]) => void;
  onRemove: (packages: string[]) => void;
}) {
  const { catalog, error: catalogError, load: loadCatalog } = useCategories();
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [results, setResults] = useState<{ results: PackageItem[]; truncated: boolean } | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [group, setGroup] = useState('all');
  const [sort, setSort] = useState<'group' | 'relevance' | 'name'>('group');

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog, revision]);

  // Search as you type (debounced); Enter searches at once.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setSubmitted('');
      setResults(null);
      return;
    }
    const timer = window.setTimeout(() => setSubmitted(q), 450);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!submitted) return;
    let cancelled = false;
    setSearching(true);
    setError('');
    api
      .get<{ results: PackageItem[]; truncated: boolean }>(hostApi(`/packages/search?q=${encodeURIComponent(submitted)}`))
      .then((r) => {
        if (!cancelled) {
          setResults(r);
          setGroup('all');
        }
      })
      .catch((err) => !cancelled && setError(err instanceof ApiError ? err.message : 'Search failed'))
      .finally(() => !cancelled && setSearching(false));
    return () => {
      cancelled = true;
    };
  }, [submitted, revision]);

  const categories = catalog?.categories ?? [];
  const searchMode = !!submitted && !!results;

  const items: Array<PackageItem & { label?: string }> = useMemo(() => {
    if (searchMode) return results!.results;
    return (catalog?.apps ?? [])
      .filter((a) => a.package)
      .map((a) => ({ name: a.package!, label: a.label, summary: a.summary, category: a.category, installed: a.installed, version: null }));
  }, [searchMode, results, catalog]);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of items) m.set(i.category, (m.get(i.category) ?? 0) + 1);
    return m;
  }, [items]);

  const visible = useMemo(() => {
    const list = items.filter((i) => group === 'all' || i.category === group);
    if (sort === 'name') return [...list].sort((a, b) => (a.label ?? a.name).localeCompare(b.label ?? b.name));
    return list;
  }, [items, group, sort]);

  const sections = sort === 'group' || !searchMode ? grouped(visible, categories) : [{ category: { id: 'results', label: '' }, items: visible }];

  return (
    <Card className="space-y-4 p-5">
      <form
        className="flex flex-wrap items-center gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (query.trim().length >= 1) setSubmitted(query.trim());
        }}
      >
        <div className="relative min-w-[14rem] flex-1">
          <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-500" />
          <Input className="pl-9" placeholder="Search all packages — e.g. nginx, postgres, ffmpeg" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search packages" />
        </div>
        {searchMode && (
          <Select className="w-auto" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort">
            <option value="group">Sort by group</option>
            <option value="relevance">Sort by relevance</option>
            <option value="name">Sort by name</option>
          </Select>
        )}
        {searching && <Spinner />}
      </form>

      <ErrorText>{error || catalogError}</ErrorText>

      <p className="text-xs text-ink-500">
        {searchMode
          ? `${results!.results.length}${results!.truncated ? '+' : ''} package${results!.results.length === 1 ? '' : 's'} match “${submitted}”${results!.truncated ? ' — showing the closest matches; refine your search to see more' : ''}.`
          : 'Popular server software, grouped by what it does. Search to find anything else in your repositories.'}
      </p>

      {categories.length > 0 && <GroupChips categories={categories} counts={counts} value={group} onChange={setGroup} />}

      {!catalog && !searchMode ? (
        <Spinner />
      ) : visible.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-500">{searchMode ? 'No packages found.' : 'Nothing here.'}</p>
      ) : (
        <div className="space-y-5">
          {sections.map(({ category, items: list }) => (
            <section key={category.id} className="space-y-2">
              {category.label && <h3 className="text-xs font-medium uppercase tracking-wide text-ink-400">{category.label}</h3>}
              <div className="grid gap-2 sm:grid-cols-2">
                {list.map((p) => (
                  <div key={p.name} className="flex items-start gap-3 rounded-2xl bg-surface-900 p-3">
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink-100">
                        {p.label ?? p.name}
                        {p.label && p.label !== p.name && <span className="font-mono text-xs font-normal text-ink-500">{p.name}</span>}
                        {p.installed && <Badge tone="green">Installed</Badge>}
                      </p>
                      <p className="line-clamp-2 text-xs text-ink-400">{p.summary}</p>
                      {(p.version || p.size || (searchMode && sort !== 'group')) && (
                        <p className="mt-0.5 text-xs text-ink-500">
                          {[p.version, p.size ? size(p.size) : null, searchMode && sort !== 'group' ? categories.find((c) => c.id === p.category)?.label : null, p.repo]
                            .filter(Boolean)
                            .join(' · ')}
                        </p>
                      )}
                    </div>
                    {p.installed ? (
                      <Button variant="ghost" className="shrink-0" onClick={() => onRemove([p.name])} disabled={actionsDisabled} title={disabledTitle}>
                        Remove
                      </Button>
                    ) : (
                      <Button className="shrink-0" onClick={() => onInstall([p.name])} disabled={actionsDisabled} title={disabledTitle}>
                        Install
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </Card>
  );
}

function InstalledTab({ revision, actionsDisabled, disabledTitle, onRemove }: { revision: number; actionsDisabled: boolean; disabledTitle?: string; onRemove: (packages: string[]) => void }) {
  const { catalog, load: loadCatalog } = useCategories();
  const [packages, setPackages] = useState<PackageItem[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState('all');
  const [onlyManual, setOnlyManual] = useState(true);
  const [sort, setSort] = useState<'group' | 'name' | 'size'>('group');
  const [limit, setLimit] = useState(300);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  useEffect(() => {
    api
      .get<{ packages: PackageItem[] }>(hostApi('/packages/installed'))
      .then((r) => {
        setPackages(r.packages);
        setError('');
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to list installed packages'));
  }, [revision]);

  const manualKnown = packages?.some((p) => p.manual !== null && p.manual !== undefined) ?? false;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (packages ?? []).filter((p) => (!onlyManual || !manualKnown || p.manual) && (!q || p.name.toLowerCase().includes(q) || p.summary.toLowerCase().includes(q)));
  }, [packages, query, onlyManual, manualKnown]);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of filtered) m.set(p.category, (m.get(p.category) ?? 0) + 1);
    return m;
  }, [filtered]);

  const visible = useMemo(() => {
    const list = filtered.filter((p) => group === 'all' || p.category === group);
    if (sort === 'size') return [...list].sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
    return list;
  }, [filtered, group, sort]);

  const categories = catalog?.categories ?? [];
  const shown = visible.slice(0, limit);
  const sections = sort === 'group' ? grouped(shown, categories) : [{ category: { id: 'all', label: '' }, items: shown }];

  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[14rem] flex-1">
          <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-500" />
          <Input className="pl-9" placeholder="Filter installed packages…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <Select className="w-auto" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort">
          <option value="group">Sort by group</option>
          <option value="name">Sort by name</option>
          <option value="size">Sort by size</option>
        </Select>
        {manualKnown && (
          <label className="flex items-center gap-2 text-sm text-ink-300">
            <input type="checkbox" checked={onlyManual} onChange={(e) => setOnlyManual(e.target.checked)} /> Only software installed on request
          </label>
        )}
      </div>
      <ErrorText>{error}</ErrorText>
      {!packages ? (
        <Spinner />
      ) : (
        <>
          <p className="text-xs text-ink-500">
            {packages.length} packages installed{manualKnown && onlyManual ? `, ${filtered.length} installed on request (the rest were pulled in as dependencies)` : ''}.
          </p>
          {categories.length > 0 && <GroupChips categories={categories} counts={counts} value={group} onChange={setGroup} />}
          <div className="space-y-5">
            {sections.map(({ category, items }) => (
              <section key={category.id} className="space-y-2">
                {category.label && <h3 className="text-xs font-medium uppercase tracking-wide text-ink-400">{category.label}</h3>}
                <div className="divide-y divide-surface-700 overflow-hidden rounded-2xl bg-surface-900">
                  {items.map((p) => (
                    <div key={p.name} className="flex items-center gap-3 px-4 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-mono text-sm text-ink-100">{p.name}</p>
                        <p className="truncate text-xs text-ink-400">{p.summary}</p>
                      </div>
                      <span className="hidden font-mono text-xs text-ink-500 sm:inline">{p.version}</span>
                      <span className="w-16 text-right text-xs text-ink-500">{size(p.size)}</span>
                      <Button variant="ghost" onClick={() => onRemove([p.name])} disabled={actionsDisabled} title={disabledTitle}>
                        Remove
                      </Button>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
          {visible.length > limit && (
            <div className="flex justify-center">
              <Button variant="ghost" onClick={() => setLimit((l) => l + 300)}>
                Show more ({visible.length - limit} left)
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
