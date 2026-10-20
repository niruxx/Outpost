import { useCallback, useEffect, useMemo, useState } from 'react';
import { OffsiteChips, OffsiteRestoreCard, useOffsite } from './OffsiteBackups.js';
import { useServerDetail } from './ServerContext.js';
import { api, ApiError, downloadUrl } from '../../api/client.js';
import type { BackupInfo, BackupSchedule, SnapshotEntry, SnapshotFileSide } from '../../api/types.js';
import { Badge, Button, Card, CardTitle, ErrorText, Field, Input, Modal, Notice, Spinner } from '../../components/ui.js';
import { Icon } from '../../components/icons.js';
import { useToast } from '../../components/Toast.js';
import { useConfirm } from '../../components/ConfirmDialog.js';
import { diffLines, withContext } from '../../lib/diff.js';
import { formatBytes } from './StatusTab.js';

const PRESETS = [
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every 6 hours', cron: '0 */6 * * *' },
  { label: 'Daily at 3 AM', cron: '0 3 * * *' },
  { label: 'Weekly (Sun 3 AM)', cron: '0 3 * * 0' },
];

/** backup-2026-10-10T03-00-00-000Z-<label>.zip → "<label>" (scheduled ones are labelled "auto"). */
function snapshotLabel(fileName: string): string | null {
  const m = fileName.match(/^backup-\d{4}-\d{2}-\d{2}T[\d-]+Z-(.+)\.zip$/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Diff view
// ---------------------------------------------------------------------------

function DiffView({ current, snapshot }: { current: SnapshotFileSide; snapshot: SnapshotFileSide }) {
  const result = useMemo(
    () => (current.text !== null || !current.exists) && snapshot.text !== null ? diffLines(current.text ?? '', snapshot.text) : null,
    [current, snapshot]
  );

  if (!result) {
    return (
      <Notice tone="info">
        {snapshot.binary || current.binary ? 'Binary file' : 'File too large to compare'} — snapshot copy is{' '}
        {formatBytes(snapshot.size)}, live copy is {current.exists ? formatBytes(current.size) : 'missing'}.
      </Notice>
    );
  }

  const rows = withContext(result.lines);
  const added = result.lines.filter((l) => l.type === 'add').length;
  const removed = result.lines.filter((l) => l.type === 'del').length;

  if (added === 0 && removed === 0) {
    return <Notice tone="info">The live file is identical to the snapshot — restoring it changes nothing.</Notice>;
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <Badge tone="green">+{added} from snapshot</Badge>
        <Badge tone="red">−{removed} from live file</Badge>
        {!current.exists && <Badge tone="yellow">Live file doesn't exist — it will be created</Badge>}
        {result.approximate && <span className="text-ink-500">Large change — shown as a block replacement.</span>}
      </div>
      <div className="max-h-[50vh] overflow-auto rounded-2xl bg-surface-1000 py-2 font-mono text-[12px] leading-5">
        {rows.map((row, i) =>
          row.type === 'skip' ? (
            <div key={i} className="bg-surface-850 px-3 py-0.5 text-ink-500">
              ⋯ {row.count} unchanged line{row.count === 1 ? '' : 's'}
            </div>
          ) : (
            <div
              key={i}
              className={`flex whitespace-pre ${
                row.type === 'add' ? 'bg-success-500/15 text-success-400' : row.type === 'del' ? 'bg-red-500/15 text-red-400' : 'text-ink-300'
              }`}
            >
              <span className="w-12 shrink-0 select-none pr-2 text-right text-ink-600">{row.oldNo ?? ''}</span>
              <span className="w-12 shrink-0 select-none pr-2 text-right text-ink-600">{row.newNo ?? ''}</span>
              <span className="w-4 shrink-0 select-none text-center">{row.type === 'add' ? '+' : row.type === 'del' ? '−' : ' '}</span>
              <span className="pr-4">{row.text || ' '}</span>
            </div>
          )
        )}
      </div>
      <p className="mt-2 text-xs text-ink-500">Red lines are in the live file and will be replaced; green lines come back from the snapshot.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Snapshot file browser → compare → restore one file
// ---------------------------------------------------------------------------

const MAX_LISTED = 400;

function SnapshotBrowser({ snapshot, onClose }: { snapshot: BackupInfo; onClose: () => void }) {
  const { serverId, can, running } = useServerDetail();
  const toast = useToast();
  const confirm = useConfirm();
  const [entries, setEntries] = useState<SnapshotEntry[] | null>(null);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [compare, setCompare] = useState<{ snapshot: SnapshotFileSide; current: SnapshotFileSide } | null>(null);
  const [error, setError] = useState('');
  const [restoring, setRestoring] = useState(false);
  const base = `/servers/${serverId}/backups/${encodeURIComponent(snapshot.fileName)}`;

  useEffect(() => {
    api
      .get<{ entries: SnapshotEntry[] }>(`${base}/entries`)
      .then((res) => setEntries(res.entries))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to read snapshot'));
  }, [base]);

  async function open(path: string) {
    setSelected(path);
    setCompare(null);
    setError('');
    try {
      setCompare(await api.get(`${base}/compare?path=${encodeURIComponent(path)}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to compare file');
    }
  }

  async function restoreFile() {
    if (!selected) return;
    const ok = await confirm({
      title: 'Restore file',
      message: (
        <>
          Overwrite the live <span className="font-mono">{selected}</span> with the copy from this snapshot?
          {running && <p className="mt-2 text-yellow-400">The server is running — it may overwrite or ignore the file until restarted.</p>}
        </>
      ),
      confirmLabel: 'Restore file',
      tone: 'danger',
    });
    if (!ok) return;
    setRestoring(true);
    try {
      await api.post(`${base}/restore-file`, { path: selected });
      toast.success(`Restored ${selected}`);
      await open(selected);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Restore failed');
    } finally {
      setRestoring(false);
    }
  }

  const q = filter.trim().toLowerCase();
  const matches = entries?.filter((e) => !q || e.path.toLowerCase().includes(q)) ?? [];

  return (
    <Modal open onClose={onClose} title={`Restore from ${snapshotLabel(snapshot.fileName) ?? 'snapshot'} · ${new Date(snapshot.createdAt).toLocaleString()}`} size="xl">
      <div className="grid min-h-[50vh] gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="flex min-h-0 flex-col">
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter files (e.g. server.properties)" autoFocus />
          <div className="mt-2 max-h-[55vh] min-h-0 flex-1 overflow-y-auto rounded-2xl bg-surface-850 p-1">
            {entries === null ? (
              <div className="flex items-center gap-2 p-3 text-sm text-ink-400">
                <Spinner /> Reading snapshot…
              </div>
            ) : (
              <>
                {matches.slice(0, MAX_LISTED).map((e) => (
                  <button
                    key={e.path}
                    onClick={() => open(e.path)}
                    className={`state-layer flex w-full items-center gap-2 rounded-xl px-3 py-1.5 text-left text-xs ${
                      selected === e.path ? 'bg-secondary-container text-secondary-on-container' : 'text-ink-200'
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate font-mono">{e.path}</span>
                    <span className="shrink-0 text-ink-500">{formatBytes(e.size)}</span>
                  </button>
                ))}
                {matches.length > MAX_LISTED && (
                  <p className="p-3 text-xs text-ink-500">
                    Showing {MAX_LISTED} of {matches.length} files — type to narrow it down.
                  </p>
                )}
                {matches.length === 0 && <p className="p-3 text-xs text-ink-500">No matching files.</p>}
              </>
            )}
          </div>
        </div>
        <div className="min-w-0 space-y-3">
          <ErrorText>{error}</ErrorText>
          {!selected ? (
            <p className="text-sm text-ink-400">Pick a file to compare the snapshot's copy against the live one before restoring it.</p>
          ) : !compare ? (
            <div className="flex items-center gap-2 text-sm text-ink-400">
              <Spinner /> Comparing…
            </div>
          ) : (
            <>
              <p className="truncate font-mono text-sm text-ink-100">{selected}</p>
              <DiffView current={compare.current} snapshot={compare.snapshot} />
              {can('backups.restore') && (
                <Button variant="primary" disabled={restoring} onClick={restoreFile}>
                  <Icon name="restart" className="h-4 w-4" /> {restoring ? 'Restoring…' : 'Restore this file'}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function BackupsTab() {
  const { serverId, can, running } = useServerDetail();
  const toast = useToast();
  const confirm = useConfirm();
  const [backups, setBackups] = useState<BackupInfo[] | null>(null);
  const [schedule, setSchedule] = useState<BackupSchedule | null>(null);
  const [cronExpression, setCronExpression] = useState('0 3 * * *');
  const [retentionCount, setRetentionCount] = useState(5);
  const [scheduleEnabled, setScheduleEnabled] = useState(true);
  const [label, setLabel] = useState('');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [busyFile, setBusyFile] = useState<string | null>(null);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [browsing, setBrowsing] = useState<BackupInfo | null>(null);
  const offsite = useOffsite(serverId);

  const canCreate = can('backups.create');
  const canRestore = can('backups.restore');
  const canBrowse = can('files.read');

  const load = useCallback(async () => {
    try {
      const [backupsRes, scheduleRes] = await Promise.all([
        api.get<{ backups: BackupInfo[] }>(`/servers/${serverId}/backups`),
        api.get<{ schedule: BackupSchedule | null }>(`/servers/${serverId}/backups/schedule`),
      ]);
      setBackups(backupsRes.backups);
      setSchedule(scheduleRes.schedule);
      if (scheduleRes.schedule) {
        setCronExpression(scheduleRes.schedule.cron_expression);
        setRetentionCount(scheduleRes.schedule.retention_count);
        setScheduleEnabled(!!scheduleRes.schedule.enabled);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load snapshots');
    }
  }, [serverId]);

  useEffect(() => {
    load();
  }, [load]);

  async function createSnapshot() {
    setCreating(true);
    setError('');
    try {
      await api.post(`/servers/${serverId}/backups`, label.trim() ? { label: label.trim() } : {});
      setLabel('');
      toast.success('Snapshot created');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create snapshot');
    } finally {
      setCreating(false);
    }
  }

  async function restoreAll(b: BackupInfo) {
    const ok = await confirm({
      title: 'Restore entire snapshot',
      message: `Replace every file in this instance with the snapshot from ${new Date(b.createdAt).toLocaleString()}? Anything changed since then is lost — take a fresh snapshot first if unsure. The server must be stopped.`,
      confirmLabel: 'Restore everything',
      tone: 'danger',
    });
    if (!ok) return;
    setBusyFile(b.fileName);
    setError('');
    try {
      await api.post(`/servers/${serverId}/backups/${encodeURIComponent(b.fileName)}/restore`);
      toast.success('Snapshot restored');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to restore snapshot');
    } finally {
      setBusyFile(null);
    }
  }

  async function deleteSnapshot(b: BackupInfo) {
    const ok = await confirm({
      title: 'Delete snapshot',
      message: `Delete the snapshot from ${new Date(b.createdAt).toLocaleString()}? This cannot be undone.`,
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    setBusyFile(b.fileName);
    try {
      await api.delete(`/servers/${serverId}/backups/${encodeURIComponent(b.fileName)}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete snapshot');
    } finally {
      setBusyFile(null);
    }
  }

  async function saveSchedule() {
    setSavingSchedule(true);
    setError('');
    try {
      const res = await api.put<{ schedule: BackupSchedule }>(`/servers/${serverId}/backups/schedule`, {
        cronExpression,
        retentionCount,
        enabled: scheduleEnabled,
      });
      setSchedule(res.schedule);
      toast.success('Snapshot schedule saved');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save schedule');
    } finally {
      setSavingSchedule(false);
    }
  }

  async function removeSchedule() {
    const ok = await confirm({
      title: 'Turn off scheduled snapshots',
      message: 'Stop taking snapshots automatically? Existing snapshots are kept.',
      confirmLabel: 'Turn off',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api.delete(`/servers/${serverId}/backups/schedule`);
      setSchedule(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to remove schedule');
    }
  }

  return (
    <div className="stagger space-y-5">
      <ErrorText>{error}</ErrorText>

      <Card className="p-5">
        <CardTitle>Snapshots</CardTitle>
        {canCreate && (
          <div className="mb-5 flex flex-wrap items-end gap-2">
            <div className="min-w-[220px] flex-1">
              <Field label="Label (optional)">
                <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. before-1.21-update" maxLength={40} />
              </Field>
            </div>
            <Button variant="primary" onClick={createSnapshot} disabled={creating}>
              {creating ? <Spinner /> : <Icon name="plus" className="h-4 w-4" />} {creating ? 'Creating…' : 'Create snapshot'}
            </Button>
          </div>
        )}
        {backups === null ? (
          <Spinner />
        ) : backups.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-500">No snapshots yet.</p>
        ) : (
          <div className="divide-y divide-surface-700 overflow-hidden rounded-2xl bg-surface-900">
            {backups.map((b) => {
              const tag = snapshotLabel(b.fileName);
              return (
                <div key={b.fileName} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-700 text-ink-300">
                    <Icon name="backup" className="h-[18px] w-[18px]" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-ink-100">{new Date(b.createdAt).toLocaleString()}</p>
                      {tag && <Badge tone={tag === 'auto' ? 'blue' : 'neutral'}>{tag === 'auto' ? 'Scheduled' : tag}</Badge>}
                    </div>
                    <p className="truncate text-xs text-ink-500">
                      {formatBytes(b.sizeBytes)} · <span className="font-mono">{b.fileName}</span>
                    </p>
                    <OffsiteChips state={offsite.state} fileName={b.fileName} />
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {canBrowse && (
                      <Button onClick={() => setBrowsing(b)} title="Browse files, compare and restore individual files">
                        <Icon name="search" className="h-4 w-4" /> Files
                      </Button>
                    )}
                    {canRestore && (
                      <Button disabled={busyFile === b.fileName || running} onClick={() => restoreAll(b)} title={running ? 'Stop the server to restore a whole snapshot' : undefined}>
                        <Icon name="restart" className="h-4 w-4" /> Restore all
                      </Button>
                    )}
                    {canBrowse && (
                      <a
                        href={downloadUrl(`/servers/${serverId}/backups/${encodeURIComponent(b.fileName)}/download`)}
                        title="Download snapshot"
                        className="state-layer inline-flex items-center rounded-full px-3 py-2 text-accent-400"
                      >
                        <Icon name="update" className="h-4 w-4" />
                      </a>
                    )}
                    {canCreate && !!offsite.state?.destinations.length && (
                      <Button
                        variant="ghost"
                        title="Copy to off-site storage now"
                        onClick={async () => {
                          try {
                            await api.post(`/servers/${serverId}/offsite/copy`, { fileName: b.fileName });
                            offsite.reload();
                          } catch (err) {
                            toast.error(err instanceof ApiError ? err.message : 'Copy failed');
                          }
                        }}
                      >
                        <Icon name="upload" className="h-4 w-4" />
                      </Button>
                    )}
                    {canCreate && (
                      <Button variant="ghost" disabled={busyFile === b.fileName} onClick={() => deleteSnapshot(b)} title="Delete snapshot">
                        <Icon name="trash" className="h-4 w-4 text-red-400" />
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {canRestore && running && <p className="mt-3 text-xs text-ink-500">Stop the server to restore a whole snapshot. Single files can be restored any time.</p>}
      </Card>

      <OffsiteRestoreCard serverId={serverId} state={offsite.state} canRestore={canRestore} onFetched={() => load()} />

      <Card className="p-5">
        <CardTitle>Snapshot schedule</CardTitle>
        {schedule ? (
          <p className="mb-4 text-sm text-ink-400">
            <span className="font-mono text-ink-200">{schedule.cron_expression}</span> · keeps the last {schedule.retention_count} snapshot(s) ·{' '}
            {schedule.enabled ? 'enabled' : 'paused'}
          </p>
        ) : (
          <p className="mb-4 text-sm text-ink-400">No schedule — snapshots are only taken manually.</p>
        )}
        {canCreate && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((p) => (
                <button
                  key={p.cron}
                  onClick={() => setCronExpression(p.cron)}
                  className={`state-layer rounded-lg border px-3 py-1.5 text-xs font-medium ${
                    cronExpression === p.cron ? 'border-transparent bg-secondary-container text-secondary-on-container' : 'border-surface-500 text-ink-300'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field label="Cron expression">
                <Input value={cronExpression} onChange={(e) => setCronExpression(e.target.value)} className="font-mono" />
              </Field>
              <Field label="Keep last N snapshots">
                <Input type="number" min={1} value={retentionCount} onChange={(e) => setRetentionCount(Number(e.target.value))} />
              </Field>
              <Field label="Status">
                <label className="flex h-[38px] items-center gap-2 text-sm text-ink-300">
                  <input type="checkbox" checked={scheduleEnabled} onChange={(e) => setScheduleEnabled(e.target.checked)} />
                  Run automatically
                </label>
              </Field>
            </div>
            <div className="flex gap-2">
              <Button variant="primary" onClick={saveSchedule} disabled={savingSchedule}>
                {savingSchedule ? 'Saving…' : 'Save schedule'}
              </Button>
              {schedule && (
                <Button variant="ghost" onClick={removeSchedule}>
                  Turn off
                </Button>
              )}
            </div>
          </div>
        )}
      </Card>

      {browsing && <SnapshotBrowser snapshot={browsing} onClose={() => setBrowsing(null)} />}
    </div>
  );
}
