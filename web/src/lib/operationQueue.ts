export type OperationState = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'interrupted';
export interface Operation {
  id: string; title: string; stage: string; status: OperationState; progress: number | null;
  serverId?: string; href?: string; startedAt: number; updatedAt: number;
  followsJob?: boolean;
}
const rows = new Map<string, Operation>();
const listeners = new Set<() => void>();
let snapshot: Operation[] = [];
let batching = false;
function publish() { if (batching) return; const finished = [...rows.values()].filter(row => !operationActive(row)).sort((a, b) => b.updatedAt - a.updatedAt); for (const row of finished.slice(100)) rows.delete(row.id); snapshot = [...rows.values()]; for (const listener of listeners) listener(); }
export function batchOperations(work: () => void) { batching = true; try { work(); } finally { batching = false; publish(); } }
export const operationsSnapshot = () => snapshot;
export function subscribeOperations(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function setOperation(row: Operation) { rows.set(row.id, row); publish(); }
export function updateOperation(id: string, patch: Partial<Operation>) { const row = rows.get(id); if (row) { rows.set(id, { ...row, ...patch, updatedAt: Date.now() }); publish(); } }
export function clearOperations() { rows.clear(); publish(); }
export function forgetOperation(id: string) { if (rows.delete(id)) publish(); }
export const operationActive = (row: Operation) => ['queued', 'running', 'paused'].includes(row.status);
export function operationId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function beginOperation(title: string, serverId?: string, stage = 'Working', href?: string) {
  const id = operationId(), now = Date.now();
  setOperation({ id, title, serverId, stage, href, status: 'running', progress: null, startedAt: now, updatedAt: now });
  return id;
}
export function finishOperation(id: string, error?: unknown) { updateOperation(id, { status: error ? 'failed' : 'completed', progress: error ? null : 100, stage: error ? error instanceof Error ? error.message : String(error) : 'Completed' }); }
// Deliberate writes and the explicitly requested scanner health check enter the queue.
export function describeOperation(path: string, method: string) {
  const clean = path.split('?')[0];
  if ((method === 'GET' && !/\/antivirus\/health$/.test(clean)) || /\/(auth|activity)\b/.test(clean) || /\/(command|presence|leave|versions|dependencies|preview|validate|game-preview|plan)(\/|$)/.test(clean) || /\/transfers(\/|$)/.test(clean)) return null;
  const serverId = clean.match(/^\/servers\/([^/]+)/)?.[1];
  let title = method === 'DELETE' ? 'Remove item' : 'Save changes', section = 'configuration';
  if (/rewind.*points/.test(clean)) { title = method === 'DELETE' ? 'Delete snapshot' : /restore$/.test(clean) ? 'Restore snapshot' : 'Save snapshot'; section = 'rewind'; }
  else if (/backups|snapshot|restore|dedup/.test(clean)) { title = method === 'DELETE' ? 'Delete backup' : /schedule/.test(clean) ? 'Save backup schedule' : /restore/.test(clean) ? 'Restore backup' : 'Save backup'; section = 'backups'; }
  else if (/antivirus/.test(clean)) { title = /scan/.test(clean) ? 'Antivirus scan' : /health|enable|signatures/.test(clean) ? 'Antivirus check' : 'Save antivirus settings'; }
  else if (/offsite/.test(clean)) { title = /copy/.test(clean) ? 'Copy backup off-site' : 'Save off-site settings'; section = 'backups'; }
  else if (/upload|import|artwork|banner/.test(clean)) title = /import/.test(clean) ? 'Import content' : 'Upload content';
  else if (/install|download|workshop/.test(clean)) { title = 'Download / install content'; section = 'console'; }
  else if (/update/.test(clean)) { title = 'Update instance'; section = 'update'; }
  else if (/transfer/.test(clean)) title = 'Transfer instance';
  return { title, serverId, href: serverId ? `/instances/${serverId}/${section}` : '/jobs' };
}
