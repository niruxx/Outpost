import { useEffect, useState } from 'react';
import { useServerDetail } from './ServerContext.js';
import { api, ApiError } from '../../api/client.js';
import { Badge, Button, Card, CardTitle, Field, Input, Notice, Select } from '../../components/ui.js';
import { useToast } from '../../components/Toast.js';

type Protocol = 'source' | 'webrcon';
interface RconView {
  config: { enabled: boolean; protocol: Protocol; host: string; port: number; useForConsole: boolean; hasPassword: boolean } | null;
  defaults: { protocol: Protocol; port: number; autoConfigure: boolean; note: string | null } | null;
  running: boolean;
}

/** Configuration → RCON: a remote console for games whose own console doesn't take input well. */
export function RconCard() {
  const { serverId, can } = useServerDetail();
  const toast = useToast();
  const [data, setData] = useState<RconView | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [protocol, setProtocol] = useState<Protocol>('source');
  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState('');
  const [password, setPassword] = useState('');
  const [useForConsole, setUseForConsole] = useState(false);
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const base = `/servers/${serverId}/rcon`;
  const canEdit = can('launch');

  const apply = (v: RconView) => {
    setData(v);
    const c = v.config;
    setEnabled(c?.enabled ?? false);
    setProtocol(c?.protocol ?? v.defaults?.protocol ?? 'source');
    setHost(c?.host ?? '127.0.0.1');
    setPort(String(c?.port ?? v.defaults?.port ?? ''));
    setUseForConsole(c?.useForConsole ?? false);
    setPassword('');
  };
  useEffect(() => {
    api.get<RconView>(base).then(apply).catch(() => setData(null));
  }, [base]);

  if (!data?.defaults) return null;

  async function save(generatePassword = false) {
    setBusy('save');
    try {
      const v = await api.put<RconView & { configured: string | null }>(base, {
        enabled,
        protocol,
        host,
        port: Number(port),
        password: password || undefined,
        useForConsole,
        generatePassword,
      });
      apply(v);
      toast.success(v.configured ?? 'RCON settings saved');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to save');
    } finally {
      setBusy('');
    }
  }

  async function test() {
    setBusy('test');
    setResult(null);
    try {
      const r = await api.post<{ ok: boolean; command: string; reply?: string; error?: string }>(`${base}/test`);
      setResult(r.ok ? { ok: true, text: `“${r.command}” → ${r.reply?.trim() || '(empty reply)'}` } : { ok: false, text: r.error ?? 'Failed' });
    } catch (err) {
      setResult({ ok: false, text: err instanceof ApiError ? err.message : 'Failed' });
    } finally {
      setBusy('');
    }
  }

  const d = data.defaults;
  return (
    <Card className="p-5">
      <CardTitle action={<Badge tone={data.config?.enabled ? 'green' : 'neutral'}>{data.config?.enabled ? 'On' : 'Off'}</Badge>}>RCON console</CardTitle>
      <p className="mb-3 text-sm text-ink-400">
        A remote console for games whose own console doesn’t take input well (Rust, Source games on Windows, ARK, Palworld).
        {d.autoConfigure ? ' Outpost switches RCON on in the game for you.' : ''}
      </p>
      {d.note && (
        <div className="mb-3">
          <Notice tone="info">{d.note}</Notice>
        </div>
      )}
      <fieldset disabled={!canEdit} className="space-y-3">
        <label className="flex items-center gap-2 text-sm text-ink-200">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Turn on RCON
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Protocol">
            <Select value={protocol} onChange={(e) => setProtocol(e.target.value as Protocol)}>
              <option value="source">Source RCON (TCP) — Source games, Minecraft, ARK, Palworld…</option>
              <option value="webrcon">WebRCON (WebSocket) — Rust</option>
            </Select>
          </Field>
          <Field label="Port">
            <Input type="number" min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value)} placeholder={String(d.port)} />
          </Field>
          <Field label="Host">
            <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="127.0.0.1" className="font-mono" />
          </Field>
          <Field label={data.config?.hasPassword ? 'Password (saved — type to change)' : 'Password'}>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={data.config?.hasPassword ? '••••••••' : 'leave empty to generate one'} autoComplete="new-password" />
          </Field>
        </div>
        <label className="flex items-start gap-2 text-sm text-ink-200">
          <input type="checkbox" className="mt-0.5" checked={useForConsole} onChange={(e) => setUseForConsole(e.target.checked)} />
          <span>
            Send console commands through RCON
            <span className="block text-xs text-ink-400">The Console box, player actions and stop commands use RCON instead of the server’s standard input.</span>
          </span>
        </label>
      </fieldset>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {canEdit && (
          <>
            <Button variant="primary" disabled={!!busy} onClick={() => save()}>
              Save
            </Button>
            {data.config?.hasPassword && (
              <Button variant="ghost" disabled={!!busy} onClick={() => save(true)}>
                New password
              </Button>
            )}
          </>
        )}
        {can('console') && data.config?.hasPassword && (
          <Button disabled={!!busy || !data.running} onClick={test} title={data.running ? undefined : 'Start the server first'}>
            {busy === 'test' ? 'Testing…' : 'Test connection'}
          </Button>
        )}
      </div>
      {result && <p className={`mt-3 whitespace-pre-wrap break-words font-mono text-xs ${result.ok ? 'text-green-400' : 'text-red-400'}`}>{result.text}</p>}
    </Card>
  );
}
