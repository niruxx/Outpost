import { publish, consoleTopic } from './wsHub.js';
import { recordLine } from './consoleHistoryService.js';

/**
 * Shared per-server console/log buffer. Unlike the process manager's runtime state,
 * this persists across install → start → stop → start cycles, so the console view
 * always has scrollback (including install logs) even when nothing is running.
 */
const LOG_BUFFER_LIMIT = 4000;

const buffers = new Map<string, string[]>();

export type LogStream = 'stdout' | 'stderr' | 'system';

type LineListener = (line: string, stream: LogStream) => void;
const listeners = new Map<string, Set<LineListener>>();

/** Calls `fn` for every new console line of an instance until the returned function is called. */
export function onLine(serverId: string, fn: LineListener): () => void {
  let set = listeners.get(serverId);
  if (!set) listeners.set(serverId, (set = new Set()));
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (!set!.size) listeners.delete(serverId);
  };
}

export function appendLine(serverId: string, line: string, stream: LogStream = 'system'): void {
  recordLine(serverId, line, stream);
  for (const fn of listeners.get(serverId) ?? []) {
    try {
      fn(line, stream);
    } catch {
      // a listener's problem isn't the console's
    }
  }
  let buffer = buffers.get(serverId);
  if (!buffer) {
    buffer = [];
    buffers.set(serverId, buffer);
  }
  buffer.push(line);
  if (buffer.length > LOG_BUFFER_LIMIT) buffer.shift();
  publish(consoleTopic(serverId), { type: 'log', stream, line, at: Date.now() });
}

export function getBuffer(serverId: string): string[] {
  return buffers.get(serverId) ?? [];
}

export function clearBuffer(serverId: string): void {
  buffers.delete(serverId);
}
