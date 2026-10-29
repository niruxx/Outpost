import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HttpError } from '../utils/asyncHandler.js';

export type LinuxFamily = 'debian' | 'fedora' | 'arch' | 'other';
export function linuxFamily(release: string): LinuxFamily {
  const value = (key: string) => release.match(new RegExp(`^${key}=["']?([^"'\\n]+)`, 'm'))?.[1]?.trim() ?? '';
  const ids = `${value('ID')} ${value('ID_LIKE')}`.split(/\s+/);
  if (ids.some(id => ['debian', 'ubuntu', 'linuxmint'].includes(id))) return 'debian';
  if (ids.some(id => ['fedora', 'rhel', 'centos', 'rocky', 'almalinux'].includes(id))) return 'fedora';
  if (ids.some(id => ['arch', 'manjaro', 'endeavouros'].includes(id))) return 'arch';
  return 'other';
}
export function hostFamily() { try { return process.platform === 'linux' ? linuxFamily(fs.readFileSync('/etc/os-release', 'utf8')) : 'other'; } catch { return 'other'; } }
export interface HostCommand { file: string; args: string[] }
export type HostRunner = (command: HostCommand, privileged?: boolean) => Promise<string>;
export const runHostCommand: HostRunner = (command, privileged = false) => new Promise((resolve, reject) => {
  const useSudo = privileged && process.platform !== 'win32' && process.getuid?.() !== 0;
  const child = execFile(useSudo ? '/usr/bin/sudo' : command.file, useSudo ? ['-n', '--', command.file, ...command.args] : command.args, { cwd: PROJECT_ROOT, timeout: 20 * 60_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, env: { ...process.env, LC_ALL: 'C', LANG: 'C', DEBIAN_FRONTEND: 'noninteractive' } }, (error, stdout, stderr) => {
    if (error) reject(new HttpError(503, `${useSudo ? 'The service account needs noninteractive sudo permission for the displayed command. ' : ''}${(stderr || error.message).slice(-3000)}`));
    else resolve(`${stdout}${stderr}`.trim());
  });
  child.stdin?.end();
});
function alternatives(family: LinuxFamily) { return family === 'debian' ? '/usr/bin/update-alternatives' : fs.existsSync('/usr/sbin/alternatives') ? '/usr/sbin/alternatives' : '/usr/bin/alternatives'; }
export function parseJavaChoices(family: LinuxFamily, output: string) {
  if (family === 'arch') return output.split(/\r?\n/).map(s => s.trim().replace(/\s+\(default\)$/, '')).filter(s => /^[a-zA-Z0-9_][\w.+-]*(?:\/jre)?$/.test(s) && !['Available', 'None'].includes(s));
  return [...new Set(output.split(/\r?\n/).map(line => family === 'debian' ? line.trim() : line.match(/^\s*(\/\S+\/bin\/java)\s+-\s+/)?.[1] ?? '').filter(s => /^\/[^\x00-\x1f]*\/bin\/java$/.test(s)))];
}
export async function systemJava(family = hostFamily(), run: HostRunner = runHostCommand) {
  if (family === 'other') return { supported: false, family, choices: [] as string[], current: '', error: 'System defaults are supported on Debian, Fedora and Arch families on Linux.' };
  try {
    const file = family === 'arch' ? '/usr/bin/archlinux-java' : alternatives(family);
    const text = await run({ file, args: family === 'arch' ? ['status'] : family === 'debian' ? ['--list', 'java'] : ['--display', 'java'] });
    const choices = parseJavaChoices(family, text);
    let current = '';
    try { current = family === 'arch' ? (await run({ file, args: ['get'] })).trim() : fs.realpathSync('/usr/bin/java'); } catch { /* no default yet */ }
    return { supported: true, family, choices, current, error: null };
  } catch (error) { return { supported: true, family, choices: [] as string[], current: '', error: error instanceof Error ? error.message : 'Unable to inspect system Java alternatives' }; }
}
export async function setSystemJava(choice: unknown, family = hostFamily(), run: HostRunner = runHostCommand) {
  const state = await systemJava(family, run);
  if (!state.supported || typeof choice !== 'string' || !state.choices.includes(choice)) throw new HttpError(400, 'Choose one of the currently registered system Java environments');
  const command = family === 'arch' ? { file: '/usr/bin/archlinux-java', args: ['set', choice] } : { file: alternatives(family), args: ['--set', 'java', choice] };
  await run(command, true); return command;
}
export function terminalBuildCommands(family: LinuxFamily): HostCommand[] {
  if (family === 'debian') return [{ file: '/usr/bin/apt-get', args: ['install', '-y', 'python3', 'make', 'g++', 'build-essential'] }];
  if (family === 'fedora') return [{ file: '/usr/bin/dnf', args: ['install', '-y', 'python3', 'make', 'gcc', 'gcc-c++'] }];
  if (family === 'arch') return [{ file: '/usr/bin/pacman', args: ['-S', '--needed', '--noconfirm', 'python', 'base-devel'] }];
  return [];
}
export const PROJECT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export function npmCommand(args: string[]): HostCommand {
  const candidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), '/usr/share/nodejs/npm/bin/npm-cli.js', '/usr/lib/node_modules/npm/bin/npm-cli.js', '/usr/local/lib/node_modules/npm/bin/npm-cli.js'].filter(Boolean) as string[];
  const cli = candidates.find(p => path.basename(p) === 'npm-cli.js' && fs.existsSync(p));
  if (!cli) throw new HttpError(503, 'npm is not installed alongside this Node runtime. Install npm for the Outpost service account first.');
  return { file: process.execPath, args: [cli, ...args] };
}
export function terminalRepairPlan(platform = process.platform, family = hostFamily()) {
  return {
    platform, family, projectRoot: PROJECT_ROOT,
    requirements: platform === 'win32' ? ['Node.js matching the running Outpost service', 'node-pty optional dependency with a matching prebuilt ConPTY backend', 'If a native build is needed: Python 3, Visual Studio 2022 Build Tools with Desktop C++, Windows SDK and matching Spectre libraries', 'Windows 10 version 1809 or newer'] : platform === 'darwin' ? ['node-pty optional dependency', 'Xcode command-line tools (xcode-select --install)', 'Python 3 and a C++ compiler'] : ['node-pty optional dependency built for the current Node.js version', 'Python 3, make and a C/C++ build toolchain', 'Existing sudo permission is needed only when installing OS packages or opening root/user shells'],
    systemCommands: platform === 'linux' ? terminalBuildCommands(family) : [],
    repairCommands: ['npm install --workspace=server --include=optional --ignore-scripts --no-audit --no-fund', 'npm rebuild node-pty --foreground-scripts --ignore-scripts=false'],
    canInstallSystemTools: platform === 'linux' && family !== 'other',
    notes: platform === 'win32' ? 'The repair first restores the packaged native backend. If no matching prebuild is available, install the listed compiler tools, restart the service to refresh its environment, then retry.' : 'OS package installation needs root or existing passwordless sudo for the exact command. Package-manager repository/network access and write access to the Outpost installation are required. This does not change sudo policy or install a host shell service.',
  };
}
export async function probeTerminalBackend(): Promise<{ available: boolean; error: string | null }> {
  return new Promise(resolve => {
    execFile(process.execPath, ['-e', "try { require('node:module').createRequire(process.argv[1])('node-pty'); process.stdout.write('ready'); } catch (e) { console.error(e.message); process.exitCode=1; }", path.join(PROJECT_ROOT, 'server', 'package.json')], { cwd: PROJECT_ROOT, timeout: 15_000, windowsHide: true, maxBuffer: 16000 }, (error, stdout, stderr) => resolve({ available: !error && stdout === 'ready', error: error || stdout !== 'ready' ? `The native node-pty backend is unavailable: ${(stderr || error?.message || 'Unexpected native backend response').trim().slice(0, 1500)}` : null }));
  });
}
export interface RepairJob { state: 'running' | 'done' | 'failed'; stage: string; output: string; error: string | null; startedAt: number }
let repair: RepairJob | null = null;
export function terminalRepairJob() { return repair; }
export function startTerminalRepair(installSystemTools: unknown, run: HostRunner = runHostCommand, probe = probeTerminalBackend) {
  if (typeof installSystemTools !== 'boolean') throw new HttpError(400, 'installSystemTools must be boolean');
  if (repair?.state === 'running') throw new HttpError(409, 'Dependency repair is already running');
  const plan = terminalRepairPlan();
  if (installSystemTools && !plan.canInstallSystemTools) throw new HttpError(400, 'OS build-tool installation is not automated on this platform; use the shown instructions');
  const job: RepairJob = { state: 'running', stage: 'Preparing', output: '', error: null, startedAt: Date.now() }; repair = job;
  void (async () => {
    const previousCwd = PROJECT_ROOT;
    // Each child has an explicit working directory; never change the panel process's cwd.
    const execute = async (command: HostCommand, privileged = false) => {
      job.stage = `${path.basename(command.file)} ${command.args.join(' ')}`;
      const result = await run(command, privileged); job.output = `${job.output}\n${result}`.slice(-12000);
    };
    if (installSystemTools) for (const command of plan.systemCommands) await execute(command, true);
    await execute(npmCommand(['install', '--workspace=server', '--include=optional', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', previousCwd]));
    await execute(npmCommand(['rebuild', 'node-pty', '--foreground-scripts', '--ignore-scripts=false', '--prefix', previousCwd]));
    job.stage = 'Checking native backend';
    const status = await probe(); if (!status.available) throw new Error(status.error ?? 'Native backend still unavailable');
    job.state = 'done'; job.stage = 'Terminal backend ready';
  })().catch(error => { job.state = 'failed'; job.error = error instanceof Error ? error.message : 'Dependency installation failed'; });
  return job;
}
