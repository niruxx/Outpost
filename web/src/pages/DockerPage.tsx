import { useCallback, useEffect, useState } from 'react';
import { setVisibleInterval } from '../lib/perf.js';
import { Link, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Layout, PageHeader } from '../components/Layout.js';
import { StatusBadge, SuspendedBadge } from '../components/StatusBadge.js';
import { Badge, Button, Card, CardTitle, Notice, Spinner } from '../components/ui.js';
import { GameTile, gameKindOf } from '../components/GameArt.js';
import { Icon } from '../components/icons.js';
import { formatBytes, formatDuration } from '../components/HostOverview.js';
import { EMPHASIZED } from '../components/motion.js';
import { useToast } from '../components/Toast.js';
import { NewInstanceModal } from '../components/NewInstanceModal.js';
import { api, ApiError } from '../api/client.js';
import type { DockerConfig, DockerOverview, InstanceListMetrics, ServerRecord } from '../api/types.js';
import { useAuth } from '../state/AuthContext.js';

function EngineCard({ overview, refreshing, onRefresh }: { overview: DockerOverview | null; refreshing: boolean; onRefresh: () => void }) {
  const engine = overview?.engine;
  return (
    <Card className="p-5">
      <CardTitle
        action={
          <Button variant="ghost" onClick={onRefresh} disabled={refreshing}>
            {refreshing ? <Spinner /> : <Icon name="refresh" className="h-4 w-4" />} Refresh
          </Button>
        }
      >
        Container engine
      </CardTitle>
      {!engine ? (
        <Spinner />
      ) : engine.available ? (
        <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
          <div className="flex items-center gap-3">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#173450] text-[#7cc0ff]">
              <Icon name="container" className="h-6 w-6" />
            </span>
            <div>
              <p className="text-base capitalize text-ink-50">
                {engine.engine} <span className="text-ink-400">{engine.version}</span>
              </p>
              <div className="mt-0.5 flex gap-1.5">
                <Badge tone="green">Connected</Badge>
                {engine.rootless && <Badge tone="blue">Rootless</Badge>}
              </div>
            </div>
          </div>
          {overview?.socket && (
            <div className="text-xs">
              <p className="text-ink-400">API socket (Portainer)</p>
              {overview.socket.path ? (
                <p className="font-mono text-ink-200">{overview.socket.path}</p>
              ) : (
                <p className="max-w-xs text-yellow-400">{overview.socket.hint}</p>
              )}
            </div>
          )}
          {overview?.counts && (
            <div className="flex gap-6 text-sm">
              {[
                ['Running', overview.counts.running],
                ['Containers', overview.counts.containers],
                ['Images', overview.counts.images],
              ].map(([label, n]) => (
                <div key={label as string}>
                  <p className="text-2xl text-ink-50">{n}</p>
                  <p className="text-xs text-ink-400">{label}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <Notice tone="warning">
          <p className="font-medium">{engine.error}</p>
          {engine.hint && <p className="mt-1">{engine.hint}</p>}
        </Notice>
      )}
    </Card>
  );
}

function DockerRow({ server, metrics }: { server: ServerRecord; metrics: InstanceListMetrics | undefined }) {
  let config: DockerConfig | null = null;
  try {
    config = server.docker_config ? JSON.parse(server.docker_config) : null;
  } catch {
    config = null;
  }
  const stats = metrics?.runtime?.stats;
  return (
    <Card hover className="relative p-4">
      <Link to={`/instances/${server.id}`} aria-label={`Open ${server.name}`} className="absolute inset-0 rounded-[inherit]" />
      <div className="flex flex-wrap items-center gap-4">
        <GameTile kind={gameKindOf(server)} className="h-12 w-12" running={server.status === 'running'} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-base font-medium text-ink-50">{server.name}</h2>
            {server.suspended ? <SuspendedBadge /> : <StatusBadge status={server.status} />}
          </div>
          <p className="mt-0.5 truncate font-mono text-xs text-ink-400">{server.version}</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {config?.ports.map((p, i) => (
            <span key={i} className="rounded-lg bg-surface-900 px-2 py-0.5 font-mono text-xs text-ink-300">
              {p.host}→{p.container}/{p.protocol}
            </span>
          ))}
        </div>
        <div className="flex gap-4 text-xs text-ink-300 tabular-nums">
          <span title="CPU">{stats?.cpuPercent != null ? `${stats.cpuPercent}%` : '—'}</span>
          <span title="Memory">{stats?.memoryMb != null ? formatBytes(stats.memoryMb * 1048576) : '—'}</span>
          <span title="Network in / out">
            {stats?.netRxRate != null ? `↓${formatBytes(stats.netRxRate)}/s ↑${formatBytes(stats.netTxRate ?? 0)}/s` : '—'}
          </span>
          <span title="Uptime">{metrics?.runtime ? formatDuration(metrics.runtime.uptimeMs / 1000) : ''}</span>
        </div>
      </div>
    </Card>
  );
}

/** The Docker page: engine status + only the container-backed instances. */
export function DockerPage() {
  const { user, creation } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const isAdmin = user?.role === 'admin';
  const canCreateContainers = isAdmin || (!!creation?.canCreate && creation.containers !== 'none');
  const [overview, setOverview] = useState<DockerOverview | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [servers, setServers] = useState<ServerRecord[] | null>(null);
  const [metrics, setMetrics] = useState<Record<string, InstanceListMetrics>>({});
  const [createOpen, setCreateOpen] = useState(false);

  const loadEngine = useCallback(async (refresh = false) => {
    setRefreshing(true);
    try {
      setOverview(await api.get<DockerOverview>(`/docker${refresh ? '?refresh=1' : ''}`));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to reach the container engine');
    } finally {
      setRefreshing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadInstances = useCallback(async () => {
    try {
      const res = await api.get<{ servers: ServerRecord[]; metrics: Record<string, InstanceListMetrics> }>('/servers');
      setServers(res.servers.filter((s) => s.platform === 'docker'));
      setMetrics(res.metrics ?? {});
    } catch {
      // the list keeps its last value
    }
  }, []);

  useEffect(() => {
    loadEngine();
    loadInstances();
    const t = setVisibleInterval(loadInstances, 4000);
    return () => t();
  }, [loadEngine, loadInstances]);

  const managed = overview?.containers ?? [];

  return (
    <Layout>
      <div className="mx-auto max-w-6xl space-y-5 px-4 py-8 sm:px-8">
        <PageHeader
          title="Docker"
          subtitle="Apps, services and game servers in containers — each one only sees its own folder."
          action={
            canCreateContainers && (
              <Button variant="primary" onClick={() => setCreateOpen(true)} disabled={!overview?.engine.available}>
                <Icon name="plus" className="h-4 w-4" /> New container
              </Button>
            )
          }
        />

        <EngineCard overview={overview} refreshing={refreshing} onRefresh={() => loadEngine(true)} />

        <div>
          <h2 className="mb-3 text-base font-medium text-ink-100">{servers ? `${servers.length} container instance${servers.length === 1 ? '' : 's'}` : 'Container instances'}</h2>
          {servers === null ? (
            <Spinner />
          ) : servers.length === 0 ? (
            <Card className="p-10 text-center">
              <GameTile kind="docker" className="mx-auto mb-3 h-14 w-14" />
              <p className="mb-1 text-base font-medium text-ink-100">No container instances yet</p>
              <p className="text-sm text-ink-400">
                {canCreateContainers ? 'Create one from the app catalog or any image you’re allowed to run.' : 'Ask an admin for container access to create one here.'}
              </p>
            </Card>
          ) : (
            <div className="space-y-3">
              <AnimatePresence initial={false}>
                {servers.map((s, i) => (
                  <motion.div key={s.id} layout initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 10) * 0.04, ease: EMPHASIZED }}>
                    <DockerRow server={s} metrics={metrics[s.id]} />
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          )}
        </div>

        {isAdmin && managed.length > 0 && (
          <Card className="p-5">
            <CardTitle>Containers started by Outpost</CardTitle>
            <p className="mb-3 text-sm text-ink-400">Labelled <span className="font-mono">outpost.instance</span> on the engine — useful for spotting leftovers after a panel restart.</p>
            <div className="space-y-1 font-mono text-xs text-ink-300">
              {managed.map((c) => (
                <p key={c.name}>
                  {c.name} · {c.image} · {c.status}
                </p>
              ))}
            </div>
          </Card>
        )}
      </div>

      <NewInstanceModal
        only={['app', 'portainer', 'container']}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(s) => {
          toast.success(`Pulling ${s.version}…`);
          navigate(`/instances/${s.id}/console`);
        }}
      />
    </Layout>
  );
}
