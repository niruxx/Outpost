import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { t } from '../i18n/index.js';
import type { AuditEntry, PageView, PresenceTab } from '../api/types.js';
import { api } from '../api/client.js';
import { Badge } from './ui.js';
import { Icon, type IconName } from './icons.js';

/** Shared pieces of the Activity page and the per-instance Activity tab. */

const VERBS: Record<string, string> = {
  create: 'Created', delete: 'Deleted', update: 'Updated', start: 'Started', stop: 'Stopped', restart: 'Restarted',
  add: 'Added', remove: 'Removed', install: 'Installed', upload: 'Uploaded', download: 'Downloaded', rename: 'Renamed',
  write: 'Edited', run: 'Ran', toggle: 'Toggled', restore: 'Restored', export: 'Exported', import: 'Imported', set: 'Set',
  save: 'Saved', apply: 'Applied', revoke: 'Revoked', suspend: 'Suspended', unsuspend: 'Unsuspended', duplicate: 'Duplicated',
  transfer: 'Transferred', open: 'Opened', close: 'Closed', reset: 'Reset', kill: 'Force-stopped', enable: 'Enabled', disable: 'Disabled',
};

const SPECIAL: Record<string, string> = {
  'auth.login': 'Signed in',
  'auth.logout': 'Signed out',
  'auth.login_disabled': 'Tried to sign in to a disabled account',
  'auth.2fa_failed': 'Failed a two-factor check',
  'access.denied': 'Was denied access',
  'server.command': 'Ran a console command',
  'server.retry_install': 'Retried the install',
  'terminal.open': 'Opened the host console',
  'terminal.close': 'Closed the host console',
  'sftp.login': 'Signed in over SFTP',
};

const NOUN: Record<string, string> = { server: 'instance', apikey: 'API key', dbhost: 'database host', libvirt: 'VM', cs2: 'CS2', upnp: 'UPnP', rcon: 'RCON', sftp: 'SFTP' };

/** "server.properties.update" → "Updated instance properties"; ".failed" entries say so. */
export function describeAction(action: string): string {
  const failed = action.endsWith('.failed');
  const base = failed ? action.slice(0, -'.failed'.length) : action;
  let text = SPECIAL[base];
  if (!text) {
    const parts = base.split('.');
    const last = parts[parts.length - 1];
    const verb = VERBS[last];
    const noun = (verb ? parts.slice(0, -1) : parts).map((p) => NOUN[p] ?? p.replace(/_/g, ' ')).join(' ');
    text = verb ? `${verb} ${noun}` : `Changed ${noun}`;
  }
  return failed ? `${t('Failed')}: ${t(text).replace(/^./, (c) => c.toLowerCase())}` : t(text);
}

export function actionTone(action: string): 'neutral' | 'green' | 'red' | 'yellow' | 'blue' {
  if (/failed|denied|delete|kill|suspend|reset|remove/.test(action)) return 'red';
  if (/^auth\.|^sftp\.login/.test(action)) return 'blue';
  if (/restore|update|transfer|sandbox|restart|stop/.test(action)) return 'yellow';
  if (/create|start|enable|install|add/.test(action)) return 'green';
  return 'neutral';
}

function actionIcon(action: string): IconName {
  if (/\.start\b/.test(action)) return 'play';
  if (/\.stop\b|kill/.test(action)) return 'stop';
  if (/restart/.test(action)) return 'restart';
  if (/command|terminal|console/.test(action)) return 'console';
  if (/^file|\.files?\b/.test(action)) return 'folder';
  if (/^backup|rewind/.test(action)) return 'backup';
  if (/^auth|login|2fa|apikey/.test(action)) return 'key';
  if (/denied/.test(action)) return 'lock';
  if (/delete|remove/.test(action)) return 'trash';
  if (/^user/.test(action)) return 'users';
  if (/plugin|workshop/.test(action)) return 'plugin';
  if (/firewall/.test(action)) return 'shieldCheck';
  return 'configuration';
}

/** "just now", "5m ago", "3h ago", then a date. Re-renders every 30 s so it stays current. */
export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return t('just now');
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ${t('ago')}`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ${t('ago')}`;
  if (seconds < 7 * 86_400) return `${Math.round(seconds / 86_400)}d ${t('ago')}`;
  return new Date(iso).toLocaleDateString();
}

export function duration(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return t('under a minute');
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

const fullTime = (iso: string) => new Date(iso).toLocaleString();

/** Green = active in a foreground tab, amber = panel open in the background, grey = offline. */
export function PresenceDot({ online, active, className = '' }: { online: boolean; active?: boolean; className?: string }) {
  const color = !online ? 'bg-ink-500' : active ? 'bg-success-400' : 'bg-yellow-400';
  return (
    <span className={`relative inline-flex h-2.5 w-2.5 shrink-0 ${className}`} aria-hidden="true">
      {online && active && <span className={`absolute inline-flex h-full w-full animate-ping-slow rounded-full ${color} opacity-60`} />}
      <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${color}`} />
    </span>
  );
}

export function presenceLabel(online: boolean, active: boolean) {
  return t(!online ? 'Offline' : active ? 'Active now' : 'Panel open in background');
}

interface FileChange { path: string; reason?: string; created?: boolean; line?: number; before?: string; after?: string }
function FileChanges({ id }: { id: number }) {
  const [open, setOpen] = useState(false);
  const [change, setChange] = useState<FileChange | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  async function toggle() {
    setOpen(!open);
    if (open || change || loading) return;
    setLoading(true);
    setError('');
    try { setChange(await api.get<FileChange>(`/activity/actions/${id}/changes`)); }
    catch (err) { setError(err instanceof Error ? err.message : 'Unable to load changes'); }
    finally { setLoading(false); }
  }
  return <div className="mt-2">
    <button type="button" onClick={toggle} aria-expanded={open} className="text-xs text-accent-400 hover:underline">{t(open ? 'Hide changes' : 'View changes')}</button>
    {open && <div className="mt-2 space-y-2 text-xs">
      {loading && <p>{t('Loading?')}</p>}
      {error && <p role="alert" className="text-red-400">{error}</p>}
      {change && <>
        <p className="break-all font-mono">{change.path}{change.created ? ' (new file)' : ''}</p>
        {change.reason ? <p>{t(change.reason)}</p> : <>
          <p className="text-ink-400">{t('Changed region starting at line')} {change.line} ? {t('Common secret fields are hidden.')}</p>
          <div className="grid gap-2 lg:grid-cols-2">
            <div><p>{t('Before')}</p><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded bg-red-500/10 p-3">{change.before || t('(empty)')}</pre></div>
            <div><p>{t('After')}</p><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded bg-success-400/10 p-3">{change.after || t('(empty)')}</pre></div>
          </div>
        </>}
      </>}
    </div>}
  </div>;
}

/** Timeline of audit entries. `showUser` adds who did it (for mixed feeds). */
export function ActionList({ entries, showUser = false, showTarget = true, empty }: { entries: AuditEntry[]; showUser?: boolean; showTarget?: boolean; empty: string }) {
  const now = useNow();
  if (!entries.length) return <p className="px-4 py-8 text-center text-sm text-ink-500">{t(empty)}</p>;
  return (
    <ol className="divide-y divide-surface-800">
      {entries.map((e) => (
        <li key={e.id} className="flex gap-3 px-4 py-3">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-700 text-ink-300">
            <Icon name={actionIcon(e.action)} className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              {showUser && <span className="text-sm font-medium text-ink-50">{e.username ?? t('system')}</span>}
              <span className="text-sm text-ink-100">{describeAction(e.action)}</span>
              {showTarget && e.target && (
                <span className="min-w-0 truncate text-sm text-ink-300">
                  {e.targetKind === 'server' ? (
                    <Link to={`/instances/${e.target}`} className="text-accent-400 hover:underline">
                      {e.targetLabel}
                    </Link>
                  ) : (
                    e.targetLabel ?? <span className="font-mono text-xs text-ink-500" title={e.target}>{e.target.length > 12 ? `${e.target.slice(0, 8)}…` : e.target}</span>
                  )}
                </span>
              )}
            </div>
            {e.hasFileChange && <FileChanges id={e.id} />}
            {e.detail && <p className="mt-0.5 break-words text-xs text-ink-400">{e.detail}</p>}
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-500">
              <Badge tone={actionTone(e.action)}>{e.action}</Badge>
              <span title={fullTime(e.at)}>{relativeTime(e.at, now)}</span>
              {(e.ip || e.agent) && <span title={e.userAgent ?? undefined}>· {[e.agent, e.ip].filter(Boolean).join(' · ')}</span>}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Pages a user opened, newest first. */
export function PageViewList({ views }: { views: PageView[] }) {
  const now = useNow();
  if (!views.length) return <p className="px-4 py-8 text-center text-sm text-ink-500">{t('No pages visited in the last 30 days.')}</p>;
  return (
    <ol className="divide-y divide-surface-800">
      {views.map((v) => (
        <li key={v.id} className="flex items-center gap-3 px-4 py-2.5">
          <Icon name="eye" className="h-4 w-4 text-ink-500" />
          <Link to={v.path} className="min-w-0 flex-1 truncate text-sm text-ink-200 hover:text-accent-400 hover:underline" title={v.path}>
            {v.label}
          </Link>
          <span className="shrink-0 text-xs text-ink-500" title={fullTime(v.at)}>
            {relativeTime(v.at, now)}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** "Viewing Survival · Console for 12m — Firefox on Windows". */
export function OpenTabList({ tabs, showUser = false }: { tabs: PresenceTab[]; showUser?: boolean }) {
  const now = useNow(15_000);
  return (
    <ul className="space-y-2">
      {tabs.map((tab) => (
        <li key={`${tab.userId}:${tab.tabId}`} className="flex items-start gap-3 rounded-2xl bg-surface-900 px-3 py-2.5">
          <PresenceDot online active={tab.visible} className="mt-1.5" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-ink-100">
              {showUser && <span className="font-medium text-ink-50">{tab.username} · </span>}
              <span className="text-ink-400">{t(tab.visible ? 'Viewing' : 'Left open on')} </span>
              <Link to={tab.path} className="text-accent-400 hover:underline">
                {tab.label}
              </Link>
            </p>
            <p className="text-[11px] text-ink-500">
              {t('for')} {duration(tab.since, now)}
              {(tab.agent || tab.ip) && ` · ${[tab.agent, tab.ip].filter(Boolean).join(' · ')}`}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}
