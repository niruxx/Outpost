import crypto from 'node:crypto';
import cron, { type ScheduledTask as CronJob } from 'node-cron';
import { prep } from '../db/db.js';
import { createBackup, enforceRetention } from './backupService.js';
import { getServer } from './serverService.js';
import { isRunning, restartServer, sendCommand, startServer, stopServer } from './processManager.js';
import { appendLine } from './consoleLogService.js';
import { notify } from './notificationService.js';
import type { BackupSchedule, ScheduledTask, TaskAction } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { HttpError } from '../utils/asyncHandler.js';

const activeTasks = new Map<string, CronJob>();

export function getSchedule(serverId: string): BackupSchedule | undefined {
  return prep('SELECT * FROM backup_schedules WHERE server_id = ?').get(serverId) as
    | BackupSchedule
    | undefined;
}

function registerTask(schedule: BackupSchedule) {
  activeTasks.get(schedule.server_id)?.stop();
  if (!schedule.enabled) return;
  const task = cron.schedule(schedule.cron_expression, async () => {
    const server = getServer(schedule.server_id);
    if (!server) return; // deleted
    try {
      logger.info(`Running scheduled backup for server ${schedule.server_id}`);
      await createBackup(schedule.server_id, 'auto');
      enforceRetention(schedule.server_id, schedule.retention_count);
    } catch (err) {
      logger.error(`Scheduled backup failed for server ${schedule.server_id}`, err);
      notify('backup.failed', { id: server.id, name: server.name }, err instanceof Error ? err.message : String(err));
    }
  });
  activeTasks.set(schedule.server_id, task);
}

export function setSchedule(
  serverId: string,
  cronExpression: string,
  retentionCount: number,
  enabled: boolean
): BackupSchedule {
  if (!cron.validate(cronExpression)) {
    throw new HttpError(400, `Invalid cron expression: ${cronExpression}`);
  }
  prep(
    `INSERT INTO backup_schedules (server_id, cron_expression, retention_count, enabled)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(server_id) DO UPDATE SET cron_expression = excluded.cron_expression,
       retention_count = excluded.retention_count, enabled = excluded.enabled`
  ).run(serverId, cronExpression, retentionCount, enabled ? 1 : 0);
  const schedule = getSchedule(serverId)!;
  registerTask(schedule);
  return schedule;
}

export function removeSchedule(serverId: string): void {
  activeTasks.get(serverId)?.stop();
  activeTasks.delete(serverId);
  prep('DELETE FROM backup_schedules WHERE server_id = ?').run(serverId);
}

// ---------------------------------------------------------------------------
// Scheduled tasks: console commands, restarts, starts and stops on a cron schedule
// ---------------------------------------------------------------------------

export const TASK_ACTIONS: TaskAction[] = ['command', 'restart', 'start', 'stop'];
const taskJobs = new Map<string, CronJob>();
const runningTasks = new Set<string>();

export function listTasks(serverId: string): ScheduledTask[] {
  return prep('SELECT * FROM scheduled_tasks WHERE server_id = ? ORDER BY created_at ASC').all(serverId) as unknown as ScheduledTask[];
}

export function getTask(serverId: string, taskId: string): ScheduledTask | undefined {
  return prep('SELECT * FROM scheduled_tasks WHERE id = ? AND server_id = ?').get(taskId, serverId) as ScheduledTask | undefined;
}

export interface TaskInput {
  name: string;
  cronExpression: string;
  action: TaskAction;
  command: string;
  warnCommand: string;
  warnSeconds: number;
  enabled: boolean;
}

export function sanitizeTaskInput(body: unknown): TaskInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim().slice(0, 80) : '';
  if (!name) throw new HttpError(400, 'Give the task a name');
  const cronExpression = typeof b.cronExpression === 'string' ? b.cronExpression.trim() : '';
  if (!cron.validate(cronExpression)) throw new HttpError(400, `Invalid cron expression: ${cronExpression || '(empty)'}`);
  const action = b.action as TaskAction;
  if (!TASK_ACTIONS.includes(action)) throw new HttpError(400, `action must be one of ${TASK_ACTIONS.join(', ')}`);
  const command = typeof b.command === 'string' ? b.command.trim().slice(0, 1000) : '';
  if (action === 'command' && !command) throw new HttpError(400, 'Enter the console command to run');
  const warns = action === 'restart' || action === 'stop';
  const warnCommand = warns && typeof b.warnCommand === 'string' ? b.warnCommand.trim().slice(0, 1000) : '';
  const warnSeconds = warnCommand ? Math.min(3600, Math.max(0, Math.round(Number(b.warnSeconds) || 0))) : 0;
  return { name, cronExpression, action, command: action === 'command' ? command : '', warnCommand, warnSeconds, enabled: b.enabled !== false };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs one task now. Returns a short result line (also stored as the task's last result). */
export async function runTask(task: ScheduledTask, trigger: 'schedule' | 'manual'): Promise<string> {
  const server = getServer(task.server_id);
  if (!server) return 'Skipped: instance no longer exists';
  if (runningTasks.has(task.id)) return 'Skipped: the previous run is still going';
  runningTasks.add(task.id);
  const log = (line: string) => appendLine(server.id, `[Outpost] Task "${task.name}": ${line}`, 'system');
  let result: string;
  let failed = false;
  try {
    if (server.suspended) result = 'Skipped: instance is suspended';
    else if (server.status === 'installing' || server.status === 'updating' || server.status === 'transferring') result = `Skipped: instance is ${server.status}`;
    else if (task.action === 'start') {
      if (isRunning(server.id)) result = 'Skipped: already running';
      else {
        log('starting the instance');
        await startServer(server.id);
        result = 'Started';
      }
    } else if (!isRunning(server.id)) {
      // A scheduled restart/stop/command never brings up an instance someone stopped on purpose.
      result = 'Skipped: instance is not running';
    } else if (task.action === 'command') {
      sendCommand(server.id, task.command);
      result = 'Command sent';
    } else {
      if (task.warn_command) {
        sendCommand(server.id, task.warn_command);
        if (task.warn_seconds > 0) {
          log(`${task.action === 'restart' ? 'restarting' : 'stopping'} in ${task.warn_seconds}s`);
          await sleep(task.warn_seconds * 1000);
        }
      }
      if (!isRunning(server.id)) result = 'Skipped: instance stopped during the warning';
      else if (task.action === 'stop') {
        log('stopping the instance');
        stopServer(server.id);
        result = 'Stopped';
      } else {
        log('restarting the instance');
        await restartServer(server.id);
        result = 'Restarted';
      }
    }
  } catch (err) {
    failed = true;
    result = `Failed: ${err instanceof Error ? err.message : String(err)}`;
    log(result);
  } finally {
    runningTasks.delete(task.id);
  }
  prep('UPDATE scheduled_tasks SET last_run_at = ?, last_result = ? WHERE id = ?').run(new Date().toISOString(), result, task.id);
  if (failed && trigger === 'schedule') notify('task.failed', { id: server.id, name: server.name }, `"${task.name}" — ${result}`);
  return result;
}

function registerScheduledTask(task: ScheduledTask) {
  taskJobs.get(task.id)?.stop();
  taskJobs.delete(task.id);
  if (!task.enabled) return;
  const job = cron.schedule(task.cron_expression, () => {
    // Re-read so edits made since registration (and deletions) are respected.
    const current = prep('SELECT * FROM scheduled_tasks WHERE id = ?').get(task.id) as ScheduledTask | undefined;
    if (!current || !current.enabled) return;
    runTask(current, 'schedule').catch((err) => logger.error(`Scheduled task ${task.id} failed`, err));
  });
  taskJobs.set(task.id, job);
}

export function createTask(serverId: string, input: TaskInput): ScheduledTask {
  const id = crypto.randomUUID();
  prep(
    `INSERT INTO scheduled_tasks (id, server_id, name, cron_expression, action, command, warn_command, warn_seconds, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, serverId, input.name, input.cronExpression, input.action, input.command, input.warnCommand, input.warnSeconds, input.enabled ? 1 : 0);
  const task = getTask(serverId, id)!;
  registerScheduledTask(task);
  return task;
}

export function updateTask(serverId: string, taskId: string, input: TaskInput): ScheduledTask {
  if (!getTask(serverId, taskId)) throw new HttpError(404, 'Task not found');
  prep(
    `UPDATE scheduled_tasks SET name = ?, cron_expression = ?, action = ?, command = ?, warn_command = ?, warn_seconds = ?, enabled = ?
     WHERE id = ? AND server_id = ?`
  ).run(input.name, input.cronExpression, input.action, input.command, input.warnCommand, input.warnSeconds, input.enabled ? 1 : 0, taskId, serverId);
  const task = getTask(serverId, taskId)!;
  registerScheduledTask(task);
  return task;
}

export function deleteTask(serverId: string, taskId: string): void {
  taskJobs.get(taskId)?.stop();
  taskJobs.delete(taskId);
  prep('DELETE FROM scheduled_tasks WHERE id = ? AND server_id = ?').run(taskId, serverId);
}

/** Stops every cron job belonging to an instance — call before it's deleted or moved to another node. */
export function forgetServerSchedules(serverId: string): void {
  activeTasks.get(serverId)?.stop();
  activeTasks.delete(serverId);
  for (const task of listTasks(serverId)) {
    taskJobs.get(task.id)?.stop();
    taskJobs.delete(task.id);
  }
}

/** Loads all persisted schedules and starts their cron jobs. Call once at boot. */
export function initScheduler(): void {
  const schedules = prep('SELECT * FROM backup_schedules').all() as unknown as BackupSchedule[];
  for (const schedule of schedules) registerTask(schedule);
  const tasks = prep('SELECT * FROM scheduled_tasks').all() as unknown as ScheduledTask[];
  for (const task of tasks) registerScheduledTask(task);
  logger.info(`Scheduler initialized with ${schedules.length} backup schedule(s) and ${tasks.length} task(s)`);
}
