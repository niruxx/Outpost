import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Layout, PageHeader } from '../components/Layout.js';
import { Card, Select, Spinner } from '../components/ui.js';
import { GameTile, gameKindOf } from '../components/GameArt.js';
import { SuspendedBadge } from '../components/StatusBadge.js';
import { api } from '../api/client.js';
import type { ServerRecord } from '../api/types.js';
import { useAuth } from '../state/AuthContext.js';
import { ServerDetailProvider, useServerDetail } from './server/ServerContext.js';
import { FilesTab } from './server/FilesTab.js';
import { HostFilesBrowser } from './HostFilesBrowser.js';
import { Icon } from '../components/icons.js';

function FilesForInstance() {
  const { server, suspendedMessage } = useServerDetail();
  if (suspendedMessage) return <p className="text-sm text-ink-300">{suspendedMessage}</p>;
  if (!server) return <Spinner />;
  return <FilesTab />;
}

/** File Management across instances: pick one on the left, browse its files on the right.
 *  Administrators also get the host itself ("Host"), at /host-files. */
export function FileManagerPage({ host = false }: { host?: boolean }) {
  const params = useParams<{ serverId?: string }>();
  const serverId = host ? undefined : params.serverId;
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [servers, setServers] = useState<ServerRecord[] | null>(null);

  useEffect(() => {
    api
      .get<{ servers: ServerRecord[] }>('/servers')
      .then((res) => setServers(res.servers))
      .catch(() => setServers([]));
  }, []);

  // Open the first accessible instance by default.
  useEffect(() => {
    if (!host && !serverId && servers?.length) {
      const first = servers.find((s) => !s.suspended || user?.role === 'admin');
      if (first) navigate(`/files/${first.id}`, { replace: true });
    }
  }, [host, serverId, servers, navigate, user?.role]);

  return (
    <Layout>
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-8">
        <PageHeader
          title={host ? 'Host File Manager' : 'File Management'}
          subtitle={host ? 'Browse and edit files on the host machine. Turn on Admin Mode in the top bar to work as root.' : 'Browse, edit, upload and download files for each instance.'}
        />
        {servers === null ? (
          <Spinner />
        ) : servers.length === 0 && !isAdmin ? (
          <Card className="p-10 text-center text-sm text-ink-400">No instances yet.</Card>
        ) : (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
            {/* Phones and tablets: a dropdown, so the file list starts near the top of the screen. */}
            <Select
              value={host ? 'host' : (serverId ?? '')}
              onChange={(e) => navigate(e.target.value === 'host' ? '/host-files' : `/files/${e.target.value}`)}
              aria-label="Instance"
              className="lg:hidden"
            >
              {!serverId && !host && <option value="">Select an instance</option>}
              {isAdmin && <option value="host">Host (this machine)</option>}
              {servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.suspended === 1 ? ' (suspended)' : ''}
                </option>
              ))}
            </Select>
            <Card className="hidden h-fit p-2 lg:block">
              {isAdmin && (
                <>
                  <button
                    onClick={() => navigate('/host-files')}
                    className={`state-layer flex w-full items-center gap-3 rounded-2xl p-2 text-left ${
                      host ? 'bg-secondary-container text-secondary-on-container' : 'text-ink-200'
                    }`}
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-tertiary-container text-tertiary-on-container">
                      <Icon name="monitor" className="h-5 w-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">Host</span>
                      <span className="block truncate text-xs text-ink-500">This machine</span>
                    </span>
                  </button>
                  {servers.length > 0 && <div className="mx-2 my-1 border-t border-surface-700" />}
                </>
              )}
              {servers.map((s) => {
                const active = s.id === serverId;
                return (
                  <button
                    key={s.id}
                    onClick={() => navigate(`/files/${s.id}`)}
                    className={`state-layer flex w-full items-center gap-3 rounded-2xl p-2 text-left ${
                      active ? 'bg-secondary-container text-secondary-on-container' : 'text-ink-200'
                    }`}
                  >
                    <GameTile kind={gameKindOf(s)} className="h-9 w-9 !rounded-xl" running={s.status === 'running'} />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{s.name}</span>
                    {s.suspended === 1 && <SuspendedBadge />}
                  </button>
                );
              })}
            </Card>
            <div className="min-w-0">
              {host ? (
                <HostFilesBrowser />
              ) : serverId ? (
                <ServerDetailProvider serverId={serverId} key={serverId}>
                  <FilesForInstance />
                </ServerDetailProvider>
              ) : (
                <p className="text-sm text-ink-400">Select an instance.</p>
              )}
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}
