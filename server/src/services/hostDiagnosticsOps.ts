/**
 * Privileged diagnostics: sos reports (collected as root, then handed to the Outpost account so
 * they can be downloaded) and kdump (crash-dump capture) configuration and testing.
 * No panel imports; runs inside Outpost when root or inside the Admin Mode helper.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { HostFileError } from './hostFileOps.js';
import { runCommand, type Emit } from './hostSystemOps.js';

export const SOS_NAME_RE = /^sosreport-[A-Za-z0-9._-]+\.tar\.(xz|gz|bz2|zst)$/;

function safeDir(dir: unknown): string {
  if (typeof dir !== 'string' || !path.posix.isAbsolute(dir) || !/^[A-Za-z0-9/_.-]+$/.test(dir) || dir.includes('..')) throw new HostFileError(400, 'Invalid folder');
  return dir;
}

async function ownerIds(owner: string): Promise<{ uid: number; gid: number }> {
  if (!/^[a-z_][a-z0-9_.-]{0,31}$/.test(owner)) throw new HostFileError(400, 'Invalid owner');
  const r = await runCommand('getent', ['passwd', owner], { timeoutMs: 10_000 });
  const f = r.stdout.split(':');
  if (f.length < 4) throw new HostFileError(404, `No account called ${owner}`);
  return { uid: Number(f[2]), gid: Number(f[3]) };
}

async function sosReport(a: { targetDir: string; owner: string; label?: string; onlyPlugins?: string[] }, emit?: Emit) {
  const dir = safeDir(a.targetDir);
  const ids = await ownerIds(a.owner);
  const label = typeof a.label === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(a.label) ? a.label : '';
  await fsp.mkdir(dir, { recursive: true });
  const before = new Set(await fsp.readdir(dir));
  const bin = fs.existsSync('/usr/sbin/sos') || fs.existsSync('/usr/bin/sos') ? 'sos' : 'sosreport';
  const args = [...(bin === 'sos' ? ['report'] : []), '--batch', '--tmp-dir', dir, ...(label ? ['--label', label] : [])];
  emit?.(`$ ${bin} ${args.join(' ')}\n`);
  const r = await runCommand(bin, args, { timeoutMs: 60 * 60_000, onOutput: emit, env: { LC_ALL: 'C.UTF-8' } });
  if (r.code === null) throw new HostFileError(502, 'sos isn’t installed — install the "sos" package from Host → Software');
  if (r.code !== 0) throw new HostFileError(422, `sos report failed: ${(r.stderr || r.stdout).trim().split('\n').filter(Boolean).slice(-2).join(' ')}`);
  const created = (await fsp.readdir(dir)).filter((f) => !before.has(f) && (SOS_NAME_RE.test(f) || /^sosreport-.*\.sha256$/.test(f)));
  for (const f of created) {
    await fsp.chown(path.join(dir, f), ids.uid, ids.gid);
    await fsp.chmod(path.join(dir, f), 0o600);
  }
  const report = created.find((f) => SOS_NAME_RE.test(f));
  if (!report) throw new HostFileError(502, 'sos finished but no report archive was found');
  return { file: report };
}

export function kdumpFlavor(): 'fedora' | 'debian' | null {
  if (fs.existsSync('/etc/kdump.conf') || fs.existsSync('/usr/bin/kdumpctl')) return 'fedora';
  if (fs.existsSync('/etc/default/kdump-tools')) return 'debian';
  return null;
}

/** Sets the dump folder in /etc/kdump.conf ("path /var/crash") or /etc/default/kdump-tools (KDUMP_COREDIR). */
export function setKdumpPath(flavor: 'fedora' | 'debian', text: string, dir: string): string {
  if (flavor === 'fedora') return /^\s*path\s+/m.test(text) ? text.replace(/^\s*path\s+.*$/m, `path ${dir}`) : `${text.replace(/\n*$/, '\n')}path ${dir}\n`;
  return /^\s*#?\s*KDUMP_COREDIR=/m.test(text) ? text.replace(/^\s*#?\s*KDUMP_COREDIR=.*$/m, `KDUMP_COREDIR="${dir}"`) : `${text.replace(/\n*$/, '\n')}KDUMP_COREDIR="${dir}"\n`;
}

const kdumpUnit = (flavor: 'fedora' | 'debian') => (flavor === 'fedora' ? 'kdump.service' : 'kdump-tools.service');

async function kdumpService(a: { enabled: boolean }) {
  const flavor = kdumpFlavor();
  if (!flavor) throw new HostFileError(409, 'kdump isn’t installed — install kexec-tools (Fedora/RHEL) or kdump-tools (Debian/Ubuntu)');
  const r = await runCommand('systemctl', [a.enabled ? 'enable' : 'disable', '--now', kdumpUnit(flavor)], { timeoutMs: 120_000 });
  if (r.code !== 0) throw new HostFileError(422, (r.stderr || r.stdout).trim().split('\n').pop() || 'systemctl failed');
  return { enabled: a.enabled };
}

async function kdumpConfig(a: { path: string }) {
  const flavor = kdumpFlavor();
  if (!flavor) throw new HostFileError(409, 'kdump isn’t installed');
  const dir = safeDir(a.path);
  const file = flavor === 'fedora' ? '/etc/kdump.conf' : '/etc/default/kdump-tools';
  await fsp.writeFile(file, setKdumpPath(flavor, await fsp.readFile(file, 'utf8'), dir));
  await fsp.mkdir(dir, { recursive: true });
  await runCommand('systemctl', ['try-restart', kdumpUnit(flavor)], { timeoutMs: 120_000 });
  return { path: dir };
}

async function kdumpReserve() {
  const flavor = kdumpFlavor();
  if (flavor === 'fedora' && fs.existsSync('/usr/bin/kdumpctl')) {
    const r = await runCommand('kdumpctl', ['reset-crashkernel'], { timeoutMs: 120_000 });
    if (r.code !== 0) throw new HostFileError(422, (r.stderr || r.stdout).trim().split('\n').pop() || 'kdumpctl failed');
    return { output: (r.stdout + r.stderr).trim(), rebootRequired: true };
  }
  throw new HostFileError(409, 'Reserve crash-kernel memory by adding crashkernel= to the kernel command line (kdump-tools does this on install on Debian/Ubuntu), then reboot');
}

/** Crashes the kernel on purpose so kdump captures a dump and the host reboots. */
async function kdumpTest() {
  const loaded = (() => {
    try {
      return fs.readFileSync('/sys/kernel/kexec_crash_loaded', 'utf8').trim() === '1';
    } catch {
      return false;
    }
  })();
  if (!loaded) throw new HostFileError(409, 'No crash kernel is loaded, so the test would only hang the host. Enable kdump and reserve memory first.');
  setTimeout(() => {
    try {
      fs.writeFileSync('/proc/sys/kernel/sysrq', '1');
      fs.writeFileSync('/proc/sysrq-trigger', 'c');
    } catch {
      // can't happen as root; nothing to report to anyway
    }
  }, 2000);
  return { crashing: true };
}

export const DIAGNOSTICS_OPS = {
  'sos.report': sosReport,
  'kdump.service': kdumpService,
  'kdump.config': kdumpConfig,
  'kdump.reserve': () => kdumpReserve(),
  'kdump.test': () => kdumpTest(),
};
