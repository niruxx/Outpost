/**
 * Privileged NetworkManager operations for the Networking page.
 *
 * Every change runs inside a NetworkManager checkpoint, as Cockpit does: before applying it, a
 * checkpoint is created with a rollback timeout. The browser must confirm within that time that it
 * can still reach the panel; then the checkpoint is destroyed and the change stays. If the change
 * cuts the panel off, nobody confirms and NetworkManager restores the previous configuration
 * on its own. No panel imports; arguments are validated here because this runs as root.
 */
import { isIP } from 'node:net';
import { HostFileError } from './hostFileOps.js';
import { runCommand } from './hostSystemOps.js';

const NM = ['org.freedesktop.NetworkManager', '/org/freedesktop/NetworkManager', 'org.freedesktop.NetworkManager'];
const CHECKPOINT_RE = /^\/org\/freedesktop\/NetworkManager\/Checkpoint\/\d+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IFNAME_RE = /^[A-Za-z0-9_.-]{1,15}$/;
const CONN_NAME_RE = /^[A-Za-z0-9 _.@-]{1,64}$/;
const BOND_MODES = ['balance-rr', 'active-backup', 'balance-xor', 'broadcast', '802.3ad', 'balance-tlb', 'balance-alb'] as const;

export interface IpConfig {
  method: 'auto' | 'manual' | 'disabled' | 'link-local' | 'ignore' | 'shared';
  /** CIDR, e.g. "192.168.1.10/24". */
  addresses: string[];
  gateway: string;
  dns: string[];
  /** Ignore DNS servers from DHCP/RA. */
  ignoreAutoDns?: boolean;
}

export type NetChange =
  | { kind: 'ip'; uuid: string; ipv4?: IpConfig; ipv6?: IpConfig; mtu?: number | null }
  | { kind: 'bond'; name: string; mode: string; ports: string[]; ipv4?: IpConfig; ipv6?: IpConfig }
  | { kind: 'bridge'; name: string; stp: boolean; ports: string[]; ipv4?: IpConfig; ipv6?: IpConfig }
  | { kind: 'vlan'; name: string; parent: string; id: number; ipv4?: IpConfig; ipv6?: IpConfig }
  | { kind: 'delete'; uuid: string }
  | { kind: 'state'; uuid: string; up: boolean }
  | { kind: 'autoconnect'; uuid: string; enabled: boolean };

const assertUuid = (u: unknown) => {
  if (typeof u !== 'string' || !UUID_RE.test(u)) throw new HostFileError(400, 'Invalid connection');
  return u;
};
const assertIf = (n: unknown, what = 'interface name') => {
  if (typeof n !== 'string' || !IFNAME_RE.test(n)) throw new HostFileError(400, `Invalid ${what} (letters, digits, "-", "_", "." — 15 characters max)`);
  return n;
};

function cidr(v: string, family: 4 | 6): string {
  const [addr, prefix, extra] = v.trim().split('/');
  const max = family === 4 ? 32 : 128;
  const p = prefix === undefined ? max : Number(prefix);
  if (extra !== undefined || isIP(addr) !== family || !Number.isInteger(p) || p < 1 || p > max) throw new HostFileError(400, `“${v}” isn’t a valid IPv${family} address with prefix (e.g. ${family === 4 ? '192.168.1.10/24' : '2001:db8::10/64'})`);
  return `${addr}/${p}`;
}

/** nmcli property arguments for one address family. */
export function ipArgs(family: 4 | 6, cfg: IpConfig | undefined): string[] {
  if (!cfg) return [];
  const k = `ipv${family}`;
  const methods4 = ['auto', 'manual', 'disabled', 'link-local', 'shared'];
  const methods6 = ['auto', 'manual', 'disabled', 'link-local', 'ignore', 'shared', 'dhcp'];
  if (!(family === 4 ? methods4 : methods6).includes(cfg.method)) throw new HostFileError(400, `Unknown IPv${family} method`);
  const addresses = (cfg.addresses ?? []).filter((a) => a.trim()).map((a) => cidr(a, family));
  if (cfg.method === 'manual' && !addresses.length) throw new HostFileError(400, `Manual IPv${family} needs at least one address`);
  const gateway = (cfg.gateway ?? '').trim();
  if (gateway && isIP(gateway) !== family) throw new HostFileError(400, `“${gateway}” isn’t a valid IPv${family} gateway`);
  const dns = (cfg.dns ?? []).map((d) => d.trim()).filter(Boolean);
  for (const d of dns) if (!isIP(d)) throw new HostFileError(400, `“${d}” isn’t a valid DNS server address`);
  if (addresses.length > 32 || dns.length > 8) throw new HostFileError(400, 'Too many addresses');
  return [
    `${k}.method`, cfg.method,
    `${k}.addresses`, cfg.method === 'manual' ? addresses.join(',') : '',
    `${k}.gateway`, cfg.method === 'manual' ? gateway : '',
    `${k}.dns`, dns.join(','),
    `${k}.ignore-auto-dns`, cfg.ignoreAutoDns ? 'yes' : 'no',
  ];
}

/** The nmcli invocations that apply a change, in order. */
export function changeCommands(change: NetChange): string[][] {
  switch (change.kind) {
    case 'ip': {
      const mods = [...ipArgs(4, change.ipv4), ...ipArgs(6, change.ipv6)];
      if (change.mtu !== undefined) {
        const mtu = change.mtu === null ? 0 : Number(change.mtu);
        if (!Number.isInteger(mtu) || (mtu !== 0 && (mtu < 576 || mtu > 9216))) throw new HostFileError(400, 'MTU must be 576–9216 (or empty for automatic)');
        mods.push('802-3-ethernet.mtu', String(mtu));
      }
      if (!mods.length) throw new HostFileError(400, 'Nothing to change');
      const uuid = assertUuid(change.uuid);
      return [['connection', 'modify', uuid, ...mods], ['connection', 'up', uuid]];
    }
    case 'bond':
    case 'bridge':
    case 'vlan': {
      const name = assertIf(change.name);
      const ip = [...ipArgs(4, change.ipv4 ?? { method: 'auto', addresses: [], gateway: '', dns: [] }), ...ipArgs(6, change.ipv6 ?? { method: 'auto', addresses: [], gateway: '', dns: [] })];
      const cmds: string[][] = [];
      if (change.kind === 'vlan') {
        const id = Number(change.id);
        if (!Number.isInteger(id) || id < 1 || id > 4094) throw new HostFileError(400, 'VLAN ID must be 1–4094');
        cmds.push(['connection', 'add', 'type', 'vlan', 'con-name', name, 'ifname', name, 'vlan.parent', assertIf(change.parent, 'parent interface'), 'vlan.id', String(id), ...ip]);
        return cmds;
      }
      const ports = (change.ports ?? []).map((p) => assertIf(p, 'port'));
      if (!ports.length) throw new HostFileError(400, `A ${change.kind} needs at least one port`);
      if (change.kind === 'bond') {
        if (!BOND_MODES.includes(change.mode as (typeof BOND_MODES)[number])) throw new HostFileError(400, 'Unknown bond mode');
        cmds.push(['connection', 'add', 'type', 'bond', 'con-name', name, 'ifname', name, 'bond.options', `mode=${change.mode},miimon=100`, ...ip]);
      } else {
        cmds.push(['connection', 'add', 'type', 'bridge', 'con-name', name, 'ifname', name, 'bridge.stp', change.stp ? 'yes' : 'no', ...ip]);
      }
      // Port profiles take precedence over each port's previous profile once activated.
      for (const port of ports) cmds.push(['connection', 'add', 'type', 'ethernet', 'con-name', `${name}-port-${port}`, 'ifname', port, 'master', name, 'slave-type', change.kind]);
      cmds.push(['connection', 'up', name]);
      return cmds;
    }
    case 'delete':
      return [['connection', 'delete', assertUuid(change.uuid)]];
    case 'state':
      return [['connection', change.up ? 'up' : 'down', assertUuid(change.uuid)]];
    case 'autoconnect':
      return [['connection', 'modify', assertUuid(change.uuid), 'connection.autoconnect', change.enabled ? 'yes' : 'no']];
    default:
      throw new HostFileError(400, 'Unknown network change');
  }
}

/** `busctl call ... CheckpointCreate` prints `o "/org/freedesktop/NetworkManager/Checkpoint/3"`. */
export function parseCheckpoint(stdout: string): string | null {
  const m = stdout.match(/o\s+"([^"]+)"/);
  return m && CHECKPOINT_RE.test(m[1]) ? m[1] : null;
}

async function createCheckpoint(timeoutSec: number): Promise<string> {
  // ao [] (all devices), rollback timeout, flags 1 = DESTROY_ALL (replace stale checkpoints).
  const r = await runCommand('busctl', ['call', ...NM, 'CheckpointCreate', 'aouu', '0', String(timeoutSec), '1'], { timeoutMs: 20_000 });
  const path = parseCheckpoint(r.stdout);
  if (r.code !== 0 || !path) throw new HostFileError(502, `Couldn’t create a NetworkManager checkpoint: ${r.stderr.trim() || 'is NetworkManager running?'}`);
  return path;
}

async function checkpointCall(method: 'CheckpointDestroy' | 'CheckpointRollback', path: string) {
  if (typeof path !== 'string' || !CHECKPOINT_RE.test(path)) throw new HostFileError(400, 'Invalid checkpoint');
  const r = await runCommand('busctl', ['call', ...NM, method, 'o', path], { timeoutMs: 60_000 });
  if (r.code !== 0) throw new HostFileError(r.stderr.includes('does not exist') || r.stderr.includes('UnknownObject') ? 410 : 502, r.stderr.trim() || `${method} failed`);
  return { ok: true };
}

/** Creates a checkpoint, applies the change, and returns the checkpoint to confirm or roll back. */
async function apply(a: { change: NetChange; rollbackSec?: number }) {
  const commands = changeCommands(a.change);
  const rollbackSec = Math.min(Math.max(Number(a.rollbackSec) || 60, 20), 300);
  const checkpoint = await createCheckpoint(rollbackSec);
  const output: string[] = [];
  try {
    for (const args of commands) {
      const r = await runCommand('nmcli', ['--wait', '30', ...args], { timeoutMs: 45_000 });
      output.push((r.stdout + r.stderr).trim());
      if (r.code !== 0) throw new HostFileError(422, `nmcli ${args.slice(0, 2).join(' ')}: ${(r.stderr || r.stdout).trim().split('\n').pop()}`);
    }
  } catch (err) {
    await checkpointCall('CheckpointRollback', checkpoint).catch(() => undefined);
    throw err;
  }
  return { checkpoint, rollbackSec, output: output.filter(Boolean).join('\n') };
}

export const NETWORK_OPS = {
  'net.apply': apply,
  'net.confirm': (a: { checkpoint: string }) => checkpointCall('CheckpointDestroy', a.checkpoint),
  'net.rollback': (a: { checkpoint: string }) => checkpointCall('CheckpointRollback', a.checkpoint),
};
