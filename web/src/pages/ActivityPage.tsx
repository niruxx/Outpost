import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Layout, PageHeader } from '../components/Layout.js';
import { Badge, Button, Card, CardTitle, ErrorText, Input, Spinner } from '../components/ui.js';
import { Icon } from '../components/icons.js';
import { api } from '../api/client.js';
import { setVisibleInterval } from '../lib/perf.js';
import { usePagedFeed } from '../lib/usePagedFeed.js';
import { t } from '../i18n/index.js';
import type { ActivityUser, AuditEntry, PageView } from '../api/types.js';
import { ActionList, OpenTabList, PageViewList, PresenceDot, describeAction, presenceLabel, relativeTime, useNow } from '../components/ActivityFeed.js';

/**
 * Activity: who is signed in, what each of their tabs is showing, and everything they've done.
 * "All users" gives the live overview; each user has their own tab (/activity/<userId>).
 */

/** Online and active first, then by most recent activity. */
function rank(u: ActivityUser) {
  return (u.active ? 2 : u.online ? 1 : 0) * 1e15 + (u.lastSeen ? new Date(u.lastSeen).getTime() : 0);
}

function Avatar({ name, className = 'h-7 w-7 text-xs' }: { name: string; className?: string }) {
  return (
    <span className={`flex shrink-0 items-center justify-center rounded-full bg-tertiary-container font-medium uppercase text-tertiary-on-container ${className}`} aria-hidden="true">
      {name.slice(0, 1)}
    </span>
  );
}

/** Horizontal, scrollable tab strip: "All users" plus one tab per account. */
function UserTabs({ users, selected, onSelect }: { users: ActivityUser[]; selected: string; onSelect: (id: string) => void }) {
  const tabs = [{ id: '', label: t('All users'), user: null as ActivityUser | null }, ...users.map((u) => ({ id: u.id, label: u.username, user: u }))];
  return (
    <div className="-mx-1 mb-5 overflow-x-auto px-1 pb-1">
      <div className="flex w-max gap-1.5" role="tablist" aria-label={t('Users')}>
        {tabs.map((tab) => {
          const isSelected = tab.id === selected;
          return (
            <button
              key={tab.id || 'all'}
              role="tab"
              aria-selected={isSelected}
              onClick={() => onSelect(tab.id)}
              className={`state-layer relative flex items-center gap-2 rounded-full border py-1.5 pl-2 pr-3.5 text-sm font-medium ${
                isSelected ? 'border-transparent text-secondary-on-container' : 'border-surface-500 text-ink-300'
              }`}
              title={tab.user ? presenceLabel(tab.user.online, tab.user.active) : undefined}
            >
              {isSelected && <motion.span layoutId="activity-user-tab" className="absolute inset-0 rounded-full bg-secondary-container" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
              <span className="relative z-10 flex items-center gap-2">
                {tab.user ? (
                  <span className="relative">
                    <Avatar name={tab.user.username} className="h-6 w-6 text-[11px]" />
                    <PresenceDot online={tab.user.online} active={tab.user.active} className="absolute -bottom-0.5 -right-0.5 ring-2 ring-surface-950 rounded-full" />
                  </span>
                ) : (
                  <span className="flex h-6 w-6 items-center justify-center">
                    <Icon name="users" className="h-4 w-4" />
                  </span>
                )}
                {tab.label}
                {tab.user && tab.user.actionsToday > 0 && <span className="text-xs tabular-nums opacity-70">{tab.user.actionsToday}</span>}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function FeedCard({ title, children, footer }: { title: string; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <Card className="overflow-hidden">
      <div className="px-5 pt-5">
        <CardTitle>{title}</CardTitle>
      </div>
      {children}
      {footer}
    </Card>
  );
}

function LoadMore({ nextBefore, loading, onClick }: { nextBefore: number | null; loading: boolean; onClick: () => void }) {
  if (!nextBefore) return null;
  return (
    <div className="flex justify-center border-t border-surface-800 p-3">
      <Button variant="ghost" disabled={loading} onClick={onClick}>
        {loading ? 'Loading…' : 'Load older'}
      </Button>
    </div>
  );
}

function useSearch() {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(id);
  }, [search]);
  return { search, setSearch, query };
}

function AllUsers({ users }: { users: ActivityUser[] }) {
  const { search, setSearch, query } = useSearch();
  const feed = usePagedFeed<AuditEntry, 'entries'>(`/activity/actions?limit=50${query ? `&search=${encodeURIComponent(query)}` : ''}`, 'entries');
  const online = users.filter((u) => u.online);
  const tabs = online.flatMap((u) => u.tabs);
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
      <Card className="h-fit p-5">
        <CardTitle action={<Badge tone={online.length ? 'green' : 'neutral'} pulse={online.length > 0}>{online.length} {t('online')}</Badge>}>Online now</CardTitle>
        {tabs.length ? <OpenTabList tabs={tabs} showUser /> : <p className="text-sm text-ink-500">{t('Nobody has the panel open right now.')}</p>}
      </Card>
      <FeedCard title="Recent actions" footer={<LoadMore nextBefore={feed.nextBefore} loading={feed.loadingMore} onClick={feed.loadMore} />}>
        <div className="px-5 pb-3">
          <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('Search actions, details, instances…')} aria-label={t('Search actions')} />
        </div>
        <ErrorText>{feed.error}</ErrorText>
        {feed.items === null ? <div className="flex justify-center p-8"><Spinner /></div> : <ActionList entries={feed.items} showUser empty="Nothing has been recorded yet." />}
      </FeedCard>
    </div>
  );
}

function UserDetail({ user }: { user: ActivityUser }) {
  const now = useNow();
  const [view, setView] = useState<'actions' | 'pages'>('actions');
  const { search, setSearch, query } = useSearch();
  const actions = usePagedFeed<AuditEntry, 'entries'>(view === 'actions' ? `/activity/users/${user.id}/actions?limit=50${query ? `&search=${encodeURIComponent(query)}` : ''}` : null, 'entries');
  const pages = usePagedFeed<PageView, 'views'>(view === 'pages' ? `/activity/users/${user.id}/views?limit=50` : null, 'views');
  const feed = view === 'actions' ? actions : pages;

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
      <div className="space-y-5">
        <Card className="p-5">
          <div className="flex items-center gap-4">
            <Avatar name={user.username} className="h-12 w-12 text-lg" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="truncate text-lg font-medium text-ink-50">{user.username}</h2>
                <Badge tone={user.role === 'admin' ? 'blue' : 'neutral'}>{user.role}</Badge>
                {user.disabled && <Badge tone="red">disabled</Badge>}
              </div>
              <p className="mt-0.5 flex items-center gap-2 text-sm text-ink-300">
                <PresenceDot online={user.online} active={user.active} />
                {presenceLabel(user.online, user.active)}
                {!user.online && user.lastSeen && <span className="text-ink-500">· {t('last seen')} {relativeTime(user.lastSeen, now)}</span>}
              </p>
            </div>
          </div>
          <dl className="mt-5 grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-2xl bg-surface-900 px-3 py-2.5">
              <dt className="text-xs text-ink-400">{t('Actions in the last 24h')}</dt>
              <dd className="mt-0.5 text-lg tabular-nums text-ink-50">{user.actionsToday}</dd>
            </div>
            <div className="rounded-2xl bg-surface-900 px-3 py-2.5">
              <dt className="text-xs text-ink-400">{t('Last action')}</dt>
              <dd className="mt-0.5 truncate text-ink-100" title={user.lastAction?.detail ?? undefined}>
                {user.lastAction ? (
                  <>
                    {describeAction(user.lastAction.action)}
                    <span className="block text-xs text-ink-500">{relativeTime(user.lastAction.at, now)}</span>
                  </>
                ) : (
                  <span className="text-ink-500">—</span>
                )}
              </dd>
            </div>
          </dl>
        </Card>
        <Card className="p-5">
          <CardTitle>Open tabs</CardTitle>
          {user.tabs.length ? <OpenTabList tabs={user.tabs} /> : <p className="text-sm text-ink-500">{t('Not signed in to the panel right now.')}</p>}
        </Card>
      </div>

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5">
          <div className="flex rounded-full border border-surface-500 p-0.5" role="tablist" aria-label={t('Activity')}>
            {(['actions', 'pages'] as const).map((v) => (
              <button
                key={v}
                role="tab"
                aria-selected={view === v}
                onClick={() => setView(v)}
                className={`state-layer rounded-full px-4 py-1.5 text-sm font-medium ${view === v ? 'bg-secondary-container text-secondary-on-container' : 'text-ink-300'}`}
              >
                {t(v === 'actions' ? 'Actions & changes' : 'Pages visited')}
              </button>
            ))}
          </div>
          <Link to={`/audit?user=${encodeURIComponent(user.username)}`} className="text-xs text-accent-400 hover:underline">
            {t('Open in Audit Log')}
          </Link>
        </div>
        {view === 'actions' && (
          <div className="px-5 pt-3">
            <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('Search this user’s actions…')} aria-label={t('Search actions')} />
          </div>
        )}
        <div className="mt-3">
          <ErrorText>{feed.error}</ErrorText>
          {view === 'actions' ? (
            actions.items === null ? <div className="flex justify-center p-8"><Spinner /></div> : <ActionList entries={actions.items} empty={query ? 'Nothing matches this search.' : 'This user hasn’t done anything yet.'} />
          ) : pages.items === null ? (
            <div className="flex justify-center p-8"><Spinner /></div>
          ) : (
            <PageViewList views={pages.items} />
          )}
        </div>
        <LoadMore nextBefore={feed.nextBefore} loading={feed.loadingMore} onClick={feed.loadMore} />
      </Card>
    </div>
  );
}

export function ActivityPage() {
  const { userId = '' } = useParams<{ userId?: string }>();
  const navigate = useNavigate();
  const [users, setUsers] = useState<ActivityUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      api
        .get<{ users: ActivityUser[] }>('/activity/users')
        .then((res) => {
          setUsers(res.users);
          setError(null);
        })
        .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load activity'));
    void load();
    return setVisibleInterval(load, 10_000);
  }, []);

  const sorted = useMemo(() => [...(users ?? [])].sort((a, b) => rank(b) - rank(a)), [users]);
  const selected = sorted.find((u) => u.id === userId) ?? null;

  return (
    <Layout>
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-8">
        <PageHeader title="Activity" subtitle="Who's signed in, what they're looking at, and every action and change they make — live." />
        <ErrorText>{error}</ErrorText>
        {users === null ? (
          <div className="flex justify-center p-10"><Spinner /></div>
        ) : (
          <>
            <UserTabs users={sorted} selected={selected ? selected.id : ''} onSelect={(id) => navigate(id ? `/activity/${id}` : '/activity')} />
            {selected ? <UserDetail key={selected.id} user={selected} /> : <AllUsers users={sorted} />}
          </>
        )}
      </div>
    </Layout>
  );
}
