import fs from 'node:fs';
import path from 'node:path';
import { instanceDir } from '../utils/paths.js';
import type { PlayerInfo } from '../types/index.js';

const onlineByServer = new Map<string, Set<string>>();

const JAVA_JOIN = /: (\w{1,16}) joined the game/;
const JAVA_LEAVE = /: (\w{1,16}) left the game/;
const BEDROCK_JOIN = /Player connected: ([^,]+),/;
const SOURCE_JOIN = /"([^"\r\n]{1,64})<\d+><[^>]+><[^>]*>" (?:entered the game|connected,)/;
const SOURCE_LEAVE = /"([^"\r\n]{1,64})<\d+><[^>]+><[^>]*>" disconnected/;
const BEDROCK_LEAVE = /Player disconnected: ([^,]+),/;

export interface PlayerEvent {
  type: 'join' | 'leave';
  name: string;
}

/** Feeds one console line through the player-activity parser, updating the online set. */
export function handleLogLine(serverId: string, line: string): PlayerEvent | null {
  let set = onlineByServer.get(serverId);
  if (!set) {
    set = new Set();
    onlineByServer.set(serverId, set);
  }

  let match = line.match(JAVA_JOIN) ?? line.match(BEDROCK_JOIN) ?? line.match(SOURCE_JOIN);
  if (match) {
    if (set.has(match[1].trim())) return null;
    set.add(match[1].trim());
    return { type: 'join', name: match[1].trim() };
  }
  match = line.match(JAVA_LEAVE) ?? line.match(BEDROCK_LEAVE) ?? line.match(SOURCE_LEAVE);
  if (match) {
    set.delete(match[1].trim());
    return { type: 'leave', name: match[1].trim() };
  }
  return null;
}

export function getOnlinePlayers(serverId: string): string[] {
  return Array.from(onlineByServer.get(serverId) ?? []);
}

export function resetOnlinePlayers(serverId: string) {
  onlineByServer.get(serverId)?.clear();
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

interface OpsEntry {
  name: string;
}
interface WhitelistEntry {
  name: string;
}
interface BanEntry {
  name: string;
}

/** Merges online players with ops.json / whitelist.json / banned-players.json for a full roster view. */
export function getPlayerRoster(serverId: string): PlayerInfo[] {
  const dir = instanceDir(serverId);
  const ops = readJsonFile<OpsEntry[]>(path.join(dir, 'ops.json'), []);
  const whitelist = readJsonFile<WhitelistEntry[]>(path.join(dir, 'whitelist.json'), []);
  const allowlist = readJsonFile<WhitelistEntry[]>(path.join(dir, 'allowlist.json'), []);
  const bans = readJsonFile<BanEntry[]>(path.join(dir, 'banned-players.json'), []);
  const online = new Set(getOnlinePlayers(serverId));

  const names = new Set<string>();
  online.forEach((n) => names.add(n));
  ops.forEach((o) => names.add(o.name));
  whitelist.forEach((w) => names.add(w.name));
  allowlist.forEach((w) => names.add(w.name));
  bans.forEach((b) => names.add(b.name));

  return Array.from(names).map((name) => ({
    name,
    online: online.has(name),
    op: ops.some((o) => o.name === name),
    whitelisted: whitelist.some((w) => w.name === name) || allowlist.some((w) => w.name === name),
    banned: bans.some((b) => b.name === name),
  }));
}
