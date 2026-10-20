import { useEffect, useState } from 'react';
import { useServerDetail } from './ServerContext.js';
import { api, ApiError } from '../../api/client.js';
import { Badge, Button, Card, CardTitle, Field, Input, Notice, Select } from '../../components/ui.js';
import { useToast } from '../../components/Toast.js';
import { useAuth } from '../../state/AuthContext.js';

interface Limits {
  cpuPercent: number | null;
  memoryMb: number | null;
  tasks: number | null;
  diskMb: number | null;
  diskAction: 'warn' | 'stop';
}
interface LimitsView {
  limits: Limits;
  support: { available: boolean; method: 'systemd' | 'container' | 'none'; reason: string | null };
  disk: { usedMb: number; limitMb: number | null; over: boolean };
}

const str = (n: number | null) => (n ? String(n) : '');

/** Configuration → Resource limits: CPU, memory, processes and disk for this instance (admins edit). */
export function LimitsCard() {
  const { serverId } = useServerDetail();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const toast = useToast();
  const [v, setV] = useState<LimitsView | null>(null);
  const [draft, setDraft] = useState({ cpuPercent: '', memoryMb: '', tasks: '', diskMb: '', diskAction: 'warn' as 'warn' | 'stop' });
  const base = `/servers/${serverId}/limits`;

  const apply = (r: LimitsView) => {
    setV(r);
    setDraft({ cpuPercent: str(r.limits.cpuPercent), memoryMb: str(r.limits.memoryMb), tasks: str(r.limits.tasks), diskMb: str(r.limits.diskMb), diskAction: r.limits.diskAction });
  };
  useEffect(() => {
    api.get<LimitsView>(base).then(apply).catch(() => setV(null));
  }, [base]);
  if (!v) return null;
  const any = v.limits.cpuPercent || v.limits.memoryMb || v.limits.tasks || v.limits.diskMb;
  if (!isAdmin && !any) return null;

  async function save() {
    try {
      apply(
        await api.put<LimitsView>(base, {
          cpuPercent: draft.cpuPercent ? Number(draft.cpuPercent) : null,
          memoryMb: draft.memoryMb ? Number(draft.memoryMb) : null,
          tasks: draft.tasks ? Number(draft.tasks) : null,
          diskMb: draft.diskMb ? Number(draft.diskMb) : null,
          diskAction: draft.diskAction,
        })
      );
      toast.success('Limits saved — CPU, memory and process limits apply from the next start');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to save');
    }
  }

  const diskPct = v.disk.limitMb ? Math.min(100, Math.round((v.disk.usedMb / v.disk.limitMb) * 100)) : null;
  return (
    <Card className="p-5">
      <CardTitle action={any ? <Badge tone={v.disk.over ? 'red' : 'green'}>{v.disk.over ? 'Over disk limit' : 'Limited'}</Badge> : <Badge>No limits</Badge>}>Resource limits</CardTitle>
      <p className="mb-3 text-sm text-ink-400">
        Caps so one instance can’t starve the others.{' '}
        {v.support.method === 'container'
          ? 'Applied as the container’s own limits.'
          : v.support.available
            ? 'CPU, memory and processes are enforced by the Linux kernel (systemd scope).'
            : ''}{' '}
        Disk is checked every few minutes; going over blocks uploads and starts.
      </p>
      {!v.support.available && v.support.reason && (
        <div className="mb-3">
          <Notice tone="warning">{v.support.reason}</Notice>
        </div>
      )}
      <div className="mb-3 text-xs text-ink-300">
        Disk: {v.disk.usedMb.toLocaleString()} MB used{v.disk.limitMb ? ` of ${v.disk.limitMb.toLocaleString()} MB` : ''}
        {diskPct !== null && (
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-700">
            <div className={`h-full ${v.disk.over ? 'bg-red-400' : diskPct > 85 ? 'bg-yellow-400' : 'bg-accent-400'}`} style={{ width: `${diskPct}%` }} />
          </div>
        )}
      </div>
      <fieldset disabled={!isAdmin} className="grid gap-3 sm:grid-cols-2">
        <Field label="CPU (% of one core — 200 = two cores)">
          <Input type="number" min={10} value={draft.cpuPercent} onChange={(e) => setDraft({ ...draft, cpuPercent: e.target.value })} placeholder="unlimited" />
        </Field>
        <Field label="Memory hard limit (MB)">
          <Input type="number" min={128} value={draft.memoryMb} onChange={(e) => setDraft({ ...draft, memoryMb: e.target.value })} placeholder="unlimited" />
        </Field>
        <Field label="Processes / threads">
          <Input type="number" min={16} value={draft.tasks} onChange={(e) => setDraft({ ...draft, tasks: e.target.value })} placeholder="unlimited" />
        </Field>
        <Field label="Disk (MB)">
          <Input type="number" min={100} value={draft.diskMb} onChange={(e) => setDraft({ ...draft, diskMb: e.target.value })} placeholder="unlimited" />
        </Field>
        <Field label="When over the disk limit">
          <Select value={draft.diskAction} onChange={(e) => setDraft({ ...draft, diskAction: e.target.value as 'warn' | 'stop' })}>
            <option value="warn">Warn and block uploads</option>
            <option value="stop">Also stop the server</option>
          </Select>
        </Field>
      </fieldset>
      {isAdmin && (
        <div className="mt-4">
          <Button variant="primary" onClick={save}>
            Save
          </Button>
        </div>
      )}
    </Card>
  );
}
