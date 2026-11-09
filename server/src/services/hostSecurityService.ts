/**
 * Security posture for the Security page, read as the Outpost service account: SELinux and
 * AppArmor state, the system crypto policy and the panel's HTTPS certificate. Denial logs and
 * AppArmor profiles need root and are fetched through hostSecurityOps in Admin Mode.
 */
import fs from 'node:fs';
import { runCommand } from './hostSystemOps.js';
import { tlsStatus } from './tlsService.js';

const read = (file: string) => {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
};

export async function securityOverview() {
  const linux = process.platform === 'linux';
  let selinux: { present: boolean; mode: string | null; configured: string | null; policy: string | null } = { present: false, mode: null, configured: null, policy: null };
  let apparmor: { present: boolean; enabled: boolean } = { present: false, enabled: false };
  let crypto: { supported: boolean; current: string | null; available: string[] } = { supported: false, current: null, available: [] };
  if (linux) {
    if (fs.existsSync('/sys/fs/selinux') || fs.existsSync('/etc/selinux/config')) {
      const g = await runCommand('getenforce', [], { timeoutMs: 10_000 });
      const conf = read('/etc/selinux/config');
      selinux = {
        present: g.code === 0 || !!conf,
        mode: g.code === 0 ? g.stdout.trim().toLowerCase() : null,
        configured: conf.match(/^SELINUX=(\w+)/m)?.[1] ?? null,
        policy: conf.match(/^SELINUXTYPE=(\w+)/m)?.[1] ?? null,
      };
    }
    const aa = read('/sys/module/apparmor/parameters/enabled');
    apparmor = { present: !!aa || fs.existsSync('/etc/apparmor.d'), enabled: aa === 'Y' };
    const show = await runCommand('update-crypto-policies', ['--show'], { timeoutMs: 10_000 });
    if (show.code === 0) {
      let available: string[] = [];
      try {
        available = fs.readdirSync('/usr/share/crypto-policies/policies').filter((f) => f.endsWith('.pol')).map((f) => f.replace(/\.pol$/, ''));
      } catch {
        available = ['DEFAULT', 'LEGACY', 'FUTURE', 'FIPS'];
      }
      crypto = { supported: true, current: show.stdout.trim(), available };
    }
  }
  return { linux, selinux, apparmor, crypto, tls: tlsStatus() };
}
