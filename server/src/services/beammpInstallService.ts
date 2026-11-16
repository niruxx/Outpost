import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { downloadFile, fetchJson, type LogFn } from '../utils/download.js';
import { instanceDir, safeJoinReal } from '../utils/paths.js';
import { launchConfigOf, launchEnv } from './launchConfig.js';
import { isManagedBeamMP, normalizeBeamMPLaunch } from './beammpService.js';
import { installEarth } from './beamngEarthService.js';
import type { ServerRecord } from '../types/index.js';

const exec = promisify(execFile);
const RELEASE_API = 'https://api.github.com/repos/BeamMP/BeamMP-Server/releases/latest';
export interface BeamMPHost { platform: string; arch: string; osRelease?: string }
interface ReleaseAsset { name: string; browser_download_url: string; size: number; digest?: string | null }
interface Release { tag_name: string; assets: ReleaseAsset[] }
type Progress = (pct: number, message: string) => void;

/** Match the distro and CPU exactly; binaries for a newer libc must never be guessed. */
export function beammpAssetName(host: BeamMPHost): string {
  if (host.platform === 'win32' && host.arch === 'x64') return 'BeamMP-Server.exe';
  if (host.platform !== 'linux' || !['x64', 'arm64'].includes(host.arch)) {
    throw new Error(`Automatic BeamMP installation does not support ${host.platform}/${host.arch}. Use an official supported host.`);
  }
  const fields = Object.fromEntries((host.osRelease ?? '').split(/\r?\n/).map(line => {
    const i = line.indexOf('=');
    return [line.slice(0, i), line.slice(i + 1).replace(/^["']|["']$/g, '')];
  }));
  if (!['debian', 'ubuntu'].includes(fields.ID) || !/^\d+(?:\.\d+)?$/.test(fields.VERSION_ID ?? '')) {
    throw new Error('Automatic BeamMP installation needs an official Debian or Ubuntu build matching this host. This Linux distribution is not supported by the automatic installer.');
  }
  return `BeamMP-Server.${fields.ID}.${fields.VERSION_ID}.${host.arch === 'x64' ? 'x86_64' : 'arm64'}`;
}

function hostInfo(): BeamMPHost {
  return { platform: process.platform, arch: process.arch, osRelease: process.platform === 'linux' ? fs.readFileSync('/etc/os-release', 'utf8') : undefined };
}

async function missingRuntime(binary: string): Promise<string[]> {
  if (process.platform === 'win32') {
    const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    return ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll'].filter(file => !fs.existsSync(path.join(system, file)));
  }
  try {
    const { stdout } = await exec('ldd', [binary], { timeout: 15_000, windowsHide: true });
    return stdout.split('\n').filter(line => line.includes('not found')).map(line => line.trim().split(/\s+/)[0]);
  } catch (error) {
    throw new Error(`Could not check BeamMP runtime libraries: ${error instanceof Error ? error.message : error}`);
  }
}

async function prepareRuntime(binary: string, log: LogFn): Promise<void> {
  const missing = await missingRuntime(binary);
  if (!missing.length) return;
  log(`[Outpost] Preparing missing BeamMP runtime: ${missing.join(', ')}`);
  try {
    if (process.platform === 'win32') {
      const installer = safeJoinReal(path.dirname(binary), `.outpost-vc-redist-${crypto.randomUUID()}.exe`);
      try {
        await downloadFile('https://aka.ms/vs/17/release/vc_redist.x64.exe', installer, undefined, log);
        try {
          await exec(installer, ['/install', '/quiet', '/norestart'], { timeout: 300_000, windowsHide: true });
        } catch (error) {
          if (![3010, 1638].includes(Number((error as { code?: unknown }).code))) throw error;
        }
      } finally { fs.rmSync(installer, { force: true }); }
    } else {
      // Official Linux builds need Lua 5.3. Use existing noninteractive package permissions.
      // Other missing libraries need host-specific attention rather than guessing packages.
      if (missing.some(lib => !/^liblua5\.3\.so/.test(lib))) throw new Error(`Install the host libraries ${missing.join(', ')}`);
      const root = process.getuid?.() === 0;
      await exec(root ? '/usr/bin/apt-get' : 'sudo', root ? ['install', '-y', 'liblua5.3-0'] : ['-n', '/usr/bin/apt-get', 'install', '-y', 'liblua5.3-0'], { timeout: 180_000, windowsHide: true, env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' } });
    }
    const remaining = await missingRuntime(binary);
    if (remaining.length) throw new Error(`Still missing: ${remaining.join(', ')}`);
  } catch (error) {
    const help = process.platform === 'win32' ? 'Install the Microsoft Visual C++ 2015–2022 x64 Redistributable on the host' : 'Install liblua5.3-0 and any missing runtime libraries on the host';
    throw new Error(`${help}, then use Retry install. Automatic runtime setup needs existing administrator/package permissions. ${error instanceof Error ? error.message : error}`);
  }
}

/** Does not start a temporary unmanaged game process or overwrite existing configuration/mods. */
export async function installBeamMP(
  server: ServerRecord,
  progress: Progress,
  log: LogFn,
  runtime: (binary: string, log: LogFn) => Promise<void> = prepareRuntime,
  host: BeamMPHost = hostInfo(),
): Promise<{ executable: string; build: string; jarFile: null }> {
  if (!isManagedBeamMP(server)) throw new Error('This instance does not use the BeamMP installer');
  const launch = normalizeBeamMPLaunch(launchConfigOf(server));
  const executable = launch.executable!;
  if (path.isAbsolute(executable) || launch.workingDir || executable.includes('/') || executable.includes('\\')) {
    throw new Error('Automatic BeamMP installation requires the executable in the instance root and the default working directory');
  }
  const name = beammpAssetName(host);
  const expectedExecutable = host.platform === 'win32' ? 'BeamMP-Server.exe' : 'BeamMP-Server';
  if (executable !== expectedExecutable) throw new Error(`This host requires ${expectedExecutable}`);
  progress(5, 'Finding the official BeamMP release');
  const release = await fetchJson<Release>(RELEASE_API, log);
  const asset = release.assets.find(asset => asset.name === name);
  if (!asset) throw new Error(`BeamMP ${release.tag_name} has no official ${name} build. This host is not supported by that release.`);
  const url = new URL(asset.browser_download_url);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !url.pathname.startsWith('/BeamMP/BeamMP-Server/releases/download/')) throw new Error('BeamMP release has an unexpected download URL');
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 128 * 1024 ** 2) throw new Error('BeamMP download size is invalid');
  const dir = instanceDir(server.id);
  const destination = safeJoinReal(dir, executable);
  const temporary = safeJoinReal(dir, `.outpost-beammp-${crypto.randomUUID()}.tmp`);
  let lastProgress = -1;
  try {
    await downloadFile(url.href, temporary, pct => {
      const current = 10 + Math.floor(pct * 0.65);
      if (current !== lastProgress) { lastProgress = current; progress(current, `Downloading BeamMP ${release.tag_name}`); }
    }, log);
    const bytes = fs.readFileSync(temporary);
    if (bytes.length !== asset.size) throw new Error('BeamMP download is incomplete (size mismatch)');
    const magic = host.platform === 'win32' ? Buffer.from('MZ') : Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
    if (!bytes.subarray(0, magic.length).equals(magic)) throw new Error('BeamMP download is not a native server executable');
    if (asset.digest) {
      if (asset.digest !== `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`) throw new Error('BeamMP download checksum mismatch');
    }
    if (host.platform !== 'win32') fs.chmodSync(temporary, 0o755);
    progress(80, 'Checking and preparing server runtime');
    await runtime(temporary, log);
    fs.renameSync(temporary, destination);
  } finally { fs.rmSync(temporary, { force: true }); }
  progress(90, 'Preparing configuration and mod folders');
  const env = launchEnv(server, launch);
  const resource = env.BEAMMP_RESOURCE_FOLDER || 'Resources';
  for (const folder of ['Client', 'Server']) fs.mkdirSync(safeJoinReal(dir, `${resource}/${folder}`), { recursive: true });
  const config = safeJoinReal(dir, 'ServerConfig.toml');
  if (!fs.existsSync(config)) {
    const text = `[General]\nPort = ${server.server_port}\nAuthKey = ${JSON.stringify(env.BEAMMP_AUTH_KEY)}\nPrivate = ${env.BEAMMP_PRIVATE}\nName = ${JSON.stringify(env.BEAMMP_NAME || server.name)}\nMap = ${JSON.stringify(env.BEAMMP_MAP)}\nMaxPlayers = ${env.BEAMMP_MAX_PLAYERS}\nMaxCars = 2\nResourceFolder = ${JSON.stringify(resource)}\nDescription = "Managed by Outpost"\nDebug = false\nLogChat = false\nAllowGuests = false\n`;
    fs.writeFileSync(config, text, { flag: 'wx', mode: 0o600 });
  }
  log(`[Outpost] BeamMP ${release.tag_name} prepared. Players use BeamMP Direct Connect with this host's address and port ${server.server_port}. Outside your LAN, allow TCP and UDP on that port.`);
  if (launch.beamngEarth) { progress(95, 'Installing BeamNG.Earth mod and server plugin'); await installEarth(server, log); }
  return { executable, build: release.tag_name, jarFile: null };
}
