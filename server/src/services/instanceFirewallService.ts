import fs from 'node:fs';
import { instanceDir, safeJoinReal } from '../utils/paths.js';
import { HttpError } from '../utils/asyncHandler.js';
import { parseProperties } from './propertiesService.js';
import { launchConfigOf, launchEnv, launchVariables, expandVariables, splitArgs } from './launchConfig.js';
import { instancePortProtocol } from './portProtocol.js';
import { dockerConfigOf } from './containerService.js';
import { isBeamMP } from './beammpService.js';
import { isProxyLoader, type ServerRecord } from '../types/index.js';

export interface InstanceFirewallPort {
  port: number;
  protocol: 'tcp' | 'udp';
  source: string;
}

function portNumber(value: unknown, source: string): number {
  if (!/^\d+$/.test(String(value)) || Number(value) < 1 || Number(value) > 65535) throw new HttpError(400, `${source} must contain a port between 1 and 65535`);
  return Number(value);
}

/** Read the same instance-local config used by the game, without following outside symlinks. */
function configText(server: ServerRecord, file: string): string | null {
  let target: string;
  try { target = safeJoinReal(instanceDir(server.id), file); }
  catch { throw new HttpError(400, 'Server configuration must stay inside the instance folder'); }
  if (!fs.existsSync(target)) return null;
  if (!fs.statSync(target).isFile() || fs.statSync(target).size > 512 * 1024) throw new HttpError(400, `${file} is not a configuration file under 512 KiB`);
  return fs.readFileSync(target, 'utf8');
}

/** Last launch override wins. Values are parsed as ports and never passed to a shell. */
function argumentPort(args: string[], flags: string[]): string | undefined {
  let value: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].split('=', 2);
    if (flags.includes(flag.toLowerCase())) value = inline ?? args[i + 1] ?? '';
  }
  return value;
}

/** Player/query ports only: RCON and remote administration remain explicit host decisions. */
export function instanceFirewallPorts(server: ServerRecord): InstanceFirewallPort[] {
  const launch = launchConfigOf(server), result: InstanceFirewallPort[] = [];
  const add = (value: unknown, protocol: 'tcp' | 'udp', source: string) => {
    const port = portNumber(value, source);
    if (!result.some(p => p.port === port && p.protocol === protocol)) result.push({ port, protocol, source });
  };
  const args = splitArgs(expandVariables(launch.args || server.extra_args || '', launchVariables(server)));
  const folder = launch.workingDir ? `${launch.workingDir}/` : '';
  if ((server.platform === 'java' && !isProxyLoader(server.loader)) || server.platform === 'bedrock') {
    const file = `${folder}server.properties`;
    const props = Object.fromEntries(parseProperties(configText(server, file) ?? '').map(p => [p.key, p.value.trim()]));
    const override = server.platform === 'java' ? argumentPort(args, ['--port', '-p']) : undefined;
    add(override ?? props['server-port'] ?? server.server_port, server.platform === 'java' ? 'tcp' : 'udp', override !== undefined ? 'Launch port override' : props['server-port'] !== undefined ? `${file}: server-port` : 'Instance port');
    if (server.platform === 'bedrock') {
      add(props['server-portv6'] ?? 19133, 'udp', `${file}: server-portv6`);
    } else if (props['enable-query'] === 'true') {
      add(props['query.port'] ?? 25565, 'udp', `${file}: query.port`);
    }
  } else if (server.platform === 'java' && isProxyLoader(server.loader)) {
    const velocity = server.loader === 'velocity';
    const file = `${folder}${velocity ? 'velocity.toml' : 'config.yml'}`;
    const text = configText(server, file) ?? '';
    const values = [...text.matchAll(velocity ? /^\s*bind\s*=\s*["'][^"'\r\n]+:(\d+)["']/gm : /^\s*host\s*:\s*["']?[^\s"']+:(\d+)["']?\s*(?:#.*)?$/gm)];
    if (values.length) for (const value of values) add(value[1], 'tcp', `${file}: ${velocity ? 'bind' : 'listener host'}`);
    else add(server.server_port, 'tcp', 'Instance proxy port');
  } else if (isBeamMP(server)) {
    const env = launchEnv(server, launch);
    const text = configText(server, `${folder}ServerConfig.toml`) ?? '';
    const general = text.match(/^\s*\[General\]\s*\r?\n([\s\S]*?)(?=^\s*\[|$(?![\s\S]))/m)?.[1] ?? '';
    const configPort = general.match(/^\s*Port\s*=\s*([^#\r\n]+)/m)?.[1].trim();
    const value = env.BEAMMP_PORT ?? configPort ?? server.server_port;
    for (const protocol of ['tcp', 'udp'] as const) add(value, protocol, env.BEAMMP_PORT !== undefined ? 'BeamMP launch environment' : configPort ? 'ServerConfig.toml: Port' : 'Instance port');
  } else if (server.platform === 'docker') {
    for (const mapping of dockerConfigOf(server)?.ports ?? []) add(mapping.host, mapping.protocol, 'Published container port');
  } else if (server.platform === 'steam') {
    const value = argumentPort(args, ['-port', '--port', '+hostport', '+server.port', '+net_port', '-serverport']);
    add(value ?? server.server_port, instancePortProtocol(server), value !== undefined ? 'Game launch port override' : 'Instance game port');
  } else {
    add(server.server_port, instancePortProtocol(server), 'Instance port');
  }
  if (!result.length) throw new HttpError(400, 'This instance has no published server ports');
  return result;
}
