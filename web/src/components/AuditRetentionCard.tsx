import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api/client.js';
import { Card, CardTitle, Field, Select, Spinner } from './ui.js';
import { useToast } from './Toast.js';
import { useConfirm } from './ConfirmDialog.js';

interface AuditStats {
  retentionDays: number;
  choices: number[];
  count: number;
  oldest: string | null;
}

const label = (d: number) => (d === 0 ? 'Forever (default)' : d % 365 === 0 ? `${d / 365} year${d === 365 ? '' : 's'}` : `${d} days`);

/** Admin: how long the audit log keeps entries. */
export function AuditRetentionCard() {
  const toast = useToast();
  const confirm = useConfirm();
  const [stats, setStats] = useState<AuditStats | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<AuditStats>('/audit/settings').then(setStats).catch(() => {});
  }, []);

  async function change(days: number) {
    if (!stats) return;
    if (days && stats.oldest && Date.now() - Date.parse(stats.oldest) > days * 86_400_000) {
      const ok = await confirm({
        title: 'Delete older audit entries',
        message: `Entries older than ${label(days).toLowerCase()} will be deleted now, and from then on automatically. This can’t be undone.`,
        confirmLabel: 'Keep ' + label(days).toLowerCase(),
        tone: 'danger',
      });
      if (!ok) return;
    }
    setSaving(true);
    try {
      const next = await api.put<AuditStats>('/audit/settings', { retentionDays: days });
      const removed = stats.count - next.count;
      setStats(next);
      toast.success(days ? `Keeping ${label(days).toLowerCase()}${removed > 0 ? ` — removed ${removed} older entries` : ''}` : 'Keeping audit entries forever');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="p-5">
      <CardTitle>Audit log</CardTitle>
      {!stats ? (
        <Spinner />
      ) : (
        <div className="space-y-3 text-sm text-ink-300">
          <p>
            {stats.count.toLocaleString()} entr{stats.count === 1 ? 'y' : 'ies'}
            {stats.oldest ? `, oldest from ${new Date(stats.oldest).toLocaleDateString()}` : ''}. Every entry records who, what, when, and the address and
            browser it came from. <Link to="/audit" className="text-accent-400 hover:underline">Open the audit log</Link>
          </p>
          <div className="max-w-xs">
            <Field label="Keep entries for">
              <Select value={stats.retentionDays} disabled={saving} onChange={(e) => change(Number(e.target.value))}>
                {stats.choices.map((d) => (
                  <option key={d} value={d}>
                    {label(d)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <p className="text-xs text-ink-500">Older entries are removed automatically every hour. Export to CSV first if you need a permanent copy.</p>
        </div>
      )}
    </Card>
  );
}
