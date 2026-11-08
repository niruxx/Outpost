import net from 'node:net';
import { discoverGateway, getExternalIp } from './upnpService.js';

/** Asked only when the router won't report its WAN address (no UPnP, or UPnP is off). */
const PUBLIC_IP_URL = 'https://api.ipify.org?format=json';

export async function lookupPublicIp(): Promise<string | null> {
  try {
    const res = await fetch(PUBLIC_IP_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const ip = ((await res.json()) as { ip?: string }).ip ?? '';
    return net.isIPv4(ip) ? ip : null;
  } catch {
    return null;
  }
}

/** CGNAT (100.64/10) and private ranges: a router whose WAN address is one of these sits behind another NAT. */
export function isPrivateOrCgnat(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
}

export interface PublicAddress {
  address: string | null;
  source: 'router' | 'lookup' | null;
  /** The router's WAN address is itself private/CGNAT — forwarding on this router won't reach the internet. */
  behindNat: boolean;
}

const OK_CACHE_MS = 10 * 60_000;
const MISS_CACHE_MS = 60_000;
let cached: { value: PublicAddress; at: number } | null = null;
let pending: Promise<PublicAddress> | null = null;

async function resolvePublicAddress(): Promise<PublicAddress> {
  let routerIp: string | null = null;
  try {
    routerIp = await getExternalIp(await discoverGateway());
  } catch {
    // no UPnP router — fall through to the online lookup
  }
  if (routerIp && net.isIPv4(routerIp) && !isPrivateOrCgnat(routerIp)) return { address: routerIp, source: 'router', behindNat: false };
  const looked = await lookupPublicIp();
  if (looked) return { address: looked, source: 'lookup', behindNat: !!routerIp && isPrivateOrCgnat(routerIp) };
  return { address: null, source: null, behindNat: !!routerIp && isPrivateOrCgnat(routerIp) };
}

/** This network's internet-facing address — what players outside the LAN connect to. Host-wide, cached. */
export async function getPublicAddress(force = false): Promise<PublicAddress> {
  if (!force && cached && Date.now() - cached.at < (cached.value.address ? OK_CACHE_MS : MISS_CACHE_MS)) return cached.value;
  pending ??= resolvePublicAddress()
    .then((value) => {
      cached = { value, at: Date.now() };
      return value;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}
