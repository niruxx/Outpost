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

function FilesForInstance() {
  const { server, suspendedMessage } = useServerDetail();
  if (suspendedMessage) return <p className="text-sm text-ink-300">{suspendedMessage}</p>;
  if (!server) return <Spinner />;
  return <FilesTab />;
}

/** File Management across instances: pick one on the left, browse its files on the right. */
export function FileManagerPage() {
  const { serverId } = useParams<{ serverId?: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [servers, setServers] = useState<ServerRecord[] | null>(null);

  useEffect(() => {
    api
      .get<{ servers: ServerRecord[] }>('/servers')
      .then((res) => setServers(res.servers))
      .catch(() => setServers([]));
  }, []);

  // Open the first accessible instance by default.
  useEffect(() => {
    if (!serverId && servers?.length) {
      const first = servers.find((s) => !s.suspended || user?.role === 'admin');
      if (first) navigate(`/files/${first.id}`, { replace: true });
    }
  }, [serverId, servers, navigate, user?.role]);

  return (
    <Layout>
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-8">
        <PageHeader title="File Management" subtitle="Browse, edit, upload and download files for each instance." />
        {servers === null ? (
          <Spinner />
        ) : servers.length === 0 ? (
          <Card className="p-10 text-center text-sm text-ink-400">No instances yet.</Card>
        ) : (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
            {/* Phones and tablets: a dropdown, so the file list starts near the top of the screen. */}
            <Select value={serverId ?? ''} onChange={(e) => navigate(`/files/${e.target.value}`)} aria-label="Instance" className="lg:hidden">
              {!serverId && <option value="">Select an instance</option>}
              {servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.suspended === 1 ? ' (suspended)' : ''}
                </option>
              ))}
            </Select>
            <Card className="hidden h-fit p-2 lg:block">
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
              {serverId ? (
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
