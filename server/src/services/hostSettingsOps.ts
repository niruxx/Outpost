/**
 * Privileged system settings for the host Overview page: hostname, time zone, clock and NTP,
 * power (reboot / shut down, now or scheduled) and tuned performance profiles. No panel imports;
 * runs inside Outpost when root or inside the Admin Mode helper.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { isIP } from 'node:net';
import { HostFileError } from './hostFileOps.js';
import { runCommand } from './hostSystemOps.js';

export const TIMESYNCD_DROPIN = '/etc/systemd/timesyncd.conf.d/50-outpost.conf';
export const CHRONY_SOURCES_NAME = 'outpost.sources';
const HOSTNAME_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const NTP_HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

async function must(cmd: string, args: string[]) {
  const r = await runCommand(cmd, args, { timeoutMs: 60_000 });
  if (r.code !== 0) throw new HostFileError(r.code === null ? 502 : 422, `${cmd}: ${(r.stderr || r.stdout).trim().split('\n').pop() || `exit ${r.code}`}`);
  return r;
}

export function assertHostname(v: unknown): string {
  if (typeof v !== 'string' || !HOSTNAME_RE.test(v)) throw new HostFileError(400, 'A host name may use letters, digits and "-", with dots between labels');
  return v;
}

export function assertTimezone(v: unknown, zoneinfo = '/usr/share/zoneinfo'): string {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(v)) throw new HostFileError(400, 'Invalid time zone');
  if (!fs.existsSync(path.join(zoneinfo, v))) throw new HostFileError(400, `Unknown time zone ${v}`);
  return v;
}

export function assertNtpServers(list: unknown): string[] {
  if (!Array.isArray(list) || list.length > 10) throw new HostFileError(400, 'Give up to 10 NTP servers');
  return list.map((s) => {
    const v = typeof s === 'string' ? s.trim() : '';
    if (!v || !(isIP(v) || NTP_HOST_RE.test(v))) throw new HostFileError(400, `“${String(s)}” isn’t a host name or IP address`);
    return v;
  });
}

/** Which NTP client is in charge: chrony (with a sourcedir we can drop a file into) or timesyncd. */
export function chronySourceDir(conf: string): string | null {
  const m = conf.match(/^\s*sourcedir\s+(\/\S+)/m);
  return m ? m[1] : null;
}

async function ntpServers(a: { servers: string[] }) {
  const servers = assertNtpServers(a.servers);
  const chronyConf = ['/etc/chrony/chrony.conf', '/etc/chrony.conf'].find((f) => fs.existsSync(f));
  const states = (await runCommand('systemctl', ['is-active', 'chronyd.service', 'chrony.service'], { timeoutMs: 10_000 })).stdout.split('\n').map((l) => l.trim());
  const chronyActive = states.includes('active');
  if (chronyConf && chronyActive) {
    const dir = chronySourceDir(await fsp.readFile(chronyConf, 'utf8'));
    if (!dir || dir.startsWith('/run')) throw new HostFileError(409, `${chronyConf} has no "sourcedir" in /etc for custom servers. Add "sourcedir /etc/chrony/sources.d" to it first.`);
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, CHRONY_SOURCES_NAME);
    if (servers.length) await fsp.writeFile(file, `# Managed by Outpost\n${servers.map((s) => `server ${s} iburst`).join('\n')}\n`, { mode: 0o644 });
    else await fsp.rm(file, { force: true });
    await must('chronyc', ['reload', 'sources']);
    return { client: 'chrony', servers };
  }
  await fsp.mkdir(path.dirname(TIMESYNCD_DROPIN), { recursive: true });
  if (servers.length) await fsp.writeFile(TIMESYNCD_DROPIN, `# Managed by Outpost\n[Time]\nNTP=${servers.join(' ')}\n`, { mode: 0o644 });
  else await fsp.rm(TIMESYNCD_DROPIN, { force: true });
  await runCommand('systemctl', ['try-restart', 'systemd-timesyncd.service'], { timeoutMs: 30_000 });
  return { client: 'timesyncd', servers };
}

async function setTime(a: { time: string }) {
  if (typeof a.time !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(a.time)) throw new HostFileError(400, 'Time must be "YYYY-MM-DD HH:MM"');
  await must('timedatectl', ['set-time', a.time]);
  return { ok: true };
}

async function power(a: { action: 'reboot' | 'poweroff'; delayMinutes?: number; message?: string }) {
  if (a.action !== 'reboot' && a.action !== 'poweroff') throw new HostFileError(400, 'Unknown power action');
  const delay = Number(a.delayMinutes ?? 0);
  if (!Number.isInteger(delay) || delay < 0 || delay > 7 * 24 * 60) throw new HostFileError(400, 'Delay must be 0 minutes to 7 days');
  const message = typeof a.message === 'string' ? a.message.replace(/[\r\n\0]/g, ' ').slice(0, 200) : '';
  const args = [a.action === 'reboot' ? '-r' : '-P', delay === 0 ? '+0' : `+${delay}`, ...(message ? [message] : [])];
  if (delay === 0) {
    // Answer first; the panel goes down with the host.
    setTimeout(() => void runCommand('shutdown', args, { timeoutMs: 30_000 }), 1500).unref?.();
    return { scheduled: false };
  }
  await must('shutdown', args);
  return { scheduled: true };
}

async function tunedProfile(a: { profile: string | null }) {
  if (a.profile === null) {
    await must('tuned-adm', ['off']);
    return { profile: null };
  }
  if (typeof a.profile !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(a.profile)) throw new HostFileError(400, 'Invalid profile');
  await must('tuned-adm', ['profile', a.profile]);
  return { profile: a.profile };
}

export const SETTINGS_OPS = {
  'settings.hostname': async (a: { hostname: string; pretty?: string }) => {
    await must('hostnamectl', ['set-hostname', assertHostname(a.hostname)]);
    if (a.pretty !== undefined) {
      const pretty = typeof a.pretty === 'string' ? a.pretty.replace(/[\r\n\0]/g, ' ').slice(0, 64) : '';
      await must('hostnamectl', ['set-hostname', '--pretty', pretty]);
    }
    return { hostname: a.hostname };
  },
  'settings.timezone': async (a: { timezone: string }) => {
    await must('timedatectl', ['set-timezone', assertTimezone(a.timezone)]);
    return { timezone: a.timezone };
  },
  'settings.ntp': async (a: { enabled: boolean }) => {
    await must('timedatectl', ['set-ntp', a.enabled === true ? 'true' : 'false']);
    return { enabled: a.enabled === true };
  },
  'settings.ntpServers': ntpServers,
  'settings.time': setTime,
  'power.schedule': power,
  'power.cancel': async () => {
    await must('shutdown', ['-c']);
    return { ok: true };
  },
  'tuned.profile': tunedProfile,
};
