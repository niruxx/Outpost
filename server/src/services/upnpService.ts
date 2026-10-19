import crypto from 'node:crypto';
import { envVar } from '../utils/env.js';
import dgram from 'node:dgram';
import { HttpError } from '../utils/asyncHandler.js';
import { logger } from '../utils/logger.js';
import { getServer, setUpnpConfig } from './serverService.js';
import { appendLine } from './consoleLogService.js';
import { findPresetFor } from './steamGames.js';
import { launchConfigOf } from './launchConfig.js';
import { dockerConfigOf } from './containerService.js';
import type { ServerRecord } from '../types/index.js';

/**
 * UPnP IGD port forwarding: discovers the LAN's Internet Gateway Device over SSDP and asks it
 * (via SOAP) to forward external ports to this host. Per-instance rules can be applied on demand
 * or automatically while the instance runs, with leases renewed in the background.
 */

export type UpnpProtocol = 'TCP' | 'UDP' | 'BOTH';

export interface UpnpRule {
  id: string;
  label: string;
  protocol: UpnpProtocol;
  externalStart: number;
  externalEnd: number;
  /** First internal port; the range maps 1:1 from here. */
  internalStart: number;
  enabled: boolean;
}

export interface UpnpConfig {
  /** Map when the instance starts, unmap when it stops. */
  autoMap: boolean;
  /** Lease in seconds (0 = permanent until removed). Renewed at half-life while mapped. */
  leaseSeconds: number;
  rules: UpnpRule[];
}

export interface Gateway {
  location: string;
  controlUrl: string;
  serviceType: string;
  friendlyName: string;
  manufacturer: string | null;
  modelName: string | null;
  localAddress: string;
  discoveredAt: string;
}

export interface MappingState {
  externalPort: number;
  internalPort: number;
  protocol: 'TCP' | 'UDP';
  ok: boolean;
  error: string | null;
  at: string;
}

export interface RouterMapping {
  externalPort: number;
  internalPort: number;
  internalClient: string;
  protocol: string;
  description: string;
  enabled: boolean;
  leaseSeconds: number;
}

const MAX_PORTS_PER_RULE = 256;
const MAX_PORTS_TOTAL = 512;
const MAX_RULES = 20;
const GATEWAY_CACHE_MS = 10 * 60_000;
const PANEL_PORT = Number(process.env.PORT ?? 8642);

class UpnpError extends Error {
  constructor(
    public code: number | null,
    message: string
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

const SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];

export function ssdpSearch(timeoutMs = 2500): Promise<string[]> {
  return new Promise((resolve) => {
    const locations = new Set<string>();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const finish = () => {
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve([...locations]);
    };
    socket.on('error', finish);
    socket.on('message', (msg) => {
      const m = msg.toString().match(/^location:\s*(\S+)/im);
      if (m) locations.add(m[1].trim());
    });
    socket.bind(0, () => {
      for (const st of SEARCH_TARGETS) {
        const packet = Buffer.from(
          `M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`
        );
        socket.send(packet, 1900, '239.255.255.250');
      }
      setTimeout(finish, timeoutMs);
    });
  });
}

const tag = (xml: string, name: string) => xml.match(new RegExp(`<${name}>([^<]*)</${name}>`, 'i'))?.[1]?.trim() ?? null;

async function describeGateway(location: string): Promise<Omit<Gateway, 'localAddress' | 'discoveredAt'> | null> {
  const res = await fetch(location, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) return null;
  const xml = await res.text();
  const services = [...xml.matchAll(/<service>([\s\S]*?)<\/service>/gi)].map((m) => ({
    serviceType: tag(m[1], 'serviceType') ?? '',
    controlUrl: tag(m[1], 'controlURL') ?? '',
  }));
  const wan =
    services.find((s) => /WANIPConnection:2/.test(s.serviceType)) ??
    services.find((s) => /WANIPConnection:1/.test(s.serviceType)) ??
    services.find((s) => /WANPPPConnection:1/.test(s.serviceType));
  if (!wan?.controlUrl) return null;
  const base = tag(xml, 'URLBase') || location;
  return {
    location,
    controlUrl: new URL(wan.controlUrl, base).toString(),
    serviceType: wan.serviceType,
    friendlyName: tag(xml, 'friendlyName') ?? 'Router',
    manufacturer: tag(xml, 'manufacturer'),
    modelName: tag(xml, 'modelName'),
  };
}

/** Which local address this host uses to reach the router — the address mappings forward to. */
function localAddressFor(host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.on('error', (err) => {
      socket.close();
      reject(err);
    });
    socket.connect(1900, host, () => {
      const { address } = socket.address();
      socket.close();
      resolve(address);
    });
  });
}

let cachedGateway: Gateway | null = null;
let discovering: Promise<Gateway> | null = null;

export async function discoverGateway(force = false): Promise<Gateway> {
  if (!force && cachedGateway && Date.now() - Date.parse(cachedGateway.discoveredAt) < GATEWAY_CACHE_MS) return cachedGateway;
  if (discovering) return discovering;
  discovering = (async () => {
    // OUTPOST_UPNP_GATEWAY=http://<router>:<port>/<description>.xml skips multicast discovery —
    // for networks where SSDP can't get through (Docker, VPNs) or to pin a specific router.
    const pinned = envVar('UPNP_GATEWAY')?.trim();
    const locations = pinned ? [pinned] : await ssdpSearch();
    for (const location of locations) {
      try {
        const described = await describeGateway(location);
        if (!described) continue;
        const localAddress = await localAddressFor(new URL(location).hostname);
        cachedGateway = { ...described, localAddress, discoveredAt: new Date().toISOString() };
        return cachedGateway;
      } catch (err) {
        logger.debug(`UPnP: ignoring ${location}`, err);
      }
    }
    throw new HttpError(
      502,
      'No UPnP router answered. Check that UPnP ("UPnP IGD") is on in your router and that this host is on the same network — ' +
        "discovery doesn't cross VPNs, Docker bridge networks or a second router. A host firewall also commonly drops the router's " +
        'replies: with firewalld run `sudo firewall-cmd --permanent --add-service=upnp-client && sudo firewall-cmd --reload` (or open ' +
        'UDP 1900 inbound). If discovery still fails, set OUTPOST_UPNP_GATEWAY to the router\'s description URL to skip it.'
    );
  })().finally(() => {
    discovering = null;
  });
  return discovering;
}

// ---------------------------------------------------------------------------
// SOAP
// ---------------------------------------------------------------------------

const escapeXml = (v: string) => v.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);

async function soap(gw: Gateway, action: string, args: [string, string | number][]): Promise<Record<string, string>> {
  const body =
    '<?xml version="1.0"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${gw.serviceType}">` +
    args.map(([k, v]) => `<${k}>${escapeXml(String(v))}</${k}>`).join('') +
    `</u:${action}></s:Body></s:Envelope>`;
  let res: Response;
  try {
    res = await fetch(gw.controlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${gw.serviceType}#${action}"` },
      body,
      signal: AbortSignal.timeout(6000),
    });
  } catch (err) {
    cachedGateway = null; // router may have moved/rebooted; rediscover next time
    throw new UpnpError(null, `Router didn't respond: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await res.text();
  if (!res.ok) {
    const code = Number(tag(text, 'errorCode')) || null;
    const desc = tag(text, 'errorDescription') ?? `HTTP ${res.status}`;
    throw new UpnpError(code, code ? `${desc} (UPnP error ${code})` : desc);
  }
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/<(New\w+)>([^<]*)<\/\1>/g)) out[m[1]] = m[2];
  return out;
}

export async function getExternalIp(gw: Gateway): Promise<string | null> {
  try {
    return (await soap(gw, 'GetExternalIPAddress', [])).NewExternalIPAddress || null;
  } catch {
    return null;
  }
}

async function addMapping(gw: Gateway, m: { externalPort: number; internalPort: number; protocol: 'TCP' | 'UDP'; description: string; leaseSeconds: number }) {
  const send = (lease: number) =>
    soap(gw, 'AddPortMapping', [
      ['NewRemoteHost', ''],
      ['NewExternalPort', m.externalPort],
      ['NewProtocol', m.protocol],
      ['NewInternalPort', m.internalPort],
      ['NewInternalClient', gw.localAddress],
      ['NewEnabled', 1],
      ['NewPortMappingDescription', m.description],
      ['NewLeaseDuration', lease],
    ]);
  try {
    await send(m.leaseSeconds);
  } catch (err) {
    // 725 OnlyPermanentLeasesSupported: some routers refuse timed leases.
    if (err instanceof UpnpError && err.code === 725 && m.leaseSeconds !== 0) await send(0);
    else throw err;
  }
}

async function deleteMapping(gw: Gateway, externalPort: number, protocol: 'TCP' | 'UDP') {
  try {
    await soap(gw, 'DeletePortMapping', [
      ['NewRemoteHost', ''],
      ['NewExternalPort', externalPort],
      ['NewProtocol', protocol],
    ]);
  } catch (err) {
    if (err instanceof UpnpError && err.code === 714) return; // NoSuchEntryInArray — already gone
    throw err;
  }
}

/** The router's mapping for one external port, or null when there is none (error 714). Falls back
 *  to scanning the list on routers that don't implement the direct lookup. */
export async function getSpecificMapping(gw: Gateway, externalPort: number, protocol: 'TCP' | 'UDP'): Promise<RouterMapping | null> {
  try {
    const r = await soap(gw, 'GetSpecificPortMappingEntry', [
      ['NewRemoteHost', ''],
      ['NewExternalPort', externalPort],
      ['NewProtocol', protocol],
    ]);
    return {
      externalPort,
      internalPort: Number(r.NewInternalPort),
      internalClient: r.NewInternalClient ?? '',
      protocol,
      description: r.NewPortMappingDescription ?? '',
      enabled: r.NewEnabled !== '0',
      leaseSeconds: Number(r.NewLeaseDuration) || 0,
    };
  } catch (err) {
    if (err instanceof UpnpError && err.code === 714) return null;
    // Only fall back when the router answered (e.g. 401 "invalid action"); a silent router is an error.
    if (!(err instanceof UpnpError) || err.code === null) throw err;
    const all = await listRouterMappings(gw);
    return all.find((m) => m.externalPort === externalPort && m.protocol.toUpperCase() === protocol) ?? null;
  }
}

/** Mappings currently on the router (most routers expose them by index). */
export async function listRouterMappings(gw: Gateway, limit = 128): Promise<RouterMapping[]> {
  const out: RouterMapping[] = [];
  for (let i = 0; i < limit; i++) {
    try {
      const r = await soap(gw, 'GetGenericPortMappingEntry', [['NewPortMappingIndex', i]]);
      out.push({
        externalPort: Number(r.NewExternalPort),
        internalPort: Number(r.NewInternalPort),
        internalClient: r.NewInternalClient ?? '',
        protocol: r.NewProtocol ?? '',
        description: r.NewPortMappingDescription ?? '',
        enabled: r.NewEnabled !== '0',
        leaseSeconds: Number(r.NewLeaseDuration) || 0,
      });
    } catch {
      break; // 713 SpecifiedArrayIndexInvalid marks the end
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-instance config
// ---------------------------------------------------------------------------

export function defaultProtocol(server: ServerRecord): UpnpProtocol {
  if (server.platform === 'java') return 'TCP';
  if (server.platform === 'bedrock') return 'UDP';
  if (server.platform === 'custom') return (launchConfigOf(server).protocol ?? 'tcp').toUpperCase() as UpnpProtocol;
  if (server.platform === 'docker') return (dockerConfigOf(server)?.ports[0]?.protocol ?? 'tcp').toUpperCase() as UpnpProtocol;
  return (findPresetFor(server)?.portProtocol ?? 'udp').toUpperCase() as UpnpProtocol;
}

export function defaultUpnpConfig(server: ServerRecord): UpnpConfig {
  return {
    autoMap: false,
    leaseSeconds: 3600,
    rules: [
      {
        id: crypto.randomUUID(),
        label: 'Game port',
        protocol: defaultProtocol(server),
        externalStart: server.server_port,
        externalEnd: server.server_port,
        internalStart: server.server_port,
        enabled: true,
      },
    ],
  };
}

export function upnpConfigOf(server: ServerRecord): { config: UpnpConfig; configured: boolean } {
  if (!server.upnp_config) return { config: defaultUpnpConfig(server), configured: false };
  try {
    return { config: JSON.parse(server.upnp_config) as UpnpConfig, configured: true };
  } catch {
    return { config: defaultUpnpConfig(server), configured: false };
  }
}

const portOk = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 65535;

export function sanitizeUpnpConfig(input: unknown, opts: { isAdmin: boolean }): UpnpConfig {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'UPnP config must be an object');
  const raw = input as Record<string, unknown>;
  const lease = Number(raw.leaseSeconds ?? 3600);
  if (!Number.isFinite(lease) || (lease !== 0 && (lease < 120 || lease > 604_800))) {
    throw new HttpError(400, 'Lease must be 0 (permanent) or between 120 seconds and 7 days');
  }
  const rulesIn = Array.isArray(raw.rules) ? raw.rules : [];
  if (rulesIn.length > MAX_RULES) throw new HttpError(400, `At most ${MAX_RULES} rules`);
  let total = 0;
  const rules = rulesIn.map((r: any, i: number): UpnpRule => {
    const externalStart = Number(r?.externalStart);
    const externalEnd = r?.externalEnd === undefined || r?.externalEnd === '' ? externalStart : Number(r.externalEnd);
    const internalStart = r?.internalStart === undefined || r?.internalStart === '' ? externalStart : Number(r.internalStart);
    const where = `Rule ${i + 1}`;
    if (!portOk(externalStart) || !portOk(externalEnd) || !portOk(internalStart)) throw new HttpError(400, `${where}: ports must be 1–65535`);
    if (externalEnd < externalStart) throw new HttpError(400, `${where}: the range end is before its start`);
    const count = externalEnd - externalStart + 1;
    if (count > MAX_PORTS_PER_RULE) throw new HttpError(400, `${where}: at most ${MAX_PORTS_PER_RULE} ports per rule`);
    const internalEnd = internalStart + count - 1;
    if (internalEnd > 65535) throw new HttpError(400, `${where}: the internal range runs past 65535`);
    const protocol: UpnpProtocol = ['TCP', 'UDP', 'BOTH'].includes(r?.protocol) ? r.protocol : 'TCP';
    if (!opts.isAdmin && r?.enabled !== false) {
      if (externalStart < 1024 || internalStart < 1024) throw new HttpError(403, `${where}: only admins can forward ports below 1024`);
      if (internalStart <= PANEL_PORT && PANEL_PORT <= internalEnd) throw new HttpError(403, `${where}: only admins can forward the panel's own port (${PANEL_PORT})`);
    }
    total += count * (protocol === 'BOTH' ? 2 : 1);
    return {
      id: typeof r?.id === 'string' && r.id ? r.id.slice(0, 64) : crypto.randomUUID(),
      label: typeof r?.label === 'string' ? r.label.trim().slice(0, 40) : '',
      protocol,
      externalStart,
      externalEnd,
      internalStart,
      enabled: r?.enabled !== false,
    };
  });
  if (total > MAX_PORTS_TOTAL) throw new HttpError(400, `At most ${MAX_PORTS_TOTAL} port mappings per instance`);
  return { autoMap: raw.autoMap === true, leaseSeconds: lease, rules };
}

/** Every individual (external, internal, protocol) mapping the enabled rules describe. */
function expand(config: UpnpConfig): { externalPort: number; internalPort: number; protocol: 'TCP' | 'UDP' }[] {
  const out: { externalPort: number; internalPort: number; protocol: 'TCP' | 'UDP' }[] = [];
  for (const rule of config.rules) {
    if (!rule.enabled) continue;
    const protocols: ('TCP' | 'UDP')[] = rule.protocol === 'BOTH' ? ['TCP', 'UDP'] : [rule.protocol];
    for (let i = 0; i <= rule.externalEnd - rule.externalStart; i++) {
      for (const protocol of protocols) out.push({ externalPort: rule.externalStart + i, internalPort: rule.internalStart + i, protocol });
    }
  }
  return out;
}

function description(server: ServerRecord): string {
  // Short, and tagged with the instance id so the router list shows whose mapping it is.
  return `Outpost ${server.id.slice(0, 8)} ${server.name}`.slice(0, 48);
}

// ---------------------------------------------------------------------------
// Applying / removing
// ---------------------------------------------------------------------------

const states = new Map<string, MappingState[]>();
const renewTimers = new Map<string, NodeJS.Timeout>();

export function getMappingStates(serverId: string): MappingState[] {
  return states.get(serverId) ?? [];
}

export async function applyMappings(serverId: string, why = 'requested'): Promise<{ gateway: Gateway; states: MappingState[] }> {
  const server = getServer(serverId);
  if (!server) throw new HttpError(404, 'Server not found');
  const { config } = upnpConfigOf(server);
  const wanted = expand(config);
  if (!wanted.length) throw new HttpError(400, 'No enabled port rules to map');
  const gw = await discoverGateway();
  const result: MappingState[] = [];
  for (const m of wanted) {
    try {
      await addMapping(gw, { ...m, description: description(server), leaseSeconds: config.leaseSeconds });
      result.push({ ...m, ok: true, error: null, at: new Date().toISOString() });
    } catch (err) {
      result.push({ ...m, ok: false, error: err instanceof Error ? err.message : String(err), at: new Date().toISOString() });
    }
  }
  states.set(serverId, result);
  const ok = result.filter((r) => r.ok).length;
  appendLine(serverId, `[Outpost] UPnP (${why}): forwarded ${ok}/${result.length} port mapping(s) on ${gw.friendlyName} to ${gw.localAddress}`, 'system');
  for (const r of result.filter((x) => !x.ok).slice(0, 5)) {
    appendLine(serverId, `[Outpost] UPnP: ${r.protocol} ${r.externalPort} failed — ${r.error}`, 'system');
  }

  clearTimeout(renewTimers.get(serverId));
  if (config.leaseSeconds > 0) {
    const timer = setTimeout(() => {
      applyMappings(serverId, 'lease renewal').catch((err) =>
        appendLine(serverId, `[Outpost] UPnP lease renewal failed: ${err instanceof Error ? err.message : String(err)}`, 'system')
      );
    }, Math.max(60, config.leaseSeconds / 2) * 1000);
    timer.unref();
    renewTimers.set(serverId, timer);
  }
  return { gateway: gw, states: result };
}

export async function removeMappings(serverId: string, why = 'requested'): Promise<number> {
  clearTimeout(renewTimers.get(serverId));
  renewTimers.delete(serverId);
  const server = getServer(serverId);
  const applied = states.get(serverId) ?? [];
  const configured = server ? expand(upnpConfigOf(server).config) : [];
  // Remove both what we last applied and what the rules describe now (they may have been edited).
  const keys = new Map<string, { externalPort: number; protocol: 'TCP' | 'UDP' }>();
  for (const m of [...applied.filter((a) => a.ok), ...configured]) keys.set(`${m.protocol}:${m.externalPort}`, m);
  if (!keys.size) return 0;
  const gw = await discoverGateway();
  let removed = 0;
  for (const m of keys.values()) {
    try {
      await deleteMapping(gw, m.externalPort, m.protocol);
      removed++;
    } catch (err) {
      logger.warn(`UPnP: couldn't remove ${m.protocol} ${m.externalPort}`, err);
    }
  }
  states.delete(serverId);
  appendLine(serverId, `[Outpost] UPnP (${why}): removed ${removed} port mapping(s)`, 'system');
  return removed;
}

export function saveUpnpConfig(serverId: string, config: UpnpConfig) {
  setUpnpConfig(serverId, JSON.stringify(config));
}

/** processManager hooks: map on start / unmap on stop when the instance asks for it. */
export async function upnpOnStart(server: ServerRecord) {
  const { config, configured } = upnpConfigOf(server);
  if (!configured || !config.autoMap || !expand(config).length) return;
  try {
    await applyMappings(server.id, 'instance started');
  } catch (err) {
    appendLine(server.id, `[Outpost] UPnP: ${err instanceof Error ? err.message : String(err)}`, 'system');
  }
}

export async function upnpOnStop(serverId: string) {
  const server = getServer(serverId);
  if (!server) return;
  const { config, configured } = upnpConfigOf(server);
  if (!configured || !config.autoMap) {
    clearTimeout(renewTimers.get(serverId));
    return;
  }
  try {
    await removeMappings(serverId, 'instance stopped');
  } catch (err) {
    appendLine(serverId, `[Outpost] UPnP: ${err instanceof Error ? err.message : String(err)}`, 'system');
  }
}
