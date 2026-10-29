import crypto from 'node:crypto';
import type { Request } from 'express';
import { prep } from '../db/db.js';
import { HttpError } from '../utils/asyncHandler.js';
import { requireConfigItems, requirePermission } from '../auth/middleware.js';
import { getUserById, getServerPermissions, logAudit } from './userService.js';
import { getServer, updateServerRecord } from './serverService.js';
import { sendCommand } from './processManager.js';
import { createBackup } from './backupService.js';
import { writeServerProperties } from './propertiesService.js';
import { instanceEvents } from './instanceEvents.js';

export const RULE_EVENTS = ['player.join', 'player.leave', 'player.firstJoin', 'state.starting', 'state.running', 'state.stopped', 'state.crashed', 'webhook'] as const;
export type RuleAction = { type: 'command'; command: string } | { type: 'backup'; label?: string } | { type: 'settings'; kind: 'setting' | 'property'; values: Record<string, string | number | boolean> };
export interface Rule { id: string; server_id: string; user_id: string; name: string; event: string; action: string; enabled: number; cooldown: number; last_run: number; last_result: string | null; secret_hash: string | null }
const busy = new Set<string>();
function context(userId: string, serverId: string): Request {
  const user = getUserById(userId), server = getServer(serverId);
  if (!user || !server || server.suspended || !getServerPermissions(userId, user.role, serverId)) throw new HttpError(403, 'Rule owner no longer has access to an active instance');
  return { auth: { sub: user.id, username: user.username, role: user.role }, params: { serverId }, method: 'AUTOMATION', originalUrl: '/automation' } as unknown as Request;
}
export function validateRuleAction(input: unknown): RuleAction {
  const a = input as RuleAction;
  if (!a || typeof a !== 'object') throw new HttpError(400, 'An action is required');
  if (a.type === 'command' && typeof a.command === 'string' && a.command.trim() && a.command.length <= 1024 && !/[\r\n\x00]/.test(a.command)) return { type: a.type, command: a.command.trim() };
  if (a.type === 'backup' && (a.label === undefined || (typeof a.label === 'string' && /^[\w .-]{0,80}$/.test(a.label)))) return { type: a.type, ...(a.label ? { label: a.label } : {}) };
  if (a.type === 'settings' && ['setting', 'property'].includes(a.kind) && a.values && typeof a.values === 'object' && !Array.isArray(a.values)) {
    const entries = Object.entries(a.values);
    if (!entries.length || entries.length > 100) throw new HttpError(400, 'Provide 1-100 settings');
    for (const [key, value] of entries) {
      if (!/^[\w.-]{1,100}$/.test(key) || !['string', 'number', 'boolean'].includes(typeof value) || /[\r\n\x00]/.test(String(value)) || String(value).length > 2048) throw new HttpError(400, 'Invalid setting key/value');
      if (a.kind === 'property' && /[\\\x00-\x1f\x7f]/.test(String(value))) throw new HttpError(400, 'Property values cannot contain escapes or control characters');
      if (a.kind === 'property' && ['server-port', 'server-ip', 'server-portv6'].includes(key)) throw new HttpError(400, 'Manage network allocations in instance settings');
      if (a.kind === 'setting' && !['name', 'autoStart', 'minMemoryMb', 'maxMemoryMb'].includes(key)) throw new HttpError(400, 'Supported settings: name, autoStart, minMemoryMb, maxMemoryMb');
      if (a.kind === 'setting' && key === 'autoStart' && typeof value !== 'boolean') throw new HttpError(400, 'autoStart must be boolean');
      if (a.kind === 'setting' && key.endsWith('MemoryMb') && (!Number.isInteger(value) || Number(value) < 128 || Number(value) > 4_194_304)) throw new HttpError(400, 'Invalid memory limit');
      if (a.kind === 'setting' && key === 'name' && (typeof value !== 'string' || !value.trim() || value.length > 100)) throw new HttpError(400, 'Invalid name');
    }
    return { type: a.type, kind: a.kind, values: Object.fromEntries(entries) };
  }
  throw new HttpError(400, 'Choose a valid command, backup or settings action');
}
function authorize(userId: string, serverId: string, action: RuleAction) {
  const req = context(userId, serverId);
  if (action.type === 'command') requirePermission(req, 'console');
  else if (action.type === 'backup') requirePermission(req, 'backups.create');
  else {
    requireConfigItems(req, action.kind, action.values);
    const server = getServer(serverId)!;
    if (action.kind === 'property' && !['java', 'bedrock'].includes(server.platform)) throw new HttpError(400, 'Properties require a Minecraft instance');
    if (action.kind === 'setting' && Number(action.values.minMemoryMb ?? server.min_memory_mb) > Number(action.values.maxMemoryMb ?? server.max_memory_mb)) throw new HttpError(400, 'Minimum memory exceeds maximum');
  }
}
export function listRules(serverId: string, userId: string) {
  const admin = getUserById(userId)?.role === 'admin';
  return (prep('SELECT * FROM automation_rules WHERE server_id = ? ORDER BY created_at').all(serverId) as unknown as Rule[]).filter(r => admin || r.user_id === userId).map(({ secret_hash, ...r }) => ({ ...r, action: JSON.parse(r.action), hasSecret: !!secret_hash }));
}
export function saveRule(serverId: string, userId: string, input: { name?: unknown; event?: unknown; action?: unknown; cooldown?: unknown; enabled?: unknown }, id?: string) {
  const action = validateRuleAction(input?.action);
  authorize(userId, serverId, action);
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100 || !RULE_EVENTS.includes(input.event as typeof RULE_EVENTS[number]) || !Number.isInteger(input.cooldown) || Number(input.cooldown) < 5 || Number(input.cooldown) > 86400 || typeof input.enabled !== 'boolean') throw new HttpError(400, 'Provide name, supported event, cooldown (5-86400 seconds) and enabled');
  if (id) {
    const old = ownedRule(serverId, userId, id);
    // Editing as admin retains the owner's authority; do not turn another user's rule into an admin rule.
    authorize(old.user_id, serverId, action);
    if (old.event !== input.event) throw new HttpError(400, 'Create a new rule to change its event');
    prep('UPDATE automation_rules SET name=?, action=?, cooldown=?, enabled=? WHERE id=?').run(input.name.trim(), JSON.stringify(action), Number(input.cooldown), input.enabled ? 1 : 0, id);
    return { id };
  }
  if (Number((prep('SELECT COUNT(*) AS n FROM automation_rules WHERE server_id=?').get(serverId) as { n: number }).n) >= 100) throw new HttpError(409, 'At most 100 rules per instance');
  const ruleId = crypto.randomUUID(), secret = input.event === 'webhook' ? crypto.randomBytes(32).toString('base64url') : undefined;
  prep('INSERT INTO automation_rules(id,server_id,user_id,name,event,action,cooldown,enabled,secret_hash) VALUES (?,?,?,?,?,?,?,?,?)').run(ruleId, serverId, userId, input.name.trim(), String(input.event), JSON.stringify(action), Number(input.cooldown), input.enabled ? 1 : 0, secret ? digest(secret) : null);
  return { id: ruleId, ...(secret ? { secret, endpoint: `/api/hooks/${ruleId}` } : {}) };
}
function ownedRule(serverId: string, userId: string, id: string) {
  const rule = prep('SELECT * FROM automation_rules WHERE id=? AND server_id=?').get(id, serverId) as unknown as Rule | undefined;
  if (!rule || (rule.user_id !== userId && getUserById(userId)?.role !== 'admin')) throw new HttpError(404, 'Rule not found');
  return rule;
}
export function deleteRule(serverId: string, userId: string, id: string) { ownedRule(serverId, userId, id); prep('DELETE FROM automation_rules WHERE id=?').run(id); }
const digest = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export function rotateRuleSecret(serverId: string, userId: string, id: string) {
  const rule = ownedRule(serverId, userId, id);
  if (rule.event !== 'webhook') throw new HttpError(400, 'Not a webhook');
  authorize(rule.user_id, serverId, JSON.parse(rule.action));
  const secret = crypto.randomBytes(32).toString('base64url'); prep('UPDATE automation_rules SET secret_hash=? WHERE id=?').run(digest(secret), id);
  return { secret, endpoint: `/api/hooks/${id}` };
}
export async function executeRule(rule: Rule, player?: string) {
  const fresh = prep('SELECT * FROM automation_rules WHERE id=?').get(rule.id) as unknown as Rule | undefined;
  if (!fresh?.enabled || busy.has(rule.id) || busy.size >= 16) return false;
  const now = Date.now();
  if (now - fresh.last_run < fresh.cooldown * 1000) return false;
  const action = validateRuleAction(JSON.parse(fresh.action)); authorize(fresh.user_id, fresh.server_id, action);
  prep('UPDATE automation_rules SET last_run=? WHERE id=?').run(now, rule.id); busy.add(rule.id);
  let result = 'Succeeded';
  try {
    if (action.type === 'command') {
      if (action.command.includes('{{player}}') && (!player || !/^[\w .-]{1,64}$/.test(player))) throw new HttpError(400, 'No safe player name for this command');
      sendCommand(fresh.server_id, action.command.replaceAll('{{player}}', player ?? ''));
    } else if (action.type === 'backup') await createBackup(fresh.server_id, action.label ?? fresh.name);
    else if (action.kind === 'property') writeServerProperties(fresh.server_id, getServer(fresh.server_id)!.platform, Object.fromEntries(Object.entries(action.values).map(([k, v]) => [k, String(v)])));
    else updateServerRecord(fresh.server_id, action.values);
    return true;
  } catch (error) { result = `Failed: ${error instanceof Error ? error.message : String(error)}`; throw error; }
  finally { busy.delete(rule.id); prep('UPDATE automation_rules SET last_result=? WHERE id=?').run(result.slice(0, 1000), rule.id); const user = getUserById(fresh.user_id); logAudit(fresh.user_id, user?.username ?? 'deleted', 'automation.run', fresh.server_id, JSON.stringify({ ruleId: rule.id, result })); }
}
export async function acceptWebhook(id: string, secret: string, delivery: string, timestamp: string) {
  const rule = prep('SELECT * FROM automation_rules WHERE id=? AND event=?').get(id, 'webhook') as unknown as Rule | undefined;
  if (!rule?.enabled || !rule.secret_hash || secret.length > 256 || !crypto.timingSafeEqual(Buffer.from(digest(secret)), Buffer.from(rule.secret_hash))) throw new HttpError(403, 'Invalid webhook credentials');
  if (!/^[\w-]{8,100}$/.test(delivery) || !/^\d{13}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 300_000) throw new HttpError(400, 'Use a unique X-Outpost-Delivery (8-100 characters) and current millisecond X-Outpost-Timestamp');
  authorize(rule.user_id, rule.server_id, JSON.parse(rule.action));
  if (prep('SELECT delivery FROM webhook_deliveries WHERE rule_id=? AND delivery=?').get(id, delivery)) return { duplicate: true };
  if (busy.has(id) || busy.size >= 16 || Date.now() - rule.last_run < rule.cooldown * 1000) throw new HttpError(429, 'Rule cooldown or concurrency limit reached');
  prep('DELETE FROM webhook_deliveries WHERE at < ?').run(Date.now() - 7 * 86400_000);
  prep('INSERT INTO webhook_deliveries(rule_id,delivery,at) VALUES (?,?,?)').run(id, delivery, Date.now());
  await executeRule(rule); return { duplicate: false };
}
let initialized = false;
export function initAutomation() {
  if (initialized) return; initialized = true;
  instanceEvents.on('event', (serverId: string, data: { type: string; status?: string; action?: string; name?: string }) => {
    const events: string[] = [];
    if (data.type === 'status') events.push(`state.${data.status}`);
    if (data.type === 'player' && data.name && ['join', 'leave'].includes(data.action ?? '')) {
      events.push(`player.${data.action}`);
      if (data.action === 'join' && getServer(serverId)) {
        const change = prep('INSERT OR IGNORE INTO player_seen(server_id,identity) VALUES (?,?)').run(serverId, data.name.toLowerCase());
        if (change.changes) events.push('player.firstJoin');
      }
    }
    for (const event of events) for (const rule of prep('SELECT * FROM automation_rules WHERE server_id=? AND event=? AND enabled=1').all(serverId, event) as unknown as Rule[]) {
      // Defer actions until the state/log publisher finishes its own transition.
      queueMicrotask(() => { void executeRule(rule, data.name).catch(error => { prep('UPDATE automation_rules SET last_result=? WHERE id=?').run(`Blocked/failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1000), rule.id); }); });
    }
  });
}
