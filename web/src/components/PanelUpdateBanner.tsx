import { useEffect, useState } from 'react';
import { setVisibleInterval } from '../lib/perf.js';
import { api } from '../api/client.js';
import { useAuth } from '../state/AuthContext.js';
import { t } from '../i18n/index.js';

interface PanelVersion {
  version: string;
  isGit: boolean;
  commit: string | null;
  behind: number;
  newCommits: { hash: string; subject: string; date: string }[];
  localChanges: number;
  upstream: string | null;
}

const IGNORE_KEY = 'outpost-ignored-update';

/**
 * Admins: "the Git repo has newer commits than this install — run ./update.sh". Ignoring hides it
 * until something newer lands (it remembers the newest commit it was shown).
 */
export function PanelUpdateBanner() {
  const { user } = useAuth();
  const [v, setV] = useState<PanelVersion | null>(null);
  const [open, setOpen] = useState(false);
  const [ignored, setIgnored] = useState<string | null>(() => {
    try {
      return localStorage.getItem(IGNORE_KEY);
    } catch {
      return null;
    }
  });

  useEffect(() => {
    if (user?.role !== 'admin') return;
    const load = () => api.get<PanelVersion>('/system/panel-version').then(setV).catch(() => setV(null));
    load();
    const timer = setVisibleInterval(load, 30 * 60_000);
    return () => timer();
  }, [user?.role]);

  if (!v || !v.behind || !v.newCommits.length) return null;
  const newest = v.newCommits[0].hash;
  if (ignored === newest) return null;

  const ignore = () => {
    try {
      localStorage.setItem(IGNORE_KEY, newest);
    } catch {
      // storage blocked — hide for this visit
    }
    setIgnored(newest);
  };

  return (
    <div className="border-b border-accent-500/30 bg-accent-500/10 px-4 py-2.5 text-sm text-ink-100">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">
          {t('Outpost update available')}: {v.behind} {v.behind === 1 ? t('new change') : t('new changes')}
        </span>
        <span className="text-ink-300">
          {t('This install runs')} <span className="font-mono">{v.commit}</span>
          {v.localChanges ? ` (+${v.localChanges} ${t('local edits')})` : ''}. {t('Run')} <span className="font-mono">./update.sh</span> {t('on the server — it backs up your data first.')}
        </span>
        <span className="ml-auto flex gap-2">
          <button type="button" className="font-medium text-accent-400" onClick={() => setOpen((o) => !o)}>
            {open ? t('Hide') : t('What’s new')}
          </button>
          <button type="button" className="font-medium text-ink-300" onClick={ignore}>
            {t('Ignore')}
          </button>
        </span>
      </div>
      {open && (
        <ul className="mx-auto mt-2 max-w-6xl space-y-0.5 text-xs text-ink-300">
          {v.newCommits.map((c) => (
            <li key={c.hash}>
              <span className="font-mono text-ink-400">{c.hash}</span> {c.subject} <span className="text-ink-500">· {new Date(c.date).toLocaleDateString()}</span>
            </li>
          ))}
          {v.behind > v.newCommits.length && <li className="text-ink-500">…and {v.behind - v.newCommits.length} more</li>}
        </ul>
      )}
    </div>
  );
}
