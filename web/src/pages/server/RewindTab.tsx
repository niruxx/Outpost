import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { setVisibleInterval } from '../../lib/perf.js';
import { useServerDetail } from './ServerContext.js';
import { api, ApiError } from '../../api/client.js';
import { Badge, Button, Card, CardTitle, ErrorText, Field, Input, Modal, Notice, Select, Spinner } from '../../components/ui.js';
import { Icon } from '../../components/icons.js';
import { useToast } from '../../components/Toast.js';
import { useConfirm } from '../../components/ConfirmDialog.js';
import { formatBytes } from './StatusTab.js';

interface RestorePoint {
  id: string;
  createdAt: string;
  reason: 'auto' | 'manual' | 'before-restore';
  worlds: string[];
  newBytes: number;
  totalBytes: number;
  fileCount: number;
}
interface RewindView {
  supported: boolean;
  config: { enabled: boolean; intervalMinutes: number; keep: number };
  intervals: number[];
  running: boolean;
  worlds: string[];
  points: RestorePoint[];
  levelDat: { world: string; current: string | null; previous: string | null }[];
}

const REASON: Record<RestorePoint['reason'], { label: string; tone: 'neutral' | 'blue' | 'yellow' }> = {
  auto: { label: 'Automatic', tone: 'neutral' },
  manual: { label: 'Manual', tone: 'blue' },
  'before-restore': { label: 'Before a restore', tone: 'yellow' },
};

/** "world_nether" → "Nether"; Bedrock's "worlds/Bedrock level" → "Bedrock level". */
function worldLabel(dir: string): string {
  if (dir.endsWith('_nether')) return 'Nether';
  if (dir.endsWith('_the_end')) return 'The End';
  return dir.replace(/^worlds\//, '') + (dir.startsWith('worlds/') ? '' : ' (Overworld)');
}

function ago(iso: string): string {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export function RewindTab() {
  const { serverId, can } = useServerDetail();
  const toast = useToast();
  const confirm = useConfirm();
  const [data, setData] = useState<RewindView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [cfg, setCfg] = useState<RewindView['config'] | null>(null);
  const [restoring, setRestoring] = useState<RestorePoint | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const base = `/servers/${serverId}/rewind`;
  const canCreate = can('backups.create');
  const canRestore = can('backups.restore');

  const load = useCallback(async () => {
    try {
      const v = await api.get<RewindView>(base);
      setData(v);
      setCfg((c) => c ?? v.config);
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load restore points');
    }
  }, [base]);

  useEffect(() => {
    load();
    const t = setVisibleInterval(load, 15000);
    return () => t();
  }, [load]);

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setBusy('');
    }
  }

  if (error) return <div className="space-y-3"><ErrorText>{error}</ErrorText><Link className="text-sm text-accent-400 underline" to={`/instances/${serverId}/configuration`}>Configure backup storage</Link></div>;
  if (!data || !cfg) return <Spinner />;
  if (!data.supported) return <Notice tone="info">World Rewind is for Minecraft Java and Bedrock instances.</Notice>;
  const dirty = JSON.stringify(cfg) !== JSON.stringify(data.config);

  return (
    <div className="space-y-5">
      <p className="text-sm text-ink-400">Restore points use this instance’s <Link className="text-accent-400 underline" to={`/instances/${serverId}/configuration`}>configured backup storage</Link>.</p>
      <Card className="p-5">
        <CardTitle action={<Badge tone={data.config.enabled ? 'green' : 'neutral'}>{data.config.enabled ? `Every ${data.config.intervalMinutes} min` : 'Off'}</Badge>}>World Rewind</CardTitle>
        <p className="mb-4 text-sm text-ink-400">
          Minecraft’s autosave overwrites the world in place, so Outpost keeps restore points for you: while the server runs it pauses saving for a moment,
          copies the world, and carries on. Unchanged files are shared between points, so each one only costs what changed. Separate from full snapshots on
          the Backup Schedule tab.
        </p>
        {data.worlds.length === 0 && (
          <div className="mb-4">
            <Notice tone="info">No world yet — start the server once so it generates one.</Notice>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="flex items-center gap-2 rounded-2xl bg-surface-900 p-3 text-sm text-ink-200">
            <input type="checkbox" checked={cfg.enabled} disabled={!canCreate} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} />
            Take restore points automatically
          </label>
          <Field label="Every">
            <Select value={cfg.intervalMinutes} disabled={!canCreate} onChange={(e) => setCfg({ ...cfg, intervalMinutes: Number(e.target.value) })}>
              {data.intervals.map((m) => (
                <option key={m} value={m}>
                  {m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? '' : 's'}`}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Keep the newest">
            <Input type="number" min={1} max={200} value={cfg.keep} disabled={!canCreate} onChange={(e) => setCfg({ ...cfg, keep: Number(e.target.value) })} />
          </Field>
        </div>
        {canCreate && (
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={!dirty || busy === 'cfg'}
              onClick={() =>
                run('cfg', async () => {
                  const v = await api.put<RewindView>(`${base}/config`, cfg);
                  setData(v);
                  setCfg(v.config);
                  toast.success(v.config.enabled ? `Restore points every ${v.config.intervalMinutes} minutes while running` : 'Automatic restore points off');
                })
              }
            >
              Save
            </Button>
            <Button
              disabled={busy === 'take' || !data.worlds.length}
              onClick={() =>
                run('take', async () => {
                  setData(await api.post<RewindView>(`${base}/points`));
                  toast.success('Restore point taken');
                })
              }
            >
              {busy === 'take' ? <Spinner /> : <Icon name="plus" className="h-4 w-4" />} Take one now
            </Button>
          </div>
        )}
        <p className="mt-3 text-xs text-ink-500">Automatic points are only taken while the server runs, and skipped when nothing changed. Manual and pre-restore points are kept until you delete them.</p>
      </Card>

      <Card className="p-5">
        <CardTitle action={<span className="text-xs text-ink-400">{data.points.length} point{data.points.length === 1 ? '' : 's'}</span>}>Restore points</CardTitle>
        {data.running && canRestore && data.points.length > 0 && (
          <div className="mb-3">
            <Notice tone="warning">Stop the server to restore — a running server would overwrite the world again on its next save.</Notice>
          </div>
        )}
        {data.points.length === 0 ? (
          <p className="text-sm text-ink-500">None yet.</p>
        ) : (
          <div className="divide-y divide-surface-700 overflow-hidden rounded-2xl bg-surface-900">
            {data.points.map((p) => (
              <div key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-ink-100">{new Date(p.createdAt).toLocaleString()}</span>
                    <span className="text-xs text-ink-500">{ago(p.createdAt)}</span>
                    <Badge tone={REASON[p.reason].tone}>{REASON[p.reason].label}</Badge>
                  </div>
                  <p className="text-xs text-ink-400">
                    {p.worlds.map(worldLabel).join(' · ')} · {formatBytes(p.totalBytes)} world, {formatBytes(p.newBytes)} new
                  </p>
                </div>
                <div className="flex w-full flex-wrap justify-end gap-2 sm:w-auto">
                  {canRestore && (
                    <Button
                      disabled={data.running}
                      title={data.running ? 'Stop the server first' : undefined}
                      onClick={() => {
                        setRestoring(p);
                        setChosen(p.worlds);
                      }}
                    >
                      Restore…
                    </Button>
                  )}
                  {canCreate && (
                    <Button
                      variant="ghost"
                      aria-label="Delete restore point"
                      onClick={async () => {
                        const ok = await confirm({ title: 'Delete restore point', message: `Delete the restore point from ${new Date(p.createdAt).toLocaleString()}?`, confirmLabel: 'Delete', tone: 'danger' });
                        if (ok) run('del', async () => setData(await api.delete<RewindView>(`${base}/points/${p.id}`)));
                      }}
                    >
                      <Icon name="trash" className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {data.levelDat.length > 0 && (
        <Card className="p-5">
          <CardTitle>World settings file (level.dat)</CardTitle>
          <p className="mb-3 text-sm text-ink-400">
            Minecraft keeps the previous copy as level.dat_old on every save. If the world won’t load, or spawn, time or game rules got scrambled, roll back to it.
          </p>
          <div className="divide-y divide-surface-700 overflow-hidden rounded-2xl bg-surface-900">
            {data.levelDat.map((l) => (
              <div key={l.world} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink-100">{worldLabel(l.world)}</p>
                  <p className="text-xs text-ink-400">
                    current {l.current ? new Date(l.current).toLocaleString() : 'missing'} · previous {l.previous ? new Date(l.previous).toLocaleString() : 'none'}
                  </p>
                </div>
                {canRestore && (
                  <Button
                    disabled={!l.previous || data.running || busy === `ld-${l.world}`}
                    title={data.running ? 'Stop the server first' : undefined}
                    onClick={async () => {
                      const ok = await confirm({
                        title: 'Restore level.dat',
                        message: `Replace ${l.world}/level.dat with level.dat_old? The current file is kept as a backup next to it.`,
                        confirmLabel: 'Restore',
                        tone: 'danger',
                      });
                      if (ok)
                        run(`ld-${l.world}`, async () => {
                          setData(await api.post<RewindView>(`${base}/level-dat`, { world: l.world }));
                          toast.success('level.dat restored — start the server to check it');
                        });
                    }}
                  >
                    Use the previous one
                  </Button>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      <Modal open={!!restoring} onClose={() => setRestoring(null)} title="Restore world">
        {restoring && (
          <div className="space-y-4">
            <p className="text-sm text-ink-300">
              Roll back to <span className="font-medium text-ink-100">{new Date(restoring.createdAt).toLocaleString()}</span>. The world as it is now is saved as a
              restore point first, so this can be undone.
            </p>
            <div className="space-y-2">
              {restoring.worlds.map((w) => (
                <label key={w} className="flex items-center gap-2 text-sm text-ink-200">
                  <input type="checkbox" checked={chosen.includes(w)} onChange={(e) => setChosen((c) => (e.target.checked ? [...c, w] : c.filter((x) => x !== w)))} />
                  {worldLabel(w)}
                </label>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setRestoring(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={!chosen.length || busy === 'restore'}
                onClick={() =>
                  run('restore', async () => {
                    const v = await api.post<RewindView & { restored: string[] }>(`${base}/points/${restoring.id}/restore`, { worlds: chosen });
                    setData(v);
                    setRestoring(null);
                    toast.success(`Restored ${v.restored.map(worldLabel).join(', ')}`);
                  })
                }
              >
                {busy === 'restore' ? 'Restoring…' : 'Restore'}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
