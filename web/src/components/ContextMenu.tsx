import { AnimatePresence, motion } from 'framer-motion';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import { t } from '../i18n/index.js';
import { Icon, type IconName } from './icons.js';

/**
 * Right-click menus. One menu is mounted for the whole app (by `ContextMenuProvider`); any element
 * opts in by spreading `useContextMenu(buildItems)` onto itself. The menu opens on right-click,
 * touch long-press and the keyboard context-menu key (or Shift+F10). Shift+right-click, text
 * fields and right-clicks on selected text still get the browser's own menu.
 */

export interface MenuAction {
  label: string;
  icon?: IconName;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** Right-aligned hint, e.g. a keyboard shortcut. */
  hint?: string;
}
export type MenuEntry = MenuAction | 'separator' | { heading: string };
/** Falsy entries are dropped, so items can be written as `cond && { … }`. */
export type MenuItems = (MenuEntry | false | null | undefined)[];

interface OpenMenu {
  x: number;
  y: number;
  items: MenuEntry[];
  /** Element focused before opening; focus goes back there when the menu closes. */
  returnFocus: HTMLElement | null;
}

interface ContextMenuApi {
  open: (at: { x: number; y: number }, items: MenuItems) => void;
  close: () => void;
}

const ContextMenuContext = createContext<ContextMenuApi | null>(null);

const isAction = (e: MenuEntry): e is MenuAction => typeof e === 'object' && 'onSelect' in e;

/** Drops falsy entries plus leading, trailing and doubled separators. */
function normalize(items: MenuItems): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const item of items) {
    if (!item) continue;
    if (item === 'separator' && (out.length === 0 || out[out.length - 1] === 'separator')) continue;
    out.push(item);
  }
  while (out[out.length - 1] === 'separator') out.pop();
  return out;
}

export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const location = useLocation();

  const close = useCallback(() => setMenu(null), []);
  const open = useCallback((at: { x: number; y: number }, items: MenuItems) => {
    const entries = normalize(items);
    if (!entries.some(isAction)) return;
    setMenu({ x: at.x, y: at.y, items: entries, returnFocus: document.activeElement as HTMLElement | null });
  }, []);

  // Navigating away closes any open menu.
  useEffect(close, [location.pathname, close]);

  const api = useMemo(() => ({ open, close }), [open, close]);
  return (
    <ContextMenuContext.Provider value={api}>
      {children}
      {createPortal(
        <AnimatePresence>{menu && <MenuSurface key={`${menu.x},${menu.y}`} menu={menu} onClose={close} />}</AnimatePresence>,
        document.body,
      )}
    </ContextMenuContext.Provider>
  );
}

export function useContextMenuApi(): ContextMenuApi {
  const ctx = useContext(ContextMenuContext);
  if (!ctx) throw new Error('useContextMenuApi must be used within ContextMenuProvider');
  return ctx;
}

const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 10;

/**
 * Props that make an element open a context menu. `build` runs at open time, so the items always
 * reflect current state. Spread the result onto the element:
 *   <div {...useContextMenu(() => [{ label: 'Rename', onSelect: rename }])}>
 */
export function useContextMenu(build: () => MenuItems) {
  const { open } = useContextMenuApi();
  const buildRef = useRef(build);
  buildRef.current = build;
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const suppressClick = useRef(false);

  const cancelPress = useCallback(() => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  }, []);
  useEffect(() => cancelPress, [cancelPress]);

  return useMemo(
    () => ({
      onContextMenu(e: ReactMouseEvent<HTMLElement>) {
        // Keyboard-invoked menus (Menu key, Shift+F10) report (0, 0); Shift only means "native menu" for the mouse.
        const fromKeyboard = e.clientX === 0 && e.clientY === 0;
        if ((e.shiftKey && !fromKeyboard) || wantsNativeMenu(e)) return;
        e.preventDefault();
        e.stopPropagation();
        cancelPress();
        if (fromKeyboard) {
          const rect = (e.target as HTMLElement).getBoundingClientRect();
          open({ x: rect.left + 8, y: rect.bottom }, buildRef.current());
        } else {
          open({ x: e.clientX, y: e.clientY }, buildRef.current());
        }
      },
      // iOS Safari never fires `contextmenu`, so touch gets its own long-press. (Where the browser
      // does fire it, both paths open the same menu at the same spot.)
      onPointerDown(e: ReactPointerEvent<HTMLElement>) {
        if (e.pointerType !== 'touch' || wantsNativeMenu(e)) return;
        cancelPress();
        const { clientX: x, clientY: y } = e;
        const timer = window.setTimeout(() => {
          press.current = null;
          suppressClick.current = true;
          navigator.vibrate?.(10);
          open({ x, y }, buildRef.current());
        }, LONG_PRESS_MS);
        press.current = { timer, x, y };
      },
      onPointerMove(e: ReactPointerEvent<HTMLElement>) {
        const p = press.current;
        if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > LONG_PRESS_SLOP) cancelPress();
      },
      onPointerUp: cancelPress,
      onPointerCancel: cancelPress,
      // The tap that ends a long-press must not also follow the link / open the row underneath.
      onClickCapture(e: ReactMouseEvent<HTMLElement>) {
        if (!suppressClick.current) return;
        suppressClick.current = false;
        e.preventDefault();
        e.stopPropagation();
      },
    }),
    [open, cancelPress],
  );
}

/** Text fields and selected text keep the browser menu, so copy/paste/spellcheck still work. */
function wantsNativeMenu(e: { target: EventTarget; currentTarget: HTMLElement }): boolean {
  const target = e.target as HTMLElement;
  if (target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return true;
  const selection = window.getSelection();
  return !!selection && !selection.isCollapsed && selection.toString().trim() !== '' && !!selection.anchorNode && e.currentTarget.contains(selection.anchorNode);
}

/** "⋯" button that opens the same menu below itself — for touch users and discoverability. */
export function MoreButton({ items, label = 'More actions', className = '' }: { items: () => MenuItems; label?: string; className?: string }) {
  const { open } = useContextMenuApi();
  return (
    <button
      type="button"
      aria-haspopup="menu"
      aria-label={t(label)}
      title={t(label)}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const rect = e.currentTarget.getBoundingClientRect();
        open({ x: rect.right, y: rect.bottom + 4 }, items());
      }}
      className={`state-layer relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-400 ${className}`}
    >
      <Icon name="more" className="h-4 w-4" />
    </button>
  );
}

const EDGE = 8;

function MenuSurface({ menu, onClose }: { menu: OpenMenu; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; origin: string } | null>(null);
  const buttons = () => Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? []);

  // Flip/clamp so the menu always fits in the viewport, then focus the first item.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const flipX = menu.x + width > vw - EDGE;
    const flipY = menu.y + height > vh - EDGE;
    const left = Math.max(EDGE, Math.min(flipX ? menu.x - width : menu.x, vw - width - EDGE));
    const top = Math.max(EDGE, Math.min(flipY ? menu.y - height : menu.y, vh - height - EDGE));
    setPos({ left, top, origin: `${flipY ? 'bottom' : 'top'} ${flipX ? 'right' : 'left'}` });
    buttons()[0]?.focus({ preventScroll: true });
  }, [menu]);

  // Dismiss on outside press, scroll, resize, window blur or another right-click elsewhere.
  useEffect(() => {
    const outside = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const dismiss = () => onClose();
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('contextmenu', outside, true);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('contextmenu', outside, true);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
    };
  }, [onClose]);

  // Hand focus back to whatever had it, unless the user has since moved focus elsewhere.
  useEffect(() => {
    const { returnFocus } = menu;
    return () => {
      if (!document.activeElement || document.activeElement === document.body || ref.current?.contains(document.activeElement)) {
        returnFocus?.focus?.({ preventScroll: true });
      }
    };
  }, [menu]);

  function onKeyDown(e: ReactKeyboardEvent) {
    const list = buttons();
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    const move = (i: number) => list[(i + list.length) % list.length]?.focus();
    switch (e.key) {
      case 'Escape':
      case 'Tab':
        // Don't let Esc also reach page-level handlers (e.g. leaving instance selection mode).
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      case 'ArrowDown':
        e.preventDefault();
        move(index + 1);
        return;
      case 'ArrowUp':
        e.preventDefault();
        move(index < 0 ? -1 : index - 1);
        return;
      case 'Home':
        e.preventDefault();
        move(0);
        return;
      case 'End':
        e.preventDefault();
        move(-1);
        return;
    }
    // Typeahead: jump to the next item starting with the typed letter.
    if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const key = e.key.toLocaleLowerCase();
      for (let step = 1; step <= list.length; step++) {
        const candidate = list[(index + step) % list.length];
        if (candidate.textContent?.trim().toLocaleLowerCase().startsWith(key)) {
          candidate.focus();
          break;
        }
      }
    }
  }

  return (
    <motion.div
      ref={ref}
      role="menu"
      aria-orientation="vertical"
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.08 } }}
      transition={{ duration: 0.12, ease: [0.2, 0, 0, 1] }}
      style={{
        position: 'fixed',
        left: pos?.left ?? menu.x,
        top: pos?.top ?? menu.y,
        transformOrigin: pos?.origin ?? 'top left',
        visibility: pos ? 'visible' : 'hidden',
      }}
      className="ui-context-menu z-[90] min-w-[12rem] max-w-[min(20rem,calc(100vw-1rem))] select-none overflow-y-auto rounded-2xl bg-surface-800 py-1.5 shadow-card ring-1 ring-surface-600 [max-height:calc(100dvh-1rem)]"
    >
      {menu.items.map((item, i) => {
        if (item === 'separator') return <div key={i} role="separator" className="my-1.5 h-px bg-surface-600" />;
        if (!isAction(item))
          return (
            <div key={i} className="truncate px-4 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wider text-ink-500">
              {item.heading}
            </div>
          );
        return (
          <button
            key={i}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
            className={`ui-context-menu-item state-layer flex w-full items-center gap-3 px-4 py-2 text-left text-sm outline-none focus-visible:bg-surface-700 disabled:cursor-not-allowed disabled:opacity-[0.38] ${
              item.danger ? 'text-red-400' : 'text-ink-100'
            }`}
          >
            {item.icon ? <Icon name={item.icon} className={`h-4 w-4 ${item.danger ? '' : 'text-ink-400'}`} /> : <span className="w-4" />}
            <span className="min-w-0 flex-1 truncate">{t(item.label)}</span>
            {item.hint && <span className="text-xs text-ink-500">{item.hint}</span>}
          </button>
        );
      })}
    </motion.div>
  );
}

/** Clipboard write that also works on plain-HTTP LAN panels, where `navigator.clipboard` is absent. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}
