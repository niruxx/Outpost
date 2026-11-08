import { useEffect, useState } from 'react';
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

  const url = `/servers/${serverId}/activity?limit=50${query ? `&search=${encodeURIComponent(query)}` : ''}`;
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
          <CardTitle>Instance activity</CardTitle>
          <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('Search actions, users, details…')} aria-label={t('Search actions')} />
        </div>
        <div className="mt-3">
          <ErrorText>{feed.error}</ErrorText>
          {feed.items === null ? (
            <div className="flex justify-center p-8"><Spinner /></div>
          ) : (
            <ActionList entries={feed.items} showUser showTarget={false} empty={query ? 'Nothing matches this search.' : 'Nothing has been done to this instance yet.'} />
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
