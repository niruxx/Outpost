import { useEffect, useState } from 'react';
import { Cs2Tab } from './server/Cs2Tab.js';
import { Tf2Tab } from './server/Tf2Tab.js';
import { GamerulesTab } from './server/GamerulesTab.js';
import { GameSettingsTab } from './server/GameSettingsTab.js';
import { setVisibleInterval } from '../lib/perf.js';
import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { motion, LayoutGroup } from 'framer-motion';
import { Layout, NavItem, NavSectionLabel, useRail } from '../components/Layout.js';
import { t } from '../i18n/index.js';
import { StatusBadge, StatusDot, SuspendedBadge } from '../components/StatusBadge.js';
import { Button, Card } from '../components/ui.js';
import { Logo } from '../components/Logo.js';
import { gameLabel, GameTile, gameKindOf } from '../components/GameArt.js';
import { GameBanner } from '../components/GameBanner.js';
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
import { ActivityTab } from './server/ActivityTab.js';
import { TasksTab } from './server/TasksTab.js';
import { WorkshopTab } from './server/WorkshopTab.js';
import { WineTab } from './server/WineTab.js';
import { RewindTab } from './server/RewindTab.js';
import { useEndpoint } from '../hooks/useEndpoint.js';
import { usePublicAddress } from '../hooks/usePublicAddress.js';
import { usePinnedInstances } from '../lib/pins.js';
import { api, ApiError } from '../api/client.js';
import { isMinecraftPlatform, isProxyLoader, type ServerRecord } from '../api/types.js';
import { ProxyTab } from './server/ProxyTab.js';
import { GmodTab, isGmodServer } from './server/GmodTab.js';
import { SteamPlayersTab, hasBrowserStats } from './server/BrowserStats.js';

function InstanceNav({ server, onNavigate }: { server: ServerRecord; onNavigate: () => void }) {
  const isCs2 = server.platform === 'steam' && (server.steam_preset === 'cs2' || (!server.steam_preset && server.steam_app_id === '730'));
  const steam = !isMinecraftPlatform(server.platform);
  // Proxies have no world: no players file, ops, whitelist, map or rewind.
  const proxy = isProxyLoader(server.loader);
  const world = !steam && !proxy;
  const kind = gameKindOf(server);
  const addons = server.platform === 'java' || server.platform === 'bedrock' || server.platform === 'steam';
  // Only label the game group when something lands in it.
  const game = world || proxy || addons || isCs2 || isGmodServer(server) || hasBrowserStats(server);
  const rail = useRail();
  const { isAdmin, isOwner } = useServerDetail();
  return (
    <LayoutGroup id="instance-nav">
    <nav className="space-y-1">
      <NavLink
        to="/"
        onClick={onNavigate}
        title={rail ? t('All instances') : undefined}
        aria-label={rail ? t('All instances') : undefined}
        className={`state-layer flex h-10 items-center gap-3 rounded-full text-sm font-medium text-ink-300 ${rail ? 'justify-center' : 'px-4'}`}
      >
        <Icon name="back" className="h-[18px] w-[18px]" />
        {!rail && t('All instances')}
      </NavLink>

      {rail ? (
        <div className="my-3 flex justify-center" title={`${server.name} · ${gameLabel(kind)}`}>
          <span className="relative">
            <GameTile kind={kind} className="h-10 w-10" running={server.status === 'running'} />
            <span className="absolute -bottom-0.5 -right-0.5"><StatusDot status={server.status} suspended={!!server.suspended} /></span>
          </span>
        </div>
      ) : (
      <div className="ui-sidebar-panel my-3 flex items-center gap-3 rounded-2xl bg-surface-850 p-3">
        <GameTile kind={kind} className="h-10 w-10" running={server.status === 'running'} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink-50">{server.name}</p>
          <p className="truncate text-xs text-ink-400">{gameLabel(kind)}</p>
        </div>
        <StatusDot status={server.status} suspended={!!server.suspended} />
      </div>
      )}

      <NavSectionLabel>Overview</NavSectionLabel>
      <NavItem to="status" icon="status" label="Status" onClick={onNavigate} />
      <NavItem to="console" icon="console" label="Console" onClick={onNavigate} />
      <NavItem to="files" icon="folder" label="File Management" onClick={onNavigate} />

      {game && <NavSectionLabel>{gameLabel(kind)}</NavSectionLabel>}
      {(world || hasBrowserStats(server)) && <NavItem to="players" icon="player" label="Players" onClick={onNavigate} />}
      {world && <NavItem to="operator" icon="shield" label="Operators" onClick={onNavigate} />}
      {world && <NavItem to="whitelist" icon="checklist" label="Whitelist" onClick={onNavigate} />}
      {addons && <NavItem to="plugins" icon="plugin" label={addonNavLabel(server)} onClick={onNavigate} />}
      {server.platform === 'steam' && <NavItem to="workshop" icon="box" label="Workshop" onClick={onNavigate} />}
      {proxy && <NavItem to="network" icon="node" label="Network" onClick={onNavigate} />}
      {isCs2 && <NavItem to="cs2" icon="bolt" label="CS2" onClick={onNavigate} />}
      {server.platform === 'steam' && !['cs2', 'tf2', 'gmod'].includes(server.steam_preset ?? '') && !( !server.steam_preset && ['730', '232250', '4020'].includes(server.steam_app_id ?? '')) && <NavItem to="game-settings" icon="configuration" label="Game settings" onClick={onNavigate} />}
      {server.platform === 'steam' && (server.steam_preset === 'tf2' || (!server.steam_preset && server.steam_app_id === '232250')) && <NavItem to="tf2" icon="bolt" label="TF2" onClick={onNavigate} />}
      {world && <NavItem to="gamerules" icon="configuration" label="Gamerules" onClick={onNavigate} />}
      {isGmodServer(server) && <NavItem to="gmod" icon="bolt" label="Garry's Mod" onClick={onNavigate} />}
      {world && <NavItem to="maps" icon="map" label="Map" onClick={onNavigate} />}

      <NavSectionLabel>Data</NavSectionLabel>
      <NavItem to="backups" icon="backup" label="Backups" onClick={onNavigate} />
      {(isAdmin || isOwner) && <NavItem to="activity" icon="eye" label="Activity" onClick={onNavigate} />}
      {world && <NavItem to="rewind" icon="refresh" label="World Rewind" onClick={onNavigate} />}

      <NavSectionLabel>Settings</NavSectionLabel>
      <NavItem to="configuration" icon="configuration" label="Configuration" onClick={onNavigate} />
      <NavItem to="tasks" icon="clock" label="Tasks & Automation" onClick={onNavigate} />
      <NavItem to="update" icon="update" label="Versions & updates" onClick={onNavigate} />
      {(server.platform === 'steam' || server.platform === 'custom') && <NavItem to="wine" icon="wine" label="Wine" onClick={onNavigate} />}
      <NavItem to="upnp" icon="router" label="UPnP" onClick={onNavigate} />
    </nav>
    </LayoutGroup>
  );
}

function CopyChip({ icon, label, value, copyValue, hint }: { icon: 'globe' | 'port'; label: string; value: string; copyValue?: string; hint?: string }) {
  const toast = useToast();
  return (
    <button
      disabled={!copyValue && (value === '…' || value === 'Unavailable')}
      onClick={() => {
        navigator.clipboard
          ?.writeText(copyValue ?? value)
          .then(() => toast.success(`Copied ${copyValue ?? value}`))
          .catch(() => toast.error('Clipboard unavailable'));
      }}
      title={hint ?? `Copy ${label.toLowerCase()}`}
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
  const pending = !!autoRestart?.pendingAt;
  useEffect(() => {
    if (!pending) return;
    const t = setVisibleInterval(() => setNow(Date.now()), 1000);
    return () => t();
  }, [pending]);
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

function HeaderPin({ serverId }: { serverId: string }) {
  const { isPinned, toggle } = usePinnedInstances();
  const pinned = isPinned(serverId);
  return (
    <button
      type="button"
      onClick={() => toggle(serverId)}
      aria-pressed={pinned}
      title={pinned ? 'Unpin from sidebar' : 'Pin to sidebar'}
      aria-label={pinned ? 'Unpin from sidebar' : 'Pin to sidebar'}
      className={`state-layer rounded-full p-1.5 ${pinned ? 'text-accent-400' : 'text-ink-500'}`}
    >
      <Icon name="pin" className={`h-4 w-4 ${pinned ? 'fill-current' : ''}`} />
    </button>
  );
}

function InstanceTopBar({ server, compact }: { server: ServerRecord; compact: boolean }) {
  const kind = gameKindOf(server);
  const endpoint = useEndpoint(server.id, server.server_port);
  const publicAddress = usePublicAddress();
  const live = server.status === 'running' || server.status === 'starting';
  const publicIp = publicAddress?.address ?? null;
  return (
    <motion.header
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      className="ui-card ui-instance-header relative overflow-hidden rounded-3xl bg-surface-850"
    >
      {/* Per-game banner; content sits on the card below it, so it reads in light mode too.
          The console keeps it short to leave room for the log. */}
      <motion.div
        className={`relative ${compact ? 'h-16 sm:h-20' : 'h-28 sm:h-36'}`}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5 }}
      >
        <GameBanner kind={kind} seed={server.id} />
      </motion.div>
      {/* Only the tile overlaps the banner; the name and lifecycle buttons stay below it however
          they wrap, so they never sit on top of the art. */}
      <div className="relative flex flex-wrap items-start gap-x-4 gap-y-3 px-5 pt-3 sm:px-6">
        <GameTile kind={kind} className={`${compact ? '-mt-10 h-14 w-14' : '-mt-12 h-16 w-16'} shrink-0 shadow-card ring-4 ring-surface-850`} running={server.status === 'running'} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-2xl font-normal text-ink-50">{server.name}</h1>
            {server.suspended ? <SuspendedBadge /> : <StatusBadge status={server.status} />}
            <HeaderPin serverId={server.id} />
          </div>
          <p className="mt-0.5 text-sm text-ink-400">
            {gameLabel(kind)}
            {isMinecraftPlatform(server.platform) && ` · ${server.loader} ${server.version}`}
            {server.platform === 'docker' && <span className="font-mono"> · 🐳 {server.version}</span>}
          </p>
        </div>
        <div>
          <LifecycleActions />
        </div>
      </div>
      <div className="relative mt-4 flex flex-wrap items-center gap-2 px-5 pb-5 sm:px-6">
        <CopyChip
          icon="globe"
          label="Local IP"
          value={endpoint?.host ?? '…'}
          copyValue={endpoint ? `${endpoint.host}:${endpoint.port}` : undefined}
          hint="Copy the LAN address — for players on the same network"
        />
        <CopyChip
          icon="globe"
          label="Public IP"
          value={publicAddress === undefined ? '…' : publicIp ?? 'Unavailable'}
          copyValue={publicIp && endpoint ? `${publicIp}:${endpoint.port}` : publicIp ?? undefined}
          hint={
            !publicIp
              ? "Couldn't determine this network's public address"
              : publicAddress?.behindNat
                ? 'Copy the public address — your router is behind another NAT/CGNAT, so outside players may not reach it'
                : 'Copy the public address — for players outside your network (needs the port forwarded)'
          }
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
  const proxy = isProxyLoader(server.loader);
  const world = !steam && !proxy;
  const onConsole = location.pathname.endsWith('/console');

  return (
    <Layout fill={onConsole} sidebar={(close) => <InstanceNav server={server} onNavigate={close} />}>
      <div className={`mx-auto flex max-w-6xl flex-col gap-5 px-4 py-6 sm:px-8 ${onConsole ? 'h-full' : ''}`}>
        <InstanceTopBar server={server} compact={onConsole} />
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
            <Route path="workshop" element={<WorkshopTab />} />
            <Route path="cs2" element={<Cs2Tab />} />
            <Route path="tf2" element={<Tf2Tab />} />
            <Route path="game-settings" element={<GameSettingsTab />} />
            {world && <Route path="gamerules" element={<GamerulesTab />} />}
            <Route path="wine" element={<WineTab />} />
            <Route path="configuration" element={<SettingsTab />} />
            <Route path="files" element={<FilesTab />} />
            <Route path="plugins" element={<PluginsTab />} />
            {world && <Route path="players" element={<PlayersTab />} />}
            {hasBrowserStats(server) && <Route path="players" element={<SteamPlayersTab />} />}
            {world && <Route path="operator" element={<OperatorTab />} />}
            {world && <Route path="whitelist" element={<WhitelistTab />} />}
            {world && <Route path="maps" element={<MapsTab />} />}
            {world && <Route path="rewind" element={<RewindTab />} />}
            {proxy && <Route path="network" element={<ProxyTab />} />}
            {isGmodServer(server) && <Route path="gmod" element={<GmodTab />} />}
            <Route path="update" element={<UpdateTab />} />
            <Route path="upnp" element={<UpnpTab />} />
            <Route path="activity" element={<ActivityTab />} />
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
