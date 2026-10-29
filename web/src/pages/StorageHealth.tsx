import { Badge } from '../components/ui.js';

export interface DiskHealth {
  status: 'passed' | 'warning' | 'failed' | 'unknown' | 'unavailable'; checkedAt: string;
  temperatureC?: number; powerOnHours?: number; selfTest?: string; remainingPercent?: number; error?: string;
}
export function StorageHealth({ health, refreshing, detail = false }: { health?: DiskHealth; refreshing?: boolean; detail?: boolean }) {
  if (!health) return <span className="mt-2 block text-xs text-ink-500">SMART: {refreshing ? 'Checking health…' : 'Not checked'}</span>;
  const tone = health.status === 'passed' ? 'green' : health.status === 'failed' ? 'red' : health.status === 'warning' ? 'yellow' : 'neutral';
  return <span className="mt-2 block space-y-1 text-xs">
    <span className="flex flex-wrap items-center gap-2"><Badge tone={tone}>SMART: {health.status}</Badge>{health.temperatureC !== undefined && <span>{health.temperatureC} °C</span>}{health.powerOnHours !== undefined && <span>{health.powerOnHours.toLocaleString()} hours</span>}</span>
    {health.selfTest && <span className="block">Self-test: {health.selfTest}{health.remainingPercent !== undefined ? ` (${health.remainingPercent}% remaining)` : ''}</span>}
    {detail && health.error && <span className="block break-words text-ink-400">{health.error}</span>}
    <span className="block text-ink-500">Checked {new Date(health.checkedAt).toLocaleString()}{refreshing ? ' · refreshing' : ''}</span>
  </span>;
}
