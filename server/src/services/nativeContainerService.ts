import { execFile } from 'node:child_process';
import { HttpError } from '../utils/asyncHandler.js';

export type ContainerEngine = 'docker' | 'podman';
export type ContainerAction = 'start' | 'stop' | 'restart' | 'pause' | 'unpause' | 'kill' | 'remove';
export const CONTAINER_ACTIONS: ContainerAction[] = ['start', 'stop', 'restart', 'pause', 'unpause', 'kill', 'remove'];
export interface NativeContainer {
  id: string; name: string; image: string; state: string; status: string; ports: string;
  instanceId: string | null; composeProject: string | null;
}
export interface ContainerDetails extends NativeContainer {
  createdAt: string | null; startedAt: string | null; finishedAt: string | null;
  autoRemove: boolean; restartPolicy: string; memoryMb: number | null; cpus: number | null;
  command: string[]; mounts: { type: string; source: string; destination: string; writable: boolean }[];
  networks: string[];
}
export type ContainerRunner = (engine: ContainerEngine, args: string[]) => Promise<{ stdout: string; stderr: string }>;
export const runContainerCommand: ContainerRunner = (engine, args) => new Promise((resolve, reject) => {
  execFile(engine, args, { timeout: 65_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
    if (error) reject(new HttpError(/no such (container|object)|does not exist/i.test(stderr) ? 404 : 503, `${engine}: ${(stderr || error.message).trim().slice(0, 1200)}`));
    else resolve({ stdout, stderr });
  });
});
export function validateContainerId(id: string) {
  if (!/^[a-f0-9]{64}$/i.test(id)) throw new HttpError(400, 'A full container ID is required');
  return id.toLowerCase();
}
function label(labels: unknown, key: string): string | null {
  if (labels && typeof labels === 'object' && !Array.isArray(labels)) return String((labels as Record<string, unknown>)[key] ?? '') || null;
  if (typeof labels === 'string') return labels.split(',').map((part) => part.split(/=(.*)/s)).find(([name]) => name === key)?.[1] || null;
  return null;
}
function portsText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((p) => `${p.host_ip || '0.0.0.0'}:${p.host_port}->${p.container_port}/${p.protocol || 'tcp'}`).join(', ');
}
export function parseContainerList(text: string): NativeContainer[] {
  if (!text.trim()) return [];
  const rows: Record<string, any>[] = text.trim().startsWith('[') ? JSON.parse(text) : text.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  return rows.map((raw) => {
    const labels = raw.Labels ?? raw.labels;
    const name = raw.Names ?? raw.names ?? raw.Name ?? raw.name ?? '';
    return { id: validateContainerId(raw.ID ?? raw.Id ?? raw.id), name: (Array.isArray(name) ? name[0] : String(name)).replace(/^\//, ''), image: String(raw.Image ?? raw.image ?? ''), state: String(raw.State ?? raw.state ?? 'unknown').toLowerCase(), status: String(raw.Status ?? raw.status ?? ''), ports: portsText(raw.Ports ?? raw.ports), instanceId: label(labels, 'outpost.instance') ?? label(labels, 'multicraft.instance'), composeProject: label(labels, 'com.docker.compose.project') ?? label(labels, 'io.podman.compose.project') };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
export class NativeContainerClient {
  constructor(readonly engine: ContainerEngine, private readonly run: ContainerRunner = runContainerCommand) {}
  async list() { return parseContainerList((await this.run(this.engine, ['ps', '--all', '--no-trunc', '--format', '{{json .}}'])).stdout); }
  async imageCount() {
    const result = await this.run(this.engine, ['images', '--quiet', '--no-trunc']);
    return new Set(result.stdout.trim().split(/\s+/).filter(Boolean)).size;
  }
  async details(id: string): Promise<ContainerDetails> {
    id = validateContainerId(id);
    const raw = JSON.parse((await this.run(this.engine, ['container', 'inspect', id])).stdout)[0];
    if (!raw || validateContainerId(raw.Id ?? raw.ID) !== id) throw new HttpError(404, 'Container not found');
    const config = raw.Config ?? {}, state = raw.State ?? {}, host = raw.HostConfig ?? {};
    const labels = config.Labels ?? {}, ports = raw.NetworkSettings?.Ports ?? {};
    return {
      id, name: String(raw.Name ?? raw.Names?.[0] ?? id).replace(/^\//, ''), image: String(config.Image ?? raw.ImageName ?? raw.Image ?? ''), state: String(state.Status ?? 'unknown').toLowerCase(), status: state.Health?.Status ? `${state.Status} (${state.Health.Status})` : String(state.Status ?? ''),
      ports: Object.entries(ports).flatMap(([port, mappings]) => Array.isArray(mappings) ? mappings.map((p) => `${p.HostIp || '0.0.0.0'}:${p.HostPort}->${port}`) : []).join(', '),
      instanceId: label(labels, 'outpost.instance') ?? label(labels, 'multicraft.instance'), composeProject: label(labels, 'com.docker.compose.project') ?? label(labels, 'io.podman.compose.project'),
      createdAt: raw.Created ?? null, startedAt: state.StartedAt ?? null, finishedAt: state.FinishedAt ?? null,
      autoRemove: host.AutoRemove === true, restartPolicy: host.RestartPolicy?.Name || 'no', memoryMb: host.Memory > 0 ? Math.round(host.Memory / 1048576) : null,
      cpus: host.NanoCpus > 0 ? host.NanoCpus / 1e9 : host.CpuQuota > 0 && host.CpuPeriod > 0 ? host.CpuQuota / host.CpuPeriod : null,
      command: [...(Array.isArray(config.Entrypoint) ? config.Entrypoint : config.Entrypoint ? [String(config.Entrypoint)] : []), ...(Array.isArray(config.Cmd) ? config.Cmd : config.Cmd ? [String(config.Cmd)] : [])],
      mounts: (Array.isArray(raw.Mounts) ? raw.Mounts : []).map((m: any) => ({ type: String(m.Type ?? ''), source: String(m.Source ?? m.Name ?? ''), destination: String(m.Destination ?? ''), writable: m.RW !== false })),
      networks: Object.keys(raw.NetworkSettings?.Networks ?? {}),
    };
  }
  async logs(id: string) {
    id = validateContainerId(id);
    const result = await this.run(this.engine, ['logs', '--tail', '500', '--timestamps', id]);
    return (result.stdout + result.stderr).slice(-1024 * 1024);
  }
  async action(id: string, action: ContainerAction) {
    id = validateContainerId(id);
    if (!CONTAINER_ACTIONS.includes(action)) throw new HttpError(400, 'Unknown container action');
    const current = await this.details(id);
    if (action === 'remove' && !['exited', 'created', 'dead', 'stopped', 'configured'].includes(current.state)) throw new HttpError(409, 'Stop the container before removing it');
    // Full IDs prevent name-reuse retargeting. Never recreate containers or delete volumes.
    await this.run(this.engine, [action === 'remove' ? 'rm' : action, ...(['stop', 'restart'].includes(action) ? ['--time', '30'] : []), id]);
  }
  async update(id: string, input: unknown) {
    id = validateContainerId(id);
    const raw = input as { restartPolicy?: unknown; memoryMb?: unknown; cpus?: unknown } | null;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'Container update must be an object');
    const current = await this.details(id), args = ['update'];
    if (raw.restartPolicy !== undefined) {
      if (!['no', 'always', 'unless-stopped', 'on-failure'].includes(String(raw.restartPolicy))) throw new HttpError(400, 'Invalid restart policy');
      if (current.autoRemove) throw new HttpError(409, 'Auto-remove containers cannot have their restart policy changed');
      args.push('--restart', String(raw.restartPolicy));
    }
    if (raw.memoryMb !== undefined) {
      if (!Number.isInteger(raw.memoryMb) || Number(raw.memoryMb) < 0 || Number(raw.memoryMb) > 16_777_216) throw new HttpError(400, 'Memory must be 0 (unlimited) or a positive integer in MB');
      args.push('--memory', `${raw.memoryMb}m`);
    }
    if (raw.cpus !== undefined) {
      if (typeof raw.cpus !== 'number' || !Number.isFinite(raw.cpus) || raw.cpus < 0 || raw.cpus > 4096) throw new HttpError(400, 'CPUs must be 0 (unlimited) or a positive number');
      args.push('--cpus', String(raw.cpus));
    }
    if (args.length === 1) throw new HttpError(400, 'No supported container settings were supplied');
    args.push(id); await this.run(this.engine, args);
  }
}
