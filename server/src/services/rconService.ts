import net from 'node:net';
import crypto from 'node:crypto';
import { HttpError } from '../utils/asyncHandler.js';
import { getServer, setRconConfig } from './serverService.js';
import { findPresetFor } from './steamGames.js';
import { readServerProperties, writeServerProperties } from './propertiesService.js';
import type { ServerRecord } from '../types/index.js';

/**
 * RCON consoles, for games whose console doesn't read standard input well (Rust, Source games on
 * Windows, ARK, Palworld…). Two protocols:
 *
 *  - source  — Valve's Source RCON over TCP (also Minecraft Java, ARK, Palworld, Conan, Factorio).
 *  - webrcon — Rust's WebSocket RCON (JSON messages).
 *
 * When an instance turns on "send console commands through RCON", the console box, quick actions
 * and graceful-stop commands go over RCON instead of the process's standard input.
 */

export type RconProtocol = 'source' | 'webrcon';

export interface RconConfig {
  enabled: boolean;
  protocol: RconProtocol;
  host: string;
  port: number;
  password: string;
  /** Console commands (and stop commands) go over RCON instead of stdin. */
  useForConsole: boolean;
}

/** What the browser gets: never the password. */
export interface PublicRcon extends Omit<RconConfig, 'password'> {
  hasPassword: boolean;
}

export interface RconDefaults {
  protocol: RconProtocol;
  port: number;
  /** Outpost sets RCON up in the game for you (server.properties / launch arguments). */
  autoConfigure: boolean;
  note: string | null;
}

export function rconDefaults(server: ServerRecord): RconDefaults | null {
  if (server.platform === 'java') {
    return { protocol: 'source', port: 25575, autoConfigure: true, note: 'Outpost turns on enable-rcon in server.properties with this port and password.' };
  }
  if (server.platform === 'steam') {
    const preset = findPresetFor(server);
    if (preset?.rcon) return { protocol: preset.rcon.protocol, port: preset.rcon.port(server), autoConfigure: !!(preset.rcon.launchArgs || preset.rcon.automatic), note: preset.rcon.note ?? null };
    return { protocol: 'source', port: server.server_port, autoConfigure: false, note: 'Turn RCON on in the game’s own settings with the same port and password.' };
  }
  if (server.platform === 'custom') return { protocol: 'source', port: server.server_port + 1, autoConfigure: false, note: 'Turn RCON on in the server’s own settings with the same port and password.' };
  return null;
}

export function rconConfigOf(server: Pick<ServerRecord, 'rcon_config'>): RconConfig | null {
  if (!server.rcon_config) return null;
  try {
    const raw = JSON.parse(server.rcon_config) as Partial<RconConfig>;
    if (typeof raw.port !== 'number' || typeof raw.password !== 'string') return null;
    return {
      enabled: raw.enabled === true,
      protocol: raw.protocol === 'webrcon' ? 'webrcon' : 'source',
      host: typeof raw.host === 'string' && raw.host ? raw.host : '127.0.0.1',
      port: raw.port,
      password: raw.password,
      useForConsole: raw.useForConsole === true,
    };
  } catch {
    return null;
  }
}

export function publicRcon(cfg: RconConfig | null): PublicRcon | null {
  if (!cfg) return null;
  const { password, ...rest } = cfg;
  return { ...rest, hasPassword: !!password };
}

/** The active config, when RCON is on. */
export function activeRcon(server: ServerRecord): RconConfig | null {
  const cfg = rconConfigOf(server);
  return cfg?.enabled ? cfg : null;
}

const HOST = /^[A-Za-z0-9.\-:]{1,253}$/;

/** Saves an instance's RCON settings (keeping the stored password when none is sent) and, where Outpost can, configures the game. */
export function saveRcon(server: ServerRecord, input: Record<string, unknown>): { config: RconConfig; configured: string | null } {
  const prev = rconConfigOf(server);
  const defaults = rconDefaults(server);
  if (!defaults) throw new HttpError(400, 'RCON isn’t available for this kind of instance');
  const port = Number(input.port ?? prev?.port ?? defaults.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, 'Port must be 1–65535');
  const host = typeof input.host === 'string' && input.host.trim() ? input.host.trim() : prev?.host ?? '127.0.0.1';
  if (!HOST.test(host)) throw new HttpError(400, 'Host must be a hostname or IP address');
  let password = typeof input.password === 'string' && input.password ? input.password : prev?.password ?? '';
  if (input.generatePassword === true || (!password && input.enabled === true)) password = crypto.randomBytes(18).toString('base64url');
  if (password.length > 200 || /[\r\n]/.test(password)) throw new HttpError(400, 'Password is too long or has line breaks');
  const config: RconConfig = {
    enabled: input.enabled === undefined ? prev?.enabled ?? false : input.enabled === true,
    protocol: input.protocol === 'webrcon' ? 'webrcon' : input.protocol === 'source' ? 'source' : prev?.protocol ?? defaults.protocol,
    host,
    port,
    password,
    useForConsole: input.useForConsole === undefined ? prev?.useForConsole ?? false : input.useForConsole === true,
  };
  if (config.enabled && !config.password) throw new HttpError(400, 'Set a password (or let Outpost generate one)');
  setRconConfig(server.id, JSON.stringify(config));
  let configured: string | null = null;
  if (server.platform === 'java') {
    // Only touch server.properties once it exists (after the first start) or when turning RCON on.
    const props = readServerProperties(server.id, server.platform);
    if (config.enabled || props.some((p) => p.key === 'enable-rcon')) {
      writeServerProperties(server.id, server.platform, {
        'enable-rcon': config.enabled ? 'true' : 'false',
        'rcon.port': String(config.port),
        'rcon.password': config.password,
      });
      configured = 'Updated server.properties — restart the server to apply.';
    }
  } else if (server.platform === 'steam' && config.enabled && defaults.autoConfigure) {
    configured = 'RCON is passed to the game on its next start.';
  }
  return { config, configured };
}

/** Launch arguments that switch RCON on, for presets that take it on the command line. */
export function rconLaunchArgs(server: ServerRecord): string[] {
  const cfg = activeRcon(server);
  if (!cfg || server.platform !== 'steam') return [];
  return findPresetFor(server)?.rcon?.launchArgs?.(cfg) ?? [];
}

// ---------------------------------------------------------------------------
// Source RCON
// ---------------------------------------------------------------------------

const SERVERDATA_AUTH = 3;
const SERVERDATA_AUTH_RESPONSE = 2;
const SERVERDATA_EXECCOMMAND = 2;

function packet(id: number, type: number, body: string): Buffer {
  const payload = Buffer.from(body, 'utf8');
  const buf = Buffer.alloc(14 + payload.length);
  buf.writeInt32LE(10 + payload.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  payload.copy(buf, 12);
  return buf; // the last two bytes stay 0 (body terminator + empty string)
}

/** Sends one command over Source RCON; resolves with the reply (multi-packet replies joined). */
export function sourceRcon(cfg: Pick<RconConfig, 'host' | 'port' | 'password'>, command: string, timeoutMs = 6000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: cfg.host, port: cfg.port });
    let buffer = Buffer.alloc(0);
    let authed = false;
    const reply: string[] = [];
    let quiet: NodeJS.Timeout | undefined;
    const finish = (err?: Error) => {
      clearTimeout(timer);
      clearTimeout(quiet);
      socket.destroy();
      if (err) reject(err);
      else resolve(reply.join(''));
    };
    const timer = setTimeout(() => (authed ? finish() : finish(new Error('RCON didn’t answer in time'))), timeoutMs);
    socket.on('connect', () => socket.write(packet(1, SERVERDATA_AUTH, cfg.password)));
    socket.on('error', (err: NodeJS.ErrnoException) =>
      finish(new Error(err.code === 'ECONNREFUSED' ? `Nothing is listening on ${cfg.host}:${cfg.port} — is RCON on in the game and the server running?` : err.message))
    );
    socket.on('close', () => finish());
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const size = buffer.readInt32LE(0);
        if (size < 10 || size > 1 << 20) return finish(new Error('Garbled RCON reply'));
        if (buffer.length < size + 4) break;
        const id = buffer.readInt32LE(4);
        const type = buffer.readInt32LE(8);
        const body = buffer.toString('utf8', 12, size + 2);
        buffer = buffer.subarray(size + 4);
        if (!authed) {
          if (type !== SERVERDATA_AUTH_RESPONSE) continue; // Source sends an empty RESPONSE_VALUE first
          if (id === -1) return finish(new Error('RCON password was rejected'));
          authed = true;
          socket.write(packet(2, SERVERDATA_EXECCOMMAND, command));
          continue;
        }
        if (id === 2) {
          reply.push(body);
          // Replies can span several packets; finish once the server goes quiet.
          clearTimeout(quiet);
          quiet = setTimeout(() => finish(), 200);
        }
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Rust WebRCON
// ---------------------------------------------------------------------------

export function webRcon(cfg: Pick<RconConfig, 'host' | 'port' | 'password'>, command: string, timeoutMs = 6000): Promise<string> {
  return new Promise((resolve, reject) => {
    const identifier = Math.floor(Math.random() * 1_000_000) + 1;
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://${cfg.host}:${cfg.port}/${encodeURIComponent(cfg.password)}`);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    let opened = false;
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('RCON didn’t answer in time'));
    }, timeoutMs);
    ws.addEventListener('open', () => {
      opened = true;
      ws.send(JSON.stringify({ Identifier: identifier, Message: command, Name: 'Outpost' }));
    });
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as { Identifier?: number; Message?: string };
        if (msg.Identifier !== identifier) return; // general log chatter
        clearTimeout(timer);
        ws.close();
        resolve(msg.Message ?? '');
      } catch {
        // not JSON — ignore
      }
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(opened ? 'RCON connection failed' : `Couldn’t connect to ${cfg.host}:${cfg.port} — wrong port or password, or the server isn’t running`));
    });
    ws.addEventListener('close', (ev) => {
      clearTimeout(timer);
      if (!opened) reject(new Error(`RCON refused the connection${ev.code === 1006 ? ' (wrong password?)' : ''}`));
    });
  });
}

export function rconSend(cfg: RconConfig, command: string): Promise<string> {
  return cfg.protocol === 'webrcon' ? webRcon(cfg, command) : sourceRcon(cfg, command);
}

/** Sends a command for an instance by id, using its saved settings. */
export async function rconCommand(serverId: string, command: string): Promise<string> {
  const server = getServer(serverId);
  if (!server) throw new HttpError(404, 'Server not found');
  const cfg = activeRcon(server);
  if (!cfg) throw new HttpError(400, 'RCON isn’t turned on for this instance');
  return rconSend(cfg, command);
}

/** A harmless command for "Test connection", per game. */
export function probeCommand(server: ServerRecord, cfg: RconConfig): string {
  if (cfg.protocol === 'webrcon') return 'serverinfo';
  if (server.platform === 'java') return 'list';
  const id = server.steam_preset ?? '';
  if (id === 'palworld') return 'Info';
  if (id === 'ark') return 'ListPlayers';
  return 'status';
}
