import type { UploadProgress } from '../api/client.js';
const size = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
const duration = (n: number) => n < 60 ? `${Math.ceil(n)}s` : `${Math.floor(n / 60)}m ${Math.ceil(n % 60)}s`;
export function UploadTracker({ progress }: { progress: UploadProgress | null }) {
  if (!progress) return null;
  return <div role="status" className="space-y-2 rounded-lg border border-surface-600 p-3 text-sm text-ink-300">
    <p>{progress.processing ? 'Upload complete. Processing files...' : `Uploading${progress.percent === null ? '...' : ` ${Math.floor(progress.percent)}%`}`}</p>
    <progress aria-label="File upload" max={100} value={progress.percent ?? undefined} className="h-2 w-full accent-accent-400" />
    <p className="text-xs">{size(progress.loaded)}{progress.total !== null && ` / ${size(progress.total)}`} ? {duration(progress.elapsedSeconds)} elapsed
      {!progress.processing && <> ? {size(progress.bytesPerSecond)}/s ? {progress.remainingSeconds === null ? 'Estimating time remaining...' : `About ${duration(progress.remainingSeconds)} remaining`}</>}
    </p>
  </div>;
}
