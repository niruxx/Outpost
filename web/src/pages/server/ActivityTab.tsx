import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { instanceChangesUrl } from '../../components/FileHistory.js';
import { useServerDetail } from './ServerContext.js';
import { api } from '../../api/client.js';
import { setVisibleInterval } from '../../lib/perf.js';
import { Badge, Button, Card, CardTitle, ErrorText, Input, Spinner } from '../../components/ui.js';
import { ActionList, OpenTabList } from '../../components/ActivityFeed.js';
import { usePagedFeed } from '../../lib/usePagedFeed.js';
import { t } from '../../i18n/index.js';
import type { AuditEntry, PresenceTab } from '../../api/types.js';

/** Everything done to this instance (start/stop, config, files, backups…) and who has it open now. */
export function ActivityTab() {
  const { serverId } = useServerDetail();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(id);
  }, [search]);

  // "File changes" narrows the feed to edits, uploads, deletes and renames — each with its diff.
  const [params, setParams] = useSearchParams();
  const filesOnly = params.get('view') === 'files';
  const setFilesOnly = (on: boolean) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (on) next.set('view', 'files');
      else next.delete('view');
      return next;
    }, { replace: true });

  const url = `/servers/${serverId}/activity?limit=50${filesOnly ? '&files=1' : ''}${query ? `&search=${encodeURIComponent(query)}` : ''}`;
  const feed = usePagedFeed<AuditEntry, 'entries'>(url, 'entries');
  // Who has this instance open (the response's `viewers`), polled on its own.
  const viewers = useViewers(`/servers/${serverId}/activity?limit=1`);

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.8fr)]">
      <Card className="h-fit p-5">
        <CardTitle action={viewers && <Badge tone={viewers.length ? 'green' : 'neutral'} pulse={viewers.length > 0}>{viewers.length}</Badge>}>Viewing now</CardTitle>
        {viewers === null ? <Spinner /> : viewers.length ? <OpenTabList tabs={viewers} showUser /> : <p className="text-sm text-ink-500">{t('Nobody has this instance open.')}</p>}
      </Card>
      <Card className="overflow-hidden">
        <div className="px-5 pt-5">
          <CardTitle action={<Segmented value={filesOnly} onChange={setFilesOnly} />}>Instance activity</CardTitle>
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t(filesOnly ? 'Search by file name or path…' : 'Search actions, users, details…')}
            aria-label={t('Search actions')}
          />
        </div>
        <div className="mt-3">
          <ErrorText>{feed.error}</ErrorText>
          {feed.items === null ? (
            <div className="flex justify-center p-8"><Spinner /></div>
          ) : (
            <ActionList
              entries={feed.items}
              showUser
              showTarget={false}
              changesUrl={instanceChangesUrl(serverId)}
              empty={query ? 'Nothing matches this search.' : filesOnly ? 'No file changes have been recorded yet.' : 'Nothing has been done to this instance yet.'}
            />
          )}
        </div>
        {feed.nextBefore && (
          <div className="flex justify-center border-t border-surface-800 p-3">
            <Button variant="ghost" disabled={feed.loadingMore} onClick={feed.loadMore}>
              {feed.loadingMore ? 'Loading…' : 'Load older'}
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}

function Segmented({ value, onChange }: { value: boolean; onChange: (filesOnly: boolean) => void }) {
  return (
    <div className="flex rounded-full border border-surface-500 p-0.5" role="tablist" aria-label={t('Show')}>
      {([false, true] as const).map((files) => (
        <button
          key={String(files)}
          role="tab"
          aria-selected={value === files}
          onClick={() => onChange(files)}
          className={`state-layer rounded-full px-3 py-1 text-xs font-medium ${value === files ? 'bg-secondary-container text-secondary-on-container' : 'text-ink-300'}`}
        >
          {t(files ? 'File changes' : 'All activity')}
        </button>
      ))}
    </div>
  );
}

function useViewers(url: string): PresenceTab[] | null {
  const [viewers, setViewers] = useState<PresenceTab[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .get<{ viewers: PresenceTab[] }>(url)
        .then((res) => !cancelled && setViewers(res.viewers))
        .catch(() => !cancelled && setViewers([]));
    void load();
    const stop = setVisibleInterval(load, 10_000);
    return () => {
      cancelled = true;
      stop();
    };
  }, [url]);
  return viewers;
}
