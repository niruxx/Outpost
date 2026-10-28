import { UploadTracker } from './UploadTracker.js';
import type { UploadProgress } from '../api/client.js';
import { useRef, useState } from 'react';
import { api, ApiError, downloadUrl } from '../api/client.js';
import { useToast } from './Toast.js';
import { useConfirm } from './ConfirmDialog.js';
import { Button, Card, Spinner } from './ui.js';

export function EnvironmentBackupCard() {
  const toast = useToast();
  const confirm = useConfirm();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [exporting, setExporting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [importing, setImporting] = useState(false);
  const [restarting, setRestarting] = useState(false);

  async function exportEnvironment() {
    setExporting(true);
    try {
      // Trigger a real browser download (streamed, so large environments don't buffer in JS).
      const a = document.createElement('a');
      a.href = downloadUrl('/environment/export');
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast.success('Export started — check your downloads');
    } finally {
      setTimeout(() => setExporting(false), 1500);
    }
  }

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
    <Card className="mb-6 p-4">
      <UploadTracker progress={uploadProgress} />
      <h2 className="text-base font-medium text-ink-100">Environment backup &amp; restore</h2>
      <p className="mt-1 mb-4 text-xs text-ink-500">
        Exports everything Outpost manages — the database, every server's files and worlds, and all backups — as
        one compressed archive. Import it into a fresh install to move or restore your whole setup.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={exporting} onClick={exportEnvironment}>
          {exporting ? 'Preparing…' : 'Export environment'}
        </Button>
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
        {importing && <span className="text-xs text-ink-500">This can take a while for large environments — don't close this tab.</span>}
      </div>
      <p className="mt-3 text-[11px] text-ink-600">
        Importing stops all servers, requires none currently running, and restarts the panel to apply. Your current
        data isn't deleted — it's kept alongside as a timestamped <code>data-pre-import-…</code> folder.
      </p>
    </Card>
  );
}
