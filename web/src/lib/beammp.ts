import type { ServerRecord } from '../api/types.js';

export function beammpInfo(server: ServerRecord): { private: boolean; earth: boolean } | null {
  if (server.platform !== 'custom') return null;
  try {
    const launch = JSON.parse(server.launch_config || '{}');
    if (launch.useShell || !/^BeamMP-Server(?:\.exe)?$/i.test((launch.executable || '').split(/[\\/]/).pop())) return null;
    const value = launch.env?.find((e: { key: string; value: string }) => e.key === 'BEAMMP_PRIVATE')?.value;
    return { private: value === undefined || value === 'true' || value === '1', earth: launch.beamngEarth === true };
  } catch { return null; }
}
