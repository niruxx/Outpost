import { useEffect, useState } from 'react';
import { api, ApiError } from '../api/client.js';
import { Card, CardTitle, Field, Select } from './ui.js';
import { useToast } from './Toast.js';

const CHOICES = [7, 14, 30, 90, 180, 365, 0];
const label = (d: number) => (d === 0 ? 'Forever' : d % 365 === 0 ? `${d / 365} year${d === 365 ? '' : 's'}` : `${d} days`);

/** Admin: how long saved console logs are kept. */
export function ConsoleLogRetentionCard() {
  const toast = useToast();
  const [days, setDays] = useState<number | null>(null);
  useEffect(() => {
    api.get<{ retentionDays: number }>('/console-logs').then((r) => setDays(r.retentionDays)).catch(() => {});
  }, []);
  if (days === null) return null;

  async function change(next: number) {
    try {
      const r = await api.put<{ retentionDays: number; deleted: number }>('/console-logs', { retentionDays: next });
      setDays(r.retentionDays);
      toast.success(`Keeping console logs ${next === 0 ? 'forever' : `for ${label(next).toLowerCase()}`}${r.deleted ? ` — removed ${r.deleted} older file(s)` : ''}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to save');
    }
  }

  return (
    <Card className="p-5">
      <CardTitle>Console logs</CardTitle>
      <p className="mb-3 text-sm text-ink-400">Every instance’s console output is saved per day (Console → Log history). Past days are compressed.</p>
      <Field label="Keep console logs for">
        <Select value={days} onChange={(e) => change(Number(e.target.value))}>
          {(CHOICES.includes(days) ? CHOICES : [days, ...CHOICES]).map((d) => (
            <option key={d} value={d}>
              {label(d)}
            </option>
          ))}
        </Select>
      </Field>
    </Card>
  );
}
