import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { setVisibleInterval } from '../lib/perf.js';
import { PanelUpdateBanner } from './PanelUpdateBanner.js';
import { t, tc } from '../i18n/index.js';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { LayoutGroup, motion } from 'framer-motion';
import { useAuth } from '../state/AuthContext.js';
import { Badge } from './ui.js';
import { Logo } from './Logo.js';
import { Icon, type IconName } from './icons.js';
import { api } from '../api/client.js';
import type { ServerRecord, SystemInfo } from '../api/types.js';
import { GameTile, gameKindOf } from './GameArt.js';
import { StatusDot } from './StatusBadge.js';
import { Wallpaper } from './Wallpaper.js';
import { CommandPaletteTrigger, openCommandPalette } from './CommandPalette.js';
import { usePinnedInstances } from '../lib/pins.js';
import { useContextMenu } from './ContextMenu.js';
import { instanceMenu } from './instanceMenu.js';
import { useToast } from './Toast.js';
import { NotificationBell } from './NotificationBell.js';

/**
 * Desktop sidebar can shrink to an icon rail. Everything rendered inside the drawer reads this
 * to draw its compact form (icons with tooltips); the phone drawer is always full width.
 */
const RailContext = createContext(false);
export const useRail = () => useContext(RailContext);
const RAIL_KEY = 'outpost_sidebar_rail';

function readRail(): boolean {
  try {
    return localStorage.getItem(RAIL_KEY) === '1';
  } catch {
    return false;
  }
}

/** One MD3 navigation-drawer item: full-width pill, secondary-container indicator when active. */
export function NavItem({
  to,
  icon,
  label,
  end = false,
  onClick,
}: {
  to: string;
  icon: IconName;
  label: string;
  end?: boolean;
  onClick?: () => void;
}) {
  const rail = useRail();
  return (
    <NavLink to={to} end={end} onClick={onClick} className="group block" title={rail ? t(label) : undefined} aria-label={rail ? t(label) : undefined}>
      {({ isActive }) => (
        <span
          className={`ui-nav-item state-layer relative flex h-12 items-center gap-3 rounded-full text-sm font-medium transition-colors duration-200 ${
            rail ? 'justify-center px-0' : 'px-4'
          } ${isActive ? 'text-secondary-on-container' : 'text-ink-300'}`}
        >
          {isActive && (
            // One shared indicator that slides between items (MD3 navigation drawer).
            <motion.span
              layoutId="nav-active-indicator"
              className="absolute inset-0 rounded-full bg-secondary-container"
              transition={{ type: 'spring', stiffness: 520, damping: 40 }}
            />
          )}
          <span className="relative z-10 transition-transform duration-200 group-hover:translate-x-0.5">
            <Icon name={icon} className="h-5 w-5" />
          </span>
          {!rail && <span className="relative z-10 truncate">{t(label)}</span>}
        </span>
      )}
    </NavLink>
  );
}

export function NavSectionLabel({ children }: { children: ReactNode }) {
  // In the rail a group label becomes a short divider.
  if (useRail()) return <div className="mx-auto my-3 h-px w-8 bg-surface-600" role="separator" />;
  return <p className="px-4 pb-1 pt-4 text-xs font-medium text-ink-400">{tc(children)}</p>;
}

/** The instances this user can open (all of them for admins), polled so status dots stay current. */
function useSidebarInstances(): ServerRecord[] | null {
  const [servers, setServers] = useState<ServerRecord[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .get<{ servers: ServerRecord[] }>('/servers')
        .then((res) => !cancelled && setServers(res.servers))
        .catch(() => {});
    load();
    const t = setVisibleInterval(load, 10000);
    return () => {
      cancelled = true;
      t();
    };
  }, []);
  return servers;
}

function InstanceNavItem({ server, onClick }: { server: ServerRecord; onClick?: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const { isPinned, toggle } = usePinnedInstances();
  const contextMenu = useContextMenu(() => instanceMenu({ server, navigate, notify: toast, pinned: isPinned(server.id), togglePin: toggle }));
  if (useRail()) {
    return (
      <NavLink {...contextMenu} to={`/instances/${server.id}`} onClick={onClick} className="block" title={server.name} aria-label={server.name}>
        <span className="ui-nav-item state-layer relative flex h-10 items-center justify-center rounded-full">
          <span className="relative">
            <GameTile kind={gameKindOf(server)} className="h-7 w-7 !rounded-lg" />
            <span className="absolute -bottom-0.5 -right-0.5"><StatusDot status={server.status} suspended={!!server.suspended} /></span>
          </span>
        </span>
      </NavLink>
    );
  }
  return (
    <NavLink {...contextMenu} to={`/instances/${server.id}`} onClick={onClick} className="group block" title={server.name}>
      <span className="ui-nav-item state-layer relative flex h-10 items-center gap-3 rounded-full px-4 text-sm text-ink-300">
        <GameTile kind={gameKindOf(server)} className="h-6 w-6 !rounded-lg" />
        <span className="min-w-0 flex-1 truncate transition-transform duration-200 group-hover:translate-x-0.5">{server.name}</span>
        <StatusDot status={server.status} suspended={!!server.suspended} />
      </span>
    </NavLink>
  );
}

const COLLAPSED_KEY = 'outpost_sidebar_instances_collapsed';
const SIDEBAR_LIMIT = 8;
// Survives the drawer remounting on every page, but not a reload: a long list starts trimmed.
let sidebarShowAll = false;

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

/** A sidebar group label that folds its group away. */
function CollapsibleSectionLabel({ open, onToggle, count, children }: { open: boolean; onToggle: () => void; count: number; children: ReactNode }) {
  if (useRail()) return <div className="mx-auto my-3 h-px w-8 bg-surface-600" role="separator" />;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="group flex w-full items-center gap-1 px-4 pb-1 pt-4 text-left text-xs font-medium text-ink-400 hover:text-ink-200"
    >
      <span className="flex-1">{tc(children)}</span>
      <span className="tabular-nums opacity-70">{count}</span>
      <Icon name="chevronDown" className={`h-3.5 w-3.5 transition-transform duration-200 ${open ? '' : '-rotate-90'}`} />
    </button>
  );
}

/** Pinned instances get their own group; the rest fold away and trim to the first few. */
function SidebarInstances({ servers, onNavigate }: { servers: ServerRecord[]; onNavigate?: () => void }) {
  const { pinned } = usePinnedInstances();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [showAll, setShowAll] = useState(sidebarShowAll);
  const rail = useRail();
  const byId = new Map(servers.map((s) => [s.id, s]));
  const pinnedServers = pinned.map((id) => byId.get(id)).filter((s): s is ServerRecord => !!s);
  const rest = servers.filter((s) => !pinned.includes(s.id));
  const shown = showAll ? rest : rest.slice(0, SIDEBAR_LIMIT);

  function toggleCollapsed() {
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, c ? '0' : '1');
      } catch {
        /* per-browser preference only */
      }
      return !c;
    });
  }

  return (
    <>
      {pinnedServers.length > 0 && (
        <>
          <NavSectionLabel>Pinned</NavSectionLabel>
          {pinnedServers.map((s) => <InstanceNavItem key={s.id} server={s} onClick={onNavigate} />)}
        </>
      )}
      {rest.length > 0 && (
        <>
          <CollapsibleSectionLabel open={!collapsed} onToggle={toggleCollapsed} count={rest.length}>
            {pinnedServers.length ? 'Other instances' : 'Instances'}
          </CollapsibleSectionLabel>
          {(!collapsed || rail) && (
            <>
              {shown.map((s) => <InstanceNavItem key={s.id} server={s} onClick={onNavigate} />)}
              {rest.length > SIDEBAR_LIMIT && (
                <button
                  type="button"
                  onClick={() => {
                    sidebarShowAll = !showAll;
                    setShowAll(!showAll);
                  }}
                  title={rail ? (showAll ? t('Show fewer') : `${t('Show')} ${rest.length - SIDEBAR_LIMIT} ${t('more')}`) : undefined}
                  className={`state-layer flex h-9 w-full items-center gap-3 rounded-full text-xs font-medium text-accent-400 ${rail ? 'justify-center' : 'px-4'}`}
                >
                  <Icon name={showAll ? 'chevronUp' : 'chevronDown'} className="h-4 w-4" />
                  {!rail && (showAll ? t('Show fewer') : `${t('Show')} ${rest.length - SIDEBAR_LIMIT} ${t('more')}`)}
                </button>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}

function MainNav({ onNavigate }: { onNavigate?: () => void }) {
  const { user } = useAuth();
  const servers = useSidebarInstances();
  return (
    // Each menu gets its own layout group: two menus on screen sharing one layoutId made framer-motion
    // treat their highlights as one element and re-animate it on every render.
    <LayoutGroup id="main-nav">
    <nav className="space-y-1">
      <NavSectionLabel>Workspace</NavSectionLabel>
      <NavItem to="/" end icon="instances" label="Instances" onClick={onNavigate} />
      <NavItem to="/files" icon="folder" label="File Management" onClick={onNavigate} />
      <NavItem to="/docker" icon="container" label="Docker" onClick={onNavigate} />
      {(user?.role === 'admin' || !!user?.vmAccess?.length) && <>
        <NavSectionLabel>Virtualization</NavSectionLabel>
        <NavItem to="/libvirt" end icon="monitor" label="Virtual Machines" onClick={onNavigate} />
        {user?.role === 'admin' && <NavItem to="/libvirt/configuration" icon="configuration" label="Libvirt Configuration" onClick={onNavigate} />}
      </>}
      <NavSectionLabel>Administration</NavSectionLabel>
      {(user?.role === 'admin' || !!user?.storagePermissions?.length) && <NavItem to="/storage" icon="storage" label="Storage" onClick={onNavigate} />}
      {user?.role === 'admin' && <NavItem to="/host-console" icon="console" label="Host Console" onClick={onNavigate} />}
      <NavItem to="/configuration" icon="configuration" label="Configuration" onClick={onNavigate} />
      {user?.role === 'admin' && <NavItem to="/users" icon="users" label="Users" onClick={onNavigate} />}
      {(user?.role === 'admin' || (user?.firewall && user.firewall !== 'none')) && (
        <NavItem to="/firewall" icon="shieldCheck" label="Firewall" onClick={onNavigate} />
      )}
      {user?.role === 'admin' && <NavItem to="/activity" icon="eye" label="Activity" onClick={onNavigate} />}
      {user?.role === 'admin' && <NavItem to="/audit" icon="checklist" label="Audit Log" onClick={onNavigate} />}
      {servers && servers.length > 0 && <SidebarInstances servers={servers} onNavigate={onNavigate} />}
    </nav>
    </LayoutGroup>
  );
}

function DrawerFooter({ system }: { system: SystemInfo | null }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  if (useRail()) {
    return (
      <div className="mt-auto flex flex-col items-center gap-2 pt-4">
        <div
          className="flex h-10 w-10 items-center justify-center rounded-full bg-accent-container text-sm font-medium text-accent-on-container"
          title={`${user?.username} (${user?.role})`}
        >
          {user?.username?.slice(0, 1).toUpperCase()}
        </div>
        <button
          onClick={() => {
            logout();
            navigate('/login');
          }}
          title={t('Sign out')}
          aria-label={t('Sign out')}
          className="state-layer rounded-full p-2 text-ink-300"
        >
          <Icon name="logout" />
        </button>
      </div>
    );
  }
  return (
    <div className="mt-auto space-y-3 px-1 pt-4">
      <div className="ui-sidebar-panel flex items-center gap-3 rounded-2xl bg-surface-850 p-3 transition-colors hover:bg-surface-800">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-container text-sm font-medium text-accent-on-container">
          {user?.username?.slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink-100">{user?.username}</p>
          <Badge tone="neutral">{user?.role}</Badge>
        </div>
        <button
          onClick={() => {
            logout();
            navigate('/login');
          }}
          title="Sign out"
          aria-label={t('Sign out')}
          className="state-layer rounded-full p-2 text-ink-300"
        >
          <Icon name="logout" />
        </button>
      </div>
      {system && (
        <p className="truncate px-3 text-[11px] text-ink-500" title={`Node ${system.nodeVersion} on ${system.hostname}`}>
          <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-accent-400 align-middle" />
          {system.hostname} · {system.platformLabel} {system.arch}
          {system.java.available ? ' · Java' : ''}
        </p>
      )}
      {system?.panel && (
        <p
          className="truncate px-3 pt-0.5 text-[11px] text-ink-500"
          title={system.panel.commitDate ? `Commit ${system.panel.commit} from ${new Date(system.panel.commitDate).toLocaleString()}` : undefined}
        >
          Outpost v{system.panel.version}
          {system.panel.commit ? <span className="font-mono"> · {system.panel.commit}</span> : null}
        </p>
      )}
    </div>
  );
}

// The drawer remounts with every page; remember which menu was showing so its entrance
// animation only plays when it actually changes (main menu ↔ an instance's menu).
let lastNavKey: string | null = null;

// Keep drawer positions across page-owned Layout remounts. Desktop and mobile have
// different viewport sizes, and each account/menu needs its own position.
const drawerPositions = new Map<string, number>();

function DrawerScroll({ positionKey, animate, children }: {
  positionKey: string; animate: boolean; children: ReactNode;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = viewport.current!;
    const restore = () => {
      if (element.clientHeight > 0) element.scrollTop = drawerPositions.get(positionKey) ?? 0;
    };
    restore();
    // Instance links arrive asynchronously. Retry when the menu grows, and when
    // a hidden desktop drawer becomes visible after a viewport resize.
    const observer = new ResizeObserver(restore);
    observer.observe(element);
    observer.observe(content.current!);
    return () => observer.disconnect();
  }, [positionKey]);
  return (
    <motion.div
      ref={viewport}
      className="min-h-0 flex-1 overflow-y-auto"
      onScroll={event => {
        const element = event.currentTarget;
        const saved = drawerPositions.get(positionKey) ?? 0;
        const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
        // A partially loaded menu can clamp restoration; keep the full target
        // until its instance links arrive, unless the user scrolls elsewhere.
        if (saved > maximum && element.scrollTop === maximum) return;
        if (element.clientHeight > 0) drawerPositions.set(positionKey, element.scrollTop);
      }}
      initial={animate ? { opacity: 0, x: -16 } : false}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.35, ease: [0.2, 0, 0, 1] }}
    >
      <div ref={content}>{children}</div>
    </motion.div>
  );
}

/**
 * App shell: MD3 navigation drawer + content. Pages can replace the drawer's navigation with
 * their own (`sidebar`) — the instance view does, swapping in Status/Console/Backups/….
 */
export function Layout({
  children,
  sidebar,
  fill = false,
}: {
  children: ReactNode;
  sidebar?: (close: () => void) => ReactNode;
  /** Pin the page to the viewport height (instead of growing with its content) so an inner
   *  panel — the console — can scroll on its own. */
  fill?: boolean;
}) {
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [rail, setRail] = useState(readRail);
  function toggleRail() {
    setRail((r) => {
      try {
        localStorage.setItem(RAIL_KEY, r ? '0' : '1');
      } catch {
        /* per-browser preference only */
      }
      return !r;
    });
  }
  const location = useLocation();
  const { user } = useAuth();

  useEffect(() => {
    api
      .get<SystemInfo>('/system')
      .then(setSystem)
      .catch(() => setSystem(null));
  }, []);

  useEffect(() => setMobileOpen(false), [location.pathname]);
  // The phone drawer's contents are only built once it's first opened (it then stays, to slide shut).
  const [drawerMounted, setDrawerMounted] = useState(false);
  useEffect(() => {
    if (mobileOpen) setDrawerMounted(true);
  }, [mobileOpen]);

  const close = () => setMobileOpen(false);
  // /instances/<id>/status → /instances/<id>: subpage changes are animated by the instance view itself.
  const pageKey = location.pathname.split('/').slice(0, 3).join('/') || '/';
  const navKey = sidebar ? pageKey : 'main';
  const [animateNav] = useState(() => {
    const changed = lastNavKey !== null && lastNavKey !== navKey;
    lastNavKey = navKey;
    return changed;
  });
  const drawer = (device: 'desktop' | 'mobile') => {
    const compact = device === 'desktop' && rail;
    return (
      <RailContext.Provider value={compact}>
        <div className={`flex h-full flex-col py-4 ${compact ? 'px-2' : 'px-3'}`}>
          <div className={`mb-4 flex items-center gap-3 py-2 ${compact ? 'flex-col px-0' : 'px-4'}`}>
            <motion.div whileHover={{ rotate: -8, scale: 1.06 }} transition={{ type: 'spring', stiffness: 400, damping: 15 }}>
              <Logo className="h-8 w-8 shrink-0 rounded-lg" />
            </motion.div>
            {!compact && (
              <div className="min-w-0 flex-1">
                <span className="text-xl font-semibold tracking-tight text-ink-50">Outpost</span>
                <p className="truncate text-[11px] text-ink-400">{t('Your server workspace')}</p>
              </div>
            )}
            <div className={`flex items-center gap-0.5 ${compact ? 'flex-col' : ''}`}>
              {device === 'desktop' && <NotificationBell compact={compact} />}
              {device === 'desktop' && (
                <button
                  type="button"
                  onClick={toggleRail}
                  title={t(compact ? 'Expand sidebar' : 'Collapse sidebar')}
                  aria-label={t(compact ? 'Expand sidebar' : 'Collapse sidebar')}
                  aria-expanded={!compact}
                  className="state-layer rounded-full p-2 text-ink-400"
                >
                  <Icon name="chevronRight" className={`h-4 w-4 transition-transform duration-200 ${compact ? '' : 'rotate-180'}`} />
                </button>
              )}
            </div>
          </div>
          <div className="px-1">
            <CommandPaletteTrigger compact={compact} />
          </div>
          <DrawerScroll positionKey={`${user?.id}:${navKey}:${device}`} animate={animateNav}>
            {sidebar ? sidebar(close) : <MainNav onNavigate={close} />}
          </DrawerScroll>
          <DrawerFooter system={system} />
        </div>
      </RailContext.Provider>
    );
  };

  return (
    <div className="ui-app relative isolate flex h-screen bg-surface-950">
      <Wallpaper />
      <aside
        className={`ui-sidebar relative z-[1] hidden shrink-0 bg-surface-900 transition-[width] duration-300 ease-out md:block ${rail ? 'w-20' : 'w-72'}`}
        data-rail={rail ? 'true' : undefined}
      >
        {/* Separate highlight namespaces, so the indicator doesn't fly across when the rail toggles. */}
        <LayoutGroup id={rail ? 'rail' : 'drawer'}>{drawer('desktop')}</LayoutGroup>
      </aside>

      {/* Phone drawer. It stays mounted and slides with CSS: when closed it ignores every touch, so
          its backdrop can never be left covering the page (an interrupted exit animation used to
          leave an invisible layer that swallowed taps and scrolling until a reload). */}
      <div className={`fixed inset-0 z-40 md:hidden ${mobileOpen ? '' : 'pointer-events-none'}`} aria-hidden={!mobileOpen}>
        <div
          className={`absolute inset-0 bg-black/60 transition-opacity duration-200 ${mobileOpen ? 'opacity-100' : 'opacity-0'}`}
          onClick={close}
        />
        <aside
          className={`ui-sidebar absolute inset-y-0 left-0 w-72 max-w-[85vw] rounded-r-3xl bg-surface-900 transition-transform duration-300 ease-out ${
            mobileOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          {/* Own namespace for the sliding "active item" highlight, separate from the desktop sidebar's. */}
          {drawerMounted && <LayoutGroup id="mobile-drawer">{drawer('mobile')}</LayoutGroup>}
        </aside>
      </div>

      <div className="relative z-[1] flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 bg-surface-900 px-4 py-3 md:hidden">
          <button onClick={() => setMobileOpen(true)} aria-label="Open navigation" className="state-layer rounded-full p-2 text-ink-200">
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M3 6h18M3 12h18M3 18h18" />
            </svg>
          </button>
          <Logo className="h-6 w-6 rounded-md" />
          <span className="flex-1 font-medium text-ink-50">Outpost</span>
          <NotificationBell compact />
          <button onClick={openCommandPalette} aria-label={t('Search')} className="state-layer rounded-full p-2 text-ink-200">
            <Icon name="search" className="h-5 w-5" />
          </button>
        </div>
        <PanelUpdateBanner />
        <main className="ui-main min-h-0 flex-1 overflow-y-auto">
          <motion.div
            key={pageKey}
            className={fill ? 'h-full' : 'min-h-full'}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: [0.2, 0, 0, 1] }}
          >
            {children}
          </motion.div>
        </main>
      </div>
    </div>
  );
}

/** Standard page header for top-level pages. */
export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} className="ui-page-header mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="ui-page-title text-4xl font-semibold leading-tight tracking-tight text-ink-50">{t(title)}</h1>
        {subtitle && <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-400">{t(subtitle)}</p>}
      </div>
      {action}
    </motion.div>
  );
}
