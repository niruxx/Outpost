/**
 * Long-running privileged host tasks (sos reports, certificate issuance) that stream output to the
 * page. One task per slot at a time; the latest task per slot is kept so a page opened later can
 * show how it went.
 */
import crypto from 'node:crypto';
import { HttpError } from '../utils/asyncHandler.js';

export interface HostJob {
  id: string;
  slot: string;
  label: string;
  state: 'running' | 'succeeded' | 'failed';
  output: string;
  error: string | null;
  result: unknown;
  startedAt: string;
  finishedAt: string | null;
  startedBy: string;
}

const MAX_OUTPUT = 512 * 1024;
const jobs = new Map<string, HostJob>();

export function getHostJob(slot: string): HostJob | null {
  return jobs.get(slot) ?? null;
}

export function startHostJob(
  slot: string,
  label: string,
  startedBy: string,
  run: (onProgress: (chunk: string) => void) => Promise<unknown>,
  onDone?: (job: HostJob) => void
): HostJob {
  if (jobs.get(slot)?.state === 'running') throw new HttpError(409, 'That task is already running');
  const job: HostJob = { id: crypto.randomUUID(), slot, label, state: 'running', output: '', error: null, result: null, startedAt: new Date().toISOString(), finishedAt: null, startedBy };
  jobs.set(slot, job);
  const append = (chunk: string) => {
    job.output += chunk;
    if (job.output.length > MAX_OUTPUT) job.output = `…\n${job.output.slice(-MAX_OUTPUT)}`;
  };
  run(append)
    .then(
      (result) => {
        job.state = 'succeeded';
        job.result = result ?? null;
      },
      (err: unknown) => {
        job.state = 'failed';
        job.error = err instanceof Error ? err.message : 'Failed';
        append(`\n${job.error}\n`);
      }
    )
    .finally(() => {
      job.finishedAt = new Date().toISOString();
      onDone?.(job);
    });
  return job;
}
