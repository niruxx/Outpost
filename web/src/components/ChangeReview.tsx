import { api } from '../api/client.js';
import { useConfirm } from './ConfirmDialog.js';
interface Change { key: string; before: unknown; after: unknown }
const flatten = (value: unknown, prefix = ''): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? Object.assign({}, ...Object.entries(value).map(([k, v]) => flatten(v, prefix ? `${prefix}.${k}` : k))) : { [prefix]: value };
export function useChangeReview() {
  const confirm = useConfirm();
  return async (before: unknown, after: unknown, note = 'Changes apply on the next start unless marked as a live setting.', validated?: { serverId: string; kind: string; input: unknown }) => {
    let changes: Change[];
    if (validated) { const result = await api.post<{ changes: Change[]; note: string }>(`/workspace/game-preview/${validated.serverId}/${validated.kind}`, validated.input); changes = result.changes; note = result.note; }
    else { const a = flatten(before), b = flatten(after); changes = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k])).map(key => ({ key, before: /password|secret|token|gslt|login/i.test(key) ? '[hidden]' : a[key] ?? null, after: /password|secret|token|gslt|login/i.test(key) ? '[changed]' : b[key] ?? null })); }
    return confirm({ title: 'Review configuration changes', confirmLabel: 'Apply reviewed changes', message: <div className="space-y-3"><p>{note}</p>{validated && <p className="text-xs text-success-500">Configuration validation passed.</p>}<div className="max-h-80 space-y-2 overflow-auto">{changes.map(c => <div key={c.key} className="rounded-xl bg-surface-900 p-3"><strong className="break-all">{c.key}</strong><div className="grid gap-2 sm:grid-cols-2"><pre className="whitespace-pre-wrap break-all text-xs text-ink-400">Before: {JSON.stringify(c.before)}</pre><pre className="whitespace-pre-wrap break-all text-xs text-ink-100">After: {JSON.stringify(c.after)}</pre></div></div>)}{!changes.length && <p>No value changes detected.</p>}</div></div> });
  };
}
