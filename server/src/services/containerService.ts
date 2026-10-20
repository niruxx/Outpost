import fs from 'node:fs';
import { containerLimitArgs } from './limitsService.js';
import { envVar } from '../utils/env.js';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { HttpError } from '../utils/asyncHandler.js';
import { instanceDir, safeJoinReal } from '../utils/paths.js';
import { expandVariables, launchVariables, splitArgs } from './launchConfig.js';
import type { ServerRecord } from '../types/index.js';

/**
 * Docker-backed instances. Works with Docker or Podman (same CLI); Podman's rootless mode needs no
 * root daemon at all. The container only ever sees the instance folder, mounted at `dataPath`.
 */

export interface PortMapping {
  host: number;
  container: number;
  protocol: 'tcp' | 'udp';
}

export interface DockerConfig {
  image: string;
  ports: PortMapping[];
  env: { key: string; value: string }[];
  /** Where the instance folder is mounted inside the container. */
  dataPath: string;
  /** CPU limit (e.g. 2 = two cores); null = unlimited. */
  cpus: number | null;
  /** Overrides the image's command (optional). */
  command: string;
  /** Run as the panel's user so files in the instance folder stay editable from the panel. */
  runAsPanelUser: boolean;
  /** Extra mounts — always subfolders of the instance folder, so the container still sees nothing else. */
  volumes: { subdir: string; containerPath: string }[];
  /** For apps with a web interface: which published port to open, and how. */
  webUi: { port: number; scheme: 'http' | 'https'; path: string } | null;
  /** Mounts the container engine's API socket (Portainer and other container managers need it).
   *  This gives the container control over every container on the host — admin-only and explicit. */
  mountEngineSocket: boolean;
  /** UI metadata: what kind of thing this is and which icon to show. */
  category: 'game' | 'app' | 'container';
  icon: string | null;
  /** Catalog template it was created from, if any. */
  template: string | null;
}

export interface EngineStatus {
  available: boolean;
  engine: 'docker' | 'podman' | null;
  version: string | null;
  rootless: boolean;
  error: string | null;
  hint: string | null;
}

// ---------------------------------------------------------------------------
// Engine detection
// ---------------------------------------------------------------------------

let cached: { status: EngineStatus; at: number } | null = null;

function tryEngine(bin: 'docker' | 'podman'): EngineStatus | null {
  const res = spawnSync(bin, ['version', '--format', bin === 'docker' ? '{{.Server.Version}}' : '{{.Version}}'], { encoding: 'utf8', timeout: 8000 });
  if (res.error && (res.error as NodeJS.ErrnoException).code === 'ENOENT') return null;
  if (res.status === 0 && res.stdout.trim()) {
    let rootless = bin === 'podman';
    if (bin === 'docker') {
      const info = spawnSync('docker', ['info', '--format', '{{.SecurityOptions}}'], { encoding: 'utf8', timeout: 8000 });
      rootless = /rootless/.test(info.stdout ?? '');
    } else {
      const info = spawnSync('podman', ['info', '--format', '{{.Host.Security.Rootless}}'], { encoding: 'utf8', timeout: 8000 });
      rootless = (info.stdout ?? '').trim() !== 'false';
    }
    return { available: true, engine: bin, version: res.stdout.trim().split('\n')[0], rootless, error: null, hint: null };
  }
  const err = `${res.stderr ?? ''}${res.stdout ?? ''}`.trim();
  const permission = /permission denied/i.test(err);
  return {
    available: false,
    engine: bin,
    version: null,
    rootless: false,
    error: err.split('\n')[0] || `${bin} isn't responding`,
    hint: permission
      ? `The panel's user can't talk to the ${bin} daemon. Add it to the docker group (\`sudo usermod -aG docker <user>\`, then log out/in and restart the panel) — or use rootless Docker/Podman.`
      : bin === 'docker'
        ? 'Start the Docker service: `sudo systemctl enable --now docker`.'
        : null,
  };
}

export function getEngineStatus(force = false): EngineStatus {
  if (!force && cached && Date.now() - cached.at < 60_000) return cached.status;
  const pinned = envVar('CONTAINER_ENGINE') as 'docker' | 'podman' | undefined;
  const candidates: ('docker' | 'podman')[] = pinned === 'podman' || pinned === 'docker' ? [pinned] : ['docker', 'podman'];
  let status: EngineStatus | null = null;
  for (const bin of candidates) {
    const s = tryEngine(bin);
    if (s?.available) {
      status = s;
      break;
    }
    status ??= s;
  }
  status ??= {
    available: false,
    engine: null,
    version: null,
    rootless: false,
    error: 'Neither Docker nor Podman is installed.',
    hint: 'Install Podman (rootless, no daemon — e.g. `sudo apt install podman`, `sudo dnf install podman`, `sudo pacman -S podman`) or Docker Engine, then click Refresh.',
  };
  cached = { status, at: Date.now() };
  return status;
}

function requireEngine(): 'docker' | 'podman' {
  const s = getEngineStatus();
  if (!s.available || !s.engine) throw new HttpError(400, `${s.error ?? 'No container engine'}${s.hint ? ` — ${s.hint}` : ''}`);
  return s.engine;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const IMAGE_RE = /^[a-z0-9]+([._/:@-][a-zA-Z0-9_.-]+)*$/;
const portOk = (n: unknown) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 65535;

export function dockerConfigOf(server: Pick<ServerRecord, 'docker_config'>): DockerConfig | null {
  if (!server.docker_config) return null;
  try {
    return JSON.parse(server.docker_config) as DockerConfig;
  } catch {
    return null;
  }
}

export function sanitizeDockerConfig(input: unknown): DockerConfig {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'docker config must be an object');
  const raw = input as Record<string, any>;
  const image = typeof raw.image === 'string' ? raw.image.trim() : '';
  if (!image || image.length > 255 || !IMAGE_RE.test(image)) throw new HttpError(400, 'Enter a valid image name, e.g. itzg/minecraft-server:latest');
  const ports: PortMapping[] = (Array.isArray(raw.ports) ? raw.ports : []).slice(0, 32).map((p: any, i: number) => {
    const host = Number(p?.host);
    const container = Number(p?.container ?? p?.host);
    if (!portOk(host) || !portOk(container)) throw new HttpError(400, `Port mapping ${i + 1}: ports must be 1–65535`);
    return { host, container, protocol: p?.protocol === 'udp' ? 'udp' : 'tcp' };
  });
  if (!ports.length) throw new HttpError(400, 'Add at least one port mapping');
  const env = (Array.isArray(raw.env) ? raw.env : [])
    .filter((e: any) => e && typeof e.key === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(e.key.trim()))
    .slice(0, 100)
    .map((e: any) => ({ key: e.key.trim(), value: String(e.value ?? '').slice(0, 4000) }));
  const dataPath = typeof raw.dataPath === 'string' && raw.dataPath.trim().startsWith('/') ? raw.dataPath.trim() : '/data';
  if (dataPath === '/' || /[:,\s]/.test(dataPath)) throw new HttpError(400, 'Data path must be an absolute folder inside the container, e.g. /data');
  const cpus = raw.cpus === null || raw.cpus === '' || raw.cpus === undefined ? null : Number(raw.cpus);
  if (cpus !== null && (!Number.isFinite(cpus) || cpus <= 0 || cpus > 256)) throw new HttpError(400, 'CPU limit must be a positive number of cores');
  const volumes = (Array.isArray(raw.volumes) ? raw.volumes : []).slice(0, 10).map((v: any, i: number) => {
    const subdir = typeof v?.subdir === 'string' ? v.subdir.trim().replace(/^\/+|\/+$/g, '') : '';
    const containerPath = typeof v?.containerPath === 'string' ? v.containerPath.trim() : '';
    if (!subdir || path.isAbsolute(subdir) || subdir.split(/[\\/]/).some((p: string) => p === '..' || p === '.')) {
      throw new HttpError(400, `Volume ${i + 1}: use a subfolder of the instance folder, e.g. media`);
    }
    if (!containerPath.startsWith('/') || containerPath === '/' || /[:,\s]/.test(containerPath)) {
      throw new HttpError(400, `Volume ${i + 1}: container path must be an absolute folder, e.g. /media`);
    }
    return { subdir, containerPath };
  });
  const targets = [dataPath, ...volumes.map((v: { containerPath: string }) => v.containerPath)];
  if (new Set(targets).size !== targets.length) throw new HttpError(400, 'Two mounts point at the same container path');

  let webUi: DockerConfig['webUi'] = null;
  if (raw.webUi && typeof raw.webUi === 'object') {
    const port = Number(raw.webUi.port);
    if (!ports.some((p) => p.host === port && p.protocol === 'tcp')) throw new HttpError(400, 'The web UI port must be one of the published TCP ports');
    const webPath = typeof raw.webUi.path === 'string' && raw.webUi.path.startsWith('/') ? raw.webUi.path.slice(0, 200) : '/';
    webUi = { port, scheme: raw.webUi.scheme === 'https' ? 'https' : 'http', path: webPath };
  }
  return {
    image,
    ports,
    env,
    dataPath,
    cpus,
    command: typeof raw.command === 'string' ? raw.command.trim().slice(0, 2000) : '',
    runAsPanelUser: raw.runAsPanelUser !== false,
    volumes,
    webUi,
    mountEngineSocket: raw.mountEngineSocket === true,
    category: raw.category === 'game' || raw.category === 'app' ? raw.category : 'container',
    icon: typeof raw.icon === 'string' && /^[a-z0-9:-]{1,40}$/.test(raw.icon) ? raw.icon : null,
    template: typeof raw.template === 'string' && /^[a-z0-9-]{1,40}$/.test(raw.template) ? raw.template : null,
  };
}

/** Where the engine's API socket lives on this host (what Portainer & co. talk to), or why it's missing. */
export function engineSocket(): { path: string | null; hint: string | null } {
  const pinned = envVar('ENGINE_SOCKET');
  if (pinned) return fs.existsSync(pinned) ? { path: pinned, hint: null } : { path: null, hint: `OUTPOST_ENGINE_SOCKET points at ${pinned}, which doesn't exist` };
  const engine = getEngineStatus().engine;
  if (engine === 'podman') {
    const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`;
    const rootless = path.join(runtime, 'podman', 'podman.sock');
    if (fs.existsSync(rootless)) return { path: rootless, hint: null };
    if (fs.existsSync('/run/podman/podman.sock')) return { path: '/run/podman/podman.sock', hint: null };
    return { path: null, hint: "Podman's API socket isn't running. Enable it once with `systemctl --user enable --now podman.socket`, then start the instance again." };
  }
  if (fs.existsSync('/var/run/docker.sock')) return { path: '/var/run/docker.sock', hint: null };
  return { path: null, hint: "Docker's API socket (/var/run/docker.sock) wasn't found." };
}

export function containerName(server: Pick<ServerRecord, 'id'>): string {
  return `outpost-${server.id.slice(0, 12)}`;
}

/** The name containers had before the rename to Outpost (still cleaned up and listed). */
function legacyContainerName(server: Pick<ServerRecord, 'id'>): string {
  return `multicraft-${server.id.slice(0, 12)}`;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const selinuxEnforcing = () => {
  try {
    return fs.readFileSync('/sys/fs/selinux/enforce', 'utf8').trim() === '1';
  } catch {
    return false;
  }
};

/** `docker run …` for an instance. Attached with -i so console input/output works like any other instance. */
export function buildContainerLaunch(server: ServerRecord): { cmd: string; args: string[] } {
  const engine = requireEngine();
  const config = dockerConfigOf(server);
  if (!config) throw new HttpError(400, 'This Docker instance has no container settings');
  const vars = launchVariables(server);
  const dir = instanceDir(server.id);
  fs.mkdirSync(dir, { recursive: true });
  const name = containerName(server);
  // A container left behind by a panel restart would block the name.
  // (also the pre-rename name, so an upgrade with a container still running doesn't clash on ports)
  spawnSync(engine, ['rm', '-f', name, legacyContainerName(server)], { stdio: 'ignore', timeout: 20000 });

  const args = [
    'run',
    '--rm',
    '-i',
    '--init',
    '--sig-proxy=true',
    '--name', name,
    '--label', `outpost.instance=${server.id}`,
    '--hostname', 'outpost',
    '-v', `${dir}:${config.dataPath}${selinuxEnforcing() ? ':Z' : ''}`,
    ...(config.volumes ?? []).flatMap((v) => {
      const host = safeJoinReal(dir, v.subdir);
      fs.mkdirSync(host, { recursive: true });
      return ['-v', `${host}:${v.containerPath}${selinuxEnforcing() ? ':Z' : ''}`];
    }),
    '--memory', `${containerLimitArgs(server).memoryMb ?? server.max_memory_mb}m`,
    '--pids-limit', String(containerLimitArgs(server).pids ?? 4096),
    '--security-opt', 'no-new-privileges',
  ];
  for (const p of config.ports) args.push('-p', `${p.host}:${p.container}/${p.protocol}`);
  for (const e of config.env) args.push('-e', `${e.key}=${expandVariables(e.value, vars)}`);
  const cpus = containerLimitArgs(server).cpus ?? config.cpus;
  if (cpus) args.push('--cpus', String(cpus));
  if (config.mountEngineSocket) {
    const socket = engineSocket();
    if (!socket.path) throw new HttpError(400, socket.hint ?? 'Container engine socket not found');
    args.push('-v', `${socket.path}:/var/run/docker.sock`);
    if (selinuxEnforcing()) args.push('--security-opt', 'label=disable');
  }
  if (config.runAsPanelUser && process.platform !== 'win32') {
    // Rootless Podman already maps the container's root to the panel user; keep-id makes the
    // container user *be* the panel user. Docker needs an explicit --user.
    if (engine === 'podman') args.push('--userns=keep-id');
    else args.push('--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`);
  }
  args.push(config.image, ...(config.command ? splitArgs(expandVariables(config.command, vars)) : []));
  return { cmd: engine, args };
}

/** Pulls the image, streaming progress lines to `onLog`. */
export function pullImage(image: string, onLog: (line: string) => void): Promise<void> {
  const engine = requireEngine();
  return new Promise((resolve, reject) => {
    onLog(`==> ${engine} pull ${image}`);
    const p = spawn(engine, ['pull', image], { windowsHide: true });
    const forward = (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) onLog(line.trim());
    };
    p.stdout.on('data', forward);
    p.stderr.on('data', forward);
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${engine} pull exited with code ${code}`))));
  });
}

/** Force-stops an instance's container (SIGKILL can't be proxied through the attached CLI). */
export function killContainer(server: Pick<ServerRecord, 'id'>) {
  const engine = getEngineStatus().engine;
  if (!engine) return;
  spawn(engine, ['kill', containerName(server)], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

const UNITS: Record<string, number> = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };

export function parseSize(text: string): number | null {
  const m = text.trim().match(/^([\d.]+)\s*([a-zA-Z]+)?$/);
  if (!m) return null;
  return Math.round(Number(m[1]) * (UNITS[(m[2] ?? 'b').toLowerCase()] ?? 1));
}

export interface ContainerSample {
  cpuPercent: number | null;
  memoryMb: number | null;
  netRx: number | null;
  netTx: number | null;
  blockRead: number | null;
  blockWrite: number | null;
}

/** One `stats --no-stream` sample. Unlike host processes, containers report their own network I/O. */
export function sampleContainer(server: Pick<ServerRecord, 'id'>): Promise<ContainerSample | null> {
  const engine = getEngineStatus().engine;
  if (!engine) return Promise.resolve(null);
  return new Promise((resolve) => {
    const p = spawn(engine, ['stats', '--no-stream', '--format', '{{.CPUPerc}}|{{.MemUsage}}|{{.NetIO}}|{{.BlockIO}}', containerName(server)], {
      windowsHide: true,
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve(null));
    p.on('exit', (code) => {
      if (code !== 0) return resolve(null);
      const [cpu, mem, net, block] = out.trim().split('\n').pop()!.split('|');
      const pair = (s: string | undefined) => (s ?? '').split('/').map((x) => parseSize(x));
      const [memUsed] = pair(mem);
      const [rx, tx] = pair(net);
      const [read, write] = pair(block);
      resolve({
        cpuPercent: cpu ? Math.round(parseFloat(cpu) * 10) / 10 : null,
        memoryMb: memUsed !== null && memUsed !== undefined ? Math.round(memUsed / 1048576) : null,
        netRx: rx ?? null,
        netTx: tx ?? null,
        blockRead: read ?? null,
        blockWrite: write ?? null,
      });
    });
    setTimeout(() => p.kill(), 15000).unref();
  });
}

/** Containers Outpost launched (by label), including any orphaned by a panel restart. */
export function listManagedContainers(): { name: string; status: string; image: string; instanceId: string }[] {
  const engine = getEngineStatus().engine;
  if (!engine) return [];
  // Repeated label filters are ANDed by the engine, so query the current and pre-rename labels separately.
  const out: { name: string; status: string; image: string; instanceId: string }[] = [];
  for (const label of ['outpost.instance', 'multicraft.instance']) {
    const res = spawnSync(engine, ['ps', '-a', '--filter', `label=${label}`, '--format', '{{.Names}}|{{.Status}}|{{.Image}}|{{.Labels}}'], {
      encoding: 'utf8',
      timeout: 10000,
    });
    if (res.status !== 0) continue;
    for (const line of res.stdout.trim().split('\n').filter(Boolean)) {
      const [name, status, image, labels] = line.split('|');
      out.push({ name, status, image, instanceId: labels?.match(/(?:outpost|multicraft)\.instance[=:]([0-9a-f-]{36})/)?.[1] ?? '' });
    }
  }
  return out;
}

export function engineCounts(): { containers: number; running: number; images: number } | null {
  const engine = getEngineStatus().engine;
  if (!engine) return null;
  const count = (args: string[]) => {
    const r = spawnSync(engine, args, { encoding: 'utf8', timeout: 10000 });
    return r.status === 0 ? r.stdout.trim().split('\n').filter(Boolean).length : 0;
  };
  return { containers: count(['ps', '-aq']), running: count(['ps', '-q']), images: count(['images', '-q']) };
}

// ---------------------------------------------------------------------------
// Access policy for non-admins
// ---------------------------------------------------------------------------

const PANEL_PORT = Number(process.env.PORT ?? 8642);

/**
 * Applies a user's container permission to a requested config. Admins pass through untouched.
 * - "catalog": the config must come from a catalog template and keep that template's image; the
 *   template's category/icon are enforced, and only a template that needs the engine socket
 *   (Portainer) may mount it.
 * - Mounting the engine socket needs the separate engine-socket permission.
 * - Host ports below 1024, and the panel's own port, are admin-only.
 */
export function enforceContainerPolicy(
  config: DockerConfig,
  policy: { containers: 'none' | 'catalog' | 'any'; engineSocket: boolean },
  isAdmin: boolean,
  findTemplate: (id: string | null) => { config: DockerConfig; name: string } | undefined
): DockerConfig {
  if (isAdmin) return config;
  if (policy.containers === 'none') throw new HttpError(403, "Your account can't create or change container instances — ask an admin");
  let out = config;
  if (policy.containers === 'catalog') {
    const template = findTemplate(config.template);
    if (!template) throw new HttpError(403, 'Your account can only run apps from the catalog');
    if (config.image !== template.config.image) {
      throw new HttpError(403, `Your account can only run the catalog's image for ${template.name} (${template.config.image})`);
    }
    if (config.mountEngineSocket && !template.config.mountEngineSocket) throw new HttpError(403, 'Only Portainer-type templates can mount the engine socket');
    out = { ...config, category: template.config.category, icon: template.config.icon };
  }
  if (out.mountEngineSocket && !policy.engineSocket) {
    throw new HttpError(403, "Your account isn't allowed to give containers control of the container engine (Portainer access)");
  }
  for (const p of out.ports) {
    if (p.host < 1024) throw new HttpError(403, `Only admins can publish host ports below 1024 (port ${p.host})`);
    if (p.host === PANEL_PORT) throw new HttpError(403, `Port ${p.host} is the panel's own port`);
  }
  return out;
}
