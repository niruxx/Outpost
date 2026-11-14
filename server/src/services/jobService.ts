import crypto from 'node:crypto';
import { prep } from '../db/db.js';

export interface PanelJob { id: string; server_id: string | null; kind: string; status: string; stage: string; progress: number | null; logs: string[]; created_at: number; updated_at: number }
type Row = Omit<PanelJob, 'logs'> & { logs: string };
export function jobRows(): PanelJob[] { return (prep('SELECT * FROM panel_jobs ORDER BY created_at DESC LIMIT 300').all() as unknown as Row[]).map(r => ({ ...r, logs: JSON.parse(r.logs) })); }
export function beginJob(kind: string, serverId: string | null, stage = 'Preparing') {
  const id = crypto.randomUUID(), at = Date.now();
  prep('INSERT INTO panel_jobs(id,server_id,kind,status,stage,progress,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(id, serverId, kind, 'running', stage, 0, at, at);
  return id;
}
export function progressJob(id: string, stage: string, progress: number | null = null) {
  stage = stage.replace(/((?:password|token|api[_-]?key|secret|authorization)\s*[=:]\s*)[^\s&]+/gi, '$1[redacted]').replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1[redacted]@');
  const old = prep('SELECT logs,stage FROM panel_jobs WHERE id=?').get(id) as { logs: string; stage: string } | undefined;
  if (!old) return;
  const logs: string[] = JSON.parse(old.logs);
  if (old.stage !== stage) logs.push(`${new Date().toISOString()} ${stage.slice(0, 500)}`);
  prep('UPDATE panel_jobs SET stage=?,progress=?,logs=?,updated_at=? WHERE id=?').run(stage.slice(0, 500), progress === null ? null : Math.max(0, Math.min(100, progress)), JSON.stringify(logs.slice(-100)), Date.now(), id);
}
export function finishJob(id: string, error?: unknown) {
  progressJob(id, error ? (error instanceof Error ? error.message : String(error)) : 'Completed', error ? null : 100);
  prep('UPDATE panel_jobs SET status=? WHERE id=?').run(error ? 'failed' : 'completed', id);
}
export function recoverJobs() {
  prep("UPDATE panel_jobs SET status='interrupted',stage='Panel restarted before completion was confirmed',updated_at=? WHERE status='running'").run(Date.now());
  prep("DELETE FROM panel_jobs WHERE status!='running' AND id NOT IN (SELECT id FROM panel_jobs ORDER BY created_at DESC LIMIT 2000)").run();
}
