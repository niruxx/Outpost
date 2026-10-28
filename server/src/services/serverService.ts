import { backupDir, rewindDir } from './backupStorageService.js';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { prep } from '../db/db.js';
import { instanceDir } from '../utils/paths.js';
import type { Loader, Platform, RestartPolicy, ServerRecord, ServerStatus } from '../types/index.js';

export interface CreateServerInput {
  name: string;
  platform: Platform;
  loader: Loader;
  version: string;
  minMemoryMb: number;
  maxMemoryMb: number;
  serverPort: number;
  extraJavaArgs?: string;
  extraArgs?: string;
  createdBy: string | null;
  steamAppId?: string | null;
  steamPreset?: string | null;
  steamLogin?: string;
  steamExtraFlags?: string;
  launchConfig?: string | null;
  dockerConfig?: string | null;
}

export function createServerRecord(input: CreateServerInput): ServerRecord {
  const id = crypto.randomUUID();
  fs.mkdirSync(instanceDir(id), { recursive: true });
  fs.mkdirSync(backupDir(id), { recursive: true });
  prep(
    `INSERT INTO servers
      (id, name, platform, loader, version, min_memory_mb, max_memory_mb, server_port, extra_java_args, extra_args, status, created_by, steam_app_id, steam_preset, steam_login, steam_extra_flags, launch_config, docker_config)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'installing', ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.name,
    input.platform,
    input.loader,
    input.version,
    input.minMemoryMb,
    input.maxMemoryMb,
    input.serverPort,
    input.extraJavaArgs ?? '',
    input.extraArgs ?? '',
    input.createdBy,
    input.steamAppId ?? null,
    input.steamPreset ?? null,
    input.steamLogin ?? 'anonymous',
    input.steamExtraFlags ?? '',
    input.launchConfig ?? null,
    input.dockerConfig ?? null
  );
  return getServer(id)!;
}

export function getServer(id: string): ServerRecord | undefined {
  return prep('SELECT * FROM servers WHERE id = ?').get(id) as ServerRecord | undefined;
}

export function listServers(): ServerRecord[] {
  return prep('SELECT * FROM servers ORDER BY created_at ASC').all() as unknown as ServerRecord[];
}

export function setServerStatus(id: string, status: ServerStatus) {
  prep('UPDATE servers SET status = ? WHERE id = ?').run(status, id);
}

export function setServerJar(id: string, jarFile: string, build: string | null) {
  prep('UPDATE servers SET jar_file = ?, build = ? WHERE id = ?').run(jarFile, build, id);
}

/** Used after an in-place update, where the Minecraft version and/or jar/build may have changed. */
export function setServerVersion(id: string, version: string, jarFile: string | null, build: string | null) {
  prep('UPDATE servers SET version = ?, jar_file = COALESCE(?, jar_file), build = ? WHERE id = ?').run(
    version,
    jarFile,
    build,
    id
  );
}

export interface UpdateServerInput {
  name?: string;
  minMemoryMb?: number;
  maxMemoryMb?: number;
  serverPort?: number;
  extraJavaArgs?: string;
  extraArgs?: string;
  autoStart?: boolean;
  steamLogin?: string;
  steamExtraFlags?: string;
  restartPolicy?: RestartPolicy;
  restartDelaySec?: number;
  restartMaxAttempts?: number;
}

/** Browsers only ever see the username part of a "user password" Steam login; saving that back keeps the stored password. */
function keepSteamPassword(next: string | undefined, current: string): string {
  if (next === undefined) return current;
  const [user, ...rest] = (current ?? '').trim().split(/\s+/);
  if (rest.length && next.trim() === user) return current;
  return next;
}

export function updateServerRecord(id: string, input: UpdateServerInput) {
  const current = getServer(id);
  if (!current) throw new Error('Server not found');
  prep(
    `UPDATE servers SET
      name = ?, min_memory_mb = ?, max_memory_mb = ?, server_port = ?,
      extra_java_args = ?, extra_args = ?, auto_start = ?, steam_login = ?, steam_extra_flags = ?,
      restart_policy = ?, restart_delay_sec = ?, restart_max_attempts = ?
     WHERE id = ?`
  ).run(
    input.name ?? current.name,
    input.minMemoryMb ?? current.min_memory_mb,
    input.maxMemoryMb ?? current.max_memory_mb,
    input.serverPort ?? current.server_port,
    input.extraJavaArgs ?? current.extra_java_args,
    input.extraArgs ?? current.extra_args,
    input.autoStart === undefined ? current.auto_start : input.autoStart ? 1 : 0,
    keepSteamPassword(input.steamLogin, current.steam_login),
    input.steamExtraFlags ?? current.steam_extra_flags,
    input.restartPolicy ?? current.restart_policy,
    input.restartDelaySec ?? current.restart_delay_sec,
    input.restartMaxAttempts ?? current.restart_max_attempts,
    id
  );
}

export function deleteServerRecord(id: string) {
  const snapshots = backupDir(id), rewind = rewindDir(id);
  prep('DELETE FROM servers WHERE id = ?').run(id);
  fs.rmSync(instanceDir(id), { recursive: true, force: true });
  fs.rmSync(snapshots, { recursive: true, force: true });
  fs.rmSync(rewind, { recursive: true, force: true });
}

export function setRewindConfig(id: string, config: string | null) {
  prep('UPDATE servers SET rewind_config = ? WHERE id = ?').run(config, id);
}

export function setModpack(id: string, modpack: string | null) {
  prep('UPDATE servers SET modpack = ? WHERE id = ?').run(modpack, id);
}

export function setRconConfig(id: string, config: string | null) {
  prep('UPDATE servers SET rcon_config = ? WHERE id = ?').run(config, id);
}

export function setAutoUpdate(id: string, config: string | null) {
  prep('UPDATE servers SET auto_update = ? WHERE id = ?').run(config, id);
}

export function setWorkshopState(id: string, state: string | null) {
  prep('UPDATE servers SET workshop = ? WHERE id = ?').run(state, id);
}

export function setServerSuspension(id: string, suspended: boolean, reason: string | null, by: string | null) {
  prep(
    `UPDATE servers SET suspended = ?, suspended_reason = ?, suspended_at = ?, suspended_by = ? WHERE id = ?`
  ).run(suspended ? 1 : 0, suspended ? reason : null, suspended ? new Date().toISOString() : null, suspended ? by : null, id);
}

/** Restores the fields an instance carries between nodes during a transfer. */
export function applyTransferredFields(
  id: string,
  fields: Pick<ServerRecord, 'jar_file' | 'build' | 'extra_java_args' | 'extra_args'>
) {
  prep('UPDATE servers SET jar_file = ?, build = ?, extra_java_args = ?, extra_args = ? WHERE id = ?').run(
    fields.jar_file,
    fields.build,
    fields.extra_java_args,
    fields.extra_args,
    id
  );
}

export function setLaunchConfig(id: string, launchConfig: string | null) {
  prep('UPDATE servers SET launch_config = ? WHERE id = ?').run(launchConfig, id);
}

export function setUpnpConfig(id: string, config: string | null) {
  prep('UPDATE servers SET upnp_config = ? WHERE id = ?').run(config, id);
}

export function setIsolation(id: string, isolation: 'inherit' | 'off') {
  prep('UPDATE servers SET isolation = ? WHERE id = ?').run(isolation, id);
}

export function setDockerConfig(id: string, config: string, image: string) {
  prep('UPDATE servers SET docker_config = ?, version = ? WHERE id = ?').run(config, image, id);
}
