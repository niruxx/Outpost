import { useEffect, useState, type ReactNode } from 'react';
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
  return (
    <NavLink to={to} end={end} onClick={onClick} className="group block">
      {({ isActive }) => (
        <span
          className={`ui-nav-item state-layer relative flex h-12 items-center gap-3 rounded-full px-4 text-sm font-medium transition-colors duration-200 ${
            isActive ? 'text-secondary-on-container' : 'text-ink-300'
          }`}
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
          <span className="relative z-10 truncate">{t(label)}</span>
        </span>
      )}
    </NavLink>
  );
}

export function NavSectionLabel({ children }: { children: ReactNode }) {
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
  return (
    <NavLink to={`/instances/${server.id}`} onClick={onClick} className="group block" title={server.name}>
      <span className="ui-nav-item state-layer relative flex h-10 items-center gap-3 rounded-full px-4 text-sm text-ink-300">
        <GameTile kind={gameKindOf(server)} className="h-6 w-6 !rounded-lg" />
        <span className="min-w-0 flex-1 truncate transition-transform duration-200 group-hover:translate-x-0.5">{server.name}</span>
        <StatusDot status={server.status} suspended={!!server.suspended} />
      </span>
    </NavLink>
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
      <NavItem to="/" end icon="instances" label="Instances" onClick={onNavigate} />
      <NavItem to="/configuration" icon="configuration" label="Configuration" onClick={onNavigate} />
      <NavItem to="/files" icon="folder" label="File Management" onClick={onNavigate} />
      <NavItem to="/docker" icon="container" label="Docker" onClick={onNavigate} />
      {user?.role === 'admin' && <NavItem to="/users" icon="users" label="Users" onClick={onNavigate} />}
      {(user?.role === 'admin' || (user?.firewall && user.firewall !== 'none')) && (
        <NavItem to="/firewall" icon="shieldCheck" label="Firewall" onClick={onNavigate} />
      )}
      {user?.role === 'admin' && <NavItem to="/audit" icon="checklist" label="Audit Log" onClick={onNavigate} />}
      {servers && servers.length > 0 && (
        <>
          <NavSectionLabel>Instances</NavSectionLabel>
          {servers.map((s) => (
            <InstanceNavItem key={s.id} server={s} onClick={onNavigate} />
          ))}
        </>
      )}
    </nav>
    </LayoutGroup>
  );
}

function DrawerFooter({ system }: { system: SystemInfo | null }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
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
  const location = useLocation();

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
  const drawer = (
    <div className="flex h-full flex-col px-3 py-4">
      <div className="mb-4 flex items-center gap-3 px-4 py-2">
        <motion.div whileHover={{ rotate: -8, scale: 1.06 }} transition={{ type: 'spring', stiffness: 400, damping: 15 }}>
          <Logo className="h-8 w-8 shrink-0 rounded-lg" />
        </motion.div>
        <span className="text-lg font-medium tracking-tight text-ink-50">Outpost</span>
      </div>
      <motion.div
        className="min-h-0 flex-1 overflow-y-auto"
        initial={animateNav ? { opacity: 0, x: -16 } : false}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.35, ease: [0.2, 0, 0, 1] }}
      >
        {sidebar ? sidebar(close) : <MainNav onNavigate={close} />}
      </motion.div>
      <DrawerFooter system={system} />
    </div>
  );

  return (
    <div className="ui-app relative isolate flex h-screen bg-surface-950">
      <Wallpaper />
      <aside className="ui-sidebar relative z-[1] hidden w-72 shrink-0 bg-surface-900 md:block">{drawer}</aside>

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
          {drawerMounted && <LayoutGroup id="mobile-drawer">{drawer}</LayoutGroup>}
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
          <span className="font-medium text-ink-50">Outpost</span>
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
    <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="ui-page-title text-[28px] font-normal leading-9 text-ink-50">{t(title)}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink-400">{t(subtitle)}</p>}
      </div>
      {action}
    </motion.div>
  );
}
