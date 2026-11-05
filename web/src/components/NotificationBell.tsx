import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '../api/client.js';
import { setVisibleInterval } from '../lib/perf.js';
import { t } from '../i18n/index.js';
import { Icon } from './icons.js';
import { Spinner } from './ui.js';
import { EventItem, type EventPage, type PanelEvent } from './EventList.js';

const UNREAD_EVENT = 'outpost:events-unread';

/** Unread (important) event count, polled while the tab is visible and shared between bells. */
function useUnread(): [number, (n: number) => void] {
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const load = () => api.get<{ unread: number }>('/events/unread').then((r) => !cancelled && setUnread(r.unread)).catch(() => {});
    load();
    const stop = setVisibleInterval(load, 30_000);
    const onChange = (e: Event) => setUnread((e as CustomEvent<number>).detail);
    window.addEventListener(UNREAD_EVENT, onChange);
    return () => {
      cancelled = true;
      stop();
      window.removeEventListener(UNREAD_EVENT, onChange);
    };
  }, []);
  const set = (n: number) => window.dispatchEvent(new CustomEvent(UNREAD_EVENT, { detail: n }));
  return [unread, set];
}

/** Bell button with an unread badge; opens the event inbox. */
export function NotificationBell({ compact = false }: { compact?: boolean }) {
  const [unread, setUnread] = useUnread();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const label = unread ? `${t('Notifications')} (${unread} ${t('unread')})` : t('Notifications');
  return (
    <>
      <button
        ref={button}
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={label}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`state-layer relative rounded-full p-2 ${open ? 'text-accent-400' : 'text-ink-300'}`}
      >
        <svg viewBox="0 0 24 24" className={compact ? 'h-5 w-5' : 'h-[18px] w-[18px]'} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unread > 0 && (
          <span className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-error-400 px-1 text-[10px] font-semibold leading-none text-surface-950">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {createPortal(
        <AnimatePresence>{open && <Inbox anchor={button.current} onClose={() => setOpen(false)} onUnread={setUnread} />}</AnimatePresence>,
        document.body,
      )}
    </>
  );
}

function Inbox({ anchor, onClose, onUnread }: { anchor: HTMLElement | null; onClose: () => void; onUnread: (n: number) => void }) {
  const [tab, setTab] = useState<'important' | 'all'>('important');
  const [events, setEvents] = useState<PanelEvent[] | null>(null);
  // What was unread when the inbox opened stays highlighted while it's open.
  const [readBefore, setReadBefore] = useState<number | null>(null);
  const [more, setMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 64, left: 16 });
  const panel = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const place = () => {
      const r = anchor?.getBoundingClientRect();
      const width = Math.min(400, window.innerWidth - 16);
      if (!r) return setPos({ top: 64, left: 8 });
      setPos({ top: r.bottom + 8, left: Math.max(8, Math.min(r.left - 8, window.innerWidth - width - 8)) });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchor]);

  useEffect(() => {
    let cancelled = false;
    setEvents(null);
    setMore(true);
    api
      .get<EventPage>(`/events?limit=30${tab === 'important' ? '&important=1' : ''}`)
      .then((page) => {
        if (cancelled) return;
        setEvents(page.events);
        setMore(page.events.length === 30);
        setReadBefore((prev) => prev ?? page.lastReadId);
        // Opening the inbox counts as reading it.
        if (page.unread > 0) api.post<{ unread: number }>('/events/read').then((r) => onUnread(r.unread)).catch(() => {});
      })
      .catch(() => !cancelled && setEvents([]));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

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

  async function loadMore() {
    if (!events?.length) return;
    setLoadingMore(true);
    try {
      const page = await api.get<EventPage>(`/events?limit=30&before=${events[events.length - 1].id}${tab === 'important' ? '&important=1' : ''}`);
      setEvents((prev) => [...(prev ?? []), ...page.events]);
      setMore(page.events.length === 30);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <motion.div
      ref={panel}
      role="dialog"
      aria-label={t('Notifications')}
      className="ui-modal fixed z-[55] flex max-h-[min(560px,75vh)] w-[min(400px,calc(100vw-16px))] flex-col overflow-hidden rounded-3xl bg-surface-800 shadow-card ring-1 ring-surface-600"
      style={{ top: pos.top, left: pos.left }}
      initial={{ opacity: 0, y: -6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -4, scale: 0.98 }}
      transition={{ type: 'spring', stiffness: 500, damping: 36 }}
    >
      <div className="flex items-center gap-2 border-b border-surface-700 px-4 py-3">
        <h2 className="flex-1 text-base font-medium text-ink-50">{t('Notifications')}</h2>
        <div className="flex rounded-full border border-surface-500 p-0.5" role="tablist">
          {(['important', 'all'] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`state-layer rounded-full px-3 py-1 text-xs font-medium ${tab === id ? 'bg-secondary-container text-secondary-on-container' : 'text-ink-300'}`}
            >
              {t(id === 'important' ? 'Important' : 'All')}
            </button>
          ))}
        </div>
        <button type="button" onClick={onClose} aria-label={t('Close')} className="state-layer rounded-full p-1.5 text-ink-400">
          <Icon name="close" className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {events === null ? (
          <div className="flex justify-center py-10 text-ink-400"><Spinner className="h-5 w-5" /></div>
        ) : events.length === 0 ? (
          <div className="px-6 py-10 text-center">
            <Icon name="shieldCheck" className="mx-auto mb-2 h-8 w-8 text-ink-500" />
            <p className="text-sm text-ink-300">{t(tab === 'important' ? 'Nothing needs your attention.' : 'No activity yet.')}</p>
            <p className="mt-1 text-xs text-ink-500">{t('Crashes, failed backups and updates show up here.')}</p>
          </div>
        ) : (
          <ul className="space-y-0.5">
            {events.map((e) => <EventItem key={e.id} event={e} unread={readBefore !== null && e.id > readBefore} onNavigate={onClose} />)}
          </ul>
        )}
        {events && events.length > 0 && more && (
          <button type="button" onClick={loadMore} disabled={loadingMore} className="state-layer mt-1 w-full rounded-full py-2 text-xs font-medium text-accent-400">
            {loadingMore ? t('Loading…') : t('Load older')}
          </button>
        )}
      </div>
    </motion.div>
  );
}
