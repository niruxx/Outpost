/**
 * Privileged security operations: SELinux mode and denials, AppArmor profiles and denials, the
 * system-wide crypto policy, and Let's Encrypt certificates for the panel through certbot.
 * No panel imports; runs inside Outpost when root or inside the Admin Mode helper.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { HostFileError } from './hostFileOps.js';
import { runCommand } from './hostSystemOps.js';

export const SELINUX_CONFIG = '/etc/selinux/config';
const DOMAIN_RE = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const EMAIL_RE = /^[^\s@"'`$\\;]{1,64}@[A-Za-z0-9.-]{1,253}$/;

async function must(cmd: string, args: string[], input?: string) {
  const r = await runCommand(cmd, args, { timeoutMs: 120_000, input });
  if (r.code !== 0) throw new HostFileError(r.code === null ? 502 : 422, `${cmd}: ${(r.stderr || r.stdout).trim().split('\n').pop() || `exit ${r.code}`}`);
  return r;
}

/** Rewrites SELINUX= in /etc/selinux/config, keeping everything else. */
export function setSelinuxConfig(text: string, mode: 'enforcing' | 'permissive' | 'disabled'): string {
  return /^SELINUX=/m.test(text) ? text.replace(/^SELINUX=.*$/m, `SELINUX=${mode}`) : `${text.replace(/\n*$/, '\n')}SELINUX=${mode}\n`;
}

async function selinuxMode(a: { mode: 'enforcing' | 'permissive'; persistent?: boolean }) {
  if (a.mode !== 'enforcing' && a.mode !== 'permissive') throw new HostFileError(400, 'Mode must be enforcing or permissive');
  await must('setenforce', [a.mode === 'enforcing' ? '1' : '0']);
  if (a.persistent) {
    const text = await fsp.readFile(SELINUX_CONFIG, 'utf8');
    await fsp.writeFile(SELINUX_CONFIG, setSelinuxConfig(text, a.mode));
  }
  return { mode: a.mode };
}

export interface Denial {
  time: string | null;
  kind: 'selinux' | 'apparmor';
  comm: string | null;
  permission: string | null;
  target: string | null;
  source: string | null;
  targetContext: string | null;
  targetClass: string | null;
  profile: string | null;
  raw: string;
}

const field = (line: string, key: string) => line.match(new RegExp(`(?:^|\\s)${key}=("[^"]*"|\\S+)`))?.[1]?.replace(/^"|"$/g, '') ?? null;

function auditTime(line: string): string | null {
  const m = line.match(/audit\((\d+)(?:\.\d+)?:\d+\)/);
  return m ? new Date(Number(m[1]) * 1000).toISOString() : null;
}

/** Raw `type=AVC msg=audit(...): avc: denied { read } for pid=… comm="x" name="y" scontext=… tcontext=… tclass=file`. */
export function parseAvc(text: string): Denial[] {
  return text
    .split('\n')
    .filter((l) => /type=(USER_)?AVC/.test(l) && /denied/.test(l))
    .map((line) => ({
      time: auditTime(line),
      kind: 'selinux' as const,
      comm: field(line, 'comm'),
      permission: line.match(/denied\s+\{\s*([^}]+?)\s*\}/)?.[1] ?? null,
      target: field(line, 'path') ?? field(line, 'name'),
      source: field(line, 'scontext'),
      targetContext: field(line, 'tcontext'),
      targetClass: field(line, 'tclass'),
      profile: null,
      raw: line,
    }));
}

/** Kernel log lines: `audit: type=1400 audit(…): apparmor="DENIED" operation="open" profile="x" name="/y" comm="z" requested_mask="r"`. */
export function parseAppArmorDenials(text: string): Denial[] {
  return text
    .split('\n')
    .filter((l) => /apparmor="DENIED"/.test(l))
    .map((line) => ({
      time: auditTime(line),
      kind: 'apparmor' as const,
      comm: field(line, 'comm'),
      permission: field(line, 'requested_mask') ?? field(line, 'operation'),
      target: field(line, 'name'),
      source: null,
      targetContext: null,
      targetClass: field(line, 'operation'),
      profile: field(line, 'profile'),
      raw: line,
    }));
}

async function selinuxDenials(a: { since?: string }) {
  const since = a.since === 'week-ago' || a.since === 'today' || a.since === 'recent' ? a.since : 'today';
  const r = await runCommand('ausearch', ['-m', 'AVC,USER_AVC', '-ts', since, '--raw'], { timeoutMs: 60_000 });
  if (r.code === null) throw new HostFileError(502, 'ausearch isn’t installed (package audit)');
  // ausearch exits 1 with "<no matches>" when there is nothing.
  return parseAvc(r.stdout).slice(-500).reverse();
}

/** audit2why explains a denial (boolean to flip, missing allow rule, context mismatch). */
async function selinuxExplain(a: { raw: string }) {
  if (typeof a.raw !== 'string' || a.raw.length > 8000 || !/type=(USER_)?AVC/.test(a.raw)) throw new HostFileError(400, 'Not an AVC record');
  const why = await runCommand('audit2why', [], { input: `${a.raw}\n`, timeoutMs: 30_000 });
  const allow = await runCommand('audit2allow', [], { input: `${a.raw}\n`, timeoutMs: 30_000 });
  if (why.code === null && allow.code === null) throw new HostFileError(502, 'audit2why isn’t installed (package policycoreutils-python-utils)');
  return { explanation: why.stdout.trim() || why.stderr.trim(), allowRule: allow.stdout.trim() };
}

async function apparmorStatus() {
  const r = await runCommand('aa-status', ['--json'], { timeoutMs: 30_000 });
  if (r.code === null) throw new HostFileError(502, 'aa-status isn’t installed (package apparmor or apparmor-utils)');
  try {
    const data = JSON.parse(r.stdout) as { profiles?: Record<string, string>; processes?: Record<string, Array<{ profile: string; pid: string; status: string }>> };
    return { profiles: Object.entries(data.profiles ?? {}).map(([name, mode]) => ({ name, mode })), processes: Object.values(data.processes ?? {}).flat() };
  } catch {
    throw new HostFileError(502, (r.stderr || 'aa-status returned no data').trim());
  }
}

/** Finds the profile file under /etc/apparmor.d that defines a profile. */
export function findProfileFile(name: string, files: Array<{ file: string; text: string }>): string | null {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\s*(?:profile\\s+)?"?${esc}"?(?:\\s+[^\\s{]+)?\\s*(?:flags=\\([^)]*\\)\\s*)?\\{`, 'm');
  return files.find((f) => re.test(f.text))?.file ?? null;
}

async function apparmorMode(a: { profile: string; mode: 'enforce' | 'complain' }) {
  if (a.mode !== 'enforce' && a.mode !== 'complain') throw new HostFileError(400, 'Mode must be enforce or complain');
  if (typeof a.profile !== 'string' || !a.profile || a.profile.length > 256 || /[\r\n\0]/.test(a.profile)) throw new HostFileError(400, 'Invalid profile');
  const dir = '/etc/apparmor.d';
  const files: Array<{ file: string; text: string }> = [];
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(dir, entry.name);
    try {
      files.push({ file, text: await fsp.readFile(file, 'utf8') });
    } catch {
      // unreadable: skip
    }
  }
  const file = findProfileFile(a.profile, files);
  if (!file) throw new HostFileError(404, `No file in ${dir} defines the profile ${a.profile}`);
  await must(a.mode === 'enforce' ? 'aa-enforce' : 'aa-complain', [file]);
  return { profile: a.profile, mode: a.mode };
}

async function apparmorDenials() {
  const r = await runCommand('journalctl', ['-k', '--no-pager', '-o', 'cat', '--since', '-7d', '-g', 'apparmor="DENIED"'], { timeoutMs: 60_000 });
  return parseAppArmorDenials(r.stdout).slice(-500).reverse();
}

async function cryptoPolicy(a: { policy: string }) {
  if (typeof a.policy !== 'string' || !/^[A-Z0-9_-]{2,32}(:[A-Z0-9_-]{2,32}){0,4}$/.test(a.policy)) throw new HostFileError(400, 'Invalid policy');
  const base = a.policy.split(':')[0];
  if (!fs.existsSync(`/usr/share/crypto-policies/policies/${base}.pol`) && !fs.existsSync(`/etc/crypto-policies/policies/${base}.pol`)) {
    throw new HostFileError(400, `Unknown crypto policy ${base}`);
  }
  await must('update-crypto-policies', ['--set', a.policy]);
  return { policy: a.policy };
}

/** The certbot deploy hook that copies a renewed certificate where Outpost can read it. */
export function deployHook(targetDir: string, owner: string): string {
  if (!path.posix.isAbsolute(targetDir) || !/^[A-Za-z0-9/_.-]+$/.test(targetDir) || targetDir.includes('..')) throw new HostFileError(400, 'Invalid certificate folder');
  if (!/^[a-z_][a-z0-9_.-]{0,31}$/.test(owner)) throw new HostFileError(400, 'Invalid owner');
  const copy = (src: string, dst: string) => `install -D -m 600 -o ${owner} "$RENEWED_LINEAGE/${src}" ${targetDir}/${dst}`;
  return `${copy('fullchain.pem', 'cert.pem')} && ${copy('privkey.pem', 'key.pem')}`;
}

async function certbotIssue(a: { domain: string; email: string; staging?: boolean; targetDir: string; owner: string }, emit?: (s: string) => void) {
  if (typeof a.domain !== 'string' || !DOMAIN_RE.test(a.domain)) throw new HostFileError(400, 'Enter a public domain name, e.g. panel.example.com');
  if (typeof a.email !== 'string' || !EMAIL_RE.test(a.email)) throw new HostFileError(400, 'Enter a valid email address for expiry notices');
  const hook = deployHook(a.targetDir, a.owner);
  const args = [
    'certonly', '--standalone', '--non-interactive', '--agree-tos', '--keep-until-expiring', '--preferred-challenges', 'http',
    '-m', a.email, '-d', a.domain, '--deploy-hook', hook, ...(a.staging ? ['--staging'] : []),
  ];
  emit?.(`$ certbot ${args.filter((x) => x !== hook).join(' ')}\n`);
  const r = await runCommand('certbot', args, { timeoutMs: 5 * 60_000, onOutput: emit });
  if (r.code === null) throw new HostFileError(502, 'certbot isn’t installed — install it from Host → Software');
  if (r.code !== 0) throw new HostFileError(422, `certbot failed: ${(r.stderr || r.stdout).trim().split('\n').filter(Boolean).slice(-2).join(' ')}`);
  // --keep-until-expiring skips the deploy hook when the cert already exists: copy it now.
  const live = `/etc/letsencrypt/live/${a.domain}`;
  if (fs.existsSync(`${live}/fullchain.pem`)) {
    await runCommand('sh', ['-c', hook], { env: { RENEWED_LINEAGE: live }, timeoutMs: 30_000 });
  }
  return { domain: a.domain };
}

export const SECURITY_OPS = {
  'selinux.mode': selinuxMode,
  'selinux.denials': selinuxDenials,
  'selinux.explain': selinuxExplain,
  'apparmor.status': () => apparmorStatus(),
  'apparmor.mode': apparmorMode,
  'apparmor.denials': () => apparmorDenials(),
  'crypto.policy': cryptoPolicy,
  'tls.certbot': certbotIssue,
};
