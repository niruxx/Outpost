import fs from 'node:fs';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { HttpError } from '../utils/asyncHandler.js';

/**
 * Host firewall management through UFW or firewalld — whichever this machine uses.
 *
 * Both need root. When the panel isn't root it runs them through `sudo -n` (never prompting); the
 * status reports the exact sudoers line to add when that isn't allowed yet. Commands are spawned
 * with argument arrays (no shell) and every user value is validated first.
 *
 * The parsing and command building are pure functions over the tools' text output, so the logic
 * is exercised by tests against recorded output without a real firewall (createFirewall takes the
 * command runner).
 */

export type Backend = 'ufw' | 'firewalld';
export type RuleAction = 'allow' | 'deny';
export type Protocol = 'tcp' | 'udp' | 'any';

export interface FirewallRule {
  /** Opaque id the client sends back to delete the rule. */
  id: string;
  action: 'allow' | 'deny' | 'reject' | 'limit';
  /** "25565", "27015-27020"; null for rules that aren't about one port (an app profile, a service…). */
  port: string | null;
  protocol: Protocol;
  /** null = from anywhere */
  source: string | null;
  /** What to show when port/protocol don't say it all: "OpenSSH", "service ssh", a raw rich rule… */
  label: string | null;
  comment: string | null;
  direction: 'in' | 'out';
}

export interface FirewallStatus {
  available: boolean;
  backend: Backend | null;
  /** Why it can't be managed (not Linux, nothing installed, sudo not allowed…). */
  reason: string | null;
  /** The sudoers line to add when the panel user may not run the tool. */
  sudoersHint: string | null;
  active: boolean;
  /** UFW: "deny (incoming), allow (outgoing)…"; firewalld: the zone name. */
  defaults: string | null;
  zone: string | null;
  rules: FirewallRule[];
  /** Ports kept reachable so nobody locks themselves out (SSH, this panel). */
  protectedPorts: { port: number; protocol: 'tcp'; why: string }[];
  /** UFW can be switched on/off from the panel; firewalld is a system service and isn't. */
  canToggle: boolean;
}

export interface NewRule {
  action: RuleAction;
  port: string;
  protocol: Protocol;
  source: string | null;
  comment: string | null;
}

export type Exec = (cmd: string, args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** "25565", "27015-27020" or "27015:27020" → normalized "a" or "a-b". */
export function normalizePort(input: unknown): string {
  const raw = String(input ?? '').trim();
  const m = raw.match(/^(\d{1,5})(?:\s*[-:]\s*(\d{1,5}))?$/);
  if (!m) throw new HttpError(400, 'Enter a port (e.g. 25565) or a range (e.g. 27015-27020)');
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : a;
  if (a < 1 || b > 65535 || a > 65535 || b < a) throw new HttpError(400, 'Ports must be between 1 and 65535, low to high');
  return a === b ? String(a) : `${a}-${b}`;
}

export function normalizeSource(input: unknown): string | null {
  const raw = String(input ?? '').trim();
  if (!raw || raw.toLowerCase() === 'any' || raw.toLowerCase() === 'anywhere') return null;
  const [addr, prefix, extra] = raw.split('/');
  const family = net.isIP(addr);
  const max = family === 4 ? 32 : 128;
  if (!family || extra !== undefined || (prefix !== undefined && (!/^\d{1,3}$/.test(prefix) || Number(prefix) > max))) {
    throw new HttpError(400, 'Source must be an IP address or a CIDR range like 192.168.1.0/24');
  }
  return raw;
}

export function sanitizeNewRule(body: unknown): NewRule {
  const b = (body ?? {}) as Record<string, unknown>;
  const action: RuleAction = b.action === 'deny' ? 'deny' : 'allow';
  const protocol: Protocol = b.protocol === 'udp' ? 'udp' : b.protocol === 'any' ? 'any' : 'tcp';
  const comment =
    typeof b.comment === 'string'
      ? b.comment
          .replace(/[^\w .:#()+-]/g, '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 60) || null
      : null;
  return { action, port: normalizePort(b.port), protocol, source: normalizeSource(b.source), comment };
}

const portRange = (port: string): [number, number] => {
  const [a, b] = port.split('-').map(Number);
  return [a, b ?? a];
};

/** Whether an allow rule from anywhere opens `port`/`protocol`. */
export function ruleOpens(rule: FirewallRule, port: number, protocol: 'tcp' | 'udp'): boolean {
  if (rule.action !== 'allow' && rule.action !== 'limit') return false;
  if (rule.direction !== 'in' || rule.source || !rule.port) return false;
  if (rule.protocol !== 'any' && rule.protocol !== protocol) return false;
  const [a, b] = portRange(rule.port);
  return port >= a && port <= b;
}

// ---------------------------------------------------------------------------
// UFW
// ---------------------------------------------------------------------------

/** Splits a command line the way ufw prints it (single-quoted comments, quoted app names). */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  const re = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

const encodeId = (kind: string, value: string) => `${kind}:${Buffer.from(value, 'utf8').toString('base64url')}`;
export function decodeId(id: string): { kind: string; value: string } {
  const i = id.indexOf(':');
  if (i < 1) throw new HttpError(400, 'Unknown rule');
  return { kind: id.slice(0, i), value: Buffer.from(id.slice(i + 1), 'base64url').toString('utf8') };
}

/** One "ufw …" line from `ufw show added` → a rule (tokens kept in the id so it can be deleted). */
export function parseUfwAdded(line: string): FirewallRule | null {
  const tokens = tokenize(line.trim());
  if (tokens[0] !== 'ufw' || tokens.length < 3) return null;
  const rest = tokens.slice(1);
  const action = rest[0] as FirewallRule['action'];
  if (!['allow', 'deny', 'reject', 'limit'].includes(action)) return null;
  let i = 1;
  let direction: 'in' | 'out' = 'in';
  if (rest[i] === 'in' || rest[i] === 'out') direction = rest[i++] as 'in' | 'out';
  if (rest[i] === 'log' || rest[i] === 'log-all') i++;

  let comment: string | null = null;
  const ci = rest.indexOf('comment');
  const body = ci >= 0 ? rest.slice(i, ci) : rest.slice(i);
  if (ci >= 0) comment = rest[ci + 1] ?? null;

  let port: string | null = null;
  let protocol: Protocol = 'any';
  let source: string | null = null;
  let label: string | null = null;

  if (body[0] === 'from' || body[0] === 'to' || body[0] === 'proto' || body.includes('from') || body.includes('to')) {
    // Extended form: [proto X] from SRC [port P] to DST [port P] [proto X] [app NAME]
    for (let j = 0; j < body.length; j++) {
      const t = body[j];
      if (t === 'proto') protocol = (body[++j] as Protocol) ?? 'any';
      else if (t === 'from') {
        const v = body[++j];
        source = v === 'any' ? null : v;
      } else if (t === 'to') j++;
      else if (t === 'port') port = (body[++j] ?? '').replace(':', '-');
      else if (t === 'app') label = body[++j] ?? null;
    }
    if (protocol !== 'tcp' && protocol !== 'udp') protocol = 'any';
  } else if (body.length === 1) {
    // Simple form: PORT[/PROTO] or an app profile name
    const m = body[0].match(/^(\d+(?::\d+)?)(?:\/(tcp|udp))?$/);
    if (m) {
      port = m[1].replace(':', '-');
      protocol = (m[2] as Protocol) ?? 'any';
    } else label = body[0];
  } else {
    label = body.join(' ');
  }
  return { id: encodeId('ufw', JSON.stringify(rest)), action, port, protocol, source, label, comment, direction };
}

export function parseUfwStatus(out: string): { active: boolean; defaults: string | null } {
  const active = /^Status:\s*active/m.test(out);
  const d = out.match(/^Default:\s*(.+)$/m);
  return { active, defaults: d ? d[1].trim() : null };
}

/** ufw arguments for a new rule — two rules when a range needs both protocols (ufw requires one). */
export function ufwAddArgs(rule: NewRule): string[][] {
  const protos: ('tcp' | 'udp' | null)[] = rule.protocol === 'any' ? (rule.port.includes('-') ? ['tcp', 'udp'] : [null]) : [rule.protocol];
  const port = rule.port.replace('-', ':');
  return protos.map((proto) => {
    const args = rule.source
      ? [rule.action, 'from', rule.source, 'to', 'any', 'port', port, ...(proto ? ['proto', proto] : [])]
      : [rule.action, proto ? `${port}/${proto}` : port];
    if (rule.comment) args.push('comment', rule.comment);
    return args;
  });
}

/** `ufw delete <rule>` — the rule exactly as `ufw show added` printed it, minus the comment. */
export function ufwDeleteArgs(stored: string[]): string[] {
  const ci = stored.indexOf('comment');
  const rule = ci >= 0 ? [...stored.slice(0, ci), ...stored.slice(ci + 2)] : stored;
  return ['delete', ...rule];
}

// ---------------------------------------------------------------------------
// firewalld
// ---------------------------------------------------------------------------

export function parseFirewalldPorts(out: string): FirewallRule[] {
  return out
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => {
      const [port, proto] = p.split('/');
      return {
        id: encodeId('port', p),
        action: 'allow' as const,
        port,
        protocol: proto === 'tcp' || proto === 'udp' ? proto : 'any',
        source: null,
        label: null,
        comment: null,
        direction: 'in' as const,
      };
    });
}

/** Well-known services, so "ssh" counts as keeping port 22 open. Others show by name. */
const SERVICE_PORTS: Record<string, { port: string; protocol: Protocol }> = {
  ssh: { port: '22', protocol: 'tcp' },
  http: { port: '80', protocol: 'tcp' },
  https: { port: '443', protocol: 'tcp' },
};

export function parseFirewalldServices(out: string): FirewallRule[] {
  return out
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((name) => ({
      id: encodeId('service', name),
      action: 'allow' as const,
      port: SERVICE_PORTS[name]?.port ?? null,
      protocol: SERVICE_PORTS[name]?.protocol ?? 'any',
      source: null,
      label: `service ${name}`,
      comment: null,
      direction: 'in' as const,
    }));
}

export function parseFirewalldRichRule(line: string): FirewallRule {
  const attr = (re: RegExp) => line.match(re)?.[1] ?? null;
  const verdict = /\b(drop|reject)\b/.test(line.replace(/"[^"]*"/g, '')) ? 'deny' : 'allow';
  const port = attr(/port port="([^"]+)"/);
  const proto = attr(/protocol="([^"]+)"/);
  return {
    id: encodeId('rich', line),
    action: verdict,
    port,
    protocol: proto === 'tcp' || proto === 'udp' ? proto : 'any',
    source: attr(/source address="([^"]+)"/),
    label: port ? null : line,
    comment: null,
    direction: 'in',
  };
}

export function firewalldRichRule(rule: NewRule, proto: 'tcp' | 'udp'): string {
  const family = rule.source ? (net.isIP(rule.source.split('/')[0]) === 6 ? ' family="ipv6"' : ' family="ipv4"') : '';
  const source = rule.source ? ` source address="${rule.source}"` : '';
  return `rule${family}${source} port port="${rule.port}" protocol="${proto}" ${rule.action === 'allow' ? 'accept' : 'drop'}`;
}

// ---------------------------------------------------------------------------
// Running the tools
// ---------------------------------------------------------------------------

const UFW_PATHS = ['/usr/sbin/ufw', '/sbin/ufw', '/usr/bin/ufw'];
const FIREWALLD_PATHS = ['/usr/bin/firewall-cmd', '/bin/firewall-cmd', '/usr/sbin/firewall-cmd'];

const realExec: Exec = (cmd, args) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { env: { ...process.env, LC_ALL: 'C' } });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

/** SSH's listening ports from sshd_config (22 if none are set). */
function sshPorts(): number[] {
  try {
    const ports = [...fs.readFileSync('/etc/ssh/sshd_config', 'utf8').matchAll(/^\s*Port\s+(\d+)/gim)].map((m) => Number(m[1]));
    return ports.length ? ports : [22];
  } catch {
    return [22];
  }
}

export interface FirewallEnv {
  platform: NodeJS.Platform;
  isRoot: boolean;
  user: string;
  exists: (path: string) => boolean;
  exec: Exec;
  panelPort: number;
  sshPorts: () => number[];
}

export function createFirewall(env: FirewallEnv) {
  // One change at a time: two edits racing would read and write a stale rule list.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  };

  const protectedPorts = () => [
    ...env.sshPorts().map((port) => ({ port, protocol: 'tcp' as const, why: 'SSH' })),
    { port: env.panelPort, protocol: 'tcp' as const, why: 'Outpost' },
  ];

  const locate = () => ({ ufw: UFW_PATHS.find(env.exists), firewalld: FIREWALLD_PATHS.find(env.exists) });

  const run = (bin: string, args: string[]) => (env.isRoot ? env.exec(bin, args) : env.exec('sudo', ['-n', bin, ...args]));

  function sudoProblem(stderr: string): boolean {
    return !env.isRoot && /password is required|not allowed|not in the sudoers|sudo: .*(command not found|no tty)/i.test(stderr);
  }

  async function must(bin: string, args: string[]): Promise<string> {
    const r = await run(bin, args);
    if (r.code !== 0) {
      const msg = (r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ');
      throw new HttpError(sudoProblem(r.stderr) ? 403 : 502, `${bin.split('/').pop()} ${args[0] ?? ''} failed: ${msg || `exit code ${r.code}`}`);
    }
    return r.stdout;
  }

  /** Which tool to use: firewalld when its daemon is running, otherwise UFW, otherwise whatever exists. */
  async function detect(): Promise<{ backend: Backend; bin: string } | { error: FirewallStatus }> {
    const base: FirewallStatus = {
      available: false,
      backend: null,
      reason: null,
      sudoersHint: null,
      active: false,
      defaults: null,
      zone: null,
      rules: [],
      protectedPorts: protectedPorts(),
      canToggle: false,
    };
    if (env.platform !== 'linux') return { error: { ...base, reason: 'Firewall management needs a Linux host with UFW or firewalld.' } };
    const found = locate();
    if (!found.ufw && !found.firewalld) {
      return { error: { ...base, reason: 'Neither UFW nor firewalld is installed. Install one — e.g. `sudo apt install ufw` or `sudo dnf install firewalld` — then reload this page.' } };
    }
    let choice: { backend: Backend; bin: string };
    if (found.firewalld) {
      const state = await run(found.firewalld, ['--state']);
      const hint = sudoersLine(found.firewalld);
      if (sudoProblem(state.stderr)) return { error: { ...base, backend: 'firewalld', reason: needSudo(), sudoersHint: hint } };
      choice = state.stdout.trim() === 'running' || !found.ufw ? { backend: 'firewalld', bin: found.firewalld } : { backend: 'ufw', bin: found.ufw };
    } else {
      choice = { backend: 'ufw', bin: found.ufw! };
    }
    if (choice.backend === 'ufw') {
      const probe = await run(choice.bin, ['status']);
      if (sudoProblem(probe.stderr)) return { error: { ...base, backend: 'ufw', reason: needSudo(), sudoersHint: sudoersLine(choice.bin) } };
    }
    return choice;
  }

  const needSudo = () =>
    `Outpost runs as "${env.user}", which isn't allowed to run the firewall tool. Add the sudoers rule below (sudo visudo -f /etc/sudoers.d/outpost-firewall), then reload this page.`;
  const sudoersLine = (bin: string) => `${env.user} ALL=(root) NOPASSWD: ${bin}`;

  async function status(): Promise<FirewallStatus> {
    const found = await detect();
    if ('error' in found) return found.error;
    const base = { reason: null, sudoersHint: null, protectedPorts: protectedPorts() };
    if (found.backend === 'ufw') {
      const st = parseUfwStatus(await must(found.bin, ['status', 'verbose']));
      const added = await must(found.bin, ['show', 'added']);
      const rules = added
        .split('\n')
        .map(parseUfwAdded)
        .filter((r): r is FirewallRule => r !== null);
      return { ...base, available: true, backend: 'ufw', active: st.active, defaults: st.defaults, zone: null, rules, canToggle: true };
    }
    const state = await run(found.bin, ['--state']);
    const active = state.stdout.trim() === 'running';
    if (!active) {
      return { ...base, available: true, backend: 'firewalld', active: false, defaults: null, zone: null, rules: [], canToggle: false, reason: 'firewalld is installed but not running (sudo systemctl enable --now firewalld).' };
    }
    const zone = (await must(found.bin, ['--get-default-zone'])).trim();
    const [ports, services, rich] = await Promise.all([
      must(found.bin, [`--zone=${zone}`, '--list-ports']),
      must(found.bin, [`--zone=${zone}`, '--list-services']),
      must(found.bin, [`--zone=${zone}`, '--list-rich-rules']),
    ]);
    const rules = [
      ...parseFirewalldServices(services),
      ...parseFirewalldPorts(ports),
      ...rich
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map(parseFirewalldRichRule),
    ];
    return { ...base, available: true, backend: 'firewalld', active, defaults: `zone "${zone}"`, zone, rules, canToggle: false };
  }

  async function requireBackend() {
    const found = await detect();
    if ('error' in found) throw new HttpError(409, found.error.reason ?? 'Firewall unavailable');
    return found;
  }

  function addRule(rule: NewRule): Promise<void> {
    return serial(async () => {
      const fw = await requireBackend();
      if (fw.backend === 'ufw') {
        for (const args of ufwAddArgs(rule)) await must(fw.bin, args);
        return;
      }
      const zone = (await must(fw.bin, ['--get-default-zone'])).trim();
      const protos: ('tcp' | 'udp')[] = rule.protocol === 'any' ? ['tcp', 'udp'] : [rule.protocol];
      for (const proto of protos) {
        if (rule.action === 'allow' && !rule.source) await must(fw.bin, ['--permanent', `--zone=${zone}`, `--add-port=${rule.port}/${proto}`]);
        else await must(fw.bin, ['--permanent', `--zone=${zone}`, `--add-rich-rule=${firewalldRichRule(rule, proto)}`]);
      }
      await must(fw.bin, ['--reload']);
    });
  }

  function deleteRule(id: string): Promise<void> {
    return serial(async () => {
      const fw = await requireBackend();
      const { kind, value } = decodeId(id);
      if (fw.backend === 'ufw') {
        if (kind !== 'ufw') throw new HttpError(400, 'That rule belongs to another firewall');
        let stored: unknown;
        try {
          stored = JSON.parse(value);
        } catch {
          throw new HttpError(400, 'Unknown rule');
        }
        if (!Array.isArray(stored) || !stored.every((t) => typeof t === 'string')) throw new HttpError(400, 'Unknown rule');
        // Only delete a rule that really exists, exactly as listed.
        const current = (await must(fw.bin, ['show', 'added'])).split('\n').map(parseUfwAdded);
        if (!current.some((r) => r?.id === id)) throw new HttpError(404, 'That rule no longer exists — refresh the list');
        await must(fw.bin, ufwDeleteArgs(stored as string[]));
        return;
      }
      const zone = (await must(fw.bin, ['--get-default-zone'])).trim();
      const flag = kind === 'port' ? '--remove-port' : kind === 'service' ? '--remove-service' : kind === 'rich' ? '--remove-rich-rule' : null;
      if (!flag) throw new HttpError(400, 'That rule belongs to another firewall');
      if (kind === 'port' && !/^\d+(-\d+)?\/(tcp|udp|sctp|dccp)$/.test(value)) throw new HttpError(400, 'Unknown rule');
      if (kind === 'service' && !/^[\w.-]+$/.test(value)) throw new HttpError(400, 'Unknown rule');
      await must(fw.bin, ['--permanent', `--zone=${zone}`, `${flag}=${value}`]);
      await must(fw.bin, ['--reload']);
    });
  }

  /** UFW only. Before switching on, make sure SSH and the panel stay reachable. */
  function setEnabled(enabled: boolean): Promise<string[]> {
    return serial(async () => {
      const fw = await requireBackend();
      if (fw.backend !== 'ufw') throw new HttpError(400, 'firewalld is a system service — start or stop it with systemctl');
      const added: string[] = [];
      if (enabled) {
        const rules = (await must(fw.bin, ['show', 'added'])).split('\n').map(parseUfwAdded).filter((r): r is FirewallRule => r !== null);
        for (const p of protectedPorts()) {
          const kept = rules.some((r) => ruleOpens(r, p.port, 'tcp') || (p.why === 'SSH' && r.label === 'OpenSSH' && r.action === 'allow'));
          if (!kept) {
            await must(fw.bin, ['allow', `${p.port}/tcp`, 'comment', `${p.why} (added by Outpost)`]);
            added.push(`${p.port}/tcp (${p.why})`);
          }
        }
        await must(fw.bin, ['--force', 'enable']);
      } else {
        await must(fw.bin, ['disable']);
      }
      return added;
    });
  }

  return { status, addRule, deleteRule, setEnabled, protectedPorts };
}

export const firewall = createFirewall({
  platform: process.platform,
  isRoot: process.getuid?.() === 0,
  user: process.env.USER ?? process.env.LOGNAME ?? 'outpost',
  exists: (p) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  exec: realExec,
  panelPort: Number(process.env.PORT ?? 8642),
  sshPorts,
});
