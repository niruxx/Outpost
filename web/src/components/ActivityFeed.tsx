import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { t } from '../i18n/index.js';
import type { AuditEntry, FileChangeKind, FileChangeRecord, FileChangeSummary, PageView, PresenceTab } from '../api/types.js';
import { api } from '../api/client.js';
import { diffLines } from '../lib/diff.js';
import { Badge, Spinner } from './ui.js';
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
  'file.mkdir': 'Created a folder',
  'file.write': 'Edited a file',
  'file.upload': 'Uploaded a file',
  'file.delete': 'Deleted a file',
  'file.rename': 'Renamed or moved a file',
  'server.properties.update': 'Changed server properties',
  'server.cs2.plugin_config': 'Edited a plugin config',
  'server.cs2.plugin_config_revert': 'Reverted a plugin config',
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

// ---------------------------------------------------------------------------
// File change history
// ---------------------------------------------------------------------------

const KIND_LABEL: Record<FileChangeKind, string> = { created: 'Created', edited: 'Edited', deleted: 'Deleted', renamed: 'Renamed' };
const KIND_TONE: Record<FileChangeKind, 'green' | 'blue' | 'red' | 'yellow'> = { created: 'green', edited: 'blue', deleted: 'red', renamed: 'yellow' };

/** Where an entry's stored diff is fetched from; the instance feed uses its own, owner-readable route. */
export type ChangesUrl = (entryId: number) => string;
const adminChangesUrl: ChangesUrl = (id) => `/activity/actions/${id}/changes`;

/** "+12 −3" line counts. */
export function ChangeCounts({ added, removed }: { added: number | null | undefined; removed: number | null | undefined }) {
  if (added == null && removed == null) return null;
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[11px] tabular-nums">
      {!!added && <span className="text-success-400">+{added}</span>}
      {!!removed && <span className="text-red-400">−{removed}</span>}
      {!added && !removed && <span className="text-ink-500">±0</span>}
    </span>
  );
}

/** Older records stored the region as "\n"-joined text; newer ones as line arrays. */
function toLines(value: string[] | string | undefined): string[] {
  if (Array.isArray(value)) return value;
  return value ? value.split('\n') : [];
}

interface DiffRow { type: 'same' | 'add' | 'del' | 'gap'; text: string; oldNo?: number; newNo?: number }

/** The stored change as unified-diff rows: context, removed/added lines (paired by LCS), context. */
function diffRows(c: FileChangeRecord): DiffRow[] {
  const start = c.line ?? 1;
  const before = toLines(c.before);
  const after = toLines(c.after);
  const ctxBefore = c.contextBefore ?? [];
  const ctxAfter = c.contextAfter ?? [];
  const rows: DiffRow[] = [];
  if (start - ctxBefore.length > 1) rows.push({ type: 'gap', text: `${start - ctxBefore.length - 1} unchanged lines above` });
  ctxBefore.forEach((text, i) => {
    const n = start - ctxBefore.length + i;
    rows.push({ type: 'same', text, oldNo: n, newNo: n });
  });
  if (before.length && after.length) {
    // Within each changed block, removed lines come first, then their replacements.
    let dels: DiffRow[] = [];
    let adds: DiffRow[] = [];
    const flush = () => {
      rows.push(...dels, ...adds);
      dels = [];
      adds = [];
    };
    for (const line of diffLines(before.join('\n'), after.join('\n')).lines) {
      const row: DiffRow = { type: line.type, text: line.text, oldNo: line.oldNo && line.oldNo + start - 1, newNo: line.newNo && line.newNo + start - 1 };
      if (row.type === 'del') dels.push(row);
      else if (row.type === 'add') adds.push(row);
      else {
        flush();
        rows.push(row);
      }
    }
    flush();
  } else {
    before.forEach((text, i) => rows.push({ type: 'del', text, oldNo: start + i }));
    after.forEach((text, i) => rows.push({ type: 'add', text, newNo: start + i }));
  }
  ctxAfter.forEach((text, i) => rows.push({ type: 'same', text, oldNo: start + before.length + i, newNo: start + after.length + i }));
  return rows;
}

const ROW_STYLE: Record<DiffRow['type'], string> = {
  same: 'text-ink-300',
  add: 'bg-success-500/10 text-ink-100',
  del: 'bg-red-500/10 text-ink-100',
  gap: 'bg-surface-800/60 text-ink-500 italic',
};
const MARK: Record<DiffRow['type'], string> = { same: ' ', add: '+', del: '−', gap: '' };

/** A recorded change rendered like a code review diff. */
export function FileDiff({ change }: { change: FileChangeRecord }) {
  const kind = change.kind ?? (change.created ? 'created' : 'edited');
  if (kind === 'renamed') {
    return (
      <p className="rounded-xl bg-surface-900 px-3 py-2 text-xs text-ink-300">
        {t(change.directory ? 'Folder moved from' : 'Moved from')} <span className="break-all font-mono text-ink-100">{change.from}</span> {t('to')}{' '}
        <span className="break-all font-mono text-ink-100">{change.path}</span>
      </p>
    );
  }
  if (change.reason) return <p className="rounded-xl bg-surface-900 px-3 py-2 text-xs text-ink-300">{t(change.reason)}</p>;
  const rows = diffRows(change);
  return (
    <div className="space-y-1.5">
      <div className="ui-diff max-h-96 overflow-auto rounded-xl border border-surface-700 bg-surface-1000/40 font-mono text-[12px] leading-5">
        <table className="w-full border-collapse">
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={ROW_STYLE[r.type]}>
                {r.type === 'gap' ? (
                  <td colSpan={4} className="px-3 py-0.5 text-[11px]">{t(r.text)}</td>
                ) : (
                  <>
                    <td className="w-10 select-none border-r border-surface-700 px-2 text-right text-ink-500">{r.oldNo ?? ''}</td>
                    <td className="w-10 select-none border-r border-surface-700 px-2 text-right text-ink-500">{r.newNo ?? ''}</td>
                    <td className={`w-5 select-none pl-2 ${r.type === 'add' ? 'text-success-400' : r.type === 'del' ? 'text-red-400' : ''}`}>{MARK[r.type]}</td>
                    <td className="whitespace-pre-wrap break-all pr-3">{r.text || ' '}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-ink-500">
        {change.truncated ? `${t('Very large change — only the start is shown.')} ` : ''}
        {t('Lines that look like passwords, tokens or keys are hidden.')}
      </p>
    </div>
  );
}

/** The file line of an entry: path, what happened and +/- counts, with the diff on demand. */
function FileChangeBlock({ id, file, changesUrl }: { id: number; file: FileChangeSummary | null | undefined; changesUrl: ChangesUrl }) {
  const [open, setOpen] = useState(false);
  const [change, setChange] = useState<FileChangeRecord | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  async function toggle() {
    setOpen(!open);
    if (open || change || loading) return;
    setLoading(true);
    setError('');
    try {
      setChange(await api.get<FileChangeRecord>(changesUrl(id)));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Unable to load changes'));
    } finally {
      setLoading(false);
    }
  }
  const kind = file?.kind ?? 'edited';
  const canExpand = !file?.directory || kind === 'renamed';
  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-surface-900 px-3 py-2">
        <Icon name={file?.directory ? 'folder' : 'file'} className="h-4 w-4 text-ink-400" />
        {file && <Badge tone={KIND_TONE[kind]}>{t(KIND_LABEL[kind])}</Badge>}
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-100" title={file?.path}>
          {file?.from && kind === 'renamed' ? <><span className="text-ink-400">{file.from}</span> → </> : null}
          {file?.path ?? t('File change')}
        </span>
        {file && !file.hidden && <ChangeCounts added={file.added} removed={file.removed} />}
        {canExpand && (
          <button type="button" onClick={toggle} aria-expanded={open} className="state-layer rounded-full px-2.5 py-0.5 text-xs font-medium text-accent-400">
            {t(open ? 'Hide changes' : 'View changes')}
          </button>
        )}
      </div>
      {open && (
        <div className="mt-2">
          {loading && <p className="flex items-center gap-2 text-xs text-ink-400"><Spinner className="h-3.5 w-3.5" /> {t('Loading…')}</p>}
          {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
          {change && <FileDiff change={change} />}
        </div>
      )}
    </div>
  );
}

const FILE_SENTENCE: Record<FileChangeKind, [file: string, folder: string]> = {
  created: ['Created a file', 'Created a folder'],
  edited: ['Edited a file', 'Edited a file'],
  deleted: ['Deleted a file', 'Deleted a folder'],
  renamed: ['Renamed or moved a file', 'Renamed or moved a folder'],
};

/** File entries say what happened to the file (a first save is "Created", not "Edited"). */
function describeEntry(e: AuditEntry): string {
  if (!e.file || e.action.endsWith('.failed') || !e.action.startsWith('file.')) return describeAction(e.action);
  return t(FILE_SENTENCE[e.file.kind][e.file.directory ? 1 : 0]);
}

/** The detail line only repeats the path(s) the file chip already shows ("a -> b", "x.yml"). */
function restatesFile(e: AuditEntry): boolean {
  if (!e.file || !e.detail) return false;
  const paths = [e.file.path, e.file.from].filter(Boolean) as string[];
  const words = e.detail.split(/\s*(?:->|→)\s*/).map((p) => p.replace(/^\/+/, ''));
  return words.every((w) => paths.includes(w) || paths.some((p) => p.endsWith(w)));
}

/** Timeline of audit entries. `showUser` adds who did it (for mixed feeds). */
export function ActionList({
  entries,
  showUser = false,
  showTarget = true,
  empty,
  changesUrl = adminChangesUrl,
}: {
  entries: AuditEntry[];
  showUser?: boolean;
  showTarget?: boolean;
  empty: string;
  changesUrl?: ChangesUrl;
}) {
  const now = useNow();
  if (!entries.length) return <p className="px-4 py-8 text-center text-sm text-ink-500">{t(empty)}</p>;
  return (
    <ol className="divide-y divide-surface-800">
      {entries.map((e) => (
        <li key={e.id} className="flex gap-3 px-4 py-3">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-700 text-ink-300">
            <Icon name={e.file ? 'file' : actionIcon(e.action)} className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              {showUser && <span className="text-sm font-medium text-ink-50">{e.username ?? t('system')}</span>}
              <span className="text-sm text-ink-100">{describeEntry(e)}</span>
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
            {e.detail && !restatesFile(e) && <p className="mt-0.5 break-words text-xs text-ink-400">{e.detail}</p>}
            {e.hasFileChange && <FileChangeBlock id={e.id} file={e.file} changesUrl={changesUrl} />}
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
