/**
 * Software updates and an app/package browser for the host, over the distribution's own package
 * manager (apt, dnf or pacman). Reads run as the Outpost service account; transactions run as root
 * through Admin Mode (hostSystemOps `pkg.run`) as background jobs whose output streams to the page.
 *
 * Parsers are pure functions over the tools' text output so they can be tested with recorded output.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HttpError } from '../utils/asyncHandler.js';
import {
  APT_AUTO_UPGRADES_FILE,
  DNF_AUTOMATIC_TIMER,
  assertPackages,
  runCommand,
  type CommandResult,
  type PackageManager,
  type PackageVerb,
} from './hostSystemOps.js';

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export const CATEGORIES = [
  { id: 'web', label: 'Web servers & proxies' },
  { id: 'databases', label: 'Databases' },
  { id: 'development', label: 'Development' },
  { id: 'containers', label: 'Containers & virtualization' },
  { id: 'system', label: 'System & monitoring' },
  { id: 'networking', label: 'Networking' },
  { id: 'security', label: 'Security' },
  { id: 'media', label: 'Media' },
  { id: 'games', label: 'Games' },
  { id: 'utilities', label: 'Editors & utilities' },
  { id: 'libraries', label: 'Libraries' },
  { id: 'other', label: 'Other' },
] as const;
export type Category = (typeof CATEGORIES)[number]['id'];

interface CatalogApp {
  id: string;
  label: string;
  summary: string;
  category: Category;
  pkgs: Partial<Record<PackageManager, string>>;
}

/** Hand-picked apps, so common server software is one click on every supported distro. */
export const CATALOG: CatalogApp[] = [
  { id: 'nginx', label: 'nginx', summary: 'High-performance web server and reverse proxy', category: 'web', pkgs: { apt: 'nginx', dnf: 'nginx', pacman: 'nginx' } },
  { id: 'apache', label: 'Apache HTTP Server', summary: 'The classic, module-rich web server', category: 'web', pkgs: { apt: 'apache2', dnf: 'httpd', pacman: 'apache' } },
  { id: 'caddy', label: 'Caddy', summary: 'Web server with automatic HTTPS', category: 'web', pkgs: { apt: 'caddy', dnf: 'caddy', pacman: 'caddy' } },
  { id: 'haproxy', label: 'HAProxy', summary: 'TCP/HTTP load balancer and proxy', category: 'web', pkgs: { apt: 'haproxy', dnf: 'haproxy', pacman: 'haproxy' } },
  { id: 'certbot', label: 'Certbot', summary: 'Free TLS certificates from Let’s Encrypt', category: 'web', pkgs: { apt: 'certbot', dnf: 'certbot', pacman: 'certbot' } },
  { id: 'mariadb', label: 'MariaDB', summary: 'MySQL-compatible database server', category: 'databases', pkgs: { apt: 'mariadb-server', dnf: 'mariadb-server', pacman: 'mariadb' } },
  { id: 'postgresql', label: 'PostgreSQL', summary: 'Advanced open-source relational database', category: 'databases', pkgs: { apt: 'postgresql', dnf: 'postgresql-server', pacman: 'postgresql' } },
  { id: 'redis', label: 'Redis / Valkey', summary: 'In-memory key-value store and cache', category: 'databases', pkgs: { apt: 'redis-server', dnf: 'valkey', pacman: 'valkey' } },
  { id: 'sqlite', label: 'SQLite', summary: 'Command-line shell for SQLite databases', category: 'databases', pkgs: { apt: 'sqlite3', dnf: 'sqlite', pacman: 'sqlite' } },
  { id: 'git', label: 'Git', summary: 'Distributed version control', category: 'development', pkgs: { apt: 'git', dnf: 'git', pacman: 'git' } },
  { id: 'build', label: 'Build tools', summary: 'GCC, make and the basics for compiling software', category: 'development', pkgs: { apt: 'build-essential', dnf: 'gcc-c++', pacman: 'base-devel' } },
  { id: 'python', label: 'Python 3', summary: 'Python interpreter and pip', category: 'development', pkgs: { apt: 'python3-pip', dnf: 'python3-pip', pacman: 'python-pip' } },
  { id: 'nodejs', label: 'Node.js', summary: 'JavaScript runtime and npm', category: 'development', pkgs: { apt: 'nodejs', dnf: 'nodejs', pacman: 'nodejs' } },
  { id: 'go', label: 'Go', summary: 'The Go programming language', category: 'development', pkgs: { apt: 'golang', dnf: 'golang', pacman: 'go' } },
  { id: 'java', label: 'OpenJDK', summary: 'Java development kit', category: 'development', pkgs: { apt: 'default-jdk', dnf: 'java-21-openjdk', pacman: 'jdk-openjdk' } },
  { id: 'rust', label: 'Rust', summary: 'Rust compiler and Cargo', category: 'development', pkgs: { apt: 'cargo', dnf: 'cargo', pacman: 'rust' } },
  { id: 'podman', label: 'Podman', summary: 'Daemonless OCI containers', category: 'containers', pkgs: { apt: 'podman', dnf: 'podman', pacman: 'podman' } },
  { id: 'docker', label: 'Docker Engine', summary: 'Container engine (distribution build)', category: 'containers', pkgs: { apt: 'docker.io', dnf: 'moby-engine', pacman: 'docker' } },
  { id: 'libvirt', label: 'libvirt + QEMU/KVM', summary: 'Virtual machines managed from the Virtual Machines page', category: 'containers', pkgs: { apt: 'libvirt-daemon-system', dnf: 'libvirt', pacman: 'libvirt' } },
  { id: 'htop', label: 'htop', summary: 'Interactive process viewer', category: 'system', pkgs: { apt: 'htop', dnf: 'htop', pacman: 'htop' } },
  { id: 'btop', label: 'btop', summary: 'Resource monitor with graphs', category: 'system', pkgs: { apt: 'btop', dnf: 'btop', pacman: 'btop' } },
  { id: 'smartmontools', label: 'smartmontools', summary: 'Disk health (SMART) monitoring', category: 'system', pkgs: { apt: 'smartmontools', dnf: 'smartmontools', pacman: 'smartmontools' } },
  { id: 'sensors', label: 'lm-sensors', summary: 'Hardware temperature and fan sensors', category: 'system', pkgs: { apt: 'lm-sensors', dnf: 'lm_sensors', pacman: 'lm_sensors' } },
  { id: 'sysstat', label: 'sysstat', summary: 'iostat, sar and other performance tools', category: 'system', pkgs: { apt: 'sysstat', dnf: 'sysstat', pacman: 'sysstat' } },
  { id: 'tmux', label: 'tmux', summary: 'Terminal multiplexer', category: 'system', pkgs: { apt: 'tmux', dnf: 'tmux', pacman: 'tmux' } },
  { id: 'rsync', label: 'rsync', summary: 'Fast file copying and synchronisation', category: 'system', pkgs: { apt: 'rsync', dnf: 'rsync', pacman: 'rsync' } },
  { id: 'wireguard', label: 'WireGuard tools', summary: 'Fast, modern VPN', category: 'networking', pkgs: { apt: 'wireguard-tools', dnf: 'wireguard-tools', pacman: 'wireguard-tools' } },
  { id: 'openssh', label: 'OpenSSH server', summary: 'Remote shell access', category: 'networking', pkgs: { apt: 'openssh-server', dnf: 'openssh-server', pacman: 'openssh' } },
  { id: 'curl', label: 'curl', summary: 'Transfer data with URLs', category: 'networking', pkgs: { apt: 'curl', dnf: 'curl', pacman: 'curl' } },
  { id: 'nmap', label: 'Nmap', summary: 'Network discovery and port scanning', category: 'networking', pkgs: { apt: 'nmap', dnf: 'nmap', pacman: 'nmap' } },
  { id: 'tcpdump', label: 'tcpdump', summary: 'Packet capture and analysis', category: 'networking', pkgs: { apt: 'tcpdump', dnf: 'tcpdump', pacman: 'tcpdump' } },
  { id: 'iperf3', label: 'iperf3', summary: 'Network bandwidth testing', category: 'networking', pkgs: { apt: 'iperf3', dnf: 'iperf3', pacman: 'iperf3' } },
  { id: 'dig', label: 'DNS tools (dig)', summary: 'Query DNS servers', category: 'networking', pkgs: { apt: 'dnsutils', dnf: 'bind-utils', pacman: 'bind' } },
  { id: 'fail2ban', label: 'Fail2ban', summary: 'Ban IPs that brute-force logins', category: 'security', pkgs: { apt: 'fail2ban', dnf: 'fail2ban', pacman: 'fail2ban' } },
  { id: 'ufw', label: 'UFW', summary: 'Uncomplicated firewall (used by the Firewall page)', category: 'security', pkgs: { apt: 'ufw', dnf: 'ufw', pacman: 'ufw' } },
  { id: 'firewalld', label: 'firewalld', summary: 'Zone-based firewall (used by the Firewall page)', category: 'security', pkgs: { apt: 'firewalld', dnf: 'firewalld', pacman: 'firewalld' } },
  { id: 'clamav', label: 'ClamAV', summary: 'Antivirus scanner', category: 'security', pkgs: { apt: 'clamav', dnf: 'clamav', pacman: 'clamav' } },
  { id: 'autoupdates', label: 'Automatic updates', summary: 'Installs security updates unattended', category: 'security', pkgs: { apt: 'unattended-upgrades', dnf: 'dnf-automatic' } },
  { id: 'ffmpeg', label: 'FFmpeg', summary: 'Record, convert and stream audio and video', category: 'media', pkgs: { apt: 'ffmpeg', dnf: 'ffmpeg-free', pacman: 'ffmpeg' } },
  { id: 'imagemagick', label: 'ImageMagick', summary: 'Convert and edit images from the command line', category: 'media', pkgs: { apt: 'imagemagick', dnf: 'ImageMagick', pacman: 'imagemagick' } },
  { id: 'steamcmd', label: 'SteamCMD', summary: 'Steam’s command-line client for dedicated servers', category: 'games', pkgs: { apt: 'steamcmd' } },
  { id: 'screen', label: 'GNU Screen', summary: 'Detachable terminal sessions, common for game servers', category: 'games', pkgs: { apt: 'screen', dnf: 'screen', pacman: 'screen' } },
  { id: 'vim', label: 'Vim', summary: 'Modal text editor', category: 'utilities', pkgs: { apt: 'vim', dnf: 'vim-enhanced', pacman: 'vim' } },
  { id: 'nano', label: 'nano', summary: 'Simple terminal text editor', category: 'utilities', pkgs: { apt: 'nano', dnf: 'nano', pacman: 'nano' } },
  { id: 'jq', label: 'jq', summary: 'Command-line JSON processor', category: 'utilities', pkgs: { apt: 'jq', dnf: 'jq', pacman: 'jq' } },
  { id: 'zip', label: 'zip / unzip', summary: 'Create and extract .zip archives', category: 'utilities', pkgs: { apt: 'unzip', dnf: 'unzip', pacman: 'unzip' } },
  { id: '7zip', label: '7-Zip', summary: 'High-ratio archiver', category: 'utilities', pkgs: { apt: '7zip', dnf: '7zip', pacman: '7zip' } },
  { id: 'tree', label: 'tree', summary: 'List folders as a tree', category: 'utilities', pkgs: { apt: 'tree', dnf: 'tree', pacman: 'tree' } },
];

const CATALOG_BY_PKG = new Map<string, Category>();
for (const app of CATALOG) for (const p of Object.values(app.pkgs)) if (p) CATALOG_BY_PKG.set(p, app.category);

const APT_SECTIONS: Record<string, Category> = {
  web: 'web', httpd: 'web', database: 'databases',
  devel: 'development', python: 'development', perl: 'development', ruby: 'development', javascript: 'development', java: 'development',
  php: 'development', rust: 'development', golang: 'development', vcs: 'development', haskell: 'development', ocaml: 'development',
  lisp: 'development', interpreters: 'development', 'cli-mono': 'development', debug: 'development', zope: 'development',
  admin: 'system', utils: 'utilities', shells: 'system', kernel: 'system', otherosfs: 'system', metapackages: 'system',
  virtual: 'containers', net: 'networking', mail: 'networking', comm: 'networking', news: 'networking',
  video: 'media', sound: 'media', graphics: 'media', games: 'games',
  editors: 'utilities', text: 'utilities', doc: 'utilities', tex: 'utilities', x11: 'utilities', gnome: 'utilities', kde: 'utilities', xfce: 'utilities',
  libs: 'libraries', libdevel: 'libraries', oldlibs: 'libraries', introspection: 'libraries',
  science: 'other', math: 'other', electronics: 'other', hamradio: 'other', embedded: 'other', localization: 'other', translations: 'other', fonts: 'other', misc: 'other',
};

/** A package's group: the curated catalog, then the distro's section/group, then name patterns. */
export function categorize(name: string, section?: string | null, groups?: string[]): Category {
  const curated = CATALOG_BY_PKG.get(name);
  if (curated) return curated;
  if (section) {
    const s = section.split('/').pop()!.toLowerCase();
    if (APT_SECTIONS[s]) return APT_SECTIONS[s];
  }
  if (groups?.some((g) => /devel/.test(g))) return 'development';
  if (/^lib.+|-libs?$|-common$|-data$/.test(name)) return 'libraries';
  if (/-(devel|dev|headers|static|debuginfo|debugsource)$/.test(name) || /^(python3?|perl|ruby|rubygem|php|golang|nodejs|rust|ghc|ocaml|java)-/.test(name)) return 'development';
  if (/(sql|mongo|redis|valkey|mariadb|database)/.test(name)) return 'databases';
  if (/(nginx|httpd|apache|caddy|lighttpd|haproxy|traefik)/.test(name)) return 'web';
  if (/(docker|podman|containerd|libvirt|qemu|virt-|lxc|incus|buildah|skopeo)/.test(name)) return 'containers';
  if (/(firewall|fail2ban|clamav|selinux|apparmor|audit|gnupg|gpg|openssl|ssh)/.test(name)) return 'security';
  if (/(ffmpeg|gstreamer|pulseaudio|pipewire|alsa|imagemagick|gimp|vlc|mpv)/.test(name)) return 'media';
  if (/(font|-fonts?-|^fonts-)/.test(name)) return 'other';
  return 'other';
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

export interface UpdateItem {
  name: string;
  current: string | null;
  available: string;
  repo: string | null;
  security: boolean;
}

export interface PackageItem {
  name: string;
  version: string | null;
  summary: string;
  category: Category;
  installed: boolean;
  repo?: string | null;
  /** Installed size in bytes, when known. */
  size?: number | null;
  /** Installed on request (not as a dependency); null when the package manager can't tell cheaply. */
  manual?: boolean | null;
}

/** `apt list --upgradable`: "name/suite1,suite2 1.2 amd64 [upgradable from: 1.1]". */
export function parseAptUpgradable(stdout: string): UpdateItem[] {
  const out: UpdateItem[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/^([^\s/]+)\/(\S+)\s+(\S+)\s+\S+\s+\[upgradable from:\s*([^\]]+)\]/);
    if (!m) continue;
    out.push({ name: m[1], repo: m[2], available: m[3], current: m[4].trim(), security: /-security\b/.test(m[2]) });
  }
  return out;
}

/** `dnf check-update`: "name.arch  version  repo" lines, stopping at "Obsoleting Packages". */
export function parseDnfCheckUpdate(stdout: string): UpdateItem[] {
  const out: UpdateItem[] = [];
  for (const line of stdout.split('\n')) {
    if (/^Obsoleting|^Security:/i.test(line.trim())) break;
    const m = line.match(/^(\S+)\.([A-Za-z0-9_]+)\s+(\S+)\s+(\S+)\s*$/);
    if (!m || /^(Last|Updating|Repositories)/.test(line)) continue;
    out.push({ name: m[1], current: null, available: m[3], repo: m[4], security: false });
  }
  return out;
}

/** Marks updates that `dnf updateinfo list --security` mentions (lines contain name-version.arch). */
export function markDnfSecurity(updates: UpdateItem[], securityOutput: string): void {
  const tokens = new Set(securityOutput.split(/\s+/).filter(Boolean));
  for (const u of updates) {
    const re = new RegExp(`^${u.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d`);
    for (const t of tokens) if (re.test(t)) { u.security = true; break; }
  }
}

/** `checkupdates` / `pacman -Qu`: "name 1.0-1 -> 1.1-1". */
export function parsePacmanUpdates(stdout: string): UpdateItem[] {
  const out: UpdateItem[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^(\S+)\s+(\S+)\s+->\s+(\S+)/);
    if (m) out.push({ name: m[1], current: m[2], available: m[3], repo: null, security: false });
  }
  return out;
}

/** `apt-cache show` stanzas → name → section/version/summary/size. */
export function parseAptShow(stdout: string): Map<string, { version: string; section: string | null; summary: string; size: number | null }> {
  const out = new Map<string, { version: string; section: string | null; summary: string; size: number | null }>();
  for (const stanza of stdout.split(/\n\s*\n/)) {
    const field = (k: string) => stanza.match(new RegExp(`^${k}:\\s*(.*)$`, 'm'))?.[1]?.trim() ?? null;
    const name = field('Package');
    if (!name || out.has(name)) continue;
    const size = Number(field('Installed-Size'));
    out.set(name, {
      version: field('Version') ?? '',
      section: field('Section'),
      summary: field('Description-en') ?? field('Description') ?? '',
      size: Number.isFinite(size) && size > 0 ? size * 1024 : null,
    });
  }
  return out;
}

/** `apt-cache search`: "name - summary". */
export function parseAptSearch(stdout: string): Array<{ name: string; summary: string }> {
  return stdout
    .split('\n')
    .map((l) => l.match(/^(\S+) - (.*)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ name: m[1], summary: m[2] }));
}

/** `dnf search` (dnf4 "name.arch : summary", dnf5 " name.arch: summary"). */
export function parseDnfSearch(stdout: string): Array<{ name: string; summary: string }> {
  const out = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*([^\s:]+)\.([A-Za-z0-9_]+)\s*:\s+(.*)$/);
    if (m && !out.has(m[1])) out.set(m[1], m[3]);
  }
  return [...out].map(([name, summary]) => ({ name, summary }));
}

/** `pacman -Ss`: "repo/name ver (group …) [installed]" + indented description. */
export function parsePacmanSearch(stdout: string): Array<{ name: string; summary: string; repo: string; version: string; groups: string[]; installed: boolean }> {
  const out: Array<{ name: string; summary: string; repo: string; version: string; groups: string[]; installed: boolean }> = [];
  const lines = stdout.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\S+)\/(\S+)\s+(\S+)(?:\s+\(([^)]*)\))?(.*)$/);
    if (!m) continue;
    const desc = lines[i + 1]?.startsWith(' ') ? lines[++i].trim() : '';
    out.push({ repo: m[1], name: m[2], version: m[3], groups: m[4] ? m[4].split(/\s+/) : [], installed: /\[installed/.test(m[5]), summary: desc });
  }
  return out;
}

/** Tab-separated name, version, section/group, size, status, summary (dpkg-query / rpm -qa). */
export function parseInstalledTsv(stdout: string, sizeUnit: number): Array<{ name: string; version: string; section: string | null; size: number | null; summary: string }> {
  const out: Array<{ name: string; version: string; section: string | null; size: number | null; summary: string }> = [];
  for (const line of stdout.split('\n')) {
    const [name, version, section, size, status, ...summary] = line.split('\t');
    if (!name || !version || (status && !/^(ii|hi|installed)/.test(status.trim()))) continue;
    if (name === 'gpg-pubkey') continue;
    const n = Number(size);
    out.push({ name, version, section: section && section !== '(none)' && section !== 'Unspecified' ? section : null, size: Number.isFinite(n) && n > 0 ? n * sizeUnit : null, summary: summary.join('\t') });
  }
  return out;
}

const UNITS: Record<string, number> = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 };

/** `pacman -Qi` blocks. */
export function parsePacmanQi(stdout: string): Array<{ name: string; version: string; summary: string; groups: string[]; size: number | null; manual: boolean }> {
  return stdout
    .split(/\n\s*\n/)
    .map((block) => {
      const f = (k: string) => block.match(new RegExp(`^${k}\\s*:\\s*(.*)$`, 'm'))?.[1]?.trim() ?? '';
      const size = f('Installed Size').match(/^([\d.]+)\s*(\w+)/);
      const groups = f('Groups');
      return {
        name: f('Name'),
        version: f('Version'),
        summary: f('Description'),
        groups: groups && groups !== 'None' ? groups.split(/\s+/) : [],
        size: size ? Math.round(Number(size[1]) * (UNITS[size[2]] ?? 1)) : null,
        manual: /Explicitly/.test(f('Install Reason')),
      };
    })
    .filter((p) => p.name);
}

// ---------------------------------------------------------------------------
// Host queries
// ---------------------------------------------------------------------------

type Exec = (cmd: string, args: string[], timeoutMs?: number) => Promise<CommandResult>;
const exec: Exec = (cmd, args, timeoutMs = 60_000) => runCommand(cmd, args, { timeoutMs });

function onPath(bin: string): boolean {
  for (const dir of (process.env.PATH ?? '/usr/bin:/bin').split(':')) {
    try {
      fs.accessSync(path.join(dir, bin), fs.constants.X_OK);
      return true;
    } catch {
      // keep looking
    }
  }
  return false;
}

let detected: { manager: PackageManager | null; distro: string | null } | null = null;
export function detectManager(): { manager: PackageManager | null; distro: string | null } {
  if (detected) return detected;
  let distro: string | null = null;
  try {
    distro = fs.readFileSync('/etc/os-release', 'utf8').match(/^PRETTY_NAME="?([^"\n]*)"?/m)?.[1] ?? null;
  } catch {
    // not Linux, or minimal image
  }
  const manager: PackageManager | null =
    process.platform !== 'linux' ? null : onPath('apt-get') && onPath('dpkg-query') ? 'apt' : onPath('dnf') ? 'dnf' : onPath('pacman') ? 'pacman' : null;
  detected = { manager, distro };
  return detected;
}

function requireManager(): PackageManager {
  const { manager } = detectManager();
  if (!manager) throw new HttpError(409, process.platform !== 'linux' ? 'Software management is only available on Linux hosts' : 'No supported package manager (apt, dnf or pacman) was found');
  return manager;
}

let installedCache: { at: number; items: PackageItem[] } | null = null;

export async function installedPackages(force = false): Promise<PackageItem[]> {
  if (!force && installedCache && Date.now() - installedCache.at < 60_000) return installedCache.items;
  const manager = requireManager();
  let items: PackageItem[] = [];
  if (manager === 'apt') {
    const [q, manual] = await Promise.all([
      exec('dpkg-query', ['-W', '-f=${Package}\t${Version}\t${Section}\t${Installed-Size}\t${db:Status-Abbrev}\t${binary:Summary}\n']),
      exec('apt-mark', ['showmanual']),
    ]);
    const manualSet = manual.code === 0 ? new Set(manual.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) : null;
    items = parseInstalledTsv(q.stdout, 1024).map((p) => ({ name: p.name, version: p.version, summary: p.summary, size: p.size, category: categorize(p.name, p.section), installed: true, manual: manualSet ? manualSet.has(p.name) : null }));
  } else if (manager === 'dnf') {
    const [q, user] = await Promise.all([
      exec('rpm', ['-qa', '--qf', '%{NAME}\t%{VERSION}-%{RELEASE}\t%{GROUP}\t%{SIZE}\tinstalled\t%{SUMMARY}\n']),
      exec('dnf', ['-q', '-C', 'repoquery', '--userinstalled', '--qf', '%{name}\n'], 90_000),
    ]);
    const userSet = user.code === 0 && user.stdout.trim() ? new Set(user.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) : null;
    items = parseInstalledTsv(q.stdout, 1).map((p) => ({ name: p.name, version: p.version, summary: p.summary, size: p.size, category: categorize(p.name, null), installed: true, manual: userSet ? userSet.has(p.name) : null }));
  } else {
    const q = await exec('pacman', ['-Qi']);
    items = parsePacmanQi(q.stdout).map((p) => ({ name: p.name, version: p.version, summary: p.summary, size: p.size, category: categorize(p.name, null, p.groups), installed: true, manual: p.manual }));
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  installedCache = { at: Date.now(), items };
  return items;
}

async function installedVersions(): Promise<Map<string, string>> {
  return new Map((await installedPackages()).map((p) => [p.name, p.version ?? '']));
}

let updatesCache: { at: string; updates: UpdateItem[]; error: string | null } | null = null;

/** Pending updates from the package manager's current metadata (refresh it first with a job). */
export async function listUpdates(force = false): Promise<{ checkedAt: string; updates: UpdateItem[]; error: string | null; individual: boolean }> {
  const manager = requireManager();
  const individual = manager !== 'pacman';
  if (!force && updatesCache) return { ...updatesCache, checkedAt: updatesCache.at, individual };
  let updates: UpdateItem[] = [];
  let error: string | null = null;
  if (manager === 'apt') {
    const r = await exec('apt', ['list', '--upgradable']);
    if (r.code !== 0) error = r.stderr.trim().split('\n').pop() ?? 'apt failed';
    updates = parseAptUpgradable(r.stdout);
  } else if (manager === 'dnf') {
    const r = await exec('dnf', ['-q', 'check-update'], 180_000);
    if (r.code !== 0 && r.code !== 100) error = (r.stderr.trim().split('\n').pop() ?? '') || `dnf check-update failed (exit ${r.code})`;
    updates = parseDnfCheckUpdate(r.stdout);
    if (updates.length) {
      const sec = await exec('dnf', ['-q', 'updateinfo', 'list', '--security', '--available'], 120_000);
      if (sec.code === 0) markDnfSecurity(updates, sec.stdout);
    }
    const versions = await installedVersions();
    for (const u of updates) u.current = versions.get(u.name) ?? null;
  } else {
    // checkupdates (pacman-contrib) syncs into a temporary database and needs no root.
    const r = onPath('checkupdates') ? await exec('checkupdates', [], 180_000) : await exec('pacman', ['-Qu']);
    // checkupdates exits 2 when there is nothing to update.
    if (r.code !== 0 && r.code !== 2 && !(r.code === 1 && !r.stdout.trim())) error = r.stderr.trim().split('\n').pop() || `exit ${r.code}`;
    updates = parsePacmanUpdates(r.stdout);
  }
  updates.sort((a, b) => Number(b.security) - Number(a.security) || a.name.localeCompare(b.name));
  updatesCache = { at: new Date().toISOString(), updates, error };
  return { ...updatesCache, checkedAt: updatesCache.at, individual };
}

/** Whether a reboot is needed to finish applying updates (new kernel, core libraries). */
export async function rebootRequired(): Promise<{ required: boolean | null; packages: string[] }> {
  const manager = detectManager().manager;
  if (manager === 'apt' && fs.existsSync('/run/reboot-required')) {
    let packages: string[] = [];
    try {
      packages = fs.readFileSync('/run/reboot-required.pkgs', 'utf8').split('\n').filter(Boolean);
    } catch {
      // the list is optional
    }
    return { required: true, packages: [...new Set(packages)] };
  }
  if (manager === 'dnf') {
    const r = await exec('dnf', ['-q', 'needs-restarting', '-r'], 60_000);
    if (r.code === 1) return { required: true, packages: [] };
    if (r.code === 0) return { required: false, packages: [] };
  }
  // Running kernel's modules were removed by an upgrade: the next boot uses a newer kernel.
  if (process.platform === 'linux') {
    const release = os.release();
    if (!fs.existsSync(`/usr/lib/modules/${release}`) && !fs.existsSync(`/lib/modules/${release}`)) return { required: true, packages: ['linux'] };
    // dnf without needs-restarting can still need a reboot for core libraries we can't see.
    return { required: manager === 'dnf' ? null : false, packages: [] };
  }
  return { required: null, packages: [] };
}

export async function autoUpdatesStatus(): Promise<{ supported: boolean; installed: boolean; enabled: boolean; packageName: string | null }> {
  const manager = detectManager().manager;
  if (manager === 'apt') {
    const installed = fs.existsSync('/usr/bin/unattended-upgrade');
    let enabled = false;
    try {
      enabled = /APT::Periodic::Unattended-Upgrade\s+"1"/.test(fs.readFileSync(APT_AUTO_UPGRADES_FILE, 'utf8'));
    } catch {
      // not configured
    }
    return { supported: true, installed, enabled: installed && enabled, packageName: 'unattended-upgrades' };
  }
  if (manager === 'dnf') {
    const r = await exec('systemctl', ['is-enabled', DNF_AUTOMATIC_TIMER], 10_000);
    const state = r.stdout.trim();
    const installed = r.code === 0 || (state !== '' && !/not-found|No such file/i.test(state + r.stderr));
    return { supported: true, installed, enabled: state === 'enabled', packageName: 'dnf-automatic' };
  }
  return { supported: false, installed: false, enabled: false, packageName: null };
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function rank(name: string, words: string[]): number {
  const q = words.join(' ').toLowerCase();
  const n = name.toLowerCase();
  if (n === q) return 0;
  if (CATALOG_BY_PKG.has(name) && n.includes(words[0].toLowerCase())) return 1;
  if (n.startsWith(q)) return 2;
  if (words.every((w) => n.includes(w.toLowerCase()))) return 3;
  return 4;
}

export async function searchPackages(query: unknown): Promise<{ results: PackageItem[]; truncated: boolean }> {
  const manager = requireManager();
  const words = typeof query === 'string' ? query.trim().split(/\s+/).filter(Boolean).slice(0, 5) : [];
  if (!words.length) return { results: [], truncated: false };
  if (words.some((w) => w.length > 64 || w.startsWith('-'))) throw new HttpError(400, 'Search terms may not start with "-" and must be short');
  const installed = await installedVersions();
  const LIMIT = 150;
  let results: PackageItem[] = [];
  let truncated = false;
  if (manager === 'apt') {
    const r = await exec('apt-cache', ['search', '--', ...words.map(escapeRegex)]);
    let found = parseAptSearch(r.stdout).sort((a, b) => rank(a.name, words) - rank(b.name, words) || a.name.localeCompare(b.name));
    truncated = found.length > LIMIT;
    found = found.slice(0, LIMIT);
    const show = found.length ? parseAptShow((await exec('apt-cache', ['show', '--no-all-versions', '--', ...found.map((f) => f.name)])).stdout) : new Map();
    results = found.map((f) => {
      const s = show.get(f.name);
      return { name: f.name, summary: s?.summary || f.summary, version: s?.version ?? null, size: s?.size ?? null, category: categorize(f.name, s?.section), installed: installed.has(f.name) };
    });
  } else if (manager === 'dnf') {
    const r = await exec('dnf', ['-q', 'search', '--', ...words], 180_000);
    if (r.code !== 0 && !r.stdout.trim() && !/No matches/i.test(r.stderr)) throw new HttpError(502, `dnf search failed: ${r.stderr.trim().split('\n').pop()}`);
    let found = parseDnfSearch(r.stdout).sort((a, b) => rank(a.name, words) - rank(b.name, words) || a.name.localeCompare(b.name));
    truncated = found.length > LIMIT;
    found = found.slice(0, LIMIT);
    results = found.map((f) => ({ name: f.name, summary: f.summary, version: installed.get(f.name) ?? null, category: categorize(f.name, null), installed: installed.has(f.name) }));
  } else {
    const r = await exec('pacman', ['-Ss', '--', ...words.map(escapeRegex)]);
    let found = parsePacmanSearch(r.stdout).sort((a, b) => rank(a.name, words) - rank(b.name, words) || a.name.localeCompare(b.name));
    truncated = found.length > LIMIT;
    found = found.slice(0, LIMIT);
    results = found.map((f) => ({ name: f.name, summary: f.summary, version: f.version, repo: f.repo, category: categorize(f.name, null, f.groups), installed: f.installed || installed.has(f.name) }));
  }
  return { results, truncated };
}

export async function catalog(): Promise<{ categories: typeof CATEGORIES; apps: Array<{ id: string; label: string; summary: string; category: Category; package: string | null; installed: boolean }> }> {
  const manager = detectManager().manager;
  const installed = manager ? await installedVersions() : new Map<string, string>();
  return {
    categories: CATEGORIES,
    apps: CATALOG.map((a) => {
      const pkg = manager ? a.pkgs[manager] ?? null : null;
      return { id: a.id, label: a.label, summary: a.summary, category: a.category, package: pkg, installed: !!pkg && installed.has(pkg) };
    }),
  };
}

// ---------------------------------------------------------------------------
// Transactions (one at a time: package managers hold a global lock)
// ---------------------------------------------------------------------------

export interface PackageJob {
  id: string;
  verb: PackageVerb;
  packages: string[];
  state: 'running' | 'succeeded' | 'failed';
  output: string;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  startedBy: string;
}

const MAX_OUTPUT = 512 * 1024;
let currentJob: PackageJob | null = null;

export function getJob(): PackageJob | null {
  return currentJob;
}

export type PrivilegedRunner = (args: { manager: PackageManager; verb: PackageVerb; packages: string[]; preview?: boolean }, onProgress?: (chunk: string) => void) => Promise<{ code: number | null; output: string }>;

export function validateTransaction(verb: unknown, packages: unknown): { manager: PackageManager; verb: PackageVerb; packages: string[] } {
  const manager = requireManager();
  const verbs: PackageVerb[] = ['refresh', 'install', 'remove', 'upgrade', 'upgrade-all'];
  if (!verbs.includes(verb as PackageVerb)) throw new HttpError(400, 'Unknown package operation');
  const v = verb as PackageVerb;
  if (v === 'upgrade' && manager === 'pacman') throw new HttpError(400, 'Arch Linux doesn’t support upgrading individual packages — upgrade everything instead');
  let pkgs: string[];
  try {
    pkgs = v === 'refresh' || v === 'upgrade-all' ? [] : assertPackages(packages, true);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  return { manager, verb: v, packages: pkgs };
}

/** Starts a transaction in the background; poll getJob() for output. */
export function startJob(run: PrivilegedRunner, request: { manager: PackageManager; verb: PackageVerb; packages: string[] }, startedBy: string, onDone?: (job: PackageJob) => void): PackageJob {
  if (currentJob?.state === 'running') throw new HttpError(409, 'Another package operation is still running');
  const job: PackageJob = {
    id: crypto.randomUUID(),
    verb: request.verb,
    packages: request.packages,
    state: 'running',
    output: '',
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    startedBy,
  };
  currentJob = job;
  const append = (chunk: string) => {
    job.output += chunk;
    if (job.output.length > MAX_OUTPUT) job.output = `…\n${job.output.slice(-MAX_OUTPUT)}`;
  };
  run(request, append).then(
    () => {
      job.state = 'succeeded';
    },
    (err: unknown) => {
      job.state = 'failed';
      job.error = err instanceof Error ? err.message : 'Failed';
      append(`\n${job.error}\n`);
    }
  ).finally(() => {
    job.finishedAt = new Date().toISOString();
    installedCache = null;
    updatesCache = null;
    onDone?.(job);
  });
  return job;
}

/** For tests. */
export function __resetPackageState() {
  currentJob = null;
  installedCache = null;
  updatesCache = null;
  detected = null;
}
