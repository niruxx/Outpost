/**
 * Network state for the Networking page, read as the Outpost service account through nmcli
 * (NetworkManager's read API is open to unprivileged users) and `ip -j`. Changes go through
 * hostNetworkOps in Admin Mode.
 */
import fs from 'node:fs';
import { HttpError } from '../utils/asyncHandler.js';
import { runCommand } from './hostSystemOps.js';

/** Splits one line of `nmcli -t -e yes` output on unescaped colons. */
export function splitTerse(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length) {
      cur += line[++i];
    } else if (c === ':') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

export interface NetDevice {
  device: string;
  type: string;
  state: string;
  connection: string | null;
  uuid: string | null;
}

export interface NetConnection {
  name: string;
  uuid: string;
  type: string;
  device: string | null;
  active: boolean;
  autoconnect: boolean;
}

export interface InterfaceInfo {
  name: string;
  mac: string | null;
  mtu: number | null;
  up: boolean;
  addresses: string[];
  rxBytes: number | null;
  txBytes: number | null;
  master: string | null;
}

export function parseDevices(stdout: string): NetDevice[] {
  return stdout
    .split('\n')
    .filter(Boolean)
    .map(splitTerse)
    .map(([device, type, state, connection, uuid]) => ({ device, type, state, connection: connection || null, uuid: uuid || null }))
    .filter((d) => d.device);
}

export function parseConnections(stdout: string): NetConnection[] {
  return stdout
    .split('\n')
    .filter(Boolean)
    .map(splitTerse)
    .map(([name, uuid, type, device, active, autoconnect]) => ({ name, uuid, type, device: device || null, active: active === 'yes', autoconnect: autoconnect === 'yes' }))
    .filter((c) => c.uuid);
}

/** `nmcli -t -e yes -f <fields> connection show <uuid>` → field → value. */
export function parseFields(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const [k, ...rest] = splitTerse(line);
    // Repeated keys (IP4.ADDRESS[1], [2]…) are joined.
    const key = k.replace(/\[\d+\]$/, '');
    const v = rest.join(':');
    out[key] = out[key] ? `${out[key]},${v}` : v;
  }
  return out;
}

const list = (v: string | undefined) => (v && v !== '--' ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

export function ipConfigFrom(fields: Record<string, string>, family: 4 | 6) {
  const k = `ipv${family}`;
  return {
    method: fields[`${k}.method`] || 'auto',
    addresses: list(fields[`${k}.addresses`]),
    gateway: fields[`${k}.gateway`] && fields[`${k}.gateway`] !== '--' ? fields[`${k}.gateway`] : '',
    dns: list(fields[`${k}.dns`]),
    ignoreAutoDns: fields[`${k}.ignore-auto-dns`] === 'yes',
  };
}

interface IpJson {
  ifname: string;
  address?: string;
  mtu?: number;
  flags?: string[];
  operstate?: string;
  master?: string;
  addr_info?: Array<{ family: string; local: string; prefixlen: number; scope?: string }>;
}

export function parseIpJson(stdout: string): InterfaceInfo[] {
  let data: IpJson[];
  try {
    data = JSON.parse(stdout);
  } catch {
    return [];
  }
  return data.map((i) => {
    const stat = (k: string) => {
      try {
        return Number(fs.readFileSync(`/sys/class/net/${i.ifname}/statistics/${k}`, 'utf8'));
      } catch {
        return null;
      }
    };
    return {
      name: i.ifname,
      mac: i.address ?? null,
      mtu: i.mtu ?? null,
      up: (i.flags ?? []).includes('UP') && i.operstate !== 'DOWN',
      addresses: (i.addr_info ?? []).filter((a) => a.scope !== 'link' || a.family === 'inet').map((a) => `${a.local}/${a.prefixlen}`),
      rxBytes: stat('rx_bytes'),
      txBytes: stat('tx_bytes'),
      master: i.master ?? null,
    };
  });
}

const DETAIL_FIELDS = [
  'connection.id', 'connection.uuid', 'connection.type', 'connection.interface-name', 'connection.autoconnect', 'connection.master', 'connection.slave-type',
  'ipv4.method', 'ipv4.addresses', 'ipv4.gateway', 'ipv4.dns', 'ipv4.ignore-auto-dns',
  'ipv6.method', 'ipv6.addresses', 'ipv6.gateway', 'ipv6.dns', 'ipv6.ignore-auto-dns',
  'bond.options', 'bridge.stp', 'vlan.id', 'vlan.parent', '802-3-ethernet.mtu', 'GENERAL.STATE', 'IP4.ADDRESS', 'IP4.GATEWAY', 'IP4.DNS', 'IP6.ADDRESS', 'IP6.GATEWAY', 'IP6.DNS',
];

export async function networkAvailability(): Promise<{ available: boolean; reason: string | null }> {
  if (process.platform !== 'linux') return { available: false, reason: 'Network configuration is only available on Linux hosts.' };
  const r = await runCommand('nmcli', ['-t', '-f', 'RUNNING', 'general'], { timeoutMs: 10_000 });
  if (r.code === null) return { available: false, reason: 'NetworkManager (nmcli) isn’t installed. This host is probably configured with systemd-networkd, netplan or ifupdown, which Outpost doesn’t edit.' };
  if (r.stdout.trim() !== 'running') return { available: false, reason: 'NetworkManager isn’t running on this host, so its network can’t be configured here.' };
  return { available: true, reason: null };
}

export async function networkOverview() {
  const availability = await networkAvailability();
  const ip = await runCommand('ip', ['-j', 'addr'], { timeoutMs: 10_000 });
  const interfaces = parseIpJson(ip.stdout).filter((i) => i.name !== 'lo');
  if (!availability.available) return { ...availability, devices: [], connections: [], interfaces };
  const [dev, con] = await Promise.all([
    runCommand('nmcli', ['-t', '-e', 'yes', '-f', 'DEVICE,TYPE,STATE,CONNECTION,CON-UUID', 'device', 'status'], { timeoutMs: 10_000 }),
    runCommand('nmcli', ['-t', '-e', 'yes', '-f', 'NAME,UUID,TYPE,DEVICE,ACTIVE,AUTOCONNECT', 'connection', 'show'], { timeoutMs: 10_000 }),
  ]);
  return { ...availability, devices: parseDevices(dev.stdout).filter((d) => d.device !== 'lo'), connections: parseConnections(con.stdout), interfaces };
}

export async function connectionDetails(uuid: string) {
  if (!/^[0-9a-f-]{36}$/i.test(uuid)) throw new HttpError(400, 'Invalid connection');
  const r = await runCommand('nmcli', ['-t', '-e', 'yes', '-f', DETAIL_FIELDS.join(','), 'connection', 'show', uuid], { timeoutMs: 10_000 });
  if (r.code !== 0) throw new HttpError(404, r.stderr.trim() || 'Connection not found');
  const f = parseFields(r.stdout);
  return {
    uuid,
    name: f['connection.id'],
    type: f['connection.type'],
    interfaceName: f['connection.interface-name'] && f['connection.interface-name'] !== '--' ? f['connection.interface-name'] : null,
    autoconnect: f['connection.autoconnect'] === 'yes',
    master: f['connection.master'] && f['connection.master'] !== '--' ? f['connection.master'] : null,
    portType: f['connection.slave-type'] && f['connection.slave-type'] !== '--' ? f['connection.slave-type'] : null,
    ipv4: ipConfigFrom(f, 4),
    ipv6: ipConfigFrom(f, 6),
    mtu: f['802-3-ethernet.mtu'] && /^\d+$/.test(f['802-3-ethernet.mtu']) && f['802-3-ethernet.mtu'] !== '0' ? Number(f['802-3-ethernet.mtu']) : null,
    bondOptions: f['bond.options'] && f['bond.options'] !== '--' ? f['bond.options'] : null,
    vlan: f['vlan.id'] && f['vlan.id'] !== '--' ? { id: Number(f['vlan.id']), parent: f['vlan.parent'] } : null,
    bridgeStp: f['bridge.stp'] ? f['bridge.stp'] === 'yes' : null,
    live: {
      state: f['GENERAL.STATE'] || null,
      ipv4: list(f['IP4.ADDRESS']),
      gateway4: f['IP4.GATEWAY'] && f['IP4.GATEWAY'] !== '--' ? f['IP4.GATEWAY'] : null,
      dns4: list(f['IP4.DNS']),
      ipv6: list(f['IP6.ADDRESS']),
      gateway6: f['IP6.GATEWAY'] && f['IP6.GATEWAY'] !== '--' ? f['IP6.GATEWAY'] : null,
      dns6: list(f['IP6.DNS']),
    },
  };
}
