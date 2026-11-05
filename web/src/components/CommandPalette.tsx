import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { api, ApiError } from '../api/client.js';
import type { ServerRecord } from '../api/types.js';
import { useAuth } from '../state/AuthContext.js';
import { THEMES, saveColorMode, saveTheme } from '../lib/theme.js';
import { t } from '../i18n/index.js';
import { useToast } from './Toast.js';
import { Icon, type IconName } from './icons.js';
import { GameTile, gameKindOf, gameLabel } from './GameArt.js';
import { StatusDot } from './StatusBadge.js';
import { CONFIGURATION_SECTIONS } from '../pages/ConfigurationPage.js';
import { useConfirm } from './ConfirmDialog.js';
import { discardUnsavedChanges, hasUnsavedChanges } from '../lib/unsaved.js';

const OPEN_EVENT = 'outpost:command-palette';
const RECENT_KEY = 'outpost_palette_recent';
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const PALETTE_SHORTCUT = isMac ? '⌘K' : 'Ctrl K';

/** Open the palette from anywhere (sidebar search button, mobile header…). */
export function openCommandPalette() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

interface Command {
  id: string;
  group: string;
  label: string;
  hint?: string;
  keywords?: string;
  icon?: IconName;
  leading?: ReactNode;
  /** Only listed once the user types — keeps the empty palette short. */
  searchOnly?: boolean;
  run: () => void | Promise<void>;
}

function readRecent(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function pushRecent(id: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...readRecent().filter((r) => r !== id)].slice(0, 5)));
  } catch {
    /* storage unavailable — recents are a nicety */
  }
}

/** Every query word must appear somewhere; label prefix matches rank first. */
function score(command: Command, words: string[]): number {
  const label = command.label.toLocaleLowerCase();
  const haystack = `${label} ${command.hint ?? ''} ${command.keywords ?? ''} ${command.group}`.toLocaleLowerCase();
  if (!words.every((w) => haystack.includes(w))) return -1;
  let s = 0;
  if (label.startsWith(words[0])) s += 4;
  if (words.every((w) => label.includes(w))) s += 2;
  return s;
}

const INSTANCE_PAGES: { path: string; label: string; icon: IconName }[] = [
  { path: 'console', label: 'Console', icon: 'console' },
  { path: 'files', label: 'Files', icon: 'folder' },
  { path: 'backups', label: 'Backups', icon: 'backup' },
  { path: 'configuration', label: 'Configuration', icon: 'configuration' },
  { path: 'tasks', label: 'Tasks & Automation', icon: 'clock' },
  { path: 'update', label: 'Versions & updates', icon: 'update' },
];

/** Ctrl/⌘+K launcher: jump to any page, instance, instance subpage or setting, or run quick actions. */
export function CommandPalette() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [servers, setServers] = useState<ServerRecord[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);

  useEffect(() => {
    if (!open || !user) return;
    setQuery('');
    setActive(0);
    api.get<{ servers: ServerRecord[] }>('/servers').then((r) => setServers(r.servers)).catch(() => {});
  }, [open, user]);

  const commands = useMemo<Command[]>(() => {
    if (!user) return [];
    const admin = user.role === 'admin';
    const go = (to: string) => async () => {
      // Same check the link guard makes, since the palette navigates without a link.
      const leaving = new URL(to, window.location.href).pathname !== window.location.pathname;
      if (leaving && hasUnsavedChanges()) {
        const ok = await confirm({
          title: t('Discard unsaved changes?'),
          message: t('Leaving this page discards them.'),
          confirmLabel: t('Discard and leave'),
          tone: 'danger',
        });
        if (!ok) return;
        discardUnsavedChanges();
      }
      navigate(to);
    };
    const list: Command[] = [];

    const pages: [boolean, string, IconName, string, string?][] = [
      [true, 'Instances', 'instances', '/', 'home dashboard servers'],
      [true, 'File Management', 'folder', '/files', 'files browser'],
      [true, 'Docker', 'container', '/docker', 'containers podman'],
      [admin || !!user.vmAccess?.length, 'Virtual Machines', 'monitor', '/libvirt', 'vm libvirt kvm'],
      [admin || !!user.storagePermissions?.length, 'Storage', 'storage', '/storage', 'disks lvm raid luks'],
      [admin, 'Host Console', 'console', '/host-console', 'terminal shell ssh'],
      [true, 'Configuration', 'configuration', '/configuration', 'settings preferences'],
      [true, 'Operations', 'node', '/configuration/operations', 'fleet hosts allocations steam'],
      [admin, 'Users', 'users', '/users', 'accounts permissions'],
      [admin || (!!user.firewall && user.firewall !== 'none'), 'Firewall', 'shieldCheck', '/firewall', 'ports rules'],
      [admin, 'Audit Log', 'checklist', '/audit', 'history events'],
    ];
    for (const [allowed, label, icon, to, keywords] of pages) {
      if (allowed) list.push({ id: `page:${to}`, group: 'Go to', label, icon, keywords, run: go(to) });
    }

    for (const section of CONFIGURATION_SECTIONS) {
      if (section.adminOnly && !admin) continue;
      list.push({
        id: `settings:${section.id}`,
        group: 'Settings',
        label: section.label,
        hint: 'Configuration',
        icon: section.icon,
        searchOnly: true,
        run: go(`/configuration${section.id === CONFIGURATION_SECTIONS[0].id ? '' : `?section=${section.id}`}`),
      });
    }

    const canAct = (s: ServerRecord) => (admin || user.role === 'moderator' || s.created_by === user.id) && !s.suspended;
    async function act(s: ServerRecord, action: 'start' | 'stop' | 'restart') {
      try {
        await api.post(`/servers/${s.id}/${action}`);
        toast.success(`${action === 'start' ? 'Starting' : action === 'stop' ? 'Stopping' : 'Restarting'} ${s.name}`);
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : `Failed to ${action} ${s.name}`);
      }
    }

    for (const s of servers) {
      const kind = gameKindOf(s);
      const leading = <GameTile kind={kind} className="h-7 w-7 !rounded-lg" />;
      list.push({
        id: `instance:${s.id}`,
        group: 'Instances',
        label: s.name,
        hint: gameLabel(kind),
        keywords: `${s.loader ?? ''} ${s.version ?? ''} ${s.server_port} ${s.status}`,
        leading: <span className="relative">{leading}<span className="absolute -bottom-0.5 -right-0.5"><StatusDot status={s.status} suspended={!!s.suspended} /></span></span>,
        run: go(`/instances/${s.id}`),
      });
      for (const page of INSTANCE_PAGES) {
        list.push({
          id: `instance:${s.id}:${page.path}`,
          group: 'Instance pages',
          label: `${s.name} › ${page.label}`,
          icon: page.icon,
          searchOnly: true,
          run: go(`/instances/${s.id}/${page.path}`),
        });
      }
      if (canAct(s)) {
        const running = s.status === 'running' || s.status === 'starting';
        const actions: ['start' | 'stop' | 'restart', IconName][] =
          running ? [['restart', 'restart'], ['stop', 'stop']] : s.status === 'stopped' || s.status === 'crashed' ? [['start', 'play']] : [];
        for (const [action, icon] of actions) {
          list.push({
            id: `action:${s.id}:${action}`,
            group: 'Actions',
            label: `${action[0].toUpperCase()}${action.slice(1)} ${s.name}`,
            icon,
            keywords: 'power',
            searchOnly: true,
            run: () => act(s, action),
          });
        }
      }
    }

    list.push({ id: 'new-instance', group: 'Actions', label: 'New instance', icon: 'plus', keywords: 'create add server', run: go('/?new=1') });
    for (const theme of THEMES) {
      list.push({ id: `theme:${theme.id}`, group: 'Theme', label: `Theme: ${theme.label}`, icon: 'eye', keywords: 'appearance look', searchOnly: true, run: () => saveTheme(theme.id) });
    }
    for (const mode of ['system', 'dark', 'light'] as const) {
      list.push({
        id: `mode:${mode}`, group: 'Theme', label: `Color mode: ${mode === 'system' ? 'System' : mode === 'dark' ? 'Dark (Nightfall)' : 'Light (Daylight)'}`,
        icon: 'eye', keywords: 'appearance theme night day', searchOnly: true,
        run: () => { saveTheme('outpost'); saveColorMode(mode); },
      });
    }
    list.push({
      id: 'sign-out', group: 'Account', label: 'Sign out', icon: 'logout', searchOnly: true,
      run: () => { logout(); navigate('/login'); },
    });
    return list;
  }, [user, servers, navigate, toast, logout, confirm]);

  const results = useMemo(() => {
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) {
      const byId = new Map(commands.map((c) => [c.id, c]));
      const recent = readRecent().map((id) => byId.get(id)).filter((c): c is Command => !!c).map((c) => ({ ...c, group: 'Recent' }));
      const recentIds = new Set(recent.map((c) => c.id));
      return [...recent, ...commands.filter((c) => !c.searchOnly && !recentIds.has(c.id))];
    }
    return commands
      .map((c) => ({ c, s: score(c, words) }))
      .filter((r) => r.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 40)
      .map((r) => r.c);
    // `open` re-reads recents each time the palette appears.
  }, [commands, query, open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  function run(command: Command | undefined) {
    if (!command) return;
    pushRecent(command.id);
    setOpen(false);
    void command.run();
  }

  if (!user) return null;

  // Keep results in their groups, in first-appearance order.
  const groups: { name: string; items: { command: Command; index: number }[] }[] = [];
  results.forEach((command, index) => {
    let group = groups.find((g) => g.name === command.group);
    if (!group) groups.push((group = { name: command.group, items: [] }));
    group.items.push({ command, index });
  });
  const ordered = groups.flatMap((g) => g.items.map((i) => i.command));

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[60] flex items-start justify-center bg-black/50 p-4 pt-[12vh] backdrop-blur-[2px]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          onMouseDown={() => setOpen(false)}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={t('Command palette')}
            className="ui-modal flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-3xl bg-surface-800 shadow-card"
            initial={{ opacity: 0, scale: 0.97, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: -4 }}
            transition={{ type: 'spring', stiffness: 500, damping: 36 }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 border-b border-surface-700 px-5 py-4">
              <Icon name="search" className="h-5 w-5 shrink-0 text-ink-400" />
              <input
                ref={inputRef}
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setActive((a) => Math.min(ordered.length - 1, a + 1));
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setActive((a) => Math.max(0, a - 1));
                  } else if (e.key === 'Enter') {
                    e.preventDefault();
                    run(ordered[active]);
                  } else if (e.key === 'Escape') {
                    setOpen(false);
                  }
                }}
                placeholder={t('Search pages, instances, settings and actions…')}
                className="min-w-0 flex-1 bg-transparent text-base text-ink-50 placeholder-ink-500 outline-none"
                role="combobox"
                aria-expanded="true"
                aria-controls="command-palette-results"
                aria-activedescendant={ordered[active] ? `command-${active}` : undefined}
              />
              <kbd className="hidden rounded-md border border-surface-600 px-1.5 py-0.5 text-[11px] text-ink-400 sm:block">Esc</kbd>
            </div>

            <div ref={listRef} id="command-palette-results" role="listbox" className="min-h-0 flex-1 overflow-y-auto p-2">
              {ordered.length === 0 ? (
                <p className="px-4 py-10 text-center text-sm text-ink-400">{t('Nothing matches')} “{query}”</p>
              ) : (
                (() => {
                  let index = -1;
                  return groups.map((group) => (
                    <div key={group.name} className="pb-1">
                      <p className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-ink-500">{t(group.name)}</p>
                      {group.items.map(({ command }) => {
                        index += 1;
                        const i = index;
                        const isActive = i === active;
                        return (
                          <button
                            key={command.id}
                            id={`command-${i}`}
                            data-index={i}
                            role="option"
                            aria-selected={isActive}
                            onMouseMove={() => active !== i && setActive(i)}
                            onClick={() => run(command)}
                            className={`flex w-full items-center gap-3 rounded-2xl px-3 py-2 text-left text-sm transition-colors ${
                              isActive ? 'bg-secondary-container text-secondary-on-container' : 'text-ink-200'
                            }`}
                          >
                            <span className="flex h-7 w-7 shrink-0 items-center justify-center">
                              {command.leading ?? (command.icon && <Icon name={command.icon} className="h-[18px] w-[18px] opacity-80" />)}
                            </span>
                            <span className="min-w-0 flex-1 truncate">{t(command.label)}</span>
                            {command.hint && <span className={`shrink-0 truncate text-xs ${isActive ? 'opacity-80' : 'text-ink-500'}`}>{t(command.hint)}</span>}
                            {isActive && <Icon name="back" className="h-3.5 w-3.5 shrink-0 rotate-180 opacity-70" />}
                          </button>
                        );
                      })}
                    </div>
                  ));
                })()
              )}
            </div>

            <div className="flex items-center gap-4 border-t border-surface-700 px-5 py-2.5 text-[11px] text-ink-500">
              <span><kbd className="font-sans">↑↓</kbd> {t('navigate')}</span>
              <span><kbd className="font-sans">↵</kbd> {t('open')}</span>
              <span className="ml-auto">{PALETTE_SHORTCUT} {t('to toggle')}</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Search-field-looking button for the sidebar that opens the palette. */
export function CommandPaletteTrigger({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <button
        type="button"
        onClick={openCommandPalette}
        title={`${t('Search or jump to…')} (${PALETTE_SHORTCUT})`}
        aria-label={t('Search or jump to…')}
        className="state-layer mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full border border-surface-600 text-ink-400"
      >
        <Icon name="search" className="h-4 w-4" />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={openCommandPalette}
      className="ui-search-trigger state-layer mb-3 flex w-full items-center gap-3 rounded-full border border-surface-600 px-4 py-2 text-sm text-ink-400"
    >
      <Icon name="search" className="h-4 w-4 shrink-0" />
      <span className="flex-1 truncate text-left">{t('Search or jump to…')}</span>
      <kbd className="rounded-md bg-surface-800 px-1.5 py-0.5 font-sans text-[11px] text-ink-400">{PALETTE_SHORTCUT}</kbd>
    </button>
  );
}
