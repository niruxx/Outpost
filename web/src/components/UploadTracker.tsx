import { useEffect, useState } from 'react';
import type { UploadProgress } from '../api/client.js';
import { ProgressBar } from './ui.js';

const size = (n: number) => n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const duration = (n: number) => n < 60 ? `${Math.floor(n)}s` : `${Math.floor(n / 60)}m ${Math.floor(n % 60)}s`;

export function UploadTracker({ progress }: { progress: UploadProgress | null }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!progress) return;
    setElapsed(progress.elapsedSeconds);
    const started = performance.now() - progress.elapsedSeconds * 1000;
    const timer = window.setInterval(() => setElapsed((performance.now() - started) / 1000), 1000);
    return () => window.clearInterval(timer);
  }, [progress]);
  if (!progress) return null;
  const percent = progress.processing ? 100 : progress.percent;
  return (
    <div role="status" aria-live="polite" className="my-3 space-y-2 rounded-xl border border-surface-600 bg-surface-900 p-4 text-sm text-ink-300">
      <ProgressBar percent={percent ?? undefined} label={progress.processing ? 'Upload complete - processing...' : 'Uploading...'} />
      {percent === null && <p className="text-xs">Waiting for the transfer size to calculate percentage...</p>}
      <p className="text-xs text-ink-400">
        {size(progress.loaded)}{progress.total !== null && ` / ${size(progress.total)}`} &middot; {duration(Math.max(elapsed, progress.elapsedSeconds))} elapsed
        {!progress.processing && <> &middot; {size(progress.bytesPerSecond)}/s &middot; {progress.remainingSeconds === null ? 'Estimating time remaining...' : `About ${duration(progress.remainingSeconds)} remaining`}</>}
      </p>
      {progress.processing && <p className="flex items-center gap-2 text-xs text-ink-400"><span className="h-2 w-2 animate-pulse rounded-full bg-accent-400" />Waiting for the server to finish. Keep this page open.</p>}
    </div>
  );
}
