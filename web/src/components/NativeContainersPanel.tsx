import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import type { NativeContainer, NativeContainerDetails } from '../api/types.js';
import { Badge, Button, Card, CardTitle, ErrorText, Field, Input, Modal, Notice, Select, Spinner } from './ui.js';
import { useConfirm } from './ConfirmDialog.js';
import { useToast } from './Toast.js';

export function NativeContainersPanel({ containers, onRefresh }: { containers: NativeContainer[]; onRefresh: () => Promise<void> }) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const filtered = containers.filter((c) => `${c.name} ${c.image} ${c.composeProject || ''}`.toLowerCase().includes(search.toLowerCase()));
  return <Card className="space-y-4 p-5"><CardTitle>Containers on this engine</CardTitle>
    <p className="text-sm text-ink-400">All running and stopped containers, including Docker CLI, Compose and Portainer workloads. No import is needed; existing mounts, ports and labels stay with their containers.</p>
    <Input aria-label="Search host containers" placeholder="Search by name, image or Compose project" value={search} onChange={(e) => setSearch(e.target.value)} />
    {!containers.length && <p className="text-sm text-ink-500">No containers found on this engine.</p>}
    <div className="space-y-2">{filtered.map((c) => <button key={c.id} onClick={() => setSelected(c.id)} className="w-full rounded-xl bg-surface-900 p-3 text-left hover:bg-surface-700">
      <span className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium text-ink-100">{c.name}</span><Badge tone={c.state === 'running' ? 'green' : c.state === 'paused' ? 'yellow' : 'neutral'}>{c.state}</Badge><Badge tone="blue">{c.instance ? 'Outpost instance' : c.instanceId ? 'Outpost-labelled' : 'External'}</Badge>{c.composeProject && <span className="text-xs text-ink-400">Compose: {c.composeProject}</span>}</span>
      <span className="mt-1 block break-all font-mono text-xs text-ink-400">{c.image} · {c.id.slice(0, 12)}</span><span className="mt-1 block break-all text-xs text-ink-500">{c.status}{c.ports ? ` · ${c.ports}` : ''}</span>
    </button>)}</div>
    <ContainerModal id={selected} onClose={() => setSelected(null)} onRefresh={onRefresh} />
  </Card>;
}
function ContainerModal({ id, onClose, onRefresh }: { id: string | null; onClose: () => void; onRefresh: () => Promise<void> }) {
  const activeId = useRef(id); activeId.current = id;
  const [container, setContainer] = useState<NativeContainerDetails | null>(null);
  const [logs, setLogs] = useState(''), [logError, setLogError] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false);
  const [restart, setRestart] = useState('no'), [memory, setMemory] = useState(0), [cpus, setCpus] = useState(0);
  const [removeName, setRemoveName] = useState('');
  const confirm = useConfirm(), toast = useToast();
  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true); setError('');
    try {
      const result = await api.get<{ container: NativeContainerDetails }>(`/docker/containers/${id}`);
      if (activeId.current !== id) return;
      setContainer(result.container); setRestart(result.container.restartPolicy); setMemory(result.container.memoryMb ?? 0); setCpus(result.container.cpus ?? 0);
    } catch (err) { if (activeId.current === id) { setContainer(null); setError(err instanceof Error ? err.message : 'Container unavailable'); } }
    finally { if (activeId.current === id) setLoading(false); }
  }, [id]);
  async function loadLogs() {
    if (!id) return;
    setLogError('');
    try { const result = await api.get<{ logs: string }>(`/docker/containers/${id}/logs`); if (activeId.current === id) setLogs(result.logs); }
    catch (err) { if (activeId.current === id) setLogError(err instanceof Error ? err.message : 'Logs unavailable'); }
  }
  useEffect(() => { setContainer(null); setLogs(''); setLogError(''); setRemoveName(''); if (id) { void load(); void loadLogs(); } }, [id, load]);
  async function action(action: string) {
    if (!container) return;
    if (['stop', 'restart', 'kill', 'remove'].includes(action) && !await confirm({ title: `${action === 'remove' ? 'Remove' : action === 'kill' ? 'Force stop' : action} ${container.name}?`, message: action === 'remove' ? 'This removes the stopped container and its writable layer. Named volumes and bind-mounted host folders are kept.' : container.autoRemove ? 'This container uses auto-remove: stopping it can remove its definition and writable layer.' : 'This acts on the existing container directly. Its engine restart policy and any external orchestrator still apply.', tone: ['remove', 'kill'].includes(action) ? 'danger' : 'default' })) return;
    setBusy(true); setError('');
    try {
      await api.post(`/docker/containers/${id}/action`, { action, ...(action === 'remove' ? { confirmation: removeName } : {}) });
      toast.success('Container action completed'); await onRefresh();
      if (action === 'remove' || (container.autoRemove && ['stop', 'kill'].includes(action))) onClose(); else await load();
    } catch (err) { setError(err instanceof Error ? err.message : 'Container action failed'); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!container) return;
    const update: Record<string, unknown> = {};
    if (!container.autoRemove && restart !== container.restartPolicy) update.restartPolicy = restart;
    if (memory !== (container.memoryMb ?? 0)) update.memoryMb = memory;
    if (cpus !== (container.cpus ?? 0)) update.cpus = cpus;
    if (!Object.keys(update).length) return;
    setBusy(true); setError('');
    try { await api.put(`/docker/containers/${id}`, update); toast.success('Container settings updated in place'); await load(); await onRefresh(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Container update failed'); }
    finally { setBusy(false); }
  }
  const stopped = !!container && ['created', 'exited', 'stopped', 'dead', 'configured'].includes(container.state);
  const writable = !!container && !container.instance?.supervised && !busy;
  return <Modal open={!!id} onClose={() => !busy && onClose()} title={container?.name ?? 'Host container'} size="lg"><div className="space-y-4">
    <ErrorText>{error}</ErrorText>{loading && !container && <Spinner />}
    {container && <><div className="flex flex-wrap items-center gap-2"><Badge tone={container.state === 'running' ? 'green' : 'neutral'}>{container.state}</Badge><span className="break-all font-mono text-xs text-ink-300">{container.image}</span><Button disabled={busy || loading} onClick={load}>Refresh details</Button></div>
      {container.instance && <Notice tone="info">Linked to <Link className="underline" to={`/instances/${container.instance.id}`}>{container.instance.name}</Link>. {container.instance.supervised ? 'Use its instance page for changes while the Outpost supervisor is active.' : 'This engine container currently has no active Outpost supervisor.'}</Notice>}
      {container.composeProject && <p className="text-xs text-ink-400">Compose project: {container.composeProject}. Future Compose deployments may replace manual settings.</p>}
      <div className="flex flex-wrap gap-2"><Button variant="primary" disabled={!writable || !stopped} onClick={() => action('start')}>Start</Button><Button disabled={!writable || !['running', 'restarting'].includes(container.state)} onClick={() => action('stop')}>Stop</Button><Button disabled={!writable || container.state !== 'running'} onClick={() => action('restart')}>Restart</Button><Button disabled={!writable || !['running', 'paused'].includes(container.state)} onClick={() => action(container.state === 'paused' ? 'unpause' : 'pause')}>{container.state === 'paused' ? 'Resume' : 'Pause'}</Button><Button variant="danger" disabled={!writable || stopped} onClick={() => action('kill')}>Force stop</Button></div>
      <div className="grid gap-3 sm:grid-cols-3"><Field label="Restart policy"><Select value={restart} disabled={!writable || container.autoRemove} onChange={(e) => setRestart(e.target.value)}><option value="no">No automatic restart</option><option value="always">Always</option><option value="unless-stopped">Unless stopped</option><option value="on-failure">On failure</option></Select></Field><Field label="Memory MB (0 = unlimited)"><Input type="number" min={0} value={memory} disabled={!writable} onChange={(e) => setMemory(Number(e.target.value))} /></Field><Field label="CPUs (0 = unlimited)"><Input type="number" min={0} step={0.25} value={cpus} disabled={!writable} onChange={(e) => setCpus(Number(e.target.value))} /></Field></div>
      <Button disabled={!writable} onClick={save}>Save settings</Button><p className="text-xs text-ink-500">Changes use the engine’s update command. Existing environment variables, mounts and port bindings are preserved; supported updates depend on the engine and container platform.</p>
      <details><summary className="cursor-pointer text-sm text-ink-200">Ports, mounts, networks and command</summary><div className="mt-3 space-y-2 break-all font-mono text-xs text-ink-400"><p>Ports: {container.ports || 'None published'}</p><p>Networks: {container.networks.join(', ') || 'None'}</p><p>Command: {container.command.join(' ') || 'Image default'}</p>{container.mounts.map((m, i) => <p key={i}>{m.type}: {m.source} → {m.destination} ({m.writable ? 'rw' : 'ro'})</p>)}</div></details>
      <div><div className="mb-2 flex items-center justify-between"><h3 className="text-sm font-medium text-ink-200">Recent logs</h3><Button variant="ghost" disabled={busy} onClick={loadLogs}>Refresh logs</Button></div><ErrorText>{logError}</ErrorText><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-surface-950 p-3 font-mono text-xs text-ink-300">{logs || 'No log output available.'}</pre></div>
      <details><summary className="cursor-pointer text-sm text-error-400">Remove stopped container</summary><div className="mt-3 space-y-3"><Field label={`Type ${container.name} to confirm removal`}><Input value={removeName} disabled={!writable || !stopped} onChange={(e) => setRemoveName(e.target.value)} /></Field><Button variant="danger" disabled={!writable || !stopped || removeName !== container.name} onClick={() => action('remove')}>Remove container</Button><p className="text-xs text-ink-500">Volumes are kept. The container’s writable layer is removed.</p></div></details>
    </>}
  </div></Modal>;
}
