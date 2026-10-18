import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Layout, PageHeader } from '../components/Layout.js';
import { Badge, Button, Card, Input, Select, Spinner } from '../components/ui.js';
import { useToast } from '../components/Toast.js';
import { api, ApiError } from '../api/client.js';
import type { AuditEntry, ServerRecord } from '../api/types.js';

const PAGE = 100;

/** "backup.restore_file" → tone by family, so failures and destructive actions stand out. */
function actionTone(action: string): 'neutral' | 'green' | 'red' | 'yellow' | 'blue' {
  if (/failed|delete|kill|suspend|reset/.test(action)) return 'red';
  if (/^auth\./.test(action)) return 'blue';
  if (/restore|update|transfer|sandbox/.test(action)) return 'yellow';
  if (/create|start|enable/.test(action)) return 'green';
  return 'neutral';
}

const FAMILIES = [
  { id: '', label: 'All actions' },
  { id: 'auth', label: 'Sign-ins & 2FA' },
  { id: 'server', label: 'Instances' },
  { id: 'backup', label: 'Snapshots' },
  { id: 'task', label: 'Scheduled tasks' },
  { id: 'file', label: 'Files' },
  { id: 'plugin', label: 'Plugins & mods' },
  { id: 'whitelist', label: 'Whitelist' },
  { id: 'user', label: 'Users' },
  { id: 'settings', label: 'Panel settings' },
  { id: 'webhook', label: 'Notifications' },
  { id: 'node', label: 'Nodes' },
  { id: 'environment', label: 'Environment backups' },
];

function formatTime(iso: string) {
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
}

export function AuditPage() {
  const toast = useToast();
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [users, setUsers] = useState<string[]>([]);
  const [servers, setServers] = useState<ServerRecord[]>([]);
  const [user, setUser] = useState('');
  const [family, setFamily] = useState('');
  const [server, setServer] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');

  // Search applies after a short pause in typing.
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const params = useCallback(
    (before?: number) => {
      const p = new URLSearchParams({ limit: String(PAGE) });
      if (user) p.set('user', user);
      if (family) p.set('action', family);
      if (server) p.set('server', server);
      if (query) p.set('search', query);
      if (before) p.set('before', String(before));
      return p.toString();
    },
    [user, family, server, query]
  );

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    api
      .get<{ entries: AuditEntry[]; nextBefore: number | null }>(`/audit?${params()}`)
      .then((res) => {
        if (cancelled) return;
        setEntries(res.entries);
        setNextBefore(res.nextBefore);
      })
      .catch((err) => toast.error(err instanceof ApiError ? err.message : 'Failed to load the audit log'));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  useEffect(() => {
    api.get<{ users: string[] }>('/audit/facets').then((r) => setUsers(r.users)).catch(() => {});
    api.get<{ servers: ServerRecord[] }>('/servers').then((r) => setServers(r.servers)).catch(() => {});
  }, []);

  async function loadMore() {
    if (!nextBefore) return;
    setLoadingMore(true);
    try {
      const res = await api.get<{ entries: AuditEntry[]; nextBefore: number | null }>(`/audit?${params(nextBefore)}`);
      setEntries((prev) => [...(prev ?? []), ...res.entries]);
      setNextBefore(res.nextBefore);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to load more');
    } finally {
      setLoadingMore(false);
    }
  }

  const filtered = !!(user || family || server || query);

  return (
    <Layout>
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-8">
        <PageHeader title="Audit Log" subtitle="Who did what on this panel — sign-ins, instance changes, snapshots, files and settings." />

        <Card className="mb-4 p-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search details, names…" aria-label="Search" />
            <Select value={family} onChange={(e) => setFamily(e.target.value)} aria-label="Action">
              {FAMILIES.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </Select>
            <Select value={user} onChange={(e) => setUser(e.target.value)} aria-label="User">
              <option value="">All users</option>
              {users.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </Select>
            <Select value={server} onChange={(e) => setServer(e.target.value)} aria-label="Instance">
              <option value="">All instances</option>
              {servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </div>
          {filtered && (
            <div className="mt-3 flex justify-end">
              <Button
                variant="ghost"
                onClick={() => {
                  setUser('');
                  setFamily('');
                  setServer('');
                  setSearch('');
                }}
              >
                Clear filters
              </Button>
            </div>
          )}
        </Card>

        <Card className="overflow-hidden">
          {entries === null ? (
            <div className="flex justify-center p-8">
              <Spinner />
            </div>
          ) : entries.length === 0 ? (
            <p className="p-8 text-center text-sm text-ink-500">{filtered ? 'Nothing matches these filters.' : 'Nothing has been recorded yet.'}</p>
          ) : (
            <>
            {/* Phones: one compact entry per event instead of a five-column table. */}
            <ul className="divide-y divide-surface-800 md:hidden">
              {entries.map((e) => (
                <li key={e.id} className="space-y-1 px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <Badge tone={actionTone(e.action)}>{e.action}</Badge>
                    <span className="text-xs tabular-nums text-ink-500" title={e.at}>
                      {formatTime(e.at)}
                    </span>
                  </div>
                  <p className="text-sm text-ink-200">
                    <span className="font-medium text-ink-100">{e.username ?? 'system'}</span>
                    {(e.targetLabel || e.target) && (
                      <>
                        <span className="text-ink-500"> → </span>
                        {e.targetKind === 'server' ? (
                          <Link to={`/instances/${e.target}`} className="text-accent-400 hover:underline">
                            {e.targetLabel}
                          </Link>
                        ) : (
                          (e.targetLabel ?? <span className="font-mono text-xs text-ink-500">{e.target!.slice(0, 8)}…</span>)
                        )}
                      </>
                    )}
                  </p>
                  {e.detail && <p className="break-words text-xs text-ink-400">{e.detail}</p>}
                </li>
              ))}
            </ul>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-surface-700 text-xs text-ink-400">
                    <th className="px-4 py-3 font-medium">When</th>
                    <th className="px-4 py-3 font-medium">User</th>
                    <th className="px-4 py-3 font-medium">Action</th>
                    <th className="px-4 py-3 font-medium">Target</th>
                    <th className="px-4 py-3 font-medium">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-800">
                  {entries.map((e) => (
                    <tr key={e.id} className="align-top">
                      <td className="whitespace-nowrap px-4 py-2.5 text-xs tabular-nums text-ink-400" title={e.at}>
                        {formatTime(e.at)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-ink-100">{e.username ?? <span className="text-ink-500">system</span>}</td>
                      <td className="px-4 py-2.5">
                        <Badge tone={actionTone(e.action)}>{e.action}</Badge>
                      </td>
                      <td className="max-w-[14rem] truncate px-4 py-2.5 text-ink-200">
                        {e.targetKind === 'server' ? (
                          <Link to={`/instances/${e.target}`} className="text-accent-400 hover:underline">
                            {e.targetLabel}
                          </Link>
                        ) : e.targetLabel ? (
                          e.targetLabel
                        ) : e.target ? (
                          <span className="font-mono text-xs text-ink-500" title={e.target}>
                            {e.target.length > 12 ? `${e.target.slice(0, 8)}…` : e.target}
                          </span>
                        ) : (
                          <span className="text-ink-500">—</span>
                        )}
                      </td>
                      <td className="max-w-[24rem] break-words px-4 py-2.5 text-xs text-ink-300">{e.detail ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </>
          )}
        </Card>

        {nextBefore && (
          <div className="mt-4 flex justify-center">
            <Button disabled={loadingMore} onClick={loadMore}>
              {loadingMore ? 'Loading…' : 'Load older entries'}
            </Button>
          </div>
        )}
      </div>
    </Layout>
  );
}
