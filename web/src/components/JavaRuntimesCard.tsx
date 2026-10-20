import { useCallback, useEffect, useState } from 'react';
import { setVisibleInterval } from '../lib/perf.js';
import { api, ApiError } from '../api/client.js';
import { Badge, Button, Card, CardTitle, Select, Spinner } from './ui.js';
import { useToast } from './Toast.js';
import { useConfirm } from './ConfirmDialog.js';

export interface JavaRuntime {
  id: string;
  path: string;
  major: number;
  version: string;
  vendor: string | null;
  managed: boolean;
}
interface JavaJob {
  major: number;
  status: 'downloading' | 'extracting' | 'done' | 'failed';
  progress: number;
  error: string | null;
}
export interface JavaInfo {
  runtimes: JavaRuntime[];
  available: number[];
  lts: number[];
  jobs: JavaJob[];
}

const NEEDED_BY: Record<number, string> = {
  8: 'Minecraft 1.16 and older',
  16: 'Minecraft 1.17',
  17: 'Minecraft 1.18 – 1.20.4',
  21: 'Minecraft 1.20.5 – 1.21.x',
  25: 'Minecraft 26.1 and newer',
};

/** Configuration → Java runtimes: what's on the host, and one-click Temurin installs. */
export function JavaRuntimesCard() {
  const toast = useToast();
  const confirm = useConfirm();
  const [info, setInfo] = useState<JavaInfo | null>(null);
  const [pick, setPick] = useState('');

  const load = useCallback(async (refresh = false) => {
    try {
      setInfo(await api.get<JavaInfo>(`/java${refresh ? '?refresh=1' : ''}`));
    } catch {
      setInfo(null);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const working = info?.jobs.some((j) => j.status === 'downloading' || j.status === 'extracting');
  useEffect(() => {
    if (!working) return;
    const t = setVisibleInterval(() => load(true), 2000);
    return () => t();
  }, [working, load]);

  if (!info) return null;
  const installedManaged = new Set(info.runtimes.filter((r) => r.managed).map((r) => r.major));
  const choices = info.available.filter((m) => !installedManaged.has(m));

  async function install(major: number) {
    try {
      await api.post('/java/install', { major });
      toast.success(`Downloading Java ${major}…`);
      setPick('');
      load(true);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to start the install');
    }
  }
  async function remove(major: number) {
    if (!(await confirm({ title: 'Remove Java runtime', message: `Remove Java ${major}? Instances that use it switch to another installed Java on their next start.`, confirmLabel: 'Remove', tone: 'danger' }))) return;
    try {
      await api.delete(`/java/${major}`);
      load(true);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to remove');
    }
  }

  return (
    <Card className="p-5">
      <CardTitle action={<Badge tone={info.runtimes.length ? 'green' : 'yellow'}>{info.runtimes.length} found</Badge>}>Java runtimes</CardTitle>
      <p className="mb-3 text-sm text-ink-400">
        Each Java instance starts with the Java its Minecraft version needs, unless its launch settings pick one. Outpost uses Javas already on this machine, or downloads Eclipse Temurin for you.
      </p>
      {info.runtimes.length === 0 ? (
        <p className="text-sm text-ink-500">No Java found yet — install one below.</p>
      ) : (
        <div className="divide-y divide-surface-700 overflow-hidden rounded-2xl bg-surface-900">
          {info.runtimes.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
              <span className="w-16 font-medium text-ink-100">Java {r.major}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs text-ink-300">
                  {r.version}
                  {r.vendor ? ` · ${r.vendor}` : ''}
                  {NEEDED_BY[r.major] ? ` · ${NEEDED_BY[r.major]}` : ''}
                </span>
                <span className="block truncate font-mono text-[11px] text-ink-500">{r.path}</span>
              </span>
              <Badge tone={r.managed ? 'blue' : 'neutral'}>{r.managed ? 'Outpost' : 'System'}</Badge>
              {r.managed && (
                <Button variant="ghost" onClick={() => remove(r.major)}>
                  Remove
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
      {info.jobs
        .filter((j) => j.status !== 'done')
        .map((j) => (
          <p key={j.major} className={`mt-2 text-xs ${j.status === 'failed' ? 'text-red-400' : 'text-ink-300'}`}>
            {j.status === 'failed' ? (
              `Java ${j.major}: ${j.error}`
            ) : (
              <span className="inline-flex items-center gap-2">
                <Spinner className="h-3 w-3" /> Java {j.major}: {j.status === 'extracting' ? 'unpacking…' : `downloading ${j.progress}%`}
              </span>
            )}
          </p>
        ))}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Select value={pick} onChange={(e) => setPick(e.target.value)} className="!w-auto">
          <option value="">Install Java…</option>
          {choices.map((m) => (
            <option key={m} value={m}>
              Java {m}
              {info.lts.includes(m) ? ' (LTS)' : ''}
              {NEEDED_BY[m] ? ` — ${NEEDED_BY[m]}` : ''}
            </option>
          ))}
        </Select>
        <Button variant="primary" disabled={!pick} onClick={() => install(Number(pick))}>
          Install
        </Button>
        <Button variant="ghost" onClick={() => load(true)}>
          Re-scan
        </Button>
      </div>
    </Card>
  );
}
