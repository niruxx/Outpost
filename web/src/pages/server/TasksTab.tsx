import { AutomationCard } from './AutomationCard.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { setVisibleInterval } from '../../lib/perf.js';
import { useServerDetail } from './ServerContext.js';
import { api, ApiError } from '../../api/client.js';
import type { ScheduledTask, TaskAction } from '../../api/types.js';
import { Badge, Button, Card, CardTitle, ErrorText, Field, Input, Modal, Notice, Spinner } from '../../components/ui.js';
import { Icon } from '../../components/icons.js';
import { useToast } from '../../components/Toast.js';
import { useConfirm } from '../../components/ConfirmDialog.js';

const ACTIONS: { id: TaskAction; label: string; hint: string }[] = [
  { id: 'command', label: 'Run a command', hint: 'Sends a console command, e.g. save-all or say Backup soon!' },
  { id: 'restart', label: 'Restart', hint: 'Restarts the instance, optionally warning players first.' },
  { id: 'stop', label: 'Stop', hint: 'Stops the instance, optionally warning players first.' },
  { id: 'start', label: 'Start', hint: 'Starts the instance if it isn’t running.' },
];

const PRESETS = [
  { label: 'Every 15 minutes', cron: '*/15 * * * *' },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every 6 hours', cron: '0 */6 * * *' },
  { label: 'Daily at 4 AM', cron: '0 4 * * *' },
  { label: 'Weekly (Mon 4 AM)', cron: '0 4 * * 1' },
];

function describeCron(expr: string): string {
  const preset = PRESETS.find((p) => p.cron === expr);
  if (preset) return preset.label;
  const m = expr.match(/^(\d{1,2}) (\d{1,2}) \* \* \*$/);
  if (m) return `Daily at ${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}`;
  return expr;
}

function timeAgo(iso: string): string {
  const secs = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

const actionLabel = (a: TaskAction) => ACTIONS.find((x) => x.id === a)?.label ?? a;

function TaskModal({
  open,
  editing,
  allowed,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: ScheduledTask | null;
  allowed: TaskAction[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { serverId } = useServerDetail();
  const toast = useToast();
  const [name, setName] = useState('');
  const [action, setAction] = useState<TaskAction>('command');
  const [command, setCommand] = useState('');
  const [warnCommand, setWarnCommand] = useState('');
  const [warnSeconds, setWarnSeconds] = useState(60);
  const [cronExpression, setCronExpression] = useState('0 4 * * *');
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? '');
    setAction(editing?.action ?? allowed[0] ?? 'command');
    setCommand(editing?.command ?? '');
    setWarnCommand(editing?.warn_command ?? '');
    setWarnSeconds(editing?.warn_seconds || 60);
    setCronExpression(editing?.cron_expression ?? '0 4 * * *');
    setEnabled(editing ? !!editing.enabled : true);
    setError('');
  }, [open, editing, allowed]);

  const warns = action === 'restart' || action === 'stop';

  async function save() {
    setBusy(true);
    setError('');
    const body = { name, action, command, warnCommand: warns ? warnCommand : '', warnSeconds, cronExpression, enabled };
    try {
      if (editing) await api.put(`/servers/${serverId}/tasks/${editing.id}`, body);
      else await api.post(`/servers/${serverId}/tasks`, body);
      toast.success(editing ? 'Task saved' : 'Task created');
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save task');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={editing ? 'Edit task' : 'New scheduled task'} size="lg">
      <div className="space-y-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Nightly restart" autoFocus />
        </Field>

        <div>
          <p className="mb-2 text-xs font-medium text-ink-300">What it does</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {ACTIONS.filter((a) => allowed.includes(a.id)).map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => setAction(a.id)}
                className={`state-layer rounded-2xl border p-3 text-left ${
                  action === a.id ? 'border-transparent bg-secondary-container text-secondary-on-container' : 'border-surface-600 text-ink-200'
                }`}
              >
                <p className="text-sm font-medium">{a.label}</p>
                <p className={`text-xs ${action === a.id ? 'opacity-80' : 'text-ink-400'}`}>{a.hint}</p>
              </button>
            ))}
          </div>
        </div>

        {action === 'command' && (
          <Field label="Console command">
            <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="save-all" className="font-mono" />
          </Field>
        )}
        {warns && allowed.includes('command') && (
          <div className="grid gap-3 sm:grid-cols-[1fr_140px]">
            <Field label="Warning command (optional)">
              <Input value={warnCommand} onChange={(e) => setWarnCommand(e.target.value)} placeholder="say Restarting in 1 minute!" className="font-mono" />
            </Field>
            <Field label="Then wait (seconds)">
              <Input type="number" min={0} max={3600} value={warnSeconds} onChange={(e) => setWarnSeconds(Number(e.target.value))} disabled={!warnCommand.trim()} />
            </Field>
          </div>
        )}

        <div>
          <p className="mb-2 text-xs font-medium text-ink-300">When</p>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.cron}
                type="button"
                onClick={() => setCronExpression(p.cron)}
                className={`state-layer rounded-lg border px-3 py-1.5 text-xs font-medium ${
                  cronExpression === p.cron ? 'border-transparent bg-secondary-container text-secondary-on-container' : 'border-surface-500 text-ink-300'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <Input value={cronExpression} onChange={(e) => setCronExpression(e.target.value)} className="font-mono" aria-label="Cron expression" />
          <p className="mt-1 text-xs text-ink-500">Cron format: minute hour day-of-month month day-of-week, in the host’s time zone.</p>
        </div>

        <label className="flex items-center gap-2 text-sm text-ink-200">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled
        </label>

        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !name.trim() || !cronExpression.trim() || (action === 'command' && !command.trim())} onClick={save}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function TasksTab() {
  const { serverId, can } = useServerDetail();
  const toast = useToast();
  const confirm = useConfirm();
  const [tasks, setTasks] = useState<ScheduledTask[] | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ScheduledTask | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);

  const canConsole = can('console');
  const canPower = can('power');
  // Stable identity: the task form resets whenever this changes.
  const allowed = useMemo<TaskAction[]>(
    () => [...(canConsole ? (['command'] as const) : []), ...(canPower ? (['restart', 'stop', 'start'] as const) : [])],
    [canConsole, canPower]
  );
  // Mirrors the server: a command (or a warning command) needs Console, the rest need Start/stop.
  const canManage = (t: ScheduledTask) => (t.action === 'command' || t.warn_command ? canConsole : true) && (t.action === 'command' || canPower);

  const load = useCallback(async () => {
    try {
      setTasks((await api.get<{ tasks: ScheduledTask[] }>(`/servers/${serverId}/tasks`)).tasks);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to load tasks');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  useEffect(() => {
    load();
    const t = setVisibleInterval(load, 15000);
    return () => t();
  }, [load]);

  async function run(task: ScheduledTask) {
    setRunningId(task.id);
    try {
      const res = await api.post<{ result: string }>(`/servers/${serverId}/tasks/${task.id}/run`);
      toast.success(`${task.name}: ${res.result}`);
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to run task');
    } finally {
      setRunningId(null);
    }
  }

  async function remove(task: ScheduledTask) {
    const ok = await confirm({ title: 'Delete task', message: `Delete the scheduled task “${task.name}”?`, confirmLabel: 'Delete', tone: 'danger' });
    if (!ok) return;
    try {
      await api.delete(`/servers/${serverId}/tasks/${task.id}`);
      toast.success(`Deleted ${task.name}`);
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to delete task');
    }
  }

  return (
    <div className="space-y-5"><AutomationCard /><Card className="p-5">
      <CardTitle
        action={
          allowed.length > 0 && (
            <Button
              variant="primary"
              onClick={() => {
                setEditing(null);
                setModalOpen(true);
              }}
            >
              <Icon name="plus" className="h-4 w-4" /> New task
            </Button>
          )
        }
      >
        Scheduled tasks
      </CardTitle>
      <p className="mb-4 text-sm text-ink-400">
        Restart on a schedule, send console commands, or start and stop the instance at set times. Snapshots have their own schedule under Backup Schedule.
      </p>

      {tasks === null ? (
        <Spinner />
      ) : tasks.length === 0 ? (
        <Notice tone="info">No tasks yet. A common one: restart every night at 4 AM, warning players a minute before.</Notice>
      ) : (
        <div className="divide-y divide-surface-700 overflow-hidden rounded-2xl bg-surface-900">
          {tasks.map((task) => (
            <div key={task.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-700 text-ink-300">
                <Icon name={task.action === 'command' ? 'terminal' : task.action === 'start' ? 'play' : task.action === 'stop' ? 'stop' : 'restart'} className="h-[18px] w-[18px]" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate text-sm font-medium text-ink-100">{task.name}</p>
                  <Badge tone="neutral">{actionLabel(task.action)}</Badge>
                  {!task.enabled && <Badge tone="yellow">Paused</Badge>}
                </div>
                <p className="truncate text-xs text-ink-400">
                  <span title={task.cron_expression}>{describeCron(task.cron_expression)}</span>
                  {task.action === 'command' && <span className="font-mono"> · {task.command}</span>}
                  {task.warn_command && ` · warns ${task.warn_seconds}s before`}
                </p>
                {task.last_run_at && (
                  <p className={`truncate text-xs ${task.last_result?.startsWith('Failed') ? 'text-red-400' : 'text-ink-500'}`}>
                    Last run {timeAgo(task.last_run_at)}: {task.last_result}
                  </p>
                )}
              </div>
              {canManage(task) && (
                <div className="flex w-full flex-wrap justify-end gap-2 sm:w-auto">
                  <Button variant="ghost" disabled={runningId === task.id} onClick={() => run(task)}>
                    <Icon name="play" className="h-4 w-4" /> {runningId === task.id ? 'Running…' : 'Run now'}
                  </Button>
                  <Button
                    onClick={() => {
                      setEditing(task);
                      setModalOpen(true);
                    }}
                  >
                    Edit
                  </Button>
                  <Button variant="danger" onClick={() => remove(task)}>
                    Delete
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <TaskModal open={modalOpen} editing={editing} allowed={allowed} onClose={() => setModalOpen(false)} onSaved={load} />
    </Card></div>
  );
}
