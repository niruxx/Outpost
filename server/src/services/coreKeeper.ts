import fs from 'node:fs';
import { HttpError } from '../utils/asyncHandler.js';
import { instanceDir, safeJoinReal } from '../utils/paths.js';
import type { ServerRecord } from '../types/index.js';
import { splitArgs } from './launchConfig.js';

export const CORE_KEEPER_ID = 'core_keeper';
export const CORE_KEEPER_APP = '1963720';
export const CORE_KEEPER_DATA = 'core-keeper-data';

export function isCoreKeeper(server: Pick<ServerRecord, 'platform' | 'steam_preset'>) {
  return server.platform === 'steam' && server.steam_preset === CORE_KEEPER_ID;
}

export function coreKeeperData(server: Pick<ServerRecord, 'id'>) {
  let directory: string;
  try { directory = safeJoinReal(instanceDir(server.id), CORE_KEEPER_DATA); }
  catch { throw new HttpError(409, 'Core Keeper’s data directory must stay inside its instance'); }
  const info = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (info && !info.isDirectory()) throw new HttpError(409, 'Core Keeper needs its own instance-local data directory');
  return directory;
}

export function coreKeeperArgs(server: ServerRecord) {
  const extras = splitArgs(server.extra_args || '');
  if (extras.some((arg) => /^-(datapath|port|ip|password|logfile|nographics)(?:=|$)/i.test(arg))) {
    throw new HttpError(400, 'Use Core Keeper Game settings for direct connections. Outpost manages the save path, display and logging.');
  }
  return ['-batchmode', '-logfile', '-', '-datapath', coreKeeperData(server), ...extras];
}
