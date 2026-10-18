import { useEffect, useState } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Layout, NavItem, NavSectionLabel } from '../components/Layout.js';
import { StatusBadge, SuspendedBadge } from '../components/StatusBadge.js';
import { Button, Card } from '../components/ui.js';
import { Logo } from '../components/Logo.js';
import { gameLabel, GameTile, GameWatermark, gameKindOf } from '../components/GameArt.js';
import { Icon } from '../components/icons.js';
import { useToast } from '../components/Toast.js';
import { ServerDetailProvider, useServerDetail } from './server/ServerContext.js';
import { StatusTab } from './server/StatusTab.js';
import { ConsoleTab } from './server/ConsoleTab.js';
import { PlayersTab } from './server/PlayersTab.js';
import { OperatorTab } from './server/OperatorTab.js';
import { WhitelistTab } from './server/WhitelistTab.js';
import { PluginsTab, addonNavLabel } from './server/PluginsTab.js';
import { MapsTab } from './server/MapsTab.js';
import { SettingsTab } from './server/SettingsTab.js';
import { FilesTab } from './server/FilesTab.js';
import { BackupsTab } from './server/BackupsTab.js';
import { UpdateTab } from './server/UpdateTab.js';
import { UpnpTab } from './server/UpnpTab.js';
import { TasksTab } from './server/TasksTab.js';
import { useEndpoint } from '../hooks/useEndpoint.js';
import { api, ApiError } from '../api/client.js';
import { isMinecraftPlatform, type ServerRecord } from '../api/types.js';

function InstanceNav({ server, onNavigate }: { server: ServerRecord; onNavigate: () => void }) {
  const steam = !isMinecraftPlatform(server.platform);
  const kind = gameKindOf(server);
  return (
    <nav className="space-y-1">
      <NavLink to="/" onClick={onNavigate} className="state-layer flex h-12 items-center gap-3 rounded-full px-4 text-sm font-medium text-ink-300">
        <Icon name="back" />
        Return to Menu
      </NavLink>

      <div className="ui-sidebar-panel my-3 flex items-center gap-3 rounded-2xl bg-surface-850 p-3">
        <GameTile kind={kind} className="h-10 w-10" running={server.status === 'running'} />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink-50">{server.name}</p>
          <p className="truncate text-xs text-ink-400">{gameLabel(kind)}</p>
        </div>
      </div>

      <NavItem to="status" icon="status" label="Status" onClick={onNavigate} />
      <NavItem to="console" icon="console" label="Console" onClick={onNavigate} />
      <NavItem to="backups" icon="backup" label="Backup Schedule" onClick={onNavigate} />
      <NavItem to="tasks" icon="clock" label="Scheduled Tasks" onClick={onNavigate} />
      <NavItem to="configuration" icon="configuration" label="Configuration" onClick={onNavigate} />
      <NavItem to="files" icon="folder" label="File Management" onClick={onNavigate} />
      <NavItem to="upnp" icon="router" label="UPnP" onClick={onNavigate} />

      <NavSectionLabel>Manage</NavSectionLabel>
      {(server.platform === 'java' || server.platform === 'bedrock' || server.platform === 'steam') && (
        <NavItem to="plugins" icon="plugin" label={addonNavLabel(server)} onClick={onNavigate} />
      )}
      {!steam && <NavItem to="players" icon="player" label="Players" onClick={onNavigate} />}
      {!steam && <NavItem to="operator" icon="shield" label="Operators" onClick={onNavigate} />}
      {!steam && <NavItem to="whitelist" icon="checklist" label="Whitelist" onClick={onNavigate} />}
      {!steam && <NavItem to="maps" icon="map" label="Map" onClick={onNavigate} />}
      <NavItem to="update" icon="update" label="Update" onClick={onNavigate} />
    </nav>
  );
}

function CopyChip({ icon, label, value, copyValue }: { icon: 'globe' | 'port'; label: string; value: string; copyValue?: string }) {
  const toast = useToast();
  return (
    <button
      onClick={() => {
        navigator.clipboard
          ?.writeText(copyValue ?? value)
          .then(() => toast.success(`Copied ${copyValue ?? value}`))
          .catch(() => toast.error('Clipboard unavailable'));
      }}
      title={`Copy ${label.toLowerCase()}`}
      className="state-layer flex items-center gap-2 rounded-lg border border-surface-600 px-3 py-1.5 text-left transition-transform active:scale-[0.97]"
    >
      <Icon name={icon} className="h-4 w-4 text-accent-400" />
      <span className="text-[11px] font-medium uppercase tracking-wide text-ink-400">{label}</span>
      <span className="font-mono text-sm text-ink-100">{value}</span>
      <Icon name="copy" className="h-3.5 w-3.5 text-ink-500" />
    </button>
  );
}

/** "Restarting in 7s" with a cancel button while an auto-restart is scheduled. */
function AutoRestartCountdown({ onCancel, canCancel }: { onCancel: () => void; canCancel: boolean }) {
  const { autoRestart } = useServerDetail();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  if (!autoRestart?.pendingAt) return null;
  const secs = Math.max(0, Math.ceil((Date.parse(autoRestart.pendingAt) - now) / 1000));
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      className="flex items-center gap-2 rounded-full bg-tertiary-container py-1 pl-3 pr-1 text-sm text-tertiary-on-container"
    >
      <Icon name="restart" className="h-4 w-4 animate-spin [animation-duration:2.5s]" />
      Auto-restart {secs > 0 ? `in ${secs}s` : 'now'}
      {autoRestart.attempts > 1 && <span className="text-xs opacity-80">· attempt {autoRestart.attempts}</span>}
      {canCancel && (
        <button onClick={onCancel} className="state-layer rounded-full px-2.5 py-1 text-xs font-medium">
          Cancel
        </button>
      )}
    </motion.div>
  );
}

function LifecycleActions() {
  const { server, serverId, can, refresh, autoRestart } = useServerDetail();
  const canWrite = can('power');
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!server || !canWrite || server.suspended) return null;

  async function act(action: 'start' | 'stop' | 'restart' | 'retry-install' | 'kill') {
    setBusy(true);
    try {
      if (action === 'kill') await api.post(`/servers/${serverId}/stop`, { force: true });
      else await api.post(`/servers/${serverId}/${action}`);
      await refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : `Failed to ${action}`);
    } finally {
      setBusy(false);
    }
  }

  const s = server.status;
  const runningLike = s === 'running' || s === 'starting';
  if (autoRestart?.pendingAt && !runningLike) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <AutoRestartCountdown canCancel={canWrite} onCancel={() => act('stop')} />
        {canWrite && (
          <Button variant="primary" disabled={busy} onClick={() => act('start')}>
            <Icon name="play" className="h-4 w-4" /> Start now
          </Button>
        )}
      </div>
    );
  }
  if (s === 'install_failed') {
    return (
      <Button variant="primary" disabled={busy} onClick={() => act('retry-install')}>
        <Icon name="restart" className="h-4 w-4" /> Retry install
      </Button>
    );
  }
  if (s === 'stopped' || s === 'crashed') {
    return (
      <Button variant="primary" disabled={busy} onClick={() => act('start')}>
        <Icon name="play" className="h-4 w-4" /> Start
      </Button>
    );
  }
  return (
    <div className="flex flex-wrap gap-2">
      <Button disabled={busy || !runningLike} onClick={() => act('restart')}>
        <Icon name="restart" className="h-4 w-4" /> Restart
      </Button>
      <Button variant="danger" disabled={busy || !runningLike} onClick={() => act('stop')}>
        <Icon name="stop" className="h-4 w-4" /> Stop
      </Button>
      {(runningLike || s === 'stopping') && (
        <Button variant="ghost" disabled={busy} onClick={() => act('kill')} title="Kill the process immediately without saving">
          <Icon name="bolt" className="h-4 w-4" /> Force kill
        </Button>
      )}
    </div>
  );
}

function OwnerChip() {
  const { owner, isOwner } = useServerDetail();
  if (!owner) return null;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-lg bg-surface-900 px-2.5 py-1 text-xs text-ink-300" title="Instance owner">
      <Icon name="player" className="h-3.5 w-3.5" />
      {isOwner ? 'You own this' : `Owner: ${owner.username}`}
    </span>
  );
}

function InstanceTopBar({ server }: { server: ServerRecord }) {
  const kind = gameKindOf(server);
  const endpoint = useEndpoint(server.id, server.server_port);
  const live = server.status === 'running' || server.status === 'starting';
  return (
    <motion.header
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      className="ui-card relative overflow-hidden rounded-3xl bg-surface-850 px-5 py-5 sm:px-6"
    >
      <motion.div
        className="pointer-events-none absolute -right-6 -top-10"
        initial={{ opacity: 0, rotate: 0, scale: 0.9 }}
        animate={{ opacity: 0.09, rotate: [12, 16, 12], y: [0, -6, 0], scale: 1 }}
        transition={{ opacity: { duration: 0.6 }, scale: { duration: 0.6 }, rotate: { duration: 9, repeat: Infinity, ease: 'easeInOut' }, y: { duration: 9, repeat: Infinity, ease: 'easeInOut' } }}
      >
        <GameWatermark kind={kind} className="h-56 w-56" />
      </motion.div>
      <div className="relative flex flex-wrap items-start gap-4">
        <GameTile kind={kind} className="h-14 w-14" running={server.status === 'running'} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-2xl font-normal text-ink-50">{server.name}</h1>
            {server.suspended ? <SuspendedBadge /> : <StatusBadge status={server.status} />}
          </div>
          <p className="mt-0.5 text-sm text-ink-400">
            {gameLabel(kind)}
            {isMinecraftPlatform(server.platform) && ` · ${server.loader} ${server.version}`}
            {server.platform === 'docker' && <span className="font-mono"> · 🐳 {server.version}</span>}
          </p>
        </div>
        <LifecycleActions />
      </div>
      <div className="relative mt-4 flex flex-wrap items-center gap-2">
        <CopyChip
          icon="globe"
          label={live ? 'Endpoint' : 'IP'}
          value={endpoint?.host ?? '…'}
          copyValue={endpoint ? `${endpoint.host}:${endpoint.port}` : undefined}
        />
        <CopyChip icon="port" label="Port" value={`${server.server_port}/${(endpoint?.protocol ?? 'tcp').toUpperCase()}`} copyValue={String(server.server_port)} />
        {endpoint?.webUrl && (
          <motion.a
            href={endpoint.webUrl}
            target="_blank"
            rel="noreferrer"
            whileTap={{ scale: 0.97 }}
            className={`state-layer inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-medium ${
              live ? 'bg-accent-400 text-accent-on' : 'bg-secondary-container text-secondary-on-container'
            }`}
            title={live ? endpoint.webUrl : 'Start the instance to use its web interface'}
          >
            <Icon name="globe" className="h-4 w-4" /> Open web UI
          </motion.a>
        )}
        <OwnerChip />
        {endpoint && endpoint.bindAddress !== '0.0.0.0' && (
          <span className="text-xs text-ink-500">bound to {endpoint.bindAddress}</span>
        )}
      </div>
    </motion.header>
  );
}

function SuspendedLock({ message }: { message: string }) {
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <Card className="max-w-md p-8 text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-error-container text-error-on-container">
          <Icon name="lock" className="h-7 w-7" />
        </div>
        <h1 className="mb-2 text-xl font-normal text-ink-50">Instance suspended</h1>
        <p className="mb-6 text-sm text-ink-300">{message}</p>
        <NavLink to="/">
          <Button>Return to Menu</Button>
        </NavLink>
      </Card>
    </div>
  );
}

function InstancePageInner() {
  const { server, suspendedMessage, loadError, isAdmin } = useServerDetail();
  const location = useLocation();

  if (suspendedMessage) {
    return (
      <Layout>
        <SuspendedLock message={suspendedMessage} />
      </Layout>
    );
  }

  if (!server) {
    return (
      <Layout>
        <div className="flex h-full flex-col items-center justify-center gap-4">
          {loadError ? (
            <>
              <p className="text-sm text-ink-300">{loadError}</p>
              <NavLink to="/">
                <Button>Return to Menu</Button>
              </NavLink>
            </>
          ) : (
            <motion.div animate={{ opacity: [1, 0.5, 1] }} transition={{ duration: 1.3, repeat: Infinity, ease: 'easeInOut' }}>
              <Logo className="h-8 w-8 rounded-lg" />
            </motion.div>
          )}
        </div>
      </Layout>
    );
  }

  const steam = !isMinecraftPlatform(server.platform);
  const onConsole = location.pathname.endsWith('/console');

  return (
    <Layout fill={onConsole} sidebar={(close) => <InstanceNav server={server} onNavigate={close} />}>
      <div className={`mx-auto flex max-w-6xl flex-col gap-5 px-4 py-6 sm:px-8 ${onConsole ? 'h-full' : ''}`}>
        <InstanceTopBar server={server} />
        {server.suspended === 1 && isAdmin && (
          <div className="flex items-center gap-3 rounded-2xl bg-error-container px-4 py-3 text-sm text-error-on-container">
            <Icon name="lock" className="h-5 w-5" />
            <span className="flex-1">
              Suspended{server.suspended_reason ? `: ${server.suspended_reason}` : ''} — only admins can see or manage this instance.
              Lift it from Configuration.
            </span>
          </div>
        )}
        <motion.div
          key={location.pathname}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
          className={onConsole ? 'min-h-0 flex-1' : ''}
        >
          <Routes>
            <Route index element={<Navigate to="status" replace />} />
            <Route path="status" element={<StatusTab />} />
            <Route path="console" element={<ConsoleTab />} />
            <Route path="backups" element={<BackupsTab />} />
            <Route path="tasks" element={<TasksTab />} />
            <Route path="configuration" element={<SettingsTab />} />
            <Route path="files" element={<FilesTab />} />
            <Route path="plugins" element={<PluginsTab />} />
            {!steam && <Route path="players" element={<PlayersTab />} />}
            {!steam && <Route path="operator" element={<OperatorTab />} />}
            {!steam && <Route path="whitelist" element={<WhitelistTab />} />}
            {!steam && <Route path="maps" element={<MapsTab />} />}
            <Route path="update" element={<UpdateTab />} />
            <Route path="upnp" element={<UpnpTab />} />
            {/* Old tab names, so existing bookmarks keep working. */}
            <Route path="settings" element={<Navigate to="../configuration" replace />} />
            <Route path="resources" element={<Navigate to="../status" replace />} />
            <Route path="*" element={<Navigate to="status" replace />} />
          </Routes>
        </motion.div>
      </div>
    </Layout>
  );
}

export function InstancePage() {
  return (
    <ServerDetailProvider>
      <InstancePageInner />
    </ServerDetailProvider>
  );
}
