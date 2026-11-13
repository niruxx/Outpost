import { GAME_PROFILES } from './gameControlProfiles.js';
import { controlsOf, resolvedFile } from './gameControlsService.js';
import type { ServerRecord } from '../types/index.js';
import { instanceDir } from '../utils/paths.js';
import path from 'node:path';

/** Replace a managed flag everywhere, including old extra-argument duplicates. */
function flag(args: string[], key: string, values: string[], oldValues = 1) {
  for (let i = args.length - 1; i >= 0; i--) {
    if (args[i] === key) {
      let take = 0;
      while (take < oldValues && args[i + take + 1] !== undefined && !/^[+-]/.test(args[i + take + 1])) take++;
      args.splice(i, 1 + take);
    }
    else if (args[i].startsWith(key + '=')) args.splice(i, 1);
  }
  args.push(key, ...values);
}
function removeFlag(args: string[], key: string) {
  for (let i = args.length - 1; i >= 0; i--) if (args[i] === key || args[i].startsWith(key + '=')) {
    const count = args[i] === key && args[i + 1] !== undefined && !/^[+-]/.test(args[i + 1]) ? 2 : 1;
    args.splice(i, count);
  }
}
function setCvar(args: string[], key: string, value: string) {
  for (let i = args.length - 3; i >= 0; i--) if (args[i] === '+set' && args[i + 1] === key) args.splice(i, 3);
  args.push('+set', key, value);
}
export function gameControlsLaunch(server: ServerRecord, id: string, original: string[]): string[] {
  let managed = false; try { managed = !!JSON.parse(server.game_settings ?? '{}').controls; } catch { /* unmanaged */ }
  const profile = GAME_PROFILES.find((p) => p.id === id);
  if (!managed || !profile) return original;
  const { values: v } = controlsOf(server, profile), args = [...original];
  if (['csgo', 'css', 'cs16', 'cscz', 'l4d2', 'hl2dm', 'dods', 'hldm', 'tfc'].includes(id)) {
    for (const field of profile.fields) if (!field.launch) removeFlag(args, `+${field.key}`);
    if (id === 'l4d2') flag(args, '+mp_gamemode', [v.mp_gamemode]);
    flag(args, '+maxplayers', [v.maxPlayers]); flag(args, '-port', [String(server.server_port)]); flag(args, '+map', [v.map]);
  } else if (id === 'quake3' || id === 'quakelive') {
    for (const field of profile.fields) if (!field.launch) setCvar(args, field.key, v[field.key]);
    setCvar(args, 'net_port', String(server.server_port));
    flag(args, '+map', id === 'quakelive' ? [v.map, v.factory] : [v.map], id === 'quakelive' ? 2 : 1);
  } else if (id === 'valheim') {
    flag(args, '-name', [v.serverName]); flag(args, '-world', [v.world]); flag(args, '-port', [String(server.server_port)]);
    flag(args, '-public', [v.public === 'true' ? '1' : '0']); flag(args, '-saveinterval', [v.saveinterval]);
    removeFlag(args, '-password'); if (v.password) args.push('-password', v.password);
    removeFlag(args, '-crossplay'); if (v.crossplay === 'true') args.push('-crossplay');
    if (v.worldStorage === 'instance') flag(args, '-savedir', [gamePath(server, 'worlds')]);
  } else if (id === 'terraria') {
    for (const key of ['-port', '-world', '-worldname', '-autocreate', '-maxplayers', '-players', '-password', '-motd', '-seed', '-difficulty']) removeFlag(args, key);
    flag(args, '-config', [resolvedFile(server, profile.file!)]);
  } else if (id === 'rust') {
    for (const field of profile.fields) if (!field.launch) removeFlag(args, `+${field.key}`);
    for (const key of ['+server.seed', '+server.worldsize', '+server.levelurl']) removeFlag(args, key);
    flag(args, '+server.hostname', [v['server.hostname']]); flag(args, '+server.maxplayers', [v['server.maxplayers']]);
    if (v['server.levelurl']) args.push('+server.levelurl', v['server.levelurl']);
    else args.push('+server.seed', v['server.seed'], '+server.worldsize', v['server.worldsize']);
  } else if (id === 'ark') {
    const parts = (args[0] ?? 'TheIsland?listen').split('?');
    const managedKeys = new Set(['sessionname', 'port', 'queryport', 'maxplayers']);
    args[0] = [v.map, ...parts.slice(1).filter((part) => !managedKeys.has(part.split('=')[0].toLowerCase())), `SessionName=${v.SessionName}`, `Port=${server.server_port}`, `QueryPort=${v.QueryPort}`, `MaxPlayers=${v.MaxPlayers}`].join('?');
  } else if (id === '7dtd') {
    removeFlag(args, '-configfile'); args.push(`-configfile=${resolvedFile(server, profile.file!)}`);
  } else if (id === 'arma3') {
    removeFlag(args, '-port'); args.push(`-port=${server.server_port}`); removeFlag(args, '-config'); args.push(`-config=${resolvedFile(server, profile.file!)}`);
  } else if (id === 'bo3') {
    for (const field of profile.fields) if (!field.launch) setCvar(args, field.key, v[field.key]);
    setCvar(args, 'g_gametype', v.gametype); setCvar(args, 'net_port', String(server.server_port));
    flag(args, '+map', [v.map]);
  } else if (id === 'palworld') {
    removeFlag(args, '-port'); args.push(`-port=${server.server_port}`);
    removeFlag(args, '-servername'); removeFlag(args, '-players');
  } else if (id === 'satisfactory') {
    removeFlag(args, '-Port'); removeFlag(args, '-port'); args.push(`-Port=${server.server_port}`);
  }
  return args;
}
const gamePath = (s: ServerRecord, relative: string) => path.join(instanceDir(s.id), relative);
