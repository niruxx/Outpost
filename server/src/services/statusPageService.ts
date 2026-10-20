import crypto from 'node:crypto';
import { prep } from '../db/db.js';
import { HttpError } from '../utils/asyncHandler.js';
import { getServer, listServers } from './serverService.js';
import { getRuntimeInfo, isRunning } from './processManager.js';
import { getOnlinePlayers } from './playerService.js';
import { readServerProperties } from './propertiesService.js';
import { findPresetFor } from './steamGames.js';
import { isMinecraftPlatform, type ServerRecord } from '../types/index.js';

/**
 * Public status pages: an optional, unguessable link per instance (/status/<slug>) that shows
 * anyone whether the server is up, how to join and who's playing — no sign-in. Nothing else
 * about the instance (owner, files, settings, panel) is exposed.
 */

export interface StatusPageConfig {
  enabled: boolean;
  slug: string;
  /** Shown under the name. */
  description: string;
  /** Address players connect to; empty = the panel's host name and the instance port. */
  address: string;
  showAddress: boolean;
  showPlayers: boolean;
  showVersion: boolean;
}

const SLUG = /^[a-z0-9-]{8,64}$/;
const newSlug = () => crypto.randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12).padEnd(12, '0');

export function statusPageOf(server: Pick<ServerRecord, 'status_page'>): StatusPageConfig | null {
  if (!server.status_page) return null;
  try {
    const raw = JSON.parse(server.status_page) as Partial<StatusPageConfig>;
    if (typeof raw.slug !== 'string' || !SLUG.test(raw.slug)) return null;
    return {
      enabled: raw.enabled === true,
      slug: raw.slug,
      description: typeof raw.description === 'string' ? raw.description : '',
      address: typeof raw.address === 'string' ? raw.address : '',
      showAddress: raw.showAddress !== false,
      showPlayers: raw.showPlayers !== false,
      showVersion: raw.showVersion !== false,
    };
  } catch {
    return null;
  }
}

function setStatusPage(id: string, cfg: StatusPageConfig) {
  prep('UPDATE servers SET status_page = ? WHERE id = ?').run(JSON.stringify(cfg), id);
}

export function saveStatusPage(server: ServerRecord, input: Record<string, unknown>): StatusPageConfig {
  const prev = statusPageOf(server) ?? { enabled: false, slug: newSlug(), description: '', address: '', showAddress: true, showPlayers: true, showVersion: true };
  const next: StatusPageConfig = { ...prev };
  if (input.enabled !== undefined) next.enabled = input.enabled === true;
  if (input.newLink === true) next.slug = newSlug();
  if (typeof input.description === 'string') {
    if (input.description.length > 500) throw new HttpError(400, 'Description is too long (500 characters max)');
    next.description = input.description.trim();
  }
  if (typeof input.address === 'string') {
    const a = input.address.trim();
    if (a && !/^[A-Za-z0-9.\-:[\]]{1,200}$/.test(a)) throw new HttpError(400, 'Address must be a host name or IP, optionally with :port');
    next.address = a;
  }
  for (const key of ['showAddress', 'showPlayers', 'showVersion'] as const) {
    if (input[key] !== undefined) next[key] = input[key] === true;
  }
  setStatusPage(server.id, next);
  return next;
}

function findBySlug(slug: string): ServerRecord | null {
  if (!SLUG.test(slug)) return null;
  for (const s of listServers()) {
    const cfg = statusPageOf(s);
    if (cfg?.enabled && cfg.slug === slug) return s;
  }
  return null;
}

function gameLabel(server: ServerRecord): string {
  if (server.platform === 'java') return `Minecraft: Java Edition${server.loader !== 'vanilla' ? ` (${server.loader[0].toUpperCase()}${server.loader.slice(1)})` : ''}`;
  if (server.platform === 'bedrock') return 'Minecraft: Bedrock Edition';
  if (server.platform === 'steam') return findPresetFor(server)?.label ?? 'Steam game server';
  if (server.platform === 'docker') return 'Container';
  return 'Server';
}

export interface PublicStatus {
  name: string;
  game: string;
  description: string;
  online: boolean;
  status: 'online' | 'starting' | 'offline' | 'maintenance';
  uptimeSeconds: number | null;
  address: string | null;
  /** When no address is set: the port, to combine with the page's own host name. */
  port: number | null;
  version: string | null;
  players: { online: number; max: number | null; names: string[] | null } | null;
  checkedAt: string;
}

/** What the public page shows for a slug — null when there's no such (enabled) page. */
export function publicStatus(slug: string): PublicStatus | null {
  const server = findBySlug(slug);
  if (!server) return null;
  const cfg = statusPageOf(server)!;
  const fresh = getServer(server.id) ?? server;
  const running = isRunning(fresh.id);
  const status: PublicStatus['status'] = fresh.suspended
    ? 'maintenance'
    : fresh.status === 'running'
      ? 'online'
      : fresh.status === 'starting' || (running && fresh.status !== 'stopping')
        ? 'starting'
        : ['installing', 'updating', 'transferring'].includes(fresh.status)
          ? 'maintenance'
          : 'offline';
  let players: PublicStatus['players'] = null;
  if (cfg.showPlayers && isMinecraftPlatform(fresh.platform)) {
    const names = status === 'online' ? getOnlinePlayers(fresh.id) : [];
    const maxRaw = readServerProperties(fresh.id, fresh.platform).find((p) => p.key === 'max-players')?.value;
    players = { online: names.length, max: maxRaw && /^\d+$/.test(maxRaw) ? Number(maxRaw) : null, names };
  }
  const runtime = status === 'online' ? getRuntimeInfo(fresh.id) : null;
  return {
    name: fresh.name,
    game: gameLabel(fresh),
    description: cfg.description,
    online: status === 'online',
    status,
    uptimeSeconds: runtime ? Math.floor(runtime.uptimeMs / 1000) : null,
    address: cfg.showAddress && cfg.address ? cfg.address : null,
    port: cfg.showAddress && !cfg.address && fresh.platform !== 'docker' ? fresh.server_port : null,
    version: cfg.showVersion && fresh.platform !== 'docker' && fresh.platform !== 'custom' ? (fresh.platform === 'bedrock' ? fresh.build ?? null : fresh.version !== 'latest' ? fresh.version : null) : null,
    players,
    checkedAt: new Date().toISOString(),
  };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** A shields-style SVG badge: "<name> | online · 3/20". */
export function statusBadgeSvg(s: PublicStatus): string {
  const left = s.name.length > 28 ? `${s.name.slice(0, 27)}…` : s.name;
  const right =
    s.status === 'online' ? `online${s.players ? ` · ${s.players.online}${s.players.max ? `/${s.players.max}` : ''}` : ''}` : s.status;
  const color = s.status === 'online' ? '#3fb950' : s.status === 'starting' ? '#d29922' : s.status === 'maintenance' ? '#58a6ff' : '#8b949e';
  const w = (t: string) => Math.round(t.length * 6.6) + 14;
  const lw = w(left);
  const rw = w(right);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + rw}" height="20" role="img" aria-label="${esc(left)}: ${esc(right)}"><title>${esc(left)}: ${esc(right)}</title><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><clipPath id="r"><rect width="${lw + rw}" height="20" rx="3" fill="#fff"/></clipPath><g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${rw}" height="20" fill="${color}"/><rect width="${lw + rw}" height="20" fill="url(#s)"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11"><text x="${lw / 2}" y="14">${esc(left)}</text><text x="${lw + rw / 2}" y="14">${esc(right)}</text></g></svg>`;
}
