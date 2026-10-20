import { useEffect, useState } from 'react';
import { api, ApiError } from '../api/client.js';
import { Badge, Button, Card, CardTitle, Field, Input, Select } from './ui.js';
import { useToast } from './Toast.js';
import { useConfirm } from './ConfirmDialog.js';

type DestType = 's3' | 'sftp';
interface Destination {
  id: string;
  name: string;
  type: DestType;
  enabled: boolean;
  keep: number;
  config: Record<string, string | number | boolean>;
}

const EMPTY_S3 = { endpoint: 'https://s3.us-east-1.amazonaws.com', region: 'us-east-1', bucket: '', accessKeyId: '', secretAccessKey: '', prefix: 'outpost', pathStyle: true };
const EMPTY_SFTP = { host: '', port: 22, username: '', password: '', privateKey: '', path: 'outpost-backups' };

/** Configuration → Off-site backups (admins): where snapshots get copied. */
export function OffsiteCard() {
  const toast = useToast();
  const confirm = useConfirm();
  const [list, setList] = useState<Destination[] | null>(null);
  const [adding, setAdding] = useState<DestType | null>(null);
  const [name, setName] = useState('');
  const [keep, setKeep] = useState('7');
  const [cfg, setCfg] = useState<Record<string, string | number | boolean>>(EMPTY_S3);
  const [testing, setTesting] = useState('');

  useEffect(() => {
    api.get<{ destinations: Destination[] }>('/offsite').then((r) => setList(r.destinations)).catch(() => setList([]));
  }, []);
  if (!list) return null;

  const run = async (fn: () => Promise<{ destinations: Destination[] }>, ok: string) => {
    try {
      setList((await fn()).destinations);
      toast.success(ok);
      return true;
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed');
      return false;
    }
  };
  const field = (key: string, label: string, opts: { type?: string; placeholder?: string; mono?: boolean } = {}) => (
    <Field label={label}>
      <Input
        type={opts.type ?? 'text'}
        value={String(cfg[key] ?? '')}
        onChange={(e) => setCfg({ ...cfg, [key]: opts.type === 'number' ? Number(e.target.value) : e.target.value })}
        placeholder={opts.placeholder}
        className={opts.mono ? 'font-mono' : ''}
        autoComplete="off"
      />
    </Field>
  );

  async function test(d: Destination) {
    setTesting(d.id);
    try {
      const r = await api.post<{ ok: boolean; error?: string }>(`/offsite/${d.id}/test`);
      if (r.ok) toast.success(`${d.name}: connection works`);
      else toast.error(`${d.name}: ${r.error}`);
    } finally {
      setTesting('');
    }
  }

  return (
    <Card className="p-5">
      <CardTitle
        action={
          !adding && (
            <Select
              value=""
              onChange={(e) => {
                const t = e.target.value as DestType;
                setAdding(t);
                setCfg(t === 's3' ? EMPTY_S3 : EMPTY_SFTP);
                setName(t === 's3' ? 'S3 storage' : 'Backup server');
              }}
              className="!w-auto !py-1 text-xs"
            >
              <option value="">Add destination…</option>
              <option value="s3">S3-compatible storage</option>
              <option value="sftp">SFTP server</option>
            </Select>
          )
        }
      >
        Off-site backups
      </CardTitle>
      <p className="mb-3 text-sm text-ink-400">
        Every new snapshot (manual or scheduled) is copied to the destinations below — AWS S3, Backblaze B2, Wasabi, Cloudflare R2, any S3-compatible storage, or another machine over SFTP. Restore from them on an instance’s Backups tab.
      </p>
      {list.length > 0 && (
        <div className="mb-3 divide-y divide-surface-700 overflow-hidden rounded-2xl bg-surface-900">
          {list.map((d) => (
            <div key={d.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-ink-100">{d.name}</span>
                <span className="block truncate font-mono text-[11px] text-ink-400">
                  {d.type === 's3' ? `s3://${d.config.bucket}/${d.config.prefix}/ · ${d.config.endpoint}` : `sftp://${d.config.username}@${d.config.host}:${d.config.port}/${d.config.path}`}
                </span>
              </span>
              <Badge>{d.keep ? `keeps ${d.keep}` : 'keeps all'}</Badge>
              <label className="flex items-center gap-1 text-xs text-ink-300">
                <input type="checkbox" checked={d.enabled} onChange={(e) => run(() => api.put(`/offsite/${d.id}`, { enabled: e.target.checked }), e.target.checked ? 'Copies on' : 'Copies paused')} />
                Copy new snapshots
              </label>
              <Button variant="ghost" disabled={testing === d.id} onClick={() => test(d)}>
                {testing === d.id ? 'Testing…' : 'Test'}
              </Button>
              <Button
                variant="ghost"
                onClick={async () => {
                  if (await confirm({ title: 'Remove destination', message: `Stop copying to “${d.name}”? Copies already there are left alone.`, confirmLabel: 'Remove', tone: 'danger' }))
                    run(() => api.delete(`/offsite/${d.id}`), 'Destination removed');
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
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Copies to keep per instance (0 = all)">
              <Input type="number" min={0} value={keep} onChange={(e) => setKeep(e.target.value)} />
            </Field>
            {adding === 's3' ? (
              <>
                {field('endpoint', 'Endpoint', { placeholder: 'https://s3.us-east-1.amazonaws.com', mono: true })}
                {field('region', 'Region', { placeholder: 'us-east-1' })}
                {field('bucket', 'Bucket', { mono: true })}
                {field('prefix', 'Folder in the bucket', { mono: true })}
                {field('accessKeyId', 'Access key ID', { mono: true })}
                {field('secretAccessKey', 'Secret access key', { type: 'password', mono: true })}
              </>
            ) : (
              <>
                {field('host', 'Host', { mono: true })}
                {field('port', 'Port', { type: 'number' })}
                {field('username', 'Username', { mono: true })}
                {field('password', 'Password (or a private key below)', { type: 'password' })}
                {field('path', 'Folder', { mono: true })}
              </>
            )}
          </div>
          {adding === 's3' && (
            <label className="flex items-center gap-2 text-sm text-ink-300">
              <input type="checkbox" checked={cfg.pathStyle !== false} onChange={(e) => setCfg({ ...cfg, pathStyle: e.target.checked })} />
              Path-style URLs (endpoint/bucket/…) — needed by most non-AWS storage
            </label>
          )}
          {adding === 'sftp' && (
            <Field label="Private key (optional, OpenSSH/PEM)">
              <textarea
                value={String(cfg.privateKey ?? '')}
                onChange={(e) => setCfg({ ...cfg, privateKey: e.target.value })}
                rows={3}
                className="ui-input w-full rounded-lg border border-surface-500 bg-transparent px-3 py-2 font-mono text-xs text-ink-100 outline-none focus:border-accent-400"
              />
            </Field>
          )}
          <div className="flex gap-2">
            <Button
              variant="primary"
              onClick={async () => {
                if (await run(() => api.post('/offsite', { type: adding, name, keep: Number(keep), config: cfg }), 'Destination added — use Test to check it')) setAdding(null);
              }}
            >
              Add
            </Button>
            <Button variant="ghost" onClick={() => setAdding(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
