import { useEffect, useState } from 'react';
import { api, ApiError } from '../api/client.js';
import { Badge, Button, Card, CardTitle, Field, Input } from './ui.js';
import { useToast } from './Toast.js';
import { useConfirm } from './ConfirmDialog.js';

interface DbHost {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  publicHost: string;
  maxDatabases: number;
  databases: number;
}

/** Configuration → Databases (admins): MySQL/MariaDB servers instances can create databases on. */
export function DbHostsCard() {
  const toast = useToast();
  const confirm = useConfirm();
  const [hosts, setHosts] = useState<DbHost[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', host: '127.0.0.1', port: '3306', username: '', password: '', publicHost: '', maxDatabases: '0' });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<{ hosts: DbHost[] }>('/database-hosts').then((r) => setHosts(r.hosts)).catch(() => setHosts([]));
  }, []);
  if (!hosts) return null;

  async function add() {
    setSaving(true);
    try {
      const r = await api.post<{ hosts: DbHost[] }>('/database-hosts', { ...form, port: Number(form.port), maxDatabases: Number(form.maxDatabases) });
      setHosts(r.hosts);
      setAdding(false);
      toast.success('Database host added — instances can create databases on it now');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to add');
    } finally {
      setSaving(false);
    }
  }
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  return (
    <Card className="p-5">
      <CardTitle action={!adding && <Button onClick={() => setAdding(true)}>Add host</Button>}>Databases</CardTitle>
      <p className="mb-3 text-sm text-ink-400">
        MySQL / MariaDB servers that instances can create their own databases on (for plugins like LuckPerms, CoreProtect or Plan). Give Outpost an account with{' '}
        <span className="font-mono text-ink-200">ALL PRIVILEGES … WITH GRANT OPTION</span>; each database gets its own user that can only reach it.
      </p>
      {hosts.length > 0 && (
        <div className="mb-3 divide-y divide-surface-700 overflow-hidden rounded-2xl bg-surface-900">
          {hosts.map((h) => (
            <div key={h.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-ink-100">{h.name}</span>
                <span className="block font-mono text-[11px] text-ink-400">
                  {h.username}@{h.host}:{h.port}
                  {h.publicHost ? ` · players see ${h.publicHost}` : ''}
                </span>
              </span>
              <Badge>
                {h.databases} database{h.databases === 1 ? '' : 's'}
                {h.maxDatabases ? ` / ${h.maxDatabases}` : ''}
              </Badge>
              <Button
                variant="ghost"
                onClick={async () => {
                  try {
                    const r = await api.post<{ version: string }>(`/database-hosts/${h.id}/test`);
                    toast.success(`${h.name}: connected (${r.version})`);
                  } catch (err) {
                    toast.error(err instanceof ApiError ? err.message : 'Failed');
                  }
                }}
              >
                Test
              </Button>
              <Button
                variant="ghost"
                onClick={async () => {
                  if (!(await confirm({ title: 'Remove database host', message: `Remove “${h.name}”? (Only possible once no instance has databases on it.)`, confirmLabel: 'Remove', tone: 'danger' }))) return;
                  try {
                    setHosts((await api.delete<{ hosts: DbHost[] }>(`/database-hosts/${h.id}`)).hosts);
                  } catch (err) {
                    toast.error(err instanceof ApiError ? err.message : 'Failed');
                  }
                }}
              >
                Remove
              </Button>
            </div>
          ))}
        </div>
      )}
      {adding && (
        <div className="space-y-3 rounded-2xl bg-surface-900 p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name">
              <Input value={form.name} onChange={set('name')} placeholder="Main MariaDB" />
            </Field>
            <Field label="Host">
              <Input value={form.host} onChange={set('host')} className="font-mono" />
            </Field>
            <Field label="Port">
              <Input type="number" value={form.port} onChange={set('port')} />
            </Field>
            <Field label="Address players/plugins use (optional)">
              <Input value={form.publicHost} onChange={set('publicHost')} placeholder="same as host" className="font-mono" />
            </Field>
            <Field label="Username">
              <Input value={form.username} onChange={set('username')} className="font-mono" autoComplete="off" />
            </Field>
            <Field label="Password">
              <Input type="password" value={form.password} onChange={set('password')} autoComplete="new-password" />
            </Field>
            <Field label="Max databases on this host (0 = no limit)">
              <Input type="number" min={0} value={form.maxDatabases} onChange={set('maxDatabases')} />
            </Field>
          </div>
          <div className="flex gap-2">
            <Button variant="primary" disabled={saving || !form.username} onClick={add}>
              {saving ? 'Connecting…' : 'Add'}
            </Button>
            <Button variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
