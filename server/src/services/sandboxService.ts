import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { instanceDir, STEAMCMD_DIR } from '../utils/paths.js';
import { getSetting, setSetting } from './systemSettingsService.js';
import type { ServerRecord } from '../types/index.js';

/**
 * Keeps game processes inside their instance folder.
 *
 * 1. A minimal environment — never the panel's own (which may carry MULTICRAFT_* secrets).
 * 2. On Linux, a bubblewrap sandbox: the instance folder is the only writable place, system
 *    directories are read-only, /tmp is private, and everything else (home folders, other
 *    instances, the panel's database and session secret) simply doesn't exist inside it.
 *    The network stays shared — game servers need it.
 */

export const SETTING_SANDBOX = 'sandbox_mode'; // 'on' | 'off' (unset = on)

export interface SandboxStatus {
  available: boolean;
  version: string | null;
  /** Why it isn't available (not Linux, bwrap missing, user namespaces blocked…). */
  reason: string | null;
  /** Global switch (admin). Per-instance opt-out exists for admins too. */
  enabled: boolean;
}

let probed: { available: boolean; version: string | null; reason: string | null } | null = null;

function probe() {
  if (probed) return probed;
  if (process.platform !== 'linux') {
    probed = { available: false, version: null, reason: 'Sandboxing uses bubblewrap, which is Linux-only.' };
    return probed;
  }
  const version = spawnSync('bwrap', ['--version'], { encoding: 'utf8' });
  if (version.error || version.status !== 0) {
    probed = {
      available: false,
      version: null,
      reason: 'bubblewrap (bwrap) isn\'t installed. Install it — e.g. `sudo apt install bubblewrap`, `sudo dnf install bubblewrap`, `sudo pacman -S bubblewrap` — then restart the panel.',
    };
    return probed;
  }
  // bwrap can be installed yet unusable when unprivileged user namespaces are disabled.
  const trial = spawnSync('bwrap', ['--ro-bind', '/', '/', '--unshare-ipc', 'true'], { encoding: 'utf8' });
  probed =
    trial.status === 0
      ? { available: true, version: version.stdout.trim(), reason: null }
      : {
          available: false,
          version: version.stdout.trim(),
          reason: `bubblewrap is installed but can't create a sandbox here (${(trial.stderr || '').trim() || 'user namespaces may be disabled'}).`,
        };
  return probed;
}

export function getSandboxStatus(): SandboxStatus {
  const p = probe();
  return { ...p, enabled: getSetting(SETTING_SANDBOX) !== 'off' };
}

export function setSandboxEnabled(enabled: boolean) {
  setSetting(SETTING_SANDBOX, enabled ? 'on' : 'off');
}

/** Whether this instance's processes run sandboxed right now. */
export function sandboxApplies(server: ServerRecord): boolean {
  if (server.platform === 'docker') return false; // containers isolate themselves
  if (server.isolation === 'off') return false;
  const status = getSandboxStatus();
  return status.available && status.enabled;
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const POSIX_KEEP = /^(PATH|LANG|LANGUAGE|LC_[A-Z_]+|TZ|TERM|USER|LOGNAME|HOME|SHELL|TMPDIR|JAVA_HOME|DISPLAY)$/;
const WINDOWS_KEEP = new Set(
  [
    'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
    'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES', 'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE', 'OS', 'USERNAME', 'HOMEDRIVE', 'HOMEPATH', 'JAVA_HOME', 'TZ',
  ]
);

/** The panel's environment reduced to what programs commonly need — no MULTICRAFT_* secrets,
 *  no tokens or credentials someone happened to export in the panel's shell or service unit. */
export function minimalEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const keep = process.platform === 'win32' ? WINDOWS_KEEP.has(key.toUpperCase()) : POSIX_KEEP.test(key);
    if (keep) out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// bubblewrap command line
// ---------------------------------------------------------------------------

/** Host paths exposed read-only. On merged-/usr systems /bin, /lib… are symlinks and are
 *  recreated as symlinks instead of bound. */
const SYSTEM_DIRS = ['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32', '/etc', '/opt', '/nix', '/snap'];
const RUN_DIRS = ['/run/systemd/resolve', '/run/NetworkManager']; // where resolv.conf often points

function underAny(p: string, roots: string[]) {
  return roots.some((r) => p === r || p.startsWith(r + '/'));
}

/** Home directory for sandboxed processes: inside the instance, so games that write ~/.config
 *  or ~/.steam keep their files with the instance. */
export function sandboxHome(server: ServerRecord): string {
  return path.join(instanceDir(server.id), '.home');
}

/** Where steamcmd keeps its own steamclient.so (Outpost's copy, then the usual system installs). */
function steamcmdClientLibs(lib: 'linux64' | 'linux32'): string[] {
  const realHome = process.env.HOME ?? '';
  return [
    path.join(STEAMCMD_DIR, lib, 'steamclient.so'),
    ...(realHome
      ? [
          path.join(realHome, '.steam', lib === 'linux64' ? 'sdk64' : 'sdk32', 'steamclient.so'),
          path.join(realHome, '.local', 'share', 'Steam', 'steamcmd', lib, 'steamclient.so'),
          path.join(realHome, '.steam', 'steamcmd', lib, 'steamclient.so'),
        ]
      : []),
  ];
}

/**
 * Steam dedicated servers load ~/.steam/sdk64/steamclient.so. Outside the sandbox steamcmd created
 * that in the real home; inside, home is the instance's own .home. Use the copy the game ships in its
 * linux64/ (linux32/) folder when it has one (as LinuxGSM does, linked); otherwise — CS2, for one,
 * doesn't ship it — copy steamcmd's, since the sandbox can't see steamcmd's folder. The copy is
 * refreshed when steamcmd updates.
 */
export function linkSteamClient(dir: string, home: string) {
  for (const [sdk, lib] of [
    ['sdk64', 'linux64'],
    ['sdk32', 'linux32'],
  ] as const) {
    const target = path.join(home, '.steam', sdk, 'steamclient.so');
    try {
      // A link left dangling (game folder moved, file removed) blocks a fresh one.
      const lst = fs.lstatSync(target, { throwIfNoEntry: false });
      if (lst?.isSymbolicLink() && !fs.existsSync(target)) fs.rmSync(target, { force: true });

      const shipped = path.join(dir, lib, 'steamclient.so');
      if (fs.existsSync(shipped)) {
        if (fs.existsSync(target)) continue;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.symlinkSync(path.relative(path.dirname(target), shipped), target);
        continue;
      }
      const fromSteamcmd = steamcmdClientLibs(lib).find((p) => fs.existsSync(p));
      if (!fromSteamcmd) continue;
      const src = fs.statSync(fromSteamcmd);
      const cur = fs.statSync(target, { throwIfNoEntry: false });
      if (cur && cur.size === src.size && cur.mtimeMs >= src.mtimeMs) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.rmSync(target, { force: true });
      fs.copyFileSync(fs.realpathSync(fromSteamcmd), target);
    } catch {
      // best effort; the game logs its own error if it really needs it
    }
  }
}

export function wrapInSandbox(
  server: ServerRecord,
  plan: { cmd: string; args: string[]; cwd: string; env: Record<string, string> }
): { cmd: string; args: string[] } {
  const dir = instanceDir(server.id);
  const home = sandboxHome(server);
  fs.mkdirSync(home, { recursive: true });
  if (server.platform === 'steam') linkSteamClient(dir, home);

  const args: string[] = ['--info-fd', '3', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try', '--hostname', 'outpost'];
  for (const d of SYSTEM_DIRS) {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(d);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) args.push('--symlink', fs.readlinkSync(d), d);
    else args.push('--ro-bind', d, d);
  }
  for (const d of RUN_DIRS) args.push('--ro-bind-try', d, d);
  args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/var', '--tmpfs', '/var/tmp');

  // A program living outside the system dirs (an admin-chosen absolute executable, or a JDK in
  // someone's home folder) gets its install folder mounted read-only so it can still run.
  const bound = [...SYSTEM_DIRS, dir];
  if (path.isAbsolute(plan.cmd)) {
    let real = plan.cmd;
    try {
      real = fs.realpathSync(plan.cmd);
    } catch {
      // reported when it fails to start
    }
    if (!underAny(real, bound)) {
      const root = path.basename(path.dirname(real)) === 'bin' ? path.dirname(path.dirname(real)) : path.dirname(real);
      args.push('--ro-bind', root, root);
    }
  }
  if (plan.env.JAVA_HOME && !underAny(plan.env.JAVA_HOME, bound)) args.push('--ro-bind-try', plan.env.JAVA_HOME, plan.env.JAVA_HOME);

  // The sandbox root is a scratch tmpfs (bwrap creates /home/<you>/… there to reach the instance
  // path). Make it read-only so the only writable places are the instance folder and /tmp, /var/tmp.
  // Bind first (bwrap must create the mount-point folders), then freeze the root; the bind is its
  // own mount and stays writable.
  args.push('--bind', dir, dir);
  args.push('--remount-ro', '/');
  args.push('--setenv', 'HOME', home, '--chdir', plan.cwd);
  // Java ignores $HOME and takes user.home from /etc/passwd — the real home path, which in here is an
  // empty read-only placeholder. JAVA_TOOL_OPTIONS reaches every JVM, including ones a game's own
  // launcher embeds (Project Zomboid), so ~ means the instance's .home for Java too.
  const userHome = /\s/.test(home) ? `"-Duser.home=${home}"` : `-Duser.home=${home}`;
  args.push('--setenv', 'JAVA_TOOL_OPTIONS', [plan.env.JAVA_TOOL_OPTIONS, userHome].filter(Boolean).join(' '));
  // Running the panel as root is discouraged; if it happens, at least drop every capability.
  if (process.getuid?.() === 0) args.push('--cap-drop', 'ALL');
  args.push('--', plan.cmd, ...plan.args);
  return { cmd: 'bwrap', args };
}
