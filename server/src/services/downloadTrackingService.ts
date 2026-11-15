import type { RequestHandler } from 'express';
import { beginJob, finishJob, progressJob } from './jobService.js';
import { requestContext } from '../utils/requestContext.js';

/** Tracks attachment bytes sent by the panel; the browser owns saving them to the user's disk. */
export const trackDownloads: RequestHandler = (req, res, next) => {
  if (req.method !== 'GET') return next();
  const context = requestContext();
  let job: string | undefined, sent = 0, last = 0, label = 'Sending file to browser';
  const explicit = !!context?.operationId && /download|export/.test(req.path);
  const record = (chunk?: unknown, encoding?: unknown) => {
    if (!req.auth || (!explicit && !/^attachment/i.test(String(res.getHeader('Content-Disposition') ?? '')))) return;
    try {
      if (!job) {
        const disposition = String(res.getHeader('Content-Disposition') ?? '');
        const name = disposition.match(/filename="?([^";]+)/i)?.[1]?.slice(0, 160);
        label = name ? `Sending ${name} to browser` : label;
        job = beginJob('download', context?.serverId ?? null, label);
      }
      sent += typeof chunk === 'string' ? Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding as BufferEncoding : 'utf8') : chunk instanceof Uint8Array ? chunk.byteLength : 0;
      if (Date.now() - last >= 250) {
        last = Date.now();
        const total = Number(res.getHeader('Content-Length'));
        progressJob(job, label, total > 0 ? Math.min(99, sent / total * 100) : null);
      }
    } catch { /* Telemetry must not prevent a download (including environment export shutdown). */ }
  };
  const write = res.write, end = res.end;
  res.write = function (this: typeof res, chunk: unknown, ...args: unknown[]) { record(chunk, args[0]); return Reflect.apply(write, this, [chunk, ...args]); } as typeof res.write;
  res.end = function (this: typeof res, chunk?: unknown, ...args: unknown[]) { record(chunk, args[0]); return Reflect.apply(end, this, [chunk, ...args]); } as typeof res.end;
  res.once('finish', () => {
    record();
    if (job) try {
      finishJob(job, res.statusCode >= 400 ? new Error(`Download failed (HTTP ${res.statusCode})`) : undefined);
      if (res.statusCode < 400) progressJob(job, 'Sent to browser — check your browser downloads for the saved file', 100);
    } catch { /* See telemetry note above. */ }
  });
  res.once('close', () => { if (job && !res.writableFinished) try { finishJob(job, new Error('Download connection closed before transmission finished')); } catch {} });
  next();
};
