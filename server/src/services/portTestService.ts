import net from 'node:net';
import { HttpError } from '../utils/asyncHandler.js';
import { isRunning } from './processManager.js';
import { discoverGateway, getExternalIp, getSpecificMapping } from './upnpService.js';
import type { ServerRecord } from '../types/index.js';

/**
 * "Is my port forward working?" — checked step by step, so the answer says *where* it breaks:
 * the router's mapping, something listening on this machine, the public address (CGNAT / double
 * NAT make forwarding pointless), and optionally a real connection attempt from the internet.
 *
 * The outside check uses portchecker.io: it receives this network's public IP and the port, and
 * can only test TCP — nothing on the internet can confirm a UDP port without the game answering.
 */

export type StepStatus = 'ok' | 'warn' | 'fail' | 'skip';
export interface TestStep {
  id: 'router' | 'local' | 'public-ip' | 'outside';
  title: string;
  status: StepStatus;
  detail: string;
}
export interface PortTestResult {
  port: number;
  protocol: 'TCP' | 'UDP';
  publicIp: string | null;
  steps: TestStep[];
  /** One-line answer for the top of the result. */
  summary: string;
}

const EXTERNAL_CHECK_URL = 'https://portchecker.io/api/v1/query';
export const EXTERNAL_CHECK_HOST = 'portchecker.io';
/** Only asked when the router won't say (no UPnP, or a hand-made forward) and the outside check runs. */
const PUBLIC_IP_URL = 'https://api.ipify.org?format=json';

async function lookupPublicIp(): Promise<string | null> {
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
function isPrivateOrCgnat(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
}

function tcpConnect(host: string, port: number, timeoutMs = 2500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function outsideCheck(ip: string, port: number): Promise<boolean> {
  const res = await fetch(EXTERNAL_CHECK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Outpost-PortTest' },
    body: JSON.stringify({ host: ip, ports: [port] }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { error?: boolean; msg?: string | null; check?: { port: number; status: boolean }[] };
  if (body.error) throw new Error(body.msg || 'the checker reported an error');
  const hit = body.check?.find((c) => c.port === port);
  if (!hit) throw new Error('the checker returned no result for this port');
  return hit.status;
}

// One outside check per instance every few seconds — it's a free third-party service.
const lastOutside = new Map<string, number>();
const OUTSIDE_COOLDOWN_MS = 8000;

export async function testPort(
  server: ServerRecord,
  opts: { externalPort: number; internalPort: number; protocol: 'TCP' | 'UDP'; outside: boolean }
): Promise<PortTestResult> {
  const { externalPort, internalPort, protocol } = opts;
  if (opts.outside) {
    if (protocol !== 'TCP') throw new HttpError(400, 'The outside check can only test TCP ports');
    const last = lastOutside.get(server.id) ?? 0;
    if (Date.now() - last < OUTSIDE_COOLDOWN_MS) throw new HttpError(429, 'Wait a few seconds before checking from outside again');
    lastOutside.set(server.id, Date.now());
  }

  const steps: TestStep[] = [];
  let publicIp: string | null = null;
  let localAddress: string | null = null;

  // 1. Router
  try {
    const gw = await discoverGateway();
    localAddress = gw.localAddress;
    publicIp = await getExternalIp(gw);
    const mapping = await getSpecificMapping(gw, externalPort, protocol);
    if (!mapping) {
      steps.push({ id: 'router', title: 'Router forward', status: 'fail', detail: `The router has no ${protocol} ${externalPort} forward. Use “Forward now” above (or add it in your router’s settings).` });
    } else if (mapping.internalClient && mapping.internalClient !== gw.localAddress) {
      steps.push({ id: 'router', title: 'Router forward', status: 'fail', detail: `${protocol} ${externalPort} is forwarded to ${mapping.internalClient}, not this machine (${gw.localAddress}).` });
    } else if (mapping.internalPort !== internalPort) {
      steps.push({ id: 'router', title: 'Router forward', status: 'warn', detail: `${protocol} ${externalPort} goes to local port ${mapping.internalPort}, not ${internalPort}.` });
    } else if (!mapping.enabled) {
      steps.push({ id: 'router', title: 'Router forward', status: 'fail', detail: 'The forward exists but the router has it disabled.' });
    } else {
      steps.push({
        id: 'router',
        title: 'Router forward',
        status: 'ok',
        detail: `${protocol} ${externalPort} → ${gw.localAddress}:${internalPort}${mapping.leaseSeconds ? ` (lease: ${Math.round(mapping.leaseSeconds / 60)} min left)` : ''}.`,
      });
    }
  } catch (err) {
    steps.push({
      id: 'router',
      title: 'Router forward',
      status: 'skip',
      detail: `${err instanceof Error ? err.message : String(err)} If you forwarded the port by hand in the router, use the outside check instead.`,
    });
  }

  // 2. This machine
  if (protocol === 'TCP') {
    const listening = (await tcpConnect('127.0.0.1', internalPort)) || (localAddress ? await tcpConnect(localAddress, internalPort) : false);
    steps.push({
      id: 'local',
      title: 'Listening on this machine',
      status: listening ? 'ok' : 'fail',
      detail: listening
        ? `Something accepts connections on TCP ${internalPort}.`
        : `Nothing accepts connections on TCP ${internalPort}${isRunning(server.id) ? ' — the instance is running but not listening there yet (or uses another port)' : ' — start the instance first'}. A host firewall can also block it.`,
    });
  } else {
    steps.push({
      id: 'local',
      title: 'Running on this machine',
      status: isRunning(server.id) ? 'ok' : 'warn',
      detail: isRunning(server.id) ? 'The instance is running. (UDP ports can’t be probed without the game answering.)' : 'The instance isn’t running — players won’t get an answer until it is.',
    });
  }

  // 3. Public address (asked elsewhere only for the outside check, which already shares it)
  const ipFromRouter = !!publicIp;
  if (!publicIp && opts.outside) publicIp = await lookupPublicIp();
  if (!publicIp) {
    steps.push({ id: 'public-ip', title: 'Public address', status: 'skip', detail: 'The router didn’t report its public IP.' });
  } else if (isPrivateOrCgnat(publicIp)) {
    steps.push({
      id: 'public-ip',
      title: 'Public address',
      status: 'fail',
      detail: `The router’s internet address is ${publicIp}, a private/carrier-grade NAT address — there’s another router or your ISP in front of it, so forwarding here can’t reach the internet. Ask your ISP for a public IP, or forward on the outer router too.`,
    });
  } else {
    steps.push({
      id: 'public-ip',
      title: 'Public address',
      status: 'ok',
      detail: `Players connect to ${publicIp}:${externalPort}.${ipFromRouter ? '' : ' (Looked up online — the router didn’t report it.)'}`,
    });
  }

  // 4. From the internet
  if (opts.outside) {
    if (!publicIp || isPrivateOrCgnat(publicIp)) {
      steps.push({ id: 'outside', title: 'Reachable from the internet', status: 'skip', detail: 'Needs a public IP from the router first.' });
    } else {
      try {
        const open = await outsideCheck(publicIp, externalPort);
        steps.push({
          id: 'outside',
          title: 'Reachable from the internet',
          status: open ? 'ok' : 'fail',
          detail: open
            ? `${EXTERNAL_CHECK_HOST} connected to ${publicIp}:${externalPort}.`
            : `${EXTERNAL_CHECK_HOST} couldn’t connect to ${publicIp}:${externalPort}. If the steps above are fine, your ISP or a firewall in between is blocking it.`,
        });
      } catch (err) {
        steps.push({ id: 'outside', title: 'Reachable from the internet', status: 'skip', detail: `The outside check didn’t work: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
  }

  const worst = steps.find((s) => s.status === 'fail');
  const outsideOk = steps.find((s) => s.id === 'outside')?.status === 'ok';
  const summary = worst
    ? `Not working: ${worst.title.toLowerCase()}.`
    : outsideOk
      ? `Working — reachable from the internet on ${publicIp}:${externalPort}.`
      : steps.some((s) => s.status === 'warn')
        ? 'Probably fine — see the warnings.'
        : protocol === 'UDP'
          ? 'Everything checkable looks right. UDP can only be confirmed by joining from outside your network.'
          : 'Everything here looks right — run the outside check to confirm.';
  return { port: externalPort, protocol, publicIp, steps, summary };
}
