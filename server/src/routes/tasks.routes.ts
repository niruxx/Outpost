import { Router, type Request } from 'express';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { requireAuth, requirePermission, requireServerAccess } from '../auth/middleware.js';
import { createTask, deleteTask, getTask, listTasks, runTask, sanitizeTaskInput, updateTask, type TaskInput } from '../services/schedulerService.js';
import { logAudit } from '../services/userService.js';
import type { TaskAction } from '../types/index.js';

/** Scheduled tasks for one instance: console commands, restarts, starts and stops on a cron schedule. */
export const tasksRouter = Router({ mergeParams: true });
tasksRouter.use(requireAuth, requireServerAccess());

/** A task runs with the scheduler's authority later, so whoever sets it up needs that authority now. */
function requireTaskPermissions(req: Request, task: Pick<TaskInput, 'action' | 'warnCommand'> | { action: TaskAction; warn_command: string }) {
  const warns = 'warnCommand' in task ? task.warnCommand : task.warn_command;
  if (task.action === 'command' || warns) requirePermission(req, 'console');
  if (task.action !== 'command') requirePermission(req, 'power');
}

tasksRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ tasks: listTasks(req.params.serverId) });
  })
);

tasksRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = sanitizeTaskInput(req.body);
    requireTaskPermissions(req, input);
    const task = createTask(req.params.serverId, input);
    logAudit(req.auth!.sub, req.auth!.username, 'task.create', req.params.serverId, `${input.name} (${input.action}, ${input.cronExpression})`);
    res.status(201).json({ task });
  })
);

tasksRouter.put(
  '/:taskId',
  asyncHandler(async (req, res) => {
    const existing = getTask(req.params.serverId, req.params.taskId);
    if (!existing) throw new HttpError(404, 'Task not found');
    const input = sanitizeTaskInput(req.body);
    requireTaskPermissions(req, existing);
    requireTaskPermissions(req, input);
    const task = updateTask(req.params.serverId, req.params.taskId, input);
    logAudit(req.auth!.sub, req.auth!.username, 'task.update', req.params.serverId, `${input.name} (${input.action}, ${input.cronExpression})`);
    res.json({ task });
  })
);

tasksRouter.post(
  '/:taskId/run',
  asyncHandler(async (req, res) => {
    const task = getTask(req.params.serverId, req.params.taskId);
    if (!task) throw new HttpError(404, 'Task not found');
    requireTaskPermissions(req, task);
    logAudit(req.auth!.sub, req.auth!.username, 'task.run', req.params.serverId, task.name);
    // Restarts with a warning can take minutes — answer right away and let the task finish.
    const done = runTask(task, 'manual');
    const quick = await Promise.race([done, new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000))]);
    res.json({ result: quick ?? 'Running…', task: getTask(req.params.serverId, req.params.taskId) });
  })
);

tasksRouter.delete(
  '/:taskId',
  asyncHandler(async (req, res) => {
    const task = getTask(req.params.serverId, req.params.taskId);
    if (!task) throw new HttpError(404, 'Task not found');
    requireTaskPermissions(req, task);
    deleteTask(req.params.serverId, req.params.taskId);
    logAudit(req.auth!.sub, req.auth!.username, 'task.delete', req.params.serverId, task.name);
    res.status(204).end();
  })
);
