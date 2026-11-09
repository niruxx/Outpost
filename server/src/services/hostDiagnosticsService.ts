/**
 * Diagnostics for the Diagnostics page: collected sos reports (stored in the data folder so the
 * Outpost account can serve them) and kdump status, read as the Outpost service account.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../utils/paths.js';
import { HttpError } from '../utils/asyncHandler.js';
import { SOS_NAME_RE, kdumpFlavor } from './hostDiagnosticsOps.js';
import { runCommand } from './hostSystemOps.js';

export const DIAG_DIR = path.join(DATA_DIR, 'diagnostics');

const read = (file: string) => {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
};

const onPath = (bins: string[]) => bins.some((b) => ['/usr/sbin', '/usr/bin', '/sbin', '/bin'].some((d) => fs.existsSync(path.join(d, b))));

export function listReports() {
  try {
    return fs
      .readdirSync(DIAG_DIR)
      .filter((f) => SOS_NAME_RE.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(DIAG_DIR, f));
        return { name: f, size: st.size, createdAt: st.mtime.toISOString(), sha256: read(path.join(DIAG_DIR, `${f}.sha256`)).split(/\s+/)[0] || null };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

export function reportPath(name: string): string {
  if (typeof name !== 'string' || !SOS_NAME_RE.test(name)) throw new HttpError(400, 'Invalid report name');
  const file = path.join(DIAG_DIR, name);
  if (!fs.existsSync(file)) throw new HttpError(404, 'No such report');
  return file;
}

export function deleteReport(name: string) {
  const file = reportPath(name);
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}.sha256`, { force: true });
}

/** Configured dump folder from /etc/kdump.conf ("path …") or /etc/default/kdump-tools (KDUMP_COREDIR). */
export function kdumpPathFrom(flavor: 'fedora' | 'debian', text: string): string {
  if (flavor === 'fedora') return text.match(/^\s*path\s+(\S+)/m)?.[1] ?? '/var/crash';
  return text.match(/^\s*KDUMP_COREDIR="?([^"\n]+)"?/m)?.[1] ?? '/var/crash';
}

export async function diagnosticsOverview() {
  const linux = process.platform === 'linux';
  const flavor = linux ? kdumpFlavor() : null;
  let kdump: Record<string, unknown> = { installed: false };
  if (flavor) {
    const unit = flavor === 'fedora' ? 'kdump.service' : 'kdump-tools.service';
    const [active, enabled] = await Promise.all([
      runCommand('systemctl', ['is-active', unit], { timeoutMs: 10_000 }),
      runCommand('systemctl', ['is-enabled', unit], { timeoutMs: 10_000 }),
    ]);
    const crashSize = Number(read('/sys/kernel/kexec_crash_size')) || 0;
    const dumpPath = kdumpPathFrom(flavor, read(flavor === 'fedora' ? '/etc/kdump.conf' : '/etc/default/kdump-tools'));
    let dumps: Array<{ name: string; modifiedAt: string }> = [];
    try {
      dumps = fs
        .readdirSync(dumpPath, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => ({ name: d.name, modifiedAt: fs.statSync(path.join(dumpPath, d.name)).mtime.toISOString() }))
        .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    } catch {
      // folder missing or unreadable
    }
    kdump = {
      installed: true,
      flavor,
      unit,
      active: active.stdout.trim() === 'active',
      enabled: enabled.stdout.trim() === 'enabled',
      reservedBytes: crashSize,
      loaded: read('/sys/kernel/kexec_crash_loaded') === '1',
      cmdline: read('/proc/cmdline').match(/crashkernel=\S+/)?.[0] ?? null,
      path: dumpPath,
      dumps,
    };
  }
  return { linux, sosInstalled: linux && onPath(['sos', 'sosreport']), reports: listReports(), dir: DIAG_DIR, kdump };
}
