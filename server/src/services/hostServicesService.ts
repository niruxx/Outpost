/**
 * systemd units for the Services page, read as the Outpost service account (systemctl's read-only
 * commands need no privileges). Changes go through hostSystemOps in Admin Mode.
 *
 * Parsers are pure functions over systemctl's text output so they can be tested with recorded
 * output on any machine.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from '../utils/asyncHandler.js';
import {
  MANAGED_MARKER,
  UNIT_DIR,
  UNIT_TYPES,
  parseManagedTimer,
  runCommand,
  validUnitName,
  type CommandResult,
  type TimerDefinition,
  type UnitAction,
  type UnitType,
} from './hostSystemOps.js';

export interface UnitSummary {
  unit: string;
  description: string;
  /** loaded, not-found, masked… */
  load: string;
  /** active, inactive, failed, activating… */
  active: string;
  sub: string;
  /** enabled, disabled, static, masked, generated… or null when there is no unit file. */
  fileState: string | null;
  preset: string | null;
  /** Timers only. */
  nextRun?: string | null;
  lastRun?: string | null;
  triggers?: string | null;
  /** Timers created on the Services page. */
  managed?: boolean;
}

export interface UnitDetails {
  unit: string;
  properties: Record<string, string>;
  file: string | null;
  managedTimer: TimerDefinition | null;
  protectedReason: string | null;
  isOwnUnit: boolean;
}

type Exec = (cmd: string, args: string[]) => Promise<CommandResult>;
const exec: Exec = (cmd, args) => runCommand(cmd, args, { timeoutMs: 30_000 });

/** `systemctl list-units --plain --no-legend` → summaries (bullets for failed units stripped). */
export function parseListUnits(stdout: string): Array<Pick<UnitSummary, 'unit' | 'load' | 'active' | 'sub' | 'description'>> {
  return stdout
    .split('\n')
    .map((l) => l.trim().replace(/^[●*×]\s*/, ''))
    .filter(Boolean)
    .map((l) => {
      const [unit, load, active, sub, ...rest] = l.split(/\s+/);
      return { unit, load, active, sub, description: rest.join(' ') };
    })
    .filter((u) => validUnitName(u.unit));
}

/** `systemctl list-unit-files --no-legend` → unit → [state, preset]. */
export function parseUnitFiles(stdout: string): Map<string, { state: string; preset: string | null }> {
  const out = new Map<string, { state: string; preset: string | null }>();
  for (const line of stdout.split('\n')) {
    const [unit, state, preset] = line.trim().split(/\s+/);
    if (unit && state && validUnitName(unit)) out.set(unit, { state, preset: preset && preset !== '-' ? preset : null });
  }
  return out;
}

/** `systemctl show` output for one or more units (blocks separated by blank lines). */
export function parseShow(stdout: string): Array<Record<string, string>> {
  const blocks: Array<Record<string, string>> = [];
  let current: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    if (!line.trim()) {
      if (Object.keys(current).length) blocks.push(current);
      current = {};
      continue;
    }
    const eq = line.indexOf('=');
    if (eq > 0) current[line.slice(0, eq)] = line.slice(eq + 1);
  }
  if (Object.keys(current).length) blocks.push(current);
  return blocks;
}

/** "@1731127200" (from --timestamp=unix) → ISO; other non-empty values are passed through. */
export function showTime(v: string | undefined): string | null {
  if (!v || v === 'n/a' || v === '0') return null;
  const m = v.match(/^@(\d+)$/);
  if (m) return Number(m[1]) > 0 ? new Date(Number(m[1]) * 1000).toISOString() : null;
  return v;
}

/** `systemd-analyze calendar --iterations=N` → normalised form and next elapses. */
export function parseCalendar(stdout: string): { normalized: string | null; next: string[] } {
  const normalized = stdout.match(/Normalized form:\s*(.+)/)?.[1]?.trim() ?? null;
  const next: string[] = [];
  for (const m of stdout.matchAll(/(?:Next elapse|Iter\. #\d+):\s*(.+)/g)) next.push(m[1].trim());
  return { normalized, next };
}

/** The unit Outpost runs in, from /proc/self/cgroup ("0::/system.slice/outpost.service"). */
export function ownUnitFromCgroup(text: string): string | null {
  for (const line of text.split('\n')) {
    const parts = line.split(':').slice(2).join(':').split('/');
    for (let i = parts.length - 1; i >= 0; i--) if (/\.service$/.test(parts[i]) && validUnitName(parts[i])) return parts[i];
  }
  return null;
}

let ownUnitCache: string | null | undefined;
export function ownUnit(): string | null {
  if (ownUnitCache !== undefined) return ownUnitCache;
  try {
    ownUnitCache = process.platform === 'linux' ? ownUnitFromCgroup(fs.readFileSync('/proc/self/cgroup', 'utf8')) : null;
  } catch {
    ownUnitCache = null;
  }
  // user@1000.service and session scopes aren't "Outpost's own" unit.
  if (ownUnitCache && /^user@/.test(ownUnitCache)) ownUnitCache = null;
  return ownUnitCache;
}

const CRITICAL: Array<[RegExp, string]> = [
  [/^sshd?(@.*)?\.service$/, 'remote SSH access to this host'],
  [/^(dbus|dbus-broker)\.service$/, 'the system message bus most services depend on'],
  [/^systemd-(journald|logind|udevd|networkd|resolved)\.service$/, 'a core part of the operating system'],
  [/^NetworkManager\.service$/, 'the host’s network connection'],
  [/^(polkit|sudo)\.service$/, 'administrative authentication'],
];

/** Why an action on a unit needs explicit confirmation, or null. */
export function protectionFor(unit: string, action: UnitAction, own: string | null = ownUnit()): string | null {
  const disruptive = action === 'stop' || action === 'mask' || action === 'disable-now' || action === 'restart';
  if (!disruptive) return null;
  if (own && unit === own) {
    return action === 'restart'
      ? `${unit} is Outpost itself. Restarting it disconnects this page for a few seconds.`
      : `${unit} is Outpost itself. This panel stops responding and you’ll need SSH or the console to start it again.`;
  }
  if (action === 'restart') return null;
  const hit = CRITICAL.find(([re]) => re.test(unit));
  return hit ? `${unit} provides ${hit[1]}. Doing this can lock you out of the host.` : null;
}

export function servicesAvailability(): { available: boolean; reason: string | null } {
  if (process.platform !== 'linux') return { available: false, reason: 'Service management uses systemd and is only available on Linux hosts.' };
  if (!fs.existsSync('/run/systemd/system')) return { available: false, reason: 'This host isn’t running systemd (for example inside a container), so there are no services to manage.' };
  return { available: true, reason: null };
}

async function readManagedTimer(base: string, dir = UNIT_DIR): Promise<TimerDefinition | null> {
  try {
    const [service, timer] = await Promise.all([fsp.readFile(path.join(dir, `${base}.service`), 'utf8'), fsp.readFile(path.join(dir, `${base}.timer`), 'utf8')]);
    return parseManagedTimer(base, service, timer);
  } catch {
    return null;
  }
}

function isManagedTimerFile(unit: string): boolean {
  try {
    const fd = fs.openSync(path.join(UNIT_DIR, unit), 'r');
    try {
      const buf = Buffer.alloc(MANAGED_MARKER.length + 4);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.subarray(0, n).toString('utf8').startsWith(MANAGED_MARKER);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

async function showWithUnixTime(props: string[], units: string[]): Promise<Array<Record<string, string>>> {
  if (!units.length) return [];
  const base = ['show', `--property=${props.join(',')}`];
  let r = await exec('systemctl', [...base, '--timestamp=unix', '--', ...units]);
  // --timestamp arrived in systemd 248; older versions print local time strings instead.
  if (r.code !== 0 && /unrecognized option|timestamp/i.test(r.stderr)) r = await exec('systemctl', [...base, '--', ...units]);
  return parseShow(r.stdout);
}

export async function listUnits(type: UnitType, deps: { exec?: Exec } = {}): Promise<UnitSummary[]> {
  if (!UNIT_TYPES.includes(type)) throw new HttpError(400, 'Unknown unit type');
  const run = deps.exec ?? exec;
  const [units, files] = await Promise.all([
    run('systemctl', ['list-units', `--type=${type}`, '--all', '--no-pager', '--plain', '--no-legend']),
    run('systemctl', ['list-unit-files', `--type=${type}`, '--no-pager', '--no-legend']),
  ]);
  if (units.code === null) throw new HttpError(502, `systemctl couldn’t run: ${units.stderr.trim() || 'not installed'}`);
  const fileStates = parseUnitFiles(files.stdout);
  const out = new Map<string, UnitSummary>();
  for (const u of parseListUnits(units.stdout)) {
    const f = fileStates.get(u.unit);
    out.set(u.unit, { ...u, fileState: f?.state ?? null, preset: f?.preset ?? null });
  }
  // Installed but never loaded (disabled, not started since boot): list-units doesn't show them.
  for (const [unit, f] of fileStates) {
    if (out.has(unit) || unit.includes('@.')) continue; // templates aren't runnable units themselves
    out.set(unit, { unit, description: '', load: f.state === 'masked' ? 'masked' : 'not-loaded', active: 'inactive', sub: 'dead', fileState: f.state, preset: f.preset });
  }
  const list = [...out.values()].sort((a, b) => a.unit.localeCompare(b.unit));
  if (type === 'timer' && !deps.exec) {
    const shown = await showWithUnixTime(['Id', 'NextElapseUSecRealtime', 'LastTriggerUSec', 'Triggers'], list.map((t) => t.unit));
    const byId = new Map(shown.map((b) => [b.Id, b]));
    for (const t of list) {
      const b = byId.get(t.unit);
      t.nextRun = showTime(b?.NextElapseUSecRealtime);
      t.lastRun = showTime(b?.LastTriggerUSec);
      t.triggers = b?.Triggers || null;
      t.managed = isManagedTimerFile(t.unit);
    }
  }
  return list;
}

const DETAIL_PROPS = [
  'Id', 'Description', 'LoadState', 'ActiveState', 'SubState', 'UnitFileState', 'UnitFilePreset', 'FragmentPath', 'DropInPaths',
  'MainPID', 'ExecMainStatus', 'Result', 'ActiveEnterTimestamp', 'InactiveEnterTimestamp', 'StateChangeTimestamp',
  'MemoryCurrent', 'CPUUsageNSec', 'TasksCurrent', 'Restart', 'User', 'Requires', 'Wants', 'After', 'Before', 'WantedBy',
  'RequiredBy', 'Triggers', 'TriggeredBy', 'NextElapseUSecRealtime', 'LastTriggerUSec', 'CanStart', 'CanStop', 'CanReload',
  'Listen', 'Where', 'What', 'Documentation',
];

export async function unitDetails(unit: string): Promise<UnitDetails> {
  if (!validUnitName(unit)) throw new HttpError(400, 'Invalid unit name');
  const [blocks, cat] = await Promise.all([showWithUnixTime(DETAIL_PROPS, [unit]), exec('systemctl', ['cat', '--no-pager', '--', unit])]);
  const properties = blocks[0] ?? {};
  for (const k of ['ActiveEnterTimestamp', 'InactiveEnterTimestamp', 'StateChangeTimestamp', 'NextElapseUSecRealtime', 'LastTriggerUSec']) {
    if (k in properties) properties[k] = showTime(properties[k]) ?? '';
  }
  const base = unit.replace(/\.(timer|service)$/, '');
  const managedTimer = /\.(timer|service)$/.test(unit) && path.dirname(properties.FragmentPath || '') === UNIT_DIR ? await readManagedTimer(base) : null;
  const own = ownUnit();
  return {
    unit,
    properties,
    file: cat.code === 0 ? cat.stdout : null,
    managedTimer,
    protectedReason: protectionFor(unit, 'stop', own),
    isOwnUnit: own === unit,
  };
}

export async function checkCalendar(expression: unknown): Promise<{ valid: boolean; normalized: string | null; next: string[]; error: string | null }> {
  if (typeof expression !== 'string' || !expression.trim() || expression.length > 200 || /[\r\n\0]/.test(expression)) {
    return { valid: false, normalized: null, next: [], error: 'Enter a calendar expression such as "daily" or "Mon..Fri 04:00"' };
  }
  const r = await exec('systemd-analyze', ['calendar', '--iterations=3', '--', expression.trim()]);
  if (r.code === null) return { valid: true, normalized: null, next: [], error: 'systemd-analyze isn’t available to check this schedule' };
  if (r.code !== 0) return { valid: false, normalized: null, next: [], error: (r.stderr.trim().split('\n').pop() || 'Invalid calendar expression').replace(/^Failed to parse calendar specification '[^']*': /, '') };
  return { valid: true, ...parseCalendar(r.stdout), error: null };
}
