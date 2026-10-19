import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../../api/client.js';
import type { UpnpConfig } from '../../api/types.js';
import { Badge, Button, Card, CardTitle, ErrorText, Field, Select, Spinner } from '../../components/ui.js';
import { Icon } from '../../components/icons.js';

type StepStatus = 'ok' | 'warn' | 'fail' | 'skip';
interface PortTestResult {
  port: number;
  protocol: 'TCP' | 'UDP';
  publicIp: string | null;
  summary: string;
  steps: { id: string; title: string; status: StepStatus; detail: string }[];
}

const STATUS: Record<StepStatus, { label: string; tone: 'green' | 'yellow' | 'red' | 'neutral' }> = {
  ok: { label: 'OK', tone: 'green' },
  warn: { label: 'Check', tone: 'yellow' },
  fail: { label: 'Problem', tone: 'red' },
  skip: { label: 'Skipped', tone: 'neutral' },
};

/** "Does my forward actually work?" — one port at a time, step by step. */
export function PortTestCard({
  base,
  config,
  defaultPort,
  canTestOutside,
}: {
  base: string;
  config: UpnpConfig;
  defaultPort: number;
  canTestOutside: boolean;
}) {
  // Each enabled rule's first port (both protocols for "TCP + UDP" rules); the instance's port if there are none.
  const choices = useMemo(() => {
    const out: { key: string; externalPort: number; internalPort: number; protocol: 'TCP' | 'UDP'; label: string }[] = [];
    for (const r of config.rules.filter((x) => x.enabled)) {
      for (const protocol of r.protocol === 'BOTH' ? (['TCP', 'UDP'] as const) : [r.protocol as 'TCP' | 'UDP']) {
        const range = r.externalEnd > r.externalStart ? ` (first of ${r.externalStart}–${r.externalEnd})` : '';
        out.push({ key: `${protocol}${r.externalStart}`, externalPort: r.externalStart, internalPort: r.internalStart, protocol, label: `${protocol} ${r.externalStart}${range}${r.label ? ` · ${r.label}` : ''}` });
      }
    }
    if (!out.length) out.push({ key: `TCP${defaultPort}`, externalPort: defaultPort, internalPort: defaultPort, protocol: 'TCP', label: `TCP ${defaultPort} (the instance’s port)` });
    return out;
  }, [config, defaultPort]);

  const [choice, setChoice] = useState(choices[0].key);
  const [busy, setBusy] = useState<'' | 'local' | 'outside'>('');
  const [result, setResult] = useState<PortTestResult | null>(null);
  const [error, setError] = useState('');
  const selected = choices.find((c) => c.key === choice) ?? choices[0];

  useEffect(() => {
    if (!choices.some((c) => c.key === choice)) setChoice(choices[0].key);
  }, [choices, choice]);

  async function run(outside: boolean) {
    setBusy(outside ? 'outside' : 'local');
    setError('');
    try {
      setResult(
        await api.post<PortTestResult>(`${base}/test`, {
          externalPort: selected.externalPort,
          internalPort: selected.internalPort,
          protocol: selected.protocol,
          outside,
        })
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The test failed to run');
    } finally {
      setBusy('');
    }
  }

  const outsideAllowed = canTestOutside && selected.protocol === 'TCP';

  return (
    <Card className="p-5">
      <CardTitle>Test port forwarding</CardTitle>
      <p className="mb-4 text-sm text-ink-400">
        Checks that the router forwards the port to this machine, that something is listening here, and that your connection has a public address. The
        outside check then has <span className="font-medium text-ink-200">portchecker.io</span> try to connect from the internet — it receives your public IP
        and the port, and can only test TCP. (If the router doesn’t report your public IP, it’s looked up through api.ipify.org first.)
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[14rem] flex-1">
          <Field label="Port">
            <Select value={selected.key} onChange={(e) => setChoice(e.target.value)}>
              {choices.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Button onClick={() => run(false)} disabled={!!busy}>
          {busy === 'local' ? <Spinner /> : <Icon name="router" className="h-4 w-4" />} Check router & this machine
        </Button>
        <Button
          variant="primary"
          onClick={() => run(true)}
          disabled={!!busy || !outsideAllowed}
          title={!canTestOutside ? 'Needs the UPnP port forwarding permission' : selected.protocol !== 'TCP' ? 'UDP ports can’t be checked from outside' : undefined}
        >
          {busy === 'outside' ? <Spinner /> : <Icon name="globe" className="h-4 w-4" />} Check from the internet
        </Button>
      </div>
      {selected.protocol === 'UDP' && (
        <p className="mt-2 text-xs text-ink-500">
          UDP can’t be confirmed from outside without the game itself answering — run the router check, then try joining from a phone on mobile data.
        </p>
      )}
      <ErrorText>{error}</ErrorText>

      {result && (
        <div className="mt-4 space-y-2">
          <p className={`text-sm font-medium ${result.steps.some((s) => s.status === 'fail') ? 'text-red-400' : 'text-ink-100'}`}>{result.summary}</p>
          <ul className="divide-y divide-surface-700 overflow-hidden rounded-2xl bg-surface-900">
            {result.steps.map((s) => (
              <li key={s.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink-100">{s.title}</p>
                  <p className="break-words text-xs text-ink-400">{s.detail}</p>
                </div>
                <Badge tone={STATUS[s.status].tone}>{STATUS[s.status].label}</Badge>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
