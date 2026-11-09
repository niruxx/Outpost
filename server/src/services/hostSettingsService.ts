/**
 * Host overview for the Host page: identity, hardware, time and NTP, scheduled power actions and
 * tuned profiles, read as the Outpost service account. Changes go through hostSettingsOps.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CHRONY_SOURCES_NAME, TIMESYNCD_DROPIN, chronySourceDir } from './hostSettingsOps.js';
import { runCommand } from './hostSystemOps.js';

const read = (file: string) => {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
};

/** `timedatectl show` / `hostnamectl show`-style KEY=VALUE output. */
export function parseKeyValues(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).replace(/^"(.*)"$/, '$1');
  }
  return out;
}

/** `tuned-adm list`: "- name   - description" lines and "Current active profile: x". */
export function parseTunedList(text: string): { profiles: Array<{ name: string; description: string }>; active: string | null } {
  const profiles: Array<{ name: string; description: string }> = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^-\s+(\S+)\s*(?:-\s*(.*))?$/);
    if (m) profiles.push({ name: m[1], description: (m[2] ?? '').trim() });
  }
  const active = text.match(/Current active profile:\s*(.+)/)?.[1]?.trim() ?? null;
  return { profiles, active: active && !/^No current/i.test(active) ? active : null };
}

/** /run/systemd/shutdown/scheduled: USEC=…, MODE=reboot|poweroff, WALL_MESSAGE=… */
export function parseScheduledShutdown(text: string): { at: string; mode: string; message: string | null } | null {
  if (!text) return null;
  const kv = parseKeyValues(text);
  const usec = Number(kv.USEC);
  if (!Number.isFinite(usec) || usec <= 0) return null;
  return { at: new Date(usec / 1000).toISOString(), mode: kv.MODE ?? 'poweroff', message: kv.WALL_MESSAGE || null };
}

export function configuredNtpServers(): { client: 'chrony' | 'timesyncd' | null; servers: string[]; managed: boolean } {
  for (const conf of ['/etc/chrony/chrony.conf', '/etc/chrony.conf']) {
    const text = read(conf);
    if (!text) continue;
    const dir = chronySourceDir(text);
    const ours = dir ? read(path.join(dir, CHRONY_SOURCES_NAME)) : '';
    const fromOurs = [...ours.matchAll(/^\s*(?:server|pool)\s+(\S+)/gm)].map((m) => m[1]);
    const fromConf = [...text.matchAll(/^\s*(?:server|pool)\s+(\S+)/gm)].map((m) => m[1]);
    return { client: 'chrony', servers: fromOurs.length ? fromOurs : fromConf, managed: fromOurs.length > 0 };
  }
  const ours = read(TIMESYNCD_DROPIN);
  const main = read('/etc/systemd/timesyncd.conf');
  const pick = (t: string) => t.match(/^\s*NTP=(.*)$/m)?.[1]?.trim().split(/\s+/).filter(Boolean) ?? [];
  const servers = pick(ours);
  return { client: fs.existsSync('/lib/systemd/systemd-timesyncd') || fs.existsSync('/usr/lib/systemd/systemd-timesyncd') ? 'timesyncd' : null, servers: servers.length ? servers : pick(main), managed: servers.length > 0 };
}

export async function hostOverview() {
  const linux = process.platform === 'linux';
  const osRelease = parseKeyValues(read('/etc/os-release'));
  const [hostnamectl, timedatectl, tuned, recommend] = linux
    ? await Promise.all([
        runCommand('hostnamectl', ['status'], { timeoutMs: 10_000 }),
        runCommand('timedatectl', ['show'], { timeoutMs: 10_000 }),
        runCommand('tuned-adm', ['list'], { timeoutMs: 15_000 }),
        runCommand('tuned-adm', ['recommend'], { timeoutMs: 15_000 }),
      ])
    : [null, null, null, null];
  const pretty = hostnamectl?.stdout.match(/Pretty hostname:\s*(.+)/)?.[1]?.trim() ?? null;
  const time = parseKeyValues(timedatectl?.stdout ?? '');
  const tunedInfo = tuned && tuned.code === 0 ? parseTunedList(tuned.stdout) : null;
  const cpus = os.cpus();
  return {
    linux,
    hostname: os.hostname(),
    prettyHostname: pretty,
    os: osRelease.PRETTY_NAME || `${os.type()} ${os.release()}`,
    kernel: os.release(),
    arch: os.arch(),
    hardware: {
      vendor: read('/sys/class/dmi/id/sys_vendor') || null,
      product: read('/sys/class/dmi/id/product_name') || null,
      cpu: cpus[0]?.model.trim() ?? null,
      cores: cpus.length,
      memoryMb: Math.round(os.totalmem() / 1048576),
      machineId: read('/etc/machine-id') || null,
    },
    bootedAt: new Date(Date.now() - os.uptime() * 1000).toISOString(),
    time: {
      now: new Date().toISOString(),
      timezone: time.Timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      ntpEnabled: time.NTP === 'yes',
      synchronized: time.NTPSynchronized === 'yes',
      canNtp: time.CanNTP !== 'no',
      ntp: linux ? configuredNtpServers() : { client: null, servers: [], managed: false },
    },
    power: { scheduled: linux ? parseScheduledShutdown(read('/run/systemd/shutdown/scheduled')) : null },
    tuned: tunedInfo ? { ...tunedInfo, recommended: recommend?.code === 0 ? recommend.stdout.trim() || null : null, installed: true } : { installed: false, profiles: [], active: null, recommended: null },
  };
}

export async function listTimezones(): Promise<string[]> {
  const r = await runCommand('timedatectl', ['list-timezones', '--no-pager'], { timeoutMs: 10_000 });
  if (r.code === 0 && r.stdout.trim()) return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
}
