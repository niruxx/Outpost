import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { beginJob, finishJob, progressJob } from '../services/jobService.js';
import { requestContext } from './requestContext.js';

/** Verbose, line-by-line log callback — mirrors what `npm install --verbose` prints. */
export type LogFn = (line: string) => void;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

/** No network activity for this long is treated as a stalled connection, not a slow one. */
const IDLE_TIMEOUT_MS = 30_000;

/** A timeout that only fires on *inactivity* — call `.arm()` on every byte received so a big
 *  file over a slow-but-steady connection is never killed, only a genuine stall is. */
function idleTimeout() {
  const controller = new AbortController();
  let timer: NodeJS.Timeout;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error(`No data received for ${IDLE_TIMEOUT_MS / 1000}s — connection appears stalled`)), IDLE_TIMEOUT_MS);
  };
  arm();
  return { signal: controller.signal, arm, clear: () => clearTimeout(timer) };
}

export async function fetchJson<T>(url: string, onLog?: LogFn): Promise<T> {
  onLog?.(`> GET ${url}`);
  const idle = idleTimeout();
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Outpost-Panel' }, signal: idle.signal });
    if (!res.ok) throw new Error(`Request to ${url} failed with status ${res.status}`);
    return (await res.json()) as T;
  } catch (err) {
    throw translateAbortError(err, url);
  } finally {
    idle.clear();
  }
}

function translateAbortError(err: unknown, url: string): Error {
  if (err instanceof Error && err.name === 'AbortError') {
    return new Error(`Timed out waiting for ${url} (no response/data — the connection appears stalled)`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

/** Streams a URL to disk, logging periodic byte-progress lines the same way a verbose installer would. */
export async function downloadFile(url: string, destination: string, onProgress?: (pct: number) => void, onLog?: LogFn): Promise<void> {
  const job = beginJob('content-download', requestContext()?.serverId ?? null, `Downloading ${path.basename(destination)}`);
  let last = 0;
  try {
    await downloadFileUntracked(url, destination, pct => { onProgress?.(pct); if (Date.now() - last >= 250) { last = Date.now(); progressJob(job, `Downloading ${path.basename(destination)}`, Math.min(99, pct)); } }, onLog);
    finishJob(job);
  } catch (error) { finishJob(job, error); throw error; }
}
async function downloadFileUntracked(
  url: string,
  destination: string,
  onProgress?: (pct: number) => void,
  onLog?: LogFn
): Promise<void> {
  onLog?.(`> GET ${url}`);
  const idle = idleTimeout();

  let res: Response;
  try {
    res = await fetch(url, { headers: { 'User-Agent': 'Outpost-Panel' }, signal: idle.signal });
  } catch (err) {
    idle.clear();
    throw translateAbortError(err, url);
  }
  if (!res.ok || !res.body) {
    idle.clear();
    throw new Error(`Download failed (${res.status}) for ${url}`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const total = Number(res.headers.get('content-length') ?? 0);
  onLog?.(
    total > 0
      ? `  content-length: ${formatBytes(total)} -> ${path.basename(destination)}`
      : `  streaming -> ${path.basename(destination)} (size unknown)`
  );

  const startedAt = Date.now();
  let received = 0;
  let lastLoggedDecile = -1;
  const nodeStream = Readable.fromWeb(res.body as import('stream/web').ReadableStream);
  const out = fs.createWriteStream(destination);
  nodeStream.on('data', (chunk: Buffer) => {
    idle.arm(); // any data at all resets the stall clock, regardless of overall speed
    received += chunk.length;
    if (total > 0) {
      const pct = Math.round((received / total) * 100);
      onProgress?.(pct);
      const decile = Math.floor(pct / 10);
      if (decile > lastLoggedDecile) {
        lastLoggedDecile = decile;
        onLog?.(`  ... ${pct}% (${formatBytes(received)} / ${formatBytes(total)})`);
      }
    }
  });
  try {
    // pipeline() (not .pipe() + finished()) is what actually matters here: if the source
    // stream errors mid-transfer (a reset connection, our idle-timeout abort, anything),
    // .pipe() alone leaves that error on `nodeStream` with no listener — which Node treats
    // as an uncaught exception and kills the *entire panel process*, not just this install.
    // pipeline() destroys both ends and rejects a single promise with the real error instead.
    await pipeline(nodeStream, out);
  } catch (err) {
    throw translateAbortError(err, url);
  } finally {
    idle.clear();
  }
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  onLog?.(`  done in ${seconds}s (${formatBytes(received)})`);
}
