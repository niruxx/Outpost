import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { setVisibleInterval } from '../lib/perf.js';
import { PanelUpdateBanner } from './PanelUpdateBanner.js';
import { t, tc } from '../i18n/index.js';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, LayoutGroup, motion } from 'framer-motion';
import { useAuth } from '../state/AuthContext.js';
import { Logo } from './Logo.js';
import { Icon, type IconName } from './icons.js';
import { api } from '../api/client.js';
import type { ServerRecord, SystemInfo } from '../api/types.js';
import { GameTile, gameKindOf } from './GameArt.js';
import { StatusDot } from './StatusBadge.js';
import { Wallpaper } from './Wallpaper.js';
import { PALETTE_SHORTCUT, openCommandPalette } from './CommandPalette.js';
import { usePinnedInstances } from '../lib/pins.js';
import { useContextMenu } from './ContextMenu.js';
import { instanceMenu } from './instanceMenu.js';
import { useToast } from './Toast.js';
import { NotificationBell } from './NotificationBell.js';
import { AdminModeButton } from './AdminModeButton.js';
import { saveColorMode, storedColorMode, storedTheme, type ColorMode } from '../lib/theme.js';

/**
 * The app shell, laid out like a productivity suite:
 *
 *   ┌───────────────────────────── top bar ─────────────────────────────┐
 *   │ ☰  Outpost        [ Search instances, pages and settings ]  🔔 ⋮⋮⋮ (A) │
 *   ├──────────┬────────────────────────────────────────────────────────┤
 *   │ + New    │                                                        │
 *   │ nav      │                 page (on a rounded sheet)              │
 *   └──────────┴────────────────────────────────────────────────────────┘
 *
 * The menu button folds the sidebar to an icon rail on desktop and opens it as a drawer on phones.
 * Pages can replace the sidebar's navigation with their own (`sidebar`) — the instance view does,
 * swapping in Status/Console/Backups/….
 */

/** Everything rendered inside a collapsed (icon-only) sidebar reads this to draw its compact form. */
const RailContext = createContext(false);
export const useRail = () => useContext(RailContext);
const RAIL_KEY = 'outpost_sidebar_rail';

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? '1' : '0');
  } catch {
    /* per-browser preference only */
  }
}

// ---------------------------------------------------------------------------
// Destinations: one list feeds the sidebar and the apps launcher
// ---------------------------------------------------------------------------

type Group = 'workspace' | 'manage' | 'system';
type Tone = 'blue' | 'green' | 'yellow' | 'red' | 'teal' | 'violet';

interface Destination {
  to: string;
  label: string;
  icon: IconName;
  group: Group;
  /** Launcher tile colour. */
  tone: Tone;
  end?: boolean;
}

const GROUP_LABEL: Record<Group, string | null> = { workspace: null, manage: 'Manage', system: 'System' };

/** The pages this account can open, in sidebar order. */
function useDestinations(): Destination[] {
  const { user } = useAuth();
  const admin = user?.role === 'admin';
  const vms = admin || !!user?.vmAccess?.length;
  const storage = admin || !!user?.storagePermissions?.length;
  const firewall = admin || (!!user?.firewall && user.firewall !== 'none');
  const list: (Destination | false)[] = [
    { to: '/', end: true, label: 'Instances', icon: 'instances', group: 'workspace', tone: 'blue' },
    { to: '/files', label: 'File Management', icon: 'folder', group: 'workspace', tone: 'yellow' },
    { to: '/docker', label: 'Docker', icon: 'container', group: 'workspace', tone: 'teal' },
    vms && { to: '/libvirt', end: true, label: 'Virtual Machines', icon: 'monitor', group: 'workspace', tone: 'violet' },
    admin && { to: '/users', label: 'Users', icon: 'users', group: 'manage', tone: 'blue' },
    admin && { to: '/activity', label: 'Activity', icon: 'eye', group: 'manage', tone: 'green' },
    admin && { to: '/audit', label: 'Audit Log', icon: 'checklist', group: 'manage', tone: 'yellow' },
    firewall && { to: '/firewall', label: 'Firewall', icon: 'shieldCheck', group: 'manage', tone: 'red' },
    storage && { to: '/storage', label: 'Storage', icon: 'storage', group: 'system', tone: 'teal' },
    admin && { to: '/host-files', label: 'Host Files', icon: 'folder', group: 'system', tone: 'yellow' },
    admin && { to: '/host-console', label: 'Host Console', icon: 'console', group: 'system', tone: 'violet' },
    admin && { to: '/libvirt/configuration', label: 'Libvirt Configuration', icon: 'monitor', group: 'system', tone: 'violet' },
    { to: '/configuration', label: 'Configuration', icon: 'configuration', group: 'system', tone: 'blue' },
  ];
  return list.filter((d): d is Destination => !!d);
}

const TONE: Record<Tone, string> = {
  blue: 'bg-accent-container text-accent-on-container',
  green: 'bg-success-500/15 text-success-400',
  yellow: 'bg-yellow-500/15 text-yellow-400',
  red: 'bg-red-500/15 text-red-400',
  teal: 'bg-tertiary-container text-tertiary-on-container',
  violet: 'bg-secondary-container text-secondary-on-container',
};

// ---------------------------------------------------------------------------
// Navigation items
// ---------------------------------------------------------------------------

/** One sidebar entry: a full-width pill, filled when it's the current page. */
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
          className={`ui-nav-item state-layer relative flex h-10 items-center gap-4 rounded-full text-sm transition-colors duration-150 ${
            rail ? 'mx-auto w-14 justify-center px-0' : 'px-4'
          } ${isActive ? 'font-semibold text-secondary-on-container' : 'font-medium text-ink-300'}`}
        >
          {isActive && (
            // One shared indicator that slides between items.
            <motion.span
              layoutId="nav-active-indicator"
              className="absolute inset-0 rounded-full bg-secondary-container"
              transition={{ type: 'spring', stiffness: 520, damping: 40 }}
            />
          )}
          <Icon name={icon} className="relative z-10 h-5 w-5" />
          {!rail && <span className="relative z-10 truncate">{t(label)}</span>}
        </span>
      )}
    </NavLink>
  );
}

export function NavSectionLabel({ children }: { children: ReactNode }) {
  // In the rail a group label becomes a short divider.
  if (useRail()) return <div className="mx-auto my-2 h-px w-8 bg-surface-700" role="separator" />;
  return <p className="ui-nav-label px-4 pb-1 pt-4 text-xs font-medium text-ink-400">{tc(children)}</p>;
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
    const stop = setVisibleInterval(load, 10000);
    return () => {
      cancelled = true;
      stop();
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
        <span className="ui-nav-item state-layer relative mx-auto flex h-10 w-14 items-center justify-center rounded-full">
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
      {({ isActive }) => (
        <span
          className={`ui-nav-item state-layer relative flex h-9 items-center gap-3 rounded-full px-4 text-sm ${
            isActive ? 'bg-secondary-container font-semibold text-secondary-on-container' : 'text-ink-300'
          }`}
        >
          <GameTile kind={gameKindOf(server)} className="h-6 w-6 !rounded-md" />
          <span className="min-w-0 flex-1 truncate">{server.name}</span>
          <StatusDot status={server.status} suspended={!!server.suspended} />
        </span>
      )}
    </NavLink>
  );
}

const COLLAPSED_KEY = 'outpost_sidebar_instances_collapsed';
const SIDEBAR_LIMIT = 6;
// Survives the drawer remounting on every page, but not a reload: a long list starts trimmed.
let sidebarShowAll = false;

/** A sidebar group label that folds its group away. */
function CollapsibleSectionLabel({ open, onToggle, count, children }: { open: boolean; onToggle: () => void; count: number; children: ReactNode }) {
  if (useRail()) return <div className="mx-auto my-2 h-px w-8 bg-surface-700" role="separator" />;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="ui-nav-label group flex w-full items-center gap-1 rounded-full px-4 pb-1 pt-4 text-left text-xs font-medium text-ink-400 hover:text-ink-200"
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
  const [collapsed, setCollapsed] = useState(() => readFlag(COLLAPSED_KEY));
  const [showAll, setShowAll] = useState(sidebarShowAll);
  const rail = useRail();
  const byId = new Map(servers.map((s) => [s.id, s]));
  const pinnedServers = pinned.map((id) => byId.get(id)).filter((s): s is ServerRecord => !!s);
  const rest = servers.filter((s) => !pinned.includes(s.id));
  const shown = showAll ? rest : rest.slice(0, SIDEBAR_LIMIT);

  function toggleCollapsed() {
    setCollapsed((c) => {
      writeFlag(COLLAPSED_KEY, !c);
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

/** The big "New" button at the top of the sidebar — creating an instance is the main action. */
function NewButton({ onNavigate }: { onNavigate?: () => void }) {
  const rail = useRail();
  const navigate = useNavigate();
  const { creation } = useAuth();
  if (!creation?.canCreate) return null;
  return (
    <button
      type="button"
      onClick={() => {
        onNavigate?.();
        navigate('/?new=1');
      }}
      title={rail ? t('New instance') : undefined}
      aria-label={t('New instance')}
      className={`ui-new-btn ui-sidebar-panel state-layer mb-3 flex h-14 items-center gap-3 rounded-2xl bg-surface-850 text-sm font-medium text-ink-100 shadow-flat transition-shadow hover:shadow-card ${
        rail ? 'mx-auto w-14 justify-center' : 'ml-1 w-fit pl-4 pr-6'
      }`}
    >
      <Icon name="plus" className="ui-new-icon h-6 w-6 text-accent-400" />
      {!rail && t('New instance')}
    </button>
  );
}

function MainNav({ onNavigate }: { onNavigate?: () => void }) {
  const destinations = useDestinations();
  const servers = useSidebarInstances();
  const groups: Group[] = ['workspace', 'manage', 'system'];
  return (
    // Each menu gets its own layout group: two menus on screen sharing one layoutId made framer-motion
    // treat their highlights as one element and re-animate it on every render.
    <LayoutGroup id="main-nav">
      <nav className="space-y-0.5" aria-label={t('Main')}>
        {groups.map((group) => {
          const items = destinations.filter((d) => d.group === group);
          if (!items.length) return null;
          return (
            <div key={group} className="space-y-0.5">
              {GROUP_LABEL[group] && <NavSectionLabel>{GROUP_LABEL[group]}</NavSectionLabel>}
              {items.map((d) => <NavItem key={d.to} to={d.to} end={d.end} icon={d.icon} label={d.label} onClick={onNavigate} />)}
            </div>
          );
        })}
        {servers && servers.length > 0 && <SidebarInstances servers={servers} onNavigate={onNavigate} />}
      </nav>
    </LayoutGroup>
  );
}

// ---------------------------------------------------------------------------
// Top bar popovers: apps launcher and account
// ---------------------------------------------------------------------------

/** A panel anchored under a top-bar button; closes on Escape, outside clicks and navigation. */
function Popover({ anchor, onClose, label, width, children }: { anchor: HTMLElement | null; onClose: () => void; label: string; width: number; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 64, left: 8 });
  useLayoutEffect(() => {
    const place = () => {
      const r = anchor?.getBoundingClientRect();
      const w = Math.min(width, window.innerWidth - 16);
      if (!r) return setPos({ top: 64, left: 8 });
      // Right-aligned to the button, kept on screen.
      setPos({ top: r.bottom + 8, left: Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchor, width]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const onDown = (e: MouseEvent) => {
      if (!panel.current?.contains(e.target as Node) && !anchor?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [anchor, onClose]);
  return createPortal(
    <motion.div
      ref={panel}
      role="dialog"
      aria-label={t(label)}
      className="ui-modal ui-popover fixed z-[55] max-h-[calc(100dvh-80px)] overflow-y-auto rounded-3xl bg-surface-800 p-2 shadow-card ring-1 ring-surface-700"
      style={{ top: pos.top, left: pos.left, width: Math.min(width, window.innerWidth - 16) }}
      initial={{ opacity: 0, y: -6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -4, scale: 0.98 }}
      transition={{ duration: 0.16, ease: [0.2, 0, 0, 1] }}
    >
      {children}
    </motion.div>,
    document.body,
  );
}

function TopBarButton({ label, onClick, active, children, buttonRef }: { label: string; onClick: () => void; active?: boolean; children: ReactNode; buttonRef?: React.Ref<HTMLButtonElement> }) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      title={t(label)}
      aria-label={t(label)}
      aria-expanded={active}
      className={`state-layer flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${active ? 'bg-surface-800 text-ink-50' : 'text-ink-300'}`}
    >
      {children}
    </button>
  );
}

/** "⋮⋮⋮" — every page as a coloured tile, the way suite launchers list their apps. */
function AppsLauncher() {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const destinations = useDestinations();
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);
  return (
    <>
      <TopBarButton label="Outpost apps" onClick={() => setOpen((o) => !o)} active={open} buttonRef={button}>
        <Icon name="apps" className="h-5 w-5" />
      </TopBarButton>
      <AnimatePresence>
        {open && (
          <Popover anchor={button.current} onClose={() => setOpen(false)} label="Outpost apps" width={340}>
            <div className="ui-launcher grid grid-cols-3 gap-1 rounded-2xl bg-surface-850 p-2">
              {destinations.map((d) => (
                <Link key={d.to} to={d.to} className="state-layer flex flex-col items-center gap-2 rounded-2xl px-1 py-3 text-center">
                  <span className={`flex h-11 w-11 items-center justify-center rounded-full ${TONE[d.tone]}`}>
                    <Icon name={d.icon} className="h-5 w-5" />
                  </span>
                  <span className="line-clamp-2 text-xs leading-tight text-ink-200">{t(d.label)}</span>
                </Link>
              ))}
            </div>
          </Popover>
        )}
      </AnimatePresence>
    </>
  );
}

const MODES: { mode: ColorMode; label: string; icon: IconName }[] = [
  { mode: 'light', label: 'Light', icon: 'sun' },
  { mode: 'dark', label: 'Dark', icon: 'moon' },
  { mode: 'system', label: 'System', icon: 'monitor' },
];

function Avatar({ name, className }: { name: string; className: string }) {
  return (
    <span className={`flex shrink-0 items-center justify-center rounded-full bg-accent-400 font-medium uppercase text-accent-on ${className}`} aria-hidden="true">
      {name.slice(0, 1)}
    </span>
  );
}

/** The signed-in account: who you are, light/dark, settings, sign out — and which host this is. */
function AccountMenu({ system }: { system: SystemInfo | null }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<ColorMode>(storedColorMode);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => setOpen(false), [location.pathname, location.search]);
  if (!user) return null;
  // Light/dark only applies to the Outpost themes; the retro themes have a fixed look.
  const modes = storedTheme() === 'outpost';
  return (
    <>
      <button
        ref={button}
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={`${user.username} (${user.role})`}
        aria-label={t('Account')}
        aria-expanded={open}
        className="state-layer ml-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
      >
        <Avatar name={user.username} className="h-8 w-8 text-sm" />
      </button>
      <AnimatePresence>
        {open && (
          <Popover anchor={button.current} onClose={() => setOpen(false)} label="Account" width={340}>
            <div className="rounded-2xl bg-surface-850 p-5 text-center">
              <Avatar name={user.username} className="mx-auto h-16 w-16 text-2xl" />
              <p className="mt-3 text-lg text-ink-50">{t('Hi')}, {user.username}!</p>
              <p className="text-xs capitalize text-ink-400">{user.role}</p>
              <Link
                to="/configuration?section=account"
                className="state-layer mt-4 inline-flex items-center rounded-full border border-surface-500 px-5 py-2 text-sm font-medium text-accent-400"
              >
                {t('Manage your account')}
              </Link>
            </div>
            {modes && (
              <div className="mt-2 flex gap-1 rounded-2xl bg-surface-850 p-1.5" role="radiogroup" aria-label={t('Appearance')}>
                {MODES.map((m) => (
                  <button
                    key={m.mode}
                    type="button"
                    role="radio"
                    aria-checked={mode === m.mode}
                    onClick={() => {
                      saveColorMode(m.mode);
                      setMode(m.mode);
                    }}
                    className={`state-layer flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2 text-xs font-medium ${
                      mode === m.mode ? 'bg-secondary-container text-secondary-on-container' : 'text-ink-300'
                    }`}
                  >
                    <Icon name={m.icon} className="h-4 w-4" />
                    {t(m.label)}
                  </button>
                ))}
              </div>
            )}
            <div className="mt-2 overflow-hidden rounded-2xl bg-surface-850">
              <Link to="/configuration" className="state-layer flex items-center gap-3 px-5 py-3 text-sm text-ink-200">
                <Icon name="configuration" className="h-5 w-5 text-ink-400" />
                {t('Settings')}
              </Link>
              <button
                type="button"
                onClick={() => {
                  logout();
                  navigate('/login');
                }}
                className="state-layer flex w-full items-center gap-3 px-5 py-3 text-left text-sm text-ink-200"
              >
                <Icon name="logout" className="h-5 w-5 text-ink-400" />
                {t('Sign out')}
              </button>
            </div>
            {system && (
              <p className="px-4 pb-1 pt-3 text-center text-[11px] text-ink-500" title={`Node ${system.nodeVersion} on ${system.hostname}`}>
                {system.hostname} · {system.platformLabel} {system.arch}
                {system.panel && (
                  <>
                    <br />
                    Outpost v{system.panel.version}
                    {system.panel.commit ? <span className="font-mono"> · {system.panel.commit}</span> : null}
                  </>
                )}
              </p>
            )}
          </Popover>
        )}
      </AnimatePresence>
    </>
  );
}

/** The wide search field in the middle of the top bar; it opens the command palette. */
function SearchField() {
  return (
    <button
      type="button"
      onClick={openCommandPalette}
      className="ui-search-trigger state-layer hidden h-12 min-w-0 max-w-[720px] flex-1 items-center gap-4 rounded-full bg-surface-800 px-5 text-left text-ink-400 md:flex"
    >
      <Icon name="search" className="h-5 w-5 shrink-0 text-ink-300" />
      <span className="flex-1 truncate text-[15px]">{t('Search instances, pages and settings')}</span>
      <kbd className="rounded-md border border-surface-600 px-1.5 py-0.5 font-sans text-[11px] text-ink-400">{PALETTE_SHORTCUT}</kbd>
    </button>
  );
}

function TopBar({ onMenu, menuLabel, system }: { onMenu: () => void; menuLabel: string; system: SystemInfo | null }) {
  return (
    <header className="ui-topbar relative z-[2] flex h-16 shrink-0 items-center gap-2 bg-surface-950 px-2 sm:px-3">
      <TopBarButton label={menuLabel} onClick={onMenu}>
        <Icon name="menu" className="h-5 w-5" />
      </TopBarButton>
      {/* Brand column lines up with the sidebar, so the search starts where the page does. */}
      <Link to="/" className="flex min-w-0 shrink-0 items-center gap-2.5 rounded-full pr-3 md:w-[13.5rem]">
        <Logo className="h-8 w-8 shrink-0 rounded-lg" />
        <span className="ui-brand truncate text-[22px] leading-none text-ink-200">Outpost</span>
      </Link>
      <SearchField />
      <div className="ml-auto flex items-center gap-0.5">
        <AdminModeButton />
        <span className="md:hidden">
          <TopBarButton label="Search" onClick={openCommandPalette}>
            <Icon name="search" className="h-5 w-5" />
          </TopBarButton>
        </span>
        <NotificationBell compact />
        <AppsLauncher />
        <AccountMenu system={system} />
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

// The sidebar remounts with every page; remember which menu was showing so its entrance
// animation only plays when it actually changes (main menu ↔ an instance's menu).
let lastNavKey: string | null = null;

// Keep sidebar scroll positions across page-owned Layout remounts. Desktop and mobile have
// different viewport sizes, and each account/menu needs its own position.
const drawerPositions = new Map<string, number>();

function DrawerScroll({ positionKey, animate, children }: { positionKey: string; animate: boolean; children: ReactNode }) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = viewport.current!;
    const restore = () => {
      if (element.clientHeight > 0) element.scrollTop = drawerPositions.get(positionKey) ?? 0;
    };
    restore();
    // Instance links arrive asynchronously. Retry when the menu grows, and when
    // a hidden desktop sidebar becomes visible after a viewport resize.
    const observer = new ResizeObserver(restore);
    observer.observe(element);
    observer.observe(content.current!);
    return () => observer.disconnect();
  }, [positionKey]);
  return (
    <motion.div
      ref={viewport}
      className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
      onScroll={(event) => {
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
      transition={{ duration: 0.3, ease: [0.2, 0, 0, 1] }}
    >
      <div ref={content} className="pb-4">{children}</div>
    </motion.div>
  );
}

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
  const [rail, setRail] = useState(() => readFlag(RAIL_KEY));
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
  function toggleMenu() {
    if (window.matchMedia('(min-width: 768px)').matches) {
      setRail((r) => {
        writeFlag(RAIL_KEY, !r);
        return !r;
      });
    } else setMobileOpen((o) => !o);
  }

  // /instances/<id>/status → /instances/<id>: subpage changes are animated by the instance view itself.
  const pageKey = location.pathname.split('/').slice(0, 3).join('/') || '/';
  const navKey = sidebar ? pageKey : 'main';
  const [animateNav] = useState(() => {
    const changed = lastNavKey !== null && lastNavKey !== navKey;
    lastNavKey = navKey;
    return changed;
  });

  const nav = (device: 'desktop' | 'mobile') => {
    const compact = device === 'desktop' && rail;
    return (
      <RailContext.Provider value={compact}>
        <div className={`flex h-full flex-col pt-2 ${compact ? 'px-2' : 'pl-2 pr-3'}`}>
          {!sidebar && <NewButton onNavigate={close} />}
          <DrawerScroll positionKey={`${user?.id}:${navKey}:${device}`} animate={animateNav}>
            {sidebar ? sidebar(close) : <MainNav onNavigate={close} />}
          </DrawerScroll>
        </div>
      </RailContext.Provider>
    );
  };

  return (
    <div className="ui-app relative isolate flex h-screen flex-col bg-surface-950">
      <Wallpaper />
      <TopBar onMenu={toggleMenu} menuLabel={rail ? 'Expand menu' : 'Main menu'} system={system} />

      <div className="relative z-[1] flex min-h-0 flex-1">
        <aside
          className={`ui-sidebar hidden shrink-0 bg-surface-950 transition-[width] duration-300 ease-out md:block ${rail ? 'w-[4.5rem]' : 'w-64'}`}
          data-rail={rail ? 'true' : undefined}
        >
          {/* Separate highlight namespaces, so the indicator doesn't fly across when the rail toggles. */}
          <LayoutGroup id={rail ? 'rail' : 'drawer'}>{nav('desktop')}</LayoutGroup>
        </aside>

        {/* Phone drawer. It stays mounted and slides with CSS: when closed it ignores every touch, so
            its backdrop can never be left covering the page (an interrupted exit animation used to
            leave an invisible layer that swallowed taps and scrolling until a reload). */}
        {/* It opens below the top bar, which stays in place so the menu button can close it again. */}
        <div className={`fixed inset-x-0 bottom-0 top-16 z-40 md:hidden ${mobileOpen ? '' : 'pointer-events-none'}`} aria-hidden={!mobileOpen}>
          <div className={`absolute inset-0 bg-black/50 transition-opacity duration-200 ${mobileOpen ? 'opacity-100' : 'opacity-0'}`} onClick={close} />
          <aside
            className={`ui-sidebar absolute inset-y-0 left-0 w-72 max-w-[85vw] rounded-r-2xl bg-surface-950 shadow-card transition-transform duration-300 ease-out ${
              mobileOpen ? 'translate-x-0' : '-translate-x-full'
            }`}
          >
            {/* Own namespace for the sliding "active item" highlight, separate from the desktop sidebar's. */}
            {drawerMounted && <LayoutGroup id="mobile-drawer">{nav('mobile')}</LayoutGroup>}
          </aside>
        </div>

        <div className="ui-sheet relative flex min-w-0 flex-1 flex-col">
          <PanelUpdateBanner />
          <main className="ui-main min-h-0 flex-1 overflow-y-auto">
            <motion.div
              key={pageKey}
              className={fill ? 'h-full' : 'min-h-full'}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, ease: [0.2, 0, 0, 1] }}
            >
              {children}
            </motion.div>
          </main>
        </div>
      </div>
    </div>
  );
}

/** Standard page header for top-level pages: a plain title, a short description, the page's main action. */
export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="ui-page-header mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="ui-page-title text-[28px] font-normal leading-9 text-ink-50">{t(title)}</h1>
        {subtitle && <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ink-400">{t(subtitle)}</p>}
      </div>
      {action}
    </motion.div>
  );
}
