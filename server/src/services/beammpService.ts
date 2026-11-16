import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError } from '../utils/asyncHandler.js';
import type { ServerRecord } from '../types/index.js';
import { launchConfigOf, launchEnv, type LaunchConfig } from './launchConfig.js';
import type { OutpostTemplate } from './templateService.js';

export function isBeamMP(server: ServerRecord): boolean {
  const launch = launchConfigOf(server);
  return server.platform === 'custom' && !launch.useShell &&
    /^BeamMP-Server(?:\.exe)?$/i.test(path.basename(launch.executable ?? ''));
}

/** BeamMP's resource location is explicit so the mod manager and server agree. */
export function beammpModFolder(server: ServerRecord): string {
  const launch = launchConfigOf(server);
  const resource = launchEnv(server, launch).BEAMMP_RESOURCE_FOLDER || 'Resources';
  if (path.isAbsolute(resource) || /^[A-Za-z]:/.test(resource) || resource.split(/[\\/]/).includes('..')) throw new HttpError(400, 'Invalid path: BeamMP resource folder must stay relative to the instance');
  return `${launch.workingDir ? `${launch.workingDir}/` : ''}${resource}/Client`;
}

export const BEAMMP_TEMPLATE_ID = 'builtin-beammp';
export const BEAMNG_EARTH_TEMPLATE_ID = 'builtin-beamng-earth';
export const BEAMNG_EARTH_MAP = '/levels/beamng_earth/info.json';

export function isManagedBeamMP(server: ServerRecord): boolean {
  return isBeamMP(server) && launchConfigOf(server).installer === 'beammp';
}

export function normalizeBeamMPLaunch(launch: LaunchConfig): LaunchConfig {
  if (!['BeamMP-Server', 'BeamMP-Server.exe'].includes(launch.executable ?? '') || launch.useShell || launch.workingDir) throw new HttpError(400, 'Managed BeamMP needs its standard executable in the instance root with the default working directory');
  const env = new Map((launch.env ?? []).map(e => [e.key, e.value]));
  const resource = env.get('BEAMMP_RESOURCE_FOLDER') || 'Resources';
  if (launch.beamngEarth && resource !== 'Resources') throw new HttpError(400, 'BeamNG.Earth requires the default Resources folder');
  if (path.isAbsolute(resource) || /^[A-Za-z]:/.test(resource) || resource.includes('{{') || resource.split(/[\\/]/).includes('..')) throw new HttpError(400, 'BeamMP resource folder must be a relative folder inside the instance');
  const privateValue = env.get('BEAMMP_PRIVATE') ?? 'true';
  if (!['true', 'false'].includes(privateValue)) throw new HttpError(400, 'Choose private or public server visibility');
  const key = env.get('BEAMMP_AUTH_KEY')?.trim();
  if (privateValue === 'false' && !key) throw new HttpError(400, 'A BeamMP Keymaster auth key is required for a public server');
  const players = env.get('BEAMMP_MAX_PLAYERS') ?? '8';
  if (!/^\d+$/.test(players) || Number(players) < 1 || Number(players) > 128) throw new HttpError(400, 'Maximum players must be 1–128');
  const map = launch.beamngEarth ? BEAMNG_EARTH_MAP : env.get('BEAMMP_MAP') ?? '/levels/gridmap_v2/info.json';
  if (!/^\/levels\/[^\r\n]+\/info\.json$/.test(map) || map.split('/').includes('..')) throw new HttpError(400, 'Map must be /levels/<map-folder>/info.json');
  env.set('BEAMMP_PRIVATE', privateValue);
  env.set('BEAMMP_AUTH_KEY', key || crypto.randomUUID());
  env.set('BEAMMP_MAX_PLAYERS', players);
  env.set('BEAMMP_MAP', map);
  return { ...launch, env: [...env].map(([key, value]) => ({ key, value })) };
}

export function beammpTemplate(): OutpostTemplate {
  return {
    format: 'outpost-template', version: 1, name: 'BeamMP Server', author: 'Outpost', exportedAt: '',
    description: 'Automatically download and configure a BeamMP server, ready to play with friends. Choose private Direct Connect or public listing. Add vehicle and map ZIP mods on the Mods tab, or enable BeamNG.Earth using its dedicated setup.',
    instance: {
      platform: 'custom', loader: 'custom', version: 'BeamMP', defaultPort: 30814,
      minMemoryMb: 256, maxMemoryMb: 1024,
      launch: {
        installer: 'beammp',
        executable: process.platform === 'win32' ? 'BeamMP-Server.exe' : 'BeamMP-Server',
        protocol: 'tcp', stop: { kind: 'stdin', commands: ['exit'] },
        env: [
          { key: 'BEAMMP_AUTH_KEY', value: '{{AUTH_KEY}}' },
          { key: 'BEAMMP_PORT', value: '{{PORT}}' },
          { key: 'BEAMMP_NAME', value: '{{NAME}}' },
          { key: 'BEAMMP_RESOURCE_FOLDER', value: 'Resources' },
          { key: 'BEAMMP_MAP', value: '{{MAP}}' },
          { key: 'BEAMMP_MAX_PLAYERS', value: '{{MAX_PLAYERS}}' },
          { key: 'BEAMMP_PRIVATE', value: '{{PRIVATE}}' },
        ],
      },
    },
    variables: [
      { key: 'PRIVATE', label: 'Server visibility', default: 'true', required: true, options: [{ value: 'true', label: 'Friends / private (unlisted)' }, { value: 'false', label: 'Public server list' }], description: 'Friends use Direct Connect. Anyone who knows the address can join.' },
      { key: 'AUTH_KEY', label: 'BeamMP auth key (public servers)', default: '', description: 'Optional for private servers; generated automatically when blank. Public servers need a real key from https://keymaster.beammp.com/.' },
      { key: 'MAP', label: 'Map path', default: '/levels/gridmap_v2/info.json', required: true, description: 'For custom map ZIPs, use /levels/<actual folder inside the ZIP>/info.json. BeamNG.Earth has a dedicated setup option.' },
      { key: 'MAX_PLAYERS', label: 'Maximum players', default: '8', required: true },
    ],
    files: [],
  };
}

export function beamngEarthTemplate(): OutpostTemplate {
  const template = beammpTemplate();
  template.name = 'BeamNG.Earth Server';
  template.description = 'Create a BeamNG.Earth multiplayer server: download BeamMP and the official Earth client mod and server plugin, then select the Earth map automatically. Every player must run the matching BeamNG.Earth app on their own computer. Private Direct Connect is the default; public servers appear in the BeamNG.Earth category.';
  template.instance.launch!.beamngEarth = true;
  template.instance.launch!.env!.find(e => e.key === 'BEAMMP_MAP')!.value = BEAMNG_EARTH_MAP;
  template.instance.launch!.env!.push({ key: 'BEAMMP_MAX_CARS', value: '3' });
  template.variables = template.variables.filter(v => v.key !== 'MAP').map(v => v.key === 'PRIVATE' ? {
    ...v, options: [{ value: 'true', label: 'Friends / private (unlisted)' }, { value: 'false', label: 'Public BeamNG.Earth category' }],
  } : v);
  return template;
}
