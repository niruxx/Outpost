import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { instanceDir } from '../utils/paths.js';
import { HttpError } from '../utils/asyncHandler.js';
import { readServerProperties, writeServerProperties } from './propertiesService.js';
import { isProxyLoader, type ServerRecord } from '../types/index.js';

/**
 * Velocity / Waterfall / BungeeCord: the proxy's listen port, its list of backend servers, and
 * wiring a backend Outpost instance up for player-info forwarding. There's no YAML/TOML library in
 * the server, so every edit here is a targeted line rewrite that leaves the rest of the file —
 * comments included — exactly as it was.
 */

export type ProxyKind = 'velocity' | 'bungee';
export type ForwardingMode = 'none' | 'legacy' | 'bungeeguard' | 'modern';

export interface ProxyBackend {
  name: string;
  address: string;
  restricted?: boolean;
  motd?: string;
}

export interface ProxyNetwork {
  kind: ProxyKind;
  /** False until the proxy has been started once and written its config file. */
  configured: boolean;
  configFile: string;
  backends: ProxyBackend[];
  /** Servers players are sent to on join, in order (Velocity `try`, Bungee `priorities`). */
  tryOrder: string[];
  forwarding: ForwardingMode;
  onlineMode: boolean;
}

export const proxyKindOf = (server: ServerRecord): ProxyKind => (server.loader === 'velocity' ? 'velocity' : 'bungee');

function requireProxy(server: ServerRecord): ProxyKind {
  if (!isProxyLoader(server.loader)) throw new HttpError(400, 'This instance isn’t a Minecraft proxy');
  return proxyKindOf(server);
}

const configPath = (server: ServerRecord) => path.join(instanceDir(server.id), proxyKindOf(server) === 'velocity' ? 'velocity.toml' : 'config.yml');
const readText = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
const ADDRESS_RE = /^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[[0-9a-fA-F:]+\](:\d{1,5})?$/;

// ---------------------------------------------------------------------------
// Tiny YAML helpers (block style only, which is what Bungee and Paper write)
// ---------------------------------------------------------------------------

const indentOf = (line: string) => line.length - line.trimStart().length;
const isContent = (line: string) => line.trim() !== '' && !line.trimStart().startsWith('#');

/** End (exclusive) of the block that starts at `start`, i.e. the next content line at <= `indent`. */
function blockEnd(lines: string[], start: number, indent: number): number {
  for (let i = start + 1; i < lines.length; i++) if (isContent(lines[i]) && indentOf(lines[i]) <= indent) return i;
  return lines.length;
}

/** Finds `a.b.c` in block YAML; returns the line index or -1. */
export function findYamlKey(lines: string[], keys: string[]): number {
  let from = 0;
  let to = lines.length;
  let parentIndent = -1;
  let found = -1;
  for (const key of keys) {
    found = -1;
    const re = new RegExp(`^(\\s*)${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\s|$)`);
    let childIndent: number | null = null;
    for (let i = from; i < to; i++) {
      if (!isContent(lines[i])) continue;
      const ind = indentOf(lines[i]);
      if (ind <= parentIndent) break;
      childIndent ??= ind;
      if (ind !== childIndent) continue;
      if (re.test(lines[i])) {
        found = i;
        break;
      }
    }
    if (found < 0) return -1;
    parentIndent = indentOf(lines[found]);
    from = found + 1;
    to = blockEnd(lines, found, parentIndent);
  }
  return found;
}

/** Sets a scalar at `keys` in place; returns false when the key isn't in the file. */
export function setYamlScalar(lines: string[], keys: string[], value: string): boolean {
  const i = findYamlKey(lines, keys);
  if (i < 0) return false;
  const key = keys[keys.length - 1];
  lines[i] = `${' '.repeat(indentOf(lines[i]))}${key}: ${value}`;
  return true;
}

const yamlString = (v: string) => `'${v.replace(/'/g, "''")}'`;
const unquote = (v: string) => {
  const t = v.trim();
  if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
  return t;
};

// ---------------------------------------------------------------------------
// Velocity (velocity.toml)
// ---------------------------------------------------------------------------

function tomlSection(lines: string[], name: string): [number, number] | null {
  const start = lines.findIndex((l) => l.trim() === `[${name}]`);
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[[^\]]+\]\s*$/.test(lines[end])) end++;
  return [start, end];
}

function tomlTopValue(lines: string[], key: string): string | null {
  for (const line of lines) {
    if (/^\s*\[/.test(line)) break; // top-level keys come before the first table
    const m = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`));
    if (m) return unquote(m[1].replace(/\s+#.*$/, ''));
  }
  return null;
}

function setTomlTop(lines: string[], key: string, value: string): void {
  const end = lines.findIndex((l) => /^\s*\[/.test(l));
  for (let i = 0; i < (end < 0 ? lines.length : end); i++) {
    if (new RegExp(`^\\s*${key}\\s*=`).test(lines[i])) {
      lines[i] = `${key} = ${value}`;
      return;
    }
  }
  lines.splice(end < 0 ? lines.length : end, 0, `${key} = ${value}`);
}

function readVelocity(text: string): Omit<ProxyNetwork, 'kind' | 'configured' | 'configFile'> {
  const lines = text.split(/\r?\n/);
  const backends: ProxyBackend[] = [];
  let tryOrder: string[] = [];
  const section = tomlSection(lines, 'servers');
  if (section) {
    const body = lines.slice(section[0] + 1, section[1]).join('\n');
    const tryMatch = body.match(/^\s*try\s*=\s*\[([\s\S]*?)\]/m);
    if (tryMatch) tryOrder = [...tryMatch[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    for (const m of body.replace(/^\s*try\s*=\s*\[[\s\S]*?\]/m, '').matchAll(/^\s*("?)([A-Za-z0-9_-]+)\1\s*=\s*"([^"]*)"/gm)) {
      backends.push({ name: m[2], address: m[3] });
    }
  }
  const mode = (tomlTopValue(lines, 'player-info-forwarding-mode') ?? 'none').toLowerCase();
  return {
    backends,
    tryOrder,
    forwarding: (['none', 'legacy', 'bungeeguard', 'modern'].includes(mode) ? mode : 'none') as ForwardingMode,
    onlineMode: tomlTopValue(lines, 'online-mode') !== 'false',
  };
}

function writeVelocity(text: string, net: { backends: ProxyBackend[]; tryOrder: string[]; forwarding: ForwardingMode; onlineMode: boolean }): string {
  const lines = text.split(/\r?\n/);
  setTomlTop(lines, 'player-info-forwarding-mode', `"${net.forwarding.toUpperCase()}"`);
  setTomlTop(lines, 'online-mode', String(net.onlineMode));
  const block = [
    '[servers]',
    '# Managed from Outpost → Network. Comments added here are not kept.',
    ...net.backends.map((b) => `${b.name} = "${b.address}"`),
    '',
    'try = [',
    ...net.tryOrder.map((n, i) => `    "${n}"${i < net.tryOrder.length - 1 ? ',' : ''}`),
    ']',
    '',
  ];
  const section = tomlSection(lines, 'servers');
  if (section) lines.splice(section[0], section[1] - section[0], ...block);
  else lines.push('', ...block);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// BungeeCord / Waterfall (config.yml)
// ---------------------------------------------------------------------------

/** Line range of the first `listeners:` list item (`- key: …` plus its continuation lines). */
function firstListener(lines: string[]): [number, number, number] | null {
  const head = findYamlKey(lines, ['listeners']);
  if (head < 0) return null;
  let item = head + 1;
  while (item < lines.length && !isContent(lines[item])) item++;
  // SnakeYAML writes list items either at the parent's indent or indented under it.
  if (item >= lines.length || !/^\s*-\s/.test(lines[item])) return null;
  const itemIndent = indentOf(lines[item]) + 2; // keys inside the item line up after "- "
  let stop = item + 1;
  while (stop < lines.length && (!isContent(lines[stop]) || indentOf(lines[stop]) >= itemIndent)) stop++;
  return [item, stop, itemIndent];
}

/** Finds `key:` inside the first listener (the item line itself may hold it after "- "). */
function listenerKey(lines: string[], key: string): number {
  const range = firstListener(lines);
  if (!range) return -1;
  const [item, stop, itemIndent] = range;
  for (let i = item; i < stop; i++) {
    const body = i === item ? lines[i].replace(/^\s*-\s/, ' '.repeat(itemIndent)) : lines[i];
    if (indentOf(body) === itemIndent && body.trimStart().startsWith(`${key}:`)) return i;
  }
  return -1;
}

function setListenerScalar(lines: string[], key: string, value: string): boolean {
  const i = listenerKey(lines, key);
  if (i < 0) return false;
  const prefix = lines[i].match(/^(\s*-\s+|\s*)/)![1];
  lines[i] = `${prefix}${key}: ${value}`;
  return true;
}

function readBungee(text: string): Omit<ProxyNetwork, 'kind' | 'configured' | 'configFile'> {
  const lines = text.split(/\r?\n/);
  const backends: ProxyBackend[] = [];
  const head = findYamlKey(lines, ['servers']);
  if (head >= 0) {
    const end = blockEnd(lines, head, indentOf(lines[head]));
    let current: ProxyBackend | null = null;
    let nameIndent: number | null = null;
    for (let i = head + 1; i < end; i++) {
      if (!isContent(lines[i])) continue;
      const ind = indentOf(lines[i]);
      nameIndent ??= ind;
      const m = lines[i].trim().match(/^([^:]+):\s*(.*)$/);
      if (!m) continue;
      if (ind === nameIndent) {
        current = { name: unquote(m[1]), address: '' };
        backends.push(current);
      } else if (current) {
        if (m[1] === 'address') current.address = unquote(m[2]);
        else if (m[1] === 'restricted') current.restricted = m[2].trim() === 'true';
        else if (m[1] === 'motd') current.motd = unquote(m[2]);
      }
    }
  }
  const tryOrder: string[] = [];
  const pri = listenerKey(lines, 'priorities');
  if (pri >= 0) {
    const inline = lines[pri].match(/priorities:\s*\[(.*)\]/);
    if (inline) tryOrder.push(...inline[1].split(',').map((s) => unquote(s)).filter(Boolean));
    else {
      for (let i = pri + 1; i < lines.length && /^\s*-\s/.test(lines[i]) && indentOf(lines[i]) >= indentOf(lines[pri].replace(/^\s*-\s/, '  ')); i++) {
        tryOrder.push(unquote(lines[i].trim().slice(1)));
      }
    }
  }
  const top = (key: string) => {
    const i = findYamlKey(lines, [key]);
    return i < 0 ? null : unquote(lines[i].slice(lines[i].indexOf(':') + 1));
  };
  return {
    backends,
    tryOrder,
    forwarding: top('ip_forward') === 'true' ? 'legacy' : 'none',
    onlineMode: top('online_mode') !== 'false',
  };
}

function writeBungee(text: string, net: { backends: ProxyBackend[]; tryOrder: string[]; forwarding: ForwardingMode; onlineMode: boolean }): string {
  const lines = text.split(/\r?\n/);
  const servers = [
    'servers:',
    ...net.backends.flatMap((b) => [
      `  ${b.name}:`,
      `    motd: ${yamlString(b.motd ?? `${b.name} (via Outpost)`)}`,
      `    address: ${b.address}`,
      `    restricted: ${b.restricted ? 'true' : 'false'}`,
    ]),
  ];
  if (!net.backends.length) servers[0] = 'servers: {}';
  const head = findYamlKey(lines, ['servers']);
  if (head >= 0) lines.splice(head, blockEnd(lines, head, indentOf(lines[head])) - head, ...servers);
  else lines.push(...servers);

  const pri = listenerKey(lines, 'priorities');
  if (pri >= 0) {
    const prefix = lines[pri].match(/^(\s*-\s+|\s*)/)![1];
    const keyIndent = prefix.length;
    let end = pri + 1;
    while (end < lines.length && /^\s*-\s/.test(lines[end]) && indentOf(lines[end]) >= keyIndent) end++;
    lines.splice(pri, end - pri, `${prefix}priorities:`, ...net.tryOrder.map((n) => `${' '.repeat(keyIndent)}- ${n}`));
    if (!net.tryOrder.length) lines[pri] = `${prefix}priorities: []`;
  }
  const setTop = (key: string, value: string) => {
    if (!setYamlScalar(lines, [key], value)) lines.push(`${key}: ${value}`);
  };
  setTop('ip_forward', net.forwarding === 'none' ? 'false' : 'true');
  setTop('online_mode', String(net.onlineMode));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getProxyNetwork(server: ServerRecord): ProxyNetwork {
  const kind = requireProxy(server);
  const file = configPath(server);
  const text = readText(file);
  const base = { kind, configured: text !== null, configFile: path.basename(file) };
  if (text === null) return { ...base, backends: [], tryOrder: [], forwarding: kind === 'velocity' ? 'none' : 'none', onlineMode: true };
  return { ...base, ...(kind === 'velocity' ? readVelocity(text) : readBungee(text)) };
}

export function sanitizeNetwork(server: ServerRecord, input: unknown): { backends: ProxyBackend[]; tryOrder: string[]; forwarding: ForwardingMode; onlineMode: boolean } {
  const kind = requireProxy(server);
  const raw = (input ?? {}) as Record<string, unknown>;
  const list = Array.isArray(raw.backends) ? raw.backends : [];
  if (list.length > 100) throw new HttpError(400, 'Too many backend servers');
  const seen = new Set<string>();
  const backends = list.map((b) => {
    const r = (b ?? {}) as Record<string, unknown>;
    const name = String(r.name ?? '').trim();
    const address = String(r.address ?? '').trim();
    if (!NAME_RE.test(name)) throw new HttpError(400, `“${name}” isn’t a valid server name (letters, numbers, - and _ only)`);
    if (seen.has(name.toLowerCase())) throw new HttpError(400, `There are two backends named “${name}”`);
    seen.add(name.toLowerCase());
    if (!ADDRESS_RE.test(address)) throw new HttpError(400, `“${address}” isn’t a valid host:port address`);
    const out: ProxyBackend = { name, address };
    if (typeof r.restricted === 'boolean') out.restricted = r.restricted;
    if (typeof r.motd === 'string' && r.motd.length <= 200) out.motd = r.motd.replace(/[\r\n]/g, ' ');
    return out;
  });
  const tryOrder = (Array.isArray(raw.tryOrder) ? raw.tryOrder : []).map(String).filter((n) => seen.has(n.toLowerCase()));
  const modes: ForwardingMode[] = kind === 'velocity' ? ['none', 'legacy', 'bungeeguard', 'modern'] : ['none', 'legacy'];
  const forwarding = modes.includes(raw.forwarding as ForwardingMode) ? (raw.forwarding as ForwardingMode) : 'none';
  return { backends, tryOrder, forwarding, onlineMode: raw.onlineMode !== false };
}

export function saveProxyNetwork(server: ServerRecord, input: unknown): ProxyNetwork {
  const kind = requireProxy(server);
  const net = sanitizeNetwork(server, input);
  const file = configPath(server);
  const text = readText(file);
  if (text === null) throw new HttpError(409, `Start the proxy once so it writes ${path.basename(file)}, then set up its servers here.`);
  fs.writeFileSync(file, kind === 'velocity' ? writeVelocity(text, net) : writeBungee(text, net));
  if (kind === 'velocity' && net.forwarding === 'modern') forwardingSecret(server);
  return getProxyNetwork(server);
}

/** Velocity's modern-forwarding secret (forwarding.secret), created if the proxy hasn't made one yet. */
export function forwardingSecret(server: ServerRecord): string {
  const lines = (readText(configPath(server)) ?? '').split(/\r?\n/);
  const name = tomlTopValue(lines, 'forwarding-secret-file') || 'forwarding.secret';
  const dir = instanceDir(server.id);
  const file = path.resolve(dir, name);
  if (!file.startsWith(dir + path.sep)) throw new HttpError(400, 'forwarding-secret-file points outside the instance');
  const existing = readText(file)?.trim();
  if (existing) return existing;
  const secret = crypto.randomBytes(12).toString('base64url');
  fs.writeFileSync(file, secret);
  return secret;
}

/**
 * Applies the proxy's port before each start: Velocity takes `--port`, Bungee/Waterfall read it
 * from the first listener (a minimal config.yml is written on the very first start, and Bungee
 * fills in every other default around it).
 */
export function proxyLaunchArgs(server: ServerRecord): string[] {
  if (!isProxyLoader(server.loader)) return [];
  if (proxyKindOf(server) === 'velocity') {
    // --port wins either way; keeping `bind` in step just stops the file from looking wrong.
    const file = configPath(server);
    const text = readText(file);
    if (text !== null) {
      const lines = text.split(/\r?\n/);
      const bind = tomlTopValue(lines, 'bind');
      if (bind) {
        const host = bind.includes(':') ? bind.slice(0, bind.lastIndexOf(':')) : '0.0.0.0';
        setTomlTop(lines, 'bind', `"${host}:${server.server_port}"`);
        const next = lines.join('\n');
        if (next !== text) fs.writeFileSync(file, next);
      }
    }
    return ['--port', String(server.server_port)];
  }
  const file = configPath(server);
  const text = readText(file);
  const port = server.server_port;
  if (text === null) {
    fs.writeFileSync(file, ['listeners:', `- host: 0.0.0.0:${port}`, `  query_port: ${port}`, ''].join('\n'));
    return [];
  }
  const lines = text.split(/\r?\n/);
  const host = listenerKey(lines, 'host');
  if (host >= 0) {
    const current = unquote(lines[host].slice(lines[host].indexOf(':') + 1));
    const bind = current.includes(':') ? current.slice(0, current.lastIndexOf(':')) : '0.0.0.0';
    setListenerScalar(lines, 'host', `${bind}:${port}`);
  }
  if (listenerKey(lines, 'query_port') >= 0) setListenerScalar(lines, 'query_port', String(port));
  const next = lines.join('\n');
  if (next !== text) fs.writeFileSync(file, next);
  return [];
}

/** The address a backend instance listens on, as the proxy should reach it. */
export function backendAddress(backend: ServerRecord): string {
  const props = readServerProperties(backend.id, backend.platform);
  const port = Number(props.find((p) => p.key === 'server-port')?.value) || backend.server_port;
  return `127.0.0.1:${port}`;
}

export interface LinkResult {
  network: ProxyNetwork;
  changes: string[];
  warnings: string[];
}

/**
 * Adds an Outpost Java instance behind this proxy and configures the backend for it: offline mode
 * (the proxy authenticates players) plus the matching forwarding switch so real UUIDs and IPs
 * reach the backend.
 */
export function linkBackend(proxy: ServerRecord, backend: ServerRecord, name: string): LinkResult {
  const kind = requireProxy(proxy);
  if (backend.platform !== 'java' || isProxyLoader(backend.loader)) throw new HttpError(400, 'Only Java game servers can sit behind a proxy');
  if (backend.id === proxy.id) throw new HttpError(400, 'A proxy can’t be its own backend');
  const current = getProxyNetwork(proxy);
  if (!current.configured) throw new HttpError(409, `Start the proxy once so it writes ${current.configFile}, then link servers.`);

  const changes: string[] = [];
  const warnings: string[] = [];
  const dir = instanceDir(backend.id);
  const address = backendAddress(backend);
  const backends = current.backends.filter((b) => b.name.toLowerCase() !== name.toLowerCase() && b.address !== address);
  backends.push({ name, address });
  const tryOrder = current.tryOrder.length ? current.tryOrder.filter((n) => backends.some((b) => b.name === n)) : [name];
  if (!tryOrder.length) tryOrder.push(name);

  // Velocity on a Paper-family backend uses modern forwarding; everything else uses legacy
  // (BungeeCord-style) forwarding, which Spigot, Paper and Purpur all understand.
  const paperFamily = backend.loader === 'paper' || backend.loader === 'purpur';
  let forwarding: ForwardingMode = kind === 'velocity' && paperFamily ? 'modern' : 'legacy';
  if (kind === 'velocity' && current.forwarding === 'modern' && !paperFamily) {
    warnings.push(`${backend.name} (${backend.loader}) doesn’t support Velocity modern forwarding — the proxy stays on modern, so players can’t join it until you switch forwarding.`);
    forwarding = 'modern';
  }
  if (kind === 'velocity' && current.forwarding === 'legacy' && paperFamily) forwarding = 'legacy';

  writeServerProperties(backend.id, backend.platform, { 'online-mode': 'false' });
  changes.push(`${backend.name}: server.properties online-mode=false (the proxy signs players in)`);

  if (forwarding === 'modern') {
    const secret = forwardingSecret(proxy);
    const file = path.join(dir, 'config', 'paper-global.yml');
    const text = readText(file);
    if (text === null) {
      warnings.push(`${backend.name} hasn’t written config/paper-global.yml yet — start it once, then link it again to finish modern forwarding.`);
    } else {
      const lines = text.split(/\r?\n/);
      const ok =
        setYamlScalar(lines, ['proxies', 'velocity', 'enabled'], 'true') &&
        setYamlScalar(lines, ['proxies', 'velocity', 'online-mode'], 'true') &&
        setYamlScalar(lines, ['proxies', 'velocity', 'secret'], yamlString(secret));
      if (ok) {
        fs.writeFileSync(file, lines.join('\n'));
        changes.push(`${backend.name}: config/paper-global.yml proxies.velocity enabled with this proxy’s secret`);
      } else warnings.push(`Couldn’t find proxies.velocity in ${backend.name}’s paper-global.yml — this Paper version may be too old for modern forwarding.`);
    }
  } else {
    const file = path.join(dir, 'spigot.yml');
    const text = readText(file);
    if (text === null) {
      // Spigot copies its defaults around whatever is already in the file.
      fs.writeFileSync(file, 'settings:\n  bungeecord: true\n');
      changes.push(`${backend.name}: created spigot.yml with settings.bungeecord=true`);
    } else {
      const lines = text.split(/\r?\n/);
      if (setYamlScalar(lines, ['settings', 'bungeecord'], 'true')) {
        fs.writeFileSync(file, lines.join('\n'));
        changes.push(`${backend.name}: spigot.yml settings.bungeecord=true`);
      } else warnings.push(`Couldn’t find settings.bungeecord in ${backend.name}’s spigot.yml.`);
    }
    if (backend.loader === 'vanilla' || !['paper', 'purpur', 'spigot'].includes(backend.loader)) {
      warnings.push(`${backend.name} is ${backend.loader}, which has no built-in proxy forwarding — players will show up with offline UUIDs unless a forwarding mod is installed.`);
    }
  }

  const network = saveProxyNetwork(proxy, { backends, tryOrder, forwarding, onlineMode: true });
  changes.unshift(`${proxy.name}: added “${name}” → ${address}, forwarding ${forwarding}`);
  return { network, changes, warnings };
}
