import crypto from 'node:crypto';
import { prep } from '../db/db.js';
import { logger } from '../utils/logger.js';
import { HttpError } from '../utils/asyncHandler.js';

/**
 * Outgoing notifications: instance and backup events posted to webhooks. Discord webhook URLs
 * get a Discord embed; any other URL gets a plain JSON body ({ event, title, message, server, at }).
 * Sending is fire-and-forget — a slow or broken webhook never holds up the panel.
 */

export const NOTIFY_EVENTS = [
  'server.started',
  'server.stopped',
  'server.crashed',
  'server.restart_gave_up',
  'backup.failed',
  'task.failed',
  'update.available',
  'update.applied',
  'update.failed',
  'quota.exceeded',
] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

const EVENT_STYLE: Record<NotifyEvent, { title: string; color: number }> = {
  'server.started': { title: 'Instance started', color: 0x3ba55d },
  'server.stopped': { title: 'Instance stopped', color: 0x95a5a6 },
  'server.crashed': { title: 'Instance crashed', color: 0xed4245 },
  'server.restart_gave_up': { title: 'Auto-restart gave up', color: 0xed4245 },
  'backup.failed': { title: 'Scheduled snapshot failed', color: 0xfaa61a },
  'task.failed': { title: 'Scheduled task failed', color: 0xfaa61a },
  'update.available': { title: 'Update available', color: 0x5865f2 },
  'update.applied': { title: 'Updated automatically', color: 0x3ba55d },
  'update.failed': { title: 'Automatic update failed', color: 0xed4245 },
  'quota.exceeded': { title: 'Disk limit reached', color: 0xfaa61a },
};

interface WebhookRow {
  id: string;
  name: string;
  url: string;
  events: string;
  server_ids: string | null;
  enabled: 0 | 1;
  created_at: string;
}

export interface Webhook {
  id: string;
  name: string;
  url: string;
  events: NotifyEvent[];
  /** null = every instance */
  serverIds: string[] | null;
  enabled: boolean;
  createdAt: string;
}

function fromRow(row: WebhookRow): Webhook {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    events: JSON.parse(row.events),
    serverIds: row.server_ids ? JSON.parse(row.server_ids) : null,
    enabled: !!row.enabled,
    createdAt: row.created_at,
  };
}

export function listWebhooks(): Webhook[] {
  return (prep('SELECT * FROM webhooks ORDER BY created_at ASC').all() as unknown as WebhookRow[]).map(fromRow);
}

function getWebhook(id: string): Webhook | undefined {
  const row = prep('SELECT * FROM webhooks WHERE id = ?').get(id) as WebhookRow | undefined;
  return row ? fromRow(row) : undefined;
}

export interface WebhookInput {
  name: string;
  url: string;
  events: NotifyEvent[];
  serverIds: string[] | null;
  enabled: boolean;
}

export function sanitizeWebhookInput(body: unknown): WebhookInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim().slice(0, 80) : '';
  if (!name) throw new HttpError(400, 'Give the webhook a name');
  const url = typeof b.url === 'string' ? b.url.trim() : '';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpError(400, 'Enter a valid webhook URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new HttpError(400, 'Webhook URLs must start with https:// or http://');
  const events = Array.isArray(b.events) ? b.events.filter((e): e is NotifyEvent => NOTIFY_EVENTS.includes(e as NotifyEvent)) : [];
  if (!events.length) throw new HttpError(400, 'Pick at least one event');
  const serverIds = Array.isArray(b.serverIds) ? b.serverIds.filter((s): s is string => typeof s === 'string') : null;
  return { name, url, events: [...new Set(events)], serverIds: serverIds && serverIds.length ? serverIds : null, enabled: b.enabled !== false };
}

export function createWebhook(input: WebhookInput): Webhook {
  const id = crypto.randomUUID();
  prep('INSERT INTO webhooks (id, name, url, events, server_ids, enabled) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    input.name,
    input.url,
    JSON.stringify(input.events),
    input.serverIds ? JSON.stringify(input.serverIds) : null,
    input.enabled ? 1 : 0
  );
  return getWebhook(id)!;
}

export function updateWebhook(id: string, input: WebhookInput): Webhook {
  if (!getWebhook(id)) throw new HttpError(404, 'Webhook not found');
  prep('UPDATE webhooks SET name = ?, url = ?, events = ?, server_ids = ?, enabled = ? WHERE id = ?').run(
    input.name,
    input.url,
    JSON.stringify(input.events),
    input.serverIds ? JSON.stringify(input.serverIds) : null,
    input.enabled ? 1 : 0,
    id
  );
  return getWebhook(id)!;
}

export function deleteWebhook(id: string): void {
  prep('DELETE FROM webhooks WHERE id = ?').run(id);
}

function isDiscord(url: string): boolean {
  try {
    const u = new URL(url);
    return /(^|\.)discord(app)?\.com$/.test(u.hostname) && u.pathname.startsWith('/api/webhooks/');
  } catch {
    return false;
  }
}

interface Payload {
  event: NotifyEvent | 'test';
  title: string;
  message: string;
  color: number;
  server: { id: string; name: string } | null;
}

async function send(hook: Webhook, payload: Payload): Promise<void> {
  const at = new Date().toISOString();
  const body = isDiscord(hook.url)
    ? {
        username: 'Outpost',
        embeds: [
          {
            title: payload.server ? `${payload.title} — ${payload.server.name}` : payload.title,
            description: payload.message,
            color: payload.color,
            timestamp: at,
            footer: { text: 'Outpost' },
          },
        ],
      }
    : { event: payload.event, title: payload.title, message: payload.message, server: payload.server, at };
  const res = await fetch(hook.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Outpost-Webhook' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
}

// A crash loop shouldn't flood a channel: a crash for the same instance goes out at most once a
// minute per webhook. Other events always go out, so a restart's "stopped" is followed by "started".
const DEDUPE_MS = 60_000;
const DEDUPED: NotifyEvent[] = ['server.crashed'];
const lastSent = new Map<string, number>();

/** Posts an event to every enabled webhook that subscribes to it (and covers this instance). */
export function notify(event: NotifyEvent, server: { id: string; name: string } | null, message: string): void {
  let hooks: Webhook[];
  try {
    hooks = listWebhooks();
  } catch (err) {
    logger.error('Could not read webhooks', err);
    return;
  }
  const style = EVENT_STYLE[event];
  for (const hook of hooks) {
    if (!hook.enabled || !hook.events.includes(event)) continue;
    if (server && hook.serverIds && !hook.serverIds.includes(server.id)) continue;
    if (DEDUPED.includes(event)) {
      const key = `${hook.id}:${event}:${server?.id ?? ''}`;
      const now = Date.now();
      if ((lastSent.get(key) ?? 0) > now - DEDUPE_MS) continue;
      lastSent.set(key, now);
    }
    send(hook, { event, title: style.title, message, color: style.color, server }).catch((err) =>
      logger.warn(`Webhook "${hook.name}" failed for ${event}: ${err instanceof Error ? err.message : String(err)}`)
    );
  }
}

/** Sends a test message and reports whether the webhook accepted it. */
export async function testWebhook(id: string): Promise<void> {
  const hook = getWebhook(id);
  if (!hook) throw new HttpError(404, 'Webhook not found');
  try {
    await send(hook, { event: 'test', title: 'Test notification', message: `Outpost can reach the “${hook.name}” webhook.`, color: 0x5865f2, server: null });
  } catch (err) {
    throw new HttpError(502, `The webhook didn’t accept the test: ${err instanceof Error ? err.message : String(err)}`);
  }
}
