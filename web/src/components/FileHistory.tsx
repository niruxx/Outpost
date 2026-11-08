import { usePagedFeed } from '../lib/usePagedFeed.js';
import { t } from '../i18n/index.js';
import type { AuditEntry } from '../api/types.js';
import { ActionList } from './ActivityFeed.js';
import { Button, ErrorText, Modal, Spinner } from './ui.js';
import { Icon } from './icons.js';

/** Where an instance's file-change entries are listed and their diffs fetched (admins and the owner). */
export const instanceFileFeed = (serverId: string, path?: string | null) =>
  `/servers/${serverId}/activity?limit=30&files=1${path ? `&path=${encodeURIComponent(path)}` : ''}`;
export const instanceChangesUrl = (serverId: string) => (entryId: number) => `/servers/${serverId}/activity/changes/${entryId}`;

/** Every recorded change to one file of an instance: who, when, and the diff. */
export function FileHistoryModal({ serverId, path, onClose }: { serverId: string; path: string | null; onClose: () => void }) {
  const feed = usePagedFeed<AuditEntry, 'entries'>(path ? instanceFileFeed(serverId, path) : null, 'entries', 30_000);
  return (
    <Modal open={!!path} onClose={onClose} title="File history" size="xl">
      <div className="mb-4 flex items-center gap-2 rounded-xl bg-surface-900 px-3 py-2">
        <Icon name="file" className="h-4 w-4 text-ink-400" />
        <span className="min-w-0 flex-1 truncate font-mono text-sm text-ink-100" title={path ?? undefined}>{path}</span>
      </div>
      <p className="mb-3 text-xs text-ink-400">
        {t('Changes made from the file manager, SFTP, uploads and Outpost’s own editors, newest first.')}
      </p>
      <ErrorText>{feed.error}</ErrorText>
      <div className="-mx-4">
        {feed.items === null ? (
          <div className="flex justify-center p-8"><Spinner /></div>
        ) : (
          <ActionList entries={feed.items} showUser showTarget={false} empty="No changes to this file have been recorded yet." changesUrl={instanceChangesUrl(serverId)} />
        )}
      </div>
      {feed.nextBefore && (
        <div className="mt-2 flex justify-center">
          <Button variant="ghost" disabled={feed.loadingMore} onClick={feed.loadMore}>
            {feed.loadingMore ? 'Loading…' : 'Load older'}
          </Button>
        </div>
      )}
    </Modal>
  );
}
