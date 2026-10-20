import { useEffect, useState } from 'react';
import { useServerDetail } from './ServerContext.js';
import { api, ApiError } from '../../api/client.js';
import { Button, Card, CardTitle, Field, Input, Select } from '../../components/ui.js';
import { useToast } from '../../components/Toast.js';
import { useConfirm } from '../../components/ConfirmDialog.js';

interface Db {
  id: string;
  name: string;
  username: string;
  password: string;
  remote: string;
  host: string;
  port: number;
  hostName: string;
  jdbc: string;
}

/** Configuration → Databases: MySQL/MariaDB databases for this instance's plugins. */
export function DatabasesCard() {
  const { serverId, can } = useServerDetail();
  const toast = useToast();
  const confirm = useConfirm();
  const [data, setData] = useState<{ databases: Db[]; hosts: { id: string; name: string }[] } | null>(null);
  const [name, setName] = useState('');
  const [hostId, setHostId] = useState('');
  const [remote, setRemote] = useState('%');
  const [shown, setShown] = useState<string | null>(null);
  const base = `/servers/${serverId}/databases`;

  useEffect(() => {
    if (!can('settings')) return;
    api.get<typeof data>(base).then(setData).catch(() => setData(null));
  }, [base, can]);
  if (!data || (!data.hosts.length && !data.databases.length)) return null;

  const run = async (fn: () => Promise<typeof data>, ok: string) => {
    try {
      setData(await fn());
      toast.success(ok);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed');
    }
  };
  const copy = (text: string, what: string) => navigator.clipboard?.writeText(text).then(() => toast.success(`${what} copied`));

  return (
    <Card className="p-5">
      <CardTitle>Databases</CardTitle>
      <p className="mb-3 text-sm text-ink-400">MySQL / MariaDB databases for plugins that need one (LuckPerms, CoreProtect, Plan…). Each has its own login that can only reach it.</p>
      {data.databases.length > 0 && (
        <div className="mb-3 space-y-2">
          {data.databases.map((d) => (
            <div key={d.id} className="rounded-2xl bg-surface-900 p-3 text-xs">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm text-ink-100">{d.name}</span>
                <span className="text-ink-400">on {d.hostName}</span>
                <span className="ml-auto flex gap-1">
                  <Button variant="ghost" onClick={() => copy(d.jdbc, 'JDBC URL')}>
                    Copy JDBC URL
                  </Button>
                  <Button variant="ghost" onClick={() => run(() => api.post(`${base}/${d.id}/rotate-password`), 'New password set — update your plugin configs')}>
                    New password
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={async () => {
                      if (await confirm({ title: 'Delete database', message: `Delete ${d.name} and everything in it? This can’t be undone.`, confirmLabel: 'Delete', tone: 'danger' }))
                        run(() => api.delete(`${base}/${d.id}`), 'Database deleted');
                    }}
                  >
                    Delete
                  </Button>
                </span>
              </div>
              <div className="grid gap-x-4 gap-y-0.5 font-mono text-ink-300 sm:grid-cols-2">
                <span>host: {d.host}:{d.port}</span>
                <span>database: {d.name}</span>
                <span>user: {d.username}</span>
                <span>
                  password:{' '}
                  {shown === d.id ? (
                    <button type="button" className="text-ink-100" onClick={() => copy(d.password, 'Password')} title="Copy">
                      {d.password}
                    </button>
                  ) : (
                    <button type="button" className="text-accent-400" onClick={() => setShown(d.id)}>
                      show
                    </button>
                  )}
                </span>
                <span>connections from: {d.remote === '%' ? 'anywhere' : d.remote}</span>
              </div>
            </div>
          ))}
        </div>
      )}
      {data.hosts.length > 0 && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[10rem] flex-1">
            <Field label="New database">
              <Input value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))} placeholder="luckperms" className="font-mono" />
            </Field>
          </div>
          {data.hosts.length > 1 && (
            <div className="w-44">
              <Field label="Host">
                <Select value={hostId} onChange={(e) => setHostId(e.target.value)}>
                  {data.hosts.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          )}
          <div className="w-40">
            <Field label="Connections from">
              <Input value={remote} onChange={(e) => setRemote(e.target.value)} placeholder="% = anywhere" className="font-mono" />
            </Field>
          </div>
          <Button
            variant="primary"
            disabled={!name}
            onClick={() =>
              run(async () => {
                const r = await api.post<typeof data>(base, { name, hostId: hostId || data.hosts[0].id, remote });
                setName('');
                return r;
              }, 'Database created')
            }
          >
            Create
          </Button>
        </div>
      )}
    </Card>
  );
}
