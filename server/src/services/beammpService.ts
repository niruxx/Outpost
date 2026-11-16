import path from 'node:path';
import type { ServerRecord } from '../types/index.js';
import { launchConfigOf, launchVariables, expandVariables } from './launchConfig.js';
import type { OutpostTemplate } from './templateService.js';

export function isBeamMP(server: ServerRecord): boolean {
  const launch = launchConfigOf(server);
  return server.platform === 'custom' && !launch.useShell &&
    /^BeamMP-Server(?:\.exe)?$/i.test(path.basename(launch.executable ?? ''));
}

/** BeamMP's resource location is explicit so the mod manager and server agree. */
export function beammpModFolder(server: ServerRecord): string {
  const launch = launchConfigOf(server);
  const resource = launch.env?.find(e => e.key === 'BEAMMP_RESOURCE_FOLDER')?.value;
  return `${launch.workingDir ? `${launch.workingDir}/` : ''}${expandVariables(resource || 'Resources', launchVariables(server))}/Client`;
}

export const BEAMMP_TEMPLATE_ID = 'builtin-beammp';

export function beammpTemplate(): OutpostTemplate {
  return {
    format: 'outpost-template', version: 1, name: 'BeamMP Server', author: 'Outpost', exportedAt: '',
    description: 'BeamNG.drive multiplayer with vehicle and map ZIP mods, including BeamNG Earth. Admins only. Upload the official server binary for your host to the instance root and name it BeamMP-Server (Linux) or BeamMP-Server.exe (Windows). Requires a BeamMP auth key and TCP + UDP access to the chosen port. Configure settings in Configuration → Launch; upload mods on the Mods tab.',
    instance: {
      platform: 'custom', loader: 'custom', version: 'BeamMP', defaultPort: 30814,
      minMemoryMb: 256, maxMemoryMb: 1024,
      launch: {
        executable: process.platform === 'win32' ? 'BeamMP-Server.exe' : 'BeamMP-Server',
        protocol: 'tcp', stop: { kind: 'stdin', commands: ['exit'] },
        env: [
          { key: 'BEAMMP_AUTH_KEY', value: '{{AUTH_KEY}}' },
          { key: 'BEAMMP_PORT', value: '{{PORT}}' },
          { key: 'BEAMMP_NAME', value: '{{NAME}}' },
          { key: 'BEAMMP_RESOURCE_FOLDER', value: 'Resources' },
          { key: 'BEAMMP_MAP', value: '{{MAP}}' },
          { key: 'BEAMMP_MAX_PLAYERS', value: '{{MAX_PLAYERS}}' },
          { key: 'BEAMMP_PRIVATE', value: 'true' },
        ],
      },
    },
    variables: [
      { key: 'AUTH_KEY', label: 'BeamMP auth key', default: '', required: true, description: 'Create a server key at https://keymaster.beammp.com/.' },
      { key: 'MAP', label: 'Map path', default: '/levels/gridmap_v2/info.json', required: true, description: 'For custom maps such as BeamNG Earth, use /levels/<actual folder inside the ZIP>/info.json.' },
      { key: 'MAX_PLAYERS', label: 'Maximum players', default: '8', required: true },
    ],
    files: [],
  };
}
