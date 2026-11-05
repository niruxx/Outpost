import { Link } from 'react-router-dom';
import { Icon, type IconName } from './icons.js';
import { t } from '../i18n/index.js';

/** One entry of the panel's event log (server/src/services/eventLogService.ts). */
export interface PanelEvent {
  id: number;
  at: number;
  event: string;
  title: string;
  severity: 'error' | 'warning' | 'notice' | 'info';
  serverId: string | null;
  serverName: string | null;
  message: string;
}

export interface EventPage {
  events: PanelEvent[];
  unread: number;
  lastReadId: number;
}

const STYLE: Record<PanelEvent['severity'], { icon: IconName; chip: string }> = {
  error: { icon: 'warning', chip: 'bg-error-container text-error-on-container' },
  warning: { icon: 'warning', chip: 'bg-yellow-500/15 text-yellow-400' },
  notice: { icon: 'update', chip: 'bg-tertiary-container text-tertiary-on-container' },
  info: { icon: 'status', chip: 'bg-surface-700 text-ink-300' },
};

const ICON_BY_EVENT: Record<string, IconName> = {
  'server.started': 'play',
  'server.stopped': 'stop',
  'server.crashed': 'warning',
  'server.restart_gave_up': 'restart',
  'backup.failed': 'backup',
  'task.failed': 'clock',
  'update.available': 'update',
  'update.applied': 'update',
  'update.failed': 'update',
  'quota.exceeded': 'disk',
};

/** "just now", "5m ago", "3h ago", "2d ago", then a date. */
export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return t('just now');
  if (s < 3600) return `${Math.round(s / 60)}m ${t('ago')}`;
  if (s < 86400) return `${Math.round(s / 3600)}h ${t('ago')}`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)}d ${t('ago')}`;
  return new Date(ms).toLocaleDateString();
}

export function EventItem({
  event, unread = false, showServer = true, onNavigate,
}: {
  event: PanelEvent; unread?: boolean; showServer?: boolean; onNavigate?: () => void;
}) {
  const style = STYLE[event.severity] ?? STYLE.info;
  return (
    <li className={`relative flex gap-3 rounded-2xl px-3 py-2.5 ${unread ? 'bg-secondary-container/40' : ''}`}>
      <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${style.chip}`}>
        <Icon name={ICON_BY_EVENT[event.event] ?? style.icon} className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <p className="min-w-0 flex-1 truncate text-sm font-medium text-ink-100">
            {t(event.title)}
            {showServer && event.serverName && (
              <>
                {' · '}
                {event.serverId ? (
                  <Link to={`/instances/${event.serverId}`} onClick={onNavigate} className="text-accent-400 hover:underline">
                    {event.serverName}
                  </Link>
                ) : (
                  <span className="text-ink-400">{event.serverName}</span>
                )}
              </>
            )}
          </p>
          <time className="shrink-0 text-[11px] text-ink-500" dateTime={new Date(event.at).toISOString()} title={new Date(event.at).toLocaleString()}>
            {timeAgo(event.at)}
          </time>
        </div>
        <p className="mt-0.5 line-clamp-2 text-xs text-ink-400">{event.message}</p>
      </div>
      {unread && <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-accent-400" aria-label={t('Unread')} />}
    </li>
  );
}
