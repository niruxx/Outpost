import { useEffect, useState } from 'react';
import { api, ApiError } from '../../api/client.js';
import { Button, Card, ErrorText, Field, Input, Notice, Spinner } from '../../components/ui.js';
import { useServerDetail } from './ServerContext.js';
import { useToast } from '../../components/Toast.js';
import { setVisibleInterval } from '../../lib/perf.js';

interface StorageInfo {
  directory: string | null; snapshots: string; rewind: string;
  available: boolean; error: string | null; changing: boolean;
}
export function BackupStorageCard({ onChanged }: { onChanged?: () => void | Promise<void> }) {
  const { serverId, server, isAdmin, refresh } = useServerDetail();
  const toast = useToast();
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [directory, setDirectory] = useState('');
  const [copyExisting, setCopyExisting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    api.get<StorageInfo>(`/servers/${serverId}/backups/storage`).then((result) => {
      if (!cancelled) { setStorage(result); setDirectory(result.directory ?? ''); setError(''); }
    }).catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load backup storage'); });
    const stop = setVisibleInterval(() => {
      api.get<StorageInfo>(`/servers/${serverId}/backups/storage`).then((result) => { if (!cancelled) setStorage(result); }).catch(() => {});
    }, 10_000);
    return () => { cancelled = true; stop(); };
  }, [serverId, server?.backup_directory]);
  async function save() {
    setBusy(true); setError('');
    try {
      const result = await api.put<StorageInfo>(`/servers/${serverId}/backups/storage`, { directory: directory.trim() || null, copyExisting });
      setStorage(result); setDirectory(result.directory ?? '');
      toast.success(copyExisting ? 'Backup storage saved. Previous backups were copied; originals are kept.' : 'Backup storage saved. Previous files were left at their original location.');
      await refresh(); await onChanged?.();
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Could not change backup storage'); }
    finally { setBusy(false); }
  }
  return <Card className="space-y-4 p-5">
    <h2 className="text-base font-medium text-ink-100">Backup storage</h2>
    <p className="text-sm text-ink-400">Choose another partition or external drive for this instance’s snapshots, scheduled/pre-update backups, downloaded off-site copies, World Rewind points and file safety/undo copies.</p>
    {!storage && !error && <Spinner />}
    {storage && <>
      {!storage.available && <Notice tone="warning">{storage.error}</Notice>}
      {storage.changing && <Notice tone="info">A storage change is in progress. Backup operations are temporarily blocked until it finishes.</Notice>}
      {isAdmin ? <>
        <Field label="Backup base directory (blank = Outpost default)"><Input value={directory} onChange={(e) => setDirectory(e.target.value)} disabled={busy} placeholder="/mnt/backup-drive/outpost or D:\OutpostBackups" /></Field>
        <p className="text-xs text-ink-500">Use an existing absolute directory on the host. Outpost creates separate snapshots and rewind folders under this instance’s ID. The service account needs read/write access.</p>
        <label className="flex items-center gap-2 text-sm text-ink-300"><input type="checkbox" checked={copyExisting} disabled={busy} onChange={(e) => setCopyExisting(e.target.checked)} />Copy existing snapshots and World Rewind points before switching</label>
        <p className="text-xs text-ink-500">Original files are kept. Uncheck to start using another location without copying; older files will stay at the previous location and will not appear here. Retention applies to the active location.</p>
        <Button variant="primary" onClick={save} disabled={busy || storage.changing}>{busy ? copyExisting ? 'Copying and saving…' : 'Saving…' : 'Save backup location'}</Button>
      </> : <p className="text-xs text-ink-500">An administrator can change host storage paths. Your backup permissions apply to the selected location.</p>}
      <dl className="space-y-2 rounded-xl bg-surface-900 p-3 text-xs"><div><dt className="text-ink-500">Snapshots</dt><dd className="break-all font-mono text-ink-200">{storage.snapshots}</dd></div><div><dt className="text-ink-500">World Rewind</dt><dd className="break-all font-mono text-ink-200">{storage.rewind}</dd></div></dl>
      <p className="text-xs text-ink-500">If the configured drive becomes unavailable, backups fail instead of silently writing to the system disk. Mount it before starting backup jobs.</p>
    </>}
    <ErrorText>{error}</ErrorText>
  </Card>;
}
