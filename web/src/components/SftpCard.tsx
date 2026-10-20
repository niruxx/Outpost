import { useEffect, useState } from 'react';
import { api, ApiError } from '../api/client.js';
import { Badge, Button, Card, CardTitle, Field, Input, Notice } from './ui.js';
import { useToast } from './Toast.js';

interface KeyInfo {
  type: string;
  fingerprint: string;
  comment: string;
}
interface SftpView {
  settings: { enabled: boolean; port: number };
  state: { running: boolean; port: number | null; error: string | null };
  hostKeyFingerprint: string | null;
  me: { hasPassword: boolean; keys: KeyInfo[] };
}

/** Configuration → SFTP: the server switch (admins) and your own SFTP password and keys. */
export function SftpCard({ isAdmin }: { isAdmin: boolean }) {
  const toast = useToast();
  const [v, setV] = useState<SftpView | null>(null);
  const [port, setPort] = useState('');
  const [password, setPassword] = useState('');
  const [key, setKey] = useState('');

  useEffect(() => {
    api
      .get<SftpView>('/sftp')
      .then((r) => {
        setV(r);
        setPort(String(r.settings.port));
      })
      .catch(() => {});
  }, []);
  if (!v) return null;

  const run = async (fn: () => Promise<SftpView>, ok: string) => {
    try {
      setV(await fn());
      toast.success(ok);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed');
    }
  };

  return (
    <Card className="p-5">
      <CardTitle action={<Badge tone={v.state.running ? 'green' : v.settings.enabled ? 'red' : 'neutral'}>{v.state.running ? `Port ${v.state.port}` : v.settings.enabled ? 'Not running' : 'Off'}</Badge>}>SFTP</CardTitle>
      <p className="mb-3 text-sm text-ink-400">
        Connect with FileZilla, WinSCP or <span className="font-mono">sftp</span> to an instance’s folder. Each instance’s File Management page shows its login name. You see only the instances (and permissions) you have in the panel.
      </p>
      {v.state.error && (
        <div className="mb-3">
          <Notice tone="error">{v.state.error}</Notice>
        </div>
      )}
      {isAdmin && (
        <div className="mb-4 flex flex-wrap items-end gap-2">
          <label className="mr-2 flex items-center gap-2 text-sm text-ink-200">
            <input type="checkbox" checked={v.settings.enabled} onChange={(e) => run(() => api.put<SftpView>('/sftp/settings', { enabled: e.target.checked }), e.target.checked ? 'SFTP is on' : 'SFTP is off')} />
            Run the SFTP server
          </label>
          <div className="w-28">
            <Field label="Port">
              <Input type="number" min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value)} />
            </Field>
          </div>
          <Button disabled={Number(port) === v.settings.port} onClick={() => run(() => api.put<SftpView>('/sftp/settings', { port: Number(port) }), 'Port saved')}>
            Save port
          </Button>
        </div>
      )}
      {v.hostKeyFingerprint && v.settings.enabled && (
        <p className="mb-3 text-xs text-ink-400">
          Server key: <span className="font-mono text-ink-200">{v.hostKeyFingerprint}</span> — check it matches the first time you connect.
        </p>
      )}
      <div className="space-y-3 rounded-2xl bg-surface-900 p-3">
        <p className="text-sm font-medium text-ink-100">Your SFTP login</p>
        <p className="text-xs text-ink-400">
          SFTP uses its own password (not your panel one), so it can’t get around two-factor sign-in. You can also add SSH keys.{' '}
          {v.me.hasPassword ? <Badge tone="green">Password set</Badge> : <Badge tone="yellow">No password</Badge>}
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[12rem] flex-1">
            <Field label={v.me.hasPassword ? 'New SFTP password' : 'SFTP password'}>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" placeholder="at least 10 characters" />
            </Field>
          </div>
          <Button
            variant="primary"
            disabled={password.length < 10}
            onClick={() =>
              run(async () => {
                const r = await api.put<SftpView>('/sftp/me/password', { password });
                setPassword('');
                return r;
              }, 'SFTP password saved')
            }
          >
            Save
          </Button>
          {v.me.hasPassword && (
            <Button variant="ghost" onClick={() => run(() => api.put<SftpView>('/sftp/me/password', { password: null }), 'SFTP password removed')}>
              Remove
            </Button>
          )}
        </div>
        {v.me.keys.map((k) => (
          <div key={k.fingerprint} className="flex items-center gap-2 text-xs">
            <span className="font-mono text-ink-200">{k.type}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-ink-400">{k.fingerprint}</span>
            <span className="text-ink-400">{k.comment}</span>
            <Button variant="ghost" onClick={() => run(() => api.delete<SftpView>(`/sftp/me/keys/${encodeURIComponent(k.fingerprint)}`), 'Key removed')}>
              Remove
            </Button>
          </div>
        ))}
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[12rem] flex-1">
            <Field label="Add an SSH public key">
              <Input value={key} onChange={(e) => setKey(e.target.value)} placeholder="ssh-ed25519 AAAA… you@laptop" className="font-mono" />
            </Field>
          </div>
          <Button
            disabled={!key.trim()}
            onClick={() =>
              run(async () => {
                const r = await api.post<SftpView>('/sftp/me/keys', { key });
                setKey('');
                return r;
              }, 'Key added')
            }
          >
            Add key
          </Button>
        </div>
      </div>
    </Card>
  );
}

/** File Management → how to connect to this instance over SFTP. */
export function SftpConnectInfo({ serverId }: { serverId: string }) {
  const [info, setInfo] = useState<{ enabled: boolean; port: number; username: string; canRead: boolean; canWrite: boolean; me: { hasPassword: boolean; keys: KeyInfo[] } } | null>(null);
  useEffect(() => {
    api.get<typeof info>(`/servers/${serverId}/sftp`).then(setInfo).catch(() => setInfo(null));
  }, [serverId]);
  if (!info?.enabled || !info.canRead) return null;
  const host = window.location.hostname;
  return (
    <div className="rounded-2xl bg-surface-850 px-4 py-3 text-xs text-ink-300">
      <span className="font-medium text-ink-100">SFTP</span> · <span className="font-mono">sftp://{info.username}@{host}:{info.port}</span>
      {!info.canWrite && ' · read-only'}
      {!info.me.hasPassword && !info.me.keys.length && <span className="text-yellow-400"> · set an SFTP password under Configuration → SFTP first</span>}
    </div>
  );
}
