import { UploadTracker } from './UploadTracker.js';
import type { UploadProgress } from '../api/client.js';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, downloadUrl } from '../api/client.js';
import { useToast } from './Toast.js';
import { useConfirm } from './ConfirmDialog.js';
import { Button, Card, ErrorText, Field, Notice, Select, Spinner } from './ui.js';
import { Icon } from './icons.js';

interface ExportPreview {
  blockers: string[];
  instances: { id: string; name: string }[];
}

const exportParts = [
  ['includeDatabase', 'Panel database', 'Accounts, permissions, settings, and configurations for selected instances'],
  ['includeFiles', 'Instance files', 'Worlds, saves, mods, and game configuration files'],
  ['includeSnapshots', 'Existing snapshots', 'ZIP and deduplicated backups from active storage'],
  ['includeRestorePoints', 'World restore points', 'Stored World Rewind history'],
  ['includeSupportFiles', 'Host support files', 'Installed tools and runtimes, plus applicable panel data'],
] as const;
type ExportFlag = (typeof exportParts)[number][0];
const defaultExport: Record<ExportFlag, boolean> & { instanceIds: string[] | null } = {
  includeDatabase: true, includeFiles: true, includeSnapshots: true,
  includeRestorePoints: true, includeSupportFiles: true, instanceIds: null,
};

export function EnvironmentBackupCard() {
  const toast = useToast();
  const confirm = useConfirm();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [scope, setScope] = useState<'environment' | 'instance'>('environment');
  const [options, setOptions] = useState(defaultExport);
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  const [checking, setChecking] = useState(true);
  const [previewError, setPreviewError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [instance, setInstance] = useState('');
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [importing, setImporting] = useState(false);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    let current = true;
    setChecking(true);
    setPreviewError('');
    api.post<ExportPreview>('/environment/export/preview', options)
      .then((result) => { if (current) setPreview(result); })
      .catch((err) => { if (current) setPreviewError(err instanceof Error ? err.message : 'Could not check backup availability.'); })
      .finally(() => { if (current) setChecking(false); });
    return () => { current = false; };
  }, [options, refresh]);

  function changeOptions(patch: Partial<typeof options>) {
    setChecking(true);
    setOptions((current) => ({ ...current, ...patch }));
  }

  const actionStyle = 'state-layer inline-flex min-h-10 w-fit max-w-full items-center gap-2 rounded-full border border-surface-600 px-4 py-2 text-sm font-medium text-ink-100 hover:bg-surface-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-400';

  async function importEnvironment(file: File) {
    const ok = await confirm({
      title: 'Import environment',
      message: (
        <>
          Import <span className="font-mono text-ink-100">{file.name}</span>? This{' '}
          <strong className="text-red-400">replaces everything</strong> in this Outpost install — all users,
          servers, and backups — with what's in the archive. The current data is kept as a timestamped backup on
          disk, but every account (including yours) will be replaced.
        </>
      ),
      confirmLabel: 'Import & replace everything',
      tone: 'danger',
    });
    if (!ok) {
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    setImporting(true);
    const formData = new FormData();
    formData.append('archive', file);
    try {
      const res = await api.upload<{ message: string }>('/environment/import', formData, setUploadProgress);
      toast.success(res.message);
      setRestarting(true);
    } catch (err) {
      if (err instanceof ApiError) {
        toast.error(err.message);
      } else {
        // A dropped connection here can also mean the import succeeded and the process is
        // already restarting (the server may exit before the HTTP response finishes).
        toast.show("Lost the connection — if the import actually started, Outpost is restarting now. Wait a few seconds and reload.");
        setRestarting(true);
      }
    } finally {
      setImporting(false);
      setUploadProgress(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  if (restarting) {
    return (
      <Card className="mb-6 p-4">
        <div className="flex items-center gap-3">
          <Spinner className="h-5 w-5 text-accent-400" />
          <div>
            <p className="text-sm font-semibold text-ink-100">Outpost is restarting…</p>
            <p className="text-xs text-ink-400">
              This page will stop responding for a few seconds. Reload once it's back, then sign in with an admin
              account from the restored backup.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card className="mb-6 space-y-5 p-4 sm:p-5">
      <UploadTracker progress={uploadProgress} />
      <fieldset className="min-w-0 space-y-3">
        <legend className="text-base font-medium text-ink-100">Create a backup</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {([
            ['environment', 'Environment export', 'Choose which instances and data to download'],
            ['instance', 'Single instance backup', 'Create and manage snapshots for one instance'],
          ] as const).map(([value, title, detail]) => (
            <label key={value} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 ${scope === value ? 'border-accent-400 bg-surface-850' : 'border-surface-700'}`}>
              <input className="mt-1" name="backup-scope" type="radio" checked={scope === value} onChange={() => setScope(value)} />
              <span className="min-w-0"><span className="block text-sm font-medium text-ink-100">{title}</span><span className="block text-xs text-ink-400">{detail}</span></span>
            </label>
          ))}
        </div>
      </fieldset>
      <ErrorText>{previewError}</ErrorText>
      {scope === 'environment' ? (
        <form className="space-y-4" method="post" action={downloadUrl('/environment/export')} target="_blank"
          onSubmit={(e) => {
            if (checking || previewError || !preview || preview.blockers.length) e.preventDefault();
            else toast.show('Export requested. Check your browser downloads.');
          }}>
          <input type="hidden" name="options" value={JSON.stringify(options)} />
          <Field label="Instances to export">
            <Select value={options.instanceIds === null ? 'all' : 'selected'} disabled={!preview}
              onChange={(e) => changeOptions({ instanceIds: e.target.value === 'all' ? null : preview?.instances.map(({ id }) => id) ?? [] })}>
              <option value="all">All instances</option>
              <option value="selected">Choose instances</option>
            </Select>
          </Field>
          {options.instanceIds !== null && preview && (
            <fieldset className="min-w-0 space-y-2 rounded-xl border border-surface-700 p-3">
              <legend className="px-1 text-sm font-medium text-ink-100">Selected instances ({options.instanceIds.length})</legend>
              <div className="flex flex-wrap gap-2">
                <Button type="button" onClick={() => changeOptions({ instanceIds: preview.instances.map(({ id }) => id) })}>Select all</Button>
                <Button type="button" onClick={() => changeOptions({ instanceIds: [] })}>Clear selection</Button>
              </div>
              <div className="grid max-h-48 gap-1 overflow-y-auto sm:grid-cols-2">
                {preview.instances.map(({ id, name }) => (
                  <label key={id} className="flex min-w-0 items-start gap-2 rounded-lg p-1.5 text-sm text-ink-200">
                    <input className="mt-1" type="checkbox" checked={options.instanceIds?.includes(id) ?? false}
                      onChange={(e) => {
                        const ids = options.instanceIds ?? [];
                        changeOptions({ instanceIds: e.target.checked ? [...ids, id] : ids.filter((value) => value !== id) });
                      }} />
                    <span className="min-w-0 break-words">{name}</span>
                  </label>
                ))}
                {!preview.instances.length && <p className="text-sm text-ink-400">No instances are available.</p>}
              </div>
            </fieldset>
          )}
          <fieldset className="min-w-0 space-y-2">
            <legend className="text-sm font-medium text-ink-100">Include in the ZIP</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {exportParts.map(([key, label, description]) => (
                <label key={key} className="flex min-w-0 items-start gap-2 rounded-xl border border-surface-700 p-2.5 text-sm text-ink-200">
                  <input className="mt-1" type="checkbox" checked={options[key]} onChange={(e) => changeOptions({ [key]: e.target.checked })} />
                  <span className="min-w-0"><span className="block font-medium">{label}</span><span className="block text-xs text-ink-400">{description}</span></span>
                </label>
              ))}
            </div>
          </fieldset>
          {!options.includeDatabase && <Notice tone="info">This creates a files-only ZIP. Environment restore requires the panel database.</Notice>}
          {options.includeDatabase && !options.includeFiles && <Notice tone="info">Instance configurations will be included. Restored instances will need their files before they can start.</Notice>}
          {!checking && preview?.blockers.length ? (
            <ul className="list-disc space-y-1 break-words pl-5 text-sm text-amber-400" role="status">
              {preview.blockers.map((blocker, i) => <li key={i}>{blocker}</li>)}
            </ul>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="primary" disabled={checking || !!previewError || !preview || !!preview.blockers.length}>
              <Icon name="download" className="h-4 w-4" /> {options.includeDatabase ? 'Download environment ZIP' : 'Download files ZIP'}
            </Button>
            {checking && <span role="status" className="inline-flex items-center gap-2 text-sm text-ink-400"><Spinner /> Checking availability…</span>}
            {!checking && (previewError || !!preview?.blockers.length) && <Button type="button" onClick={() => setRefresh((value) => value + 1)}>Check again</Button>}
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-full min-w-0 sm:w-64">
            <Field label="Instance">
              <Select value={instance} onChange={(e) => setInstance(e.target.value)} disabled={!preview?.instances.length}>
                <option value="">{preview?.instances.length ? 'Choose an instance' : preview ? 'No instances' : 'Loading instances…'}</option>
                {preview?.instances.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
              </Select>
            </Field>
          </div>
          {preview?.instances.some(({ id }) => id === instance) && <Link to={`/instances/${encodeURIComponent(instance)}/backups`} className={actionStyle}>Open instance backups</Link>}
          {previewError && <Button onClick={() => setRefresh((value) => value + 1)}>Try again</Button>}
        </div>
      )}
      <div className="space-y-2 border-t border-surface-700 pt-4">
        <h2 className="text-sm font-medium text-ink-100">Restore the whole environment</h2>
        <p className="text-xs text-ink-400">Stop all instances first. Import replaces Outpost’s data and restarts the panel. The previous data is retained on disk.</p>
        <input
          ref={fileInputRef}
          type="file"
          accept=".zip"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) importEnvironment(file);
          }}
        />
        <Button variant="danger" disabled={importing} onClick={() => fileInputRef.current?.click()}>
          {importing ? 'Importing…' : 'Import environment…'}
        </Button>
        {importing && <p className="text-xs text-ink-500">Keep this tab open while the archive uploads.</p>}
      </div>
    </Card>
  );
}
