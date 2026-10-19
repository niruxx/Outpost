import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { downloadFile, type LogFn } from '../utils/download.js';

/**
 * Installers for game servers that don't come from steamcmd — the files are downloaded straight
 * from the project that publishes them.
 */

/** Extracts the entries under `prefix` into `dest`, refusing any path that would land outside it. */
function extractUnder(zip: AdmZip, prefix: string, dest: string): number {
  const root = path.resolve(dest);
  let count = 0;
  for (const entry of zip.getEntries()) {
    if (!entry.entryName.startsWith(prefix) || entry.isDirectory) continue;
    const rel = entry.entryName.slice(prefix.length);
    if (!rel) continue;
    const target = path.resolve(root, rel);
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`Refusing to extract ${entry.entryName} outside the instance folder`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.getData());
    count++;
  }
  return count;
}

async function fetchZip(url: string, scratch: string, onLog?: LogFn): Promise<AdmZip> {
  onLog?.(`==> Downloading ${url}`);
  await downloadFile(url, scratch, undefined, onLog);
  try {
    return new AdmZip(scratch);
  } finally {
    fs.rmSync(scratch, { force: true });
  }
}

const IOQ3_BUILDS: Partial<Record<NodeJS.Platform, string>> = {
  linux: 'https://files.ioquake3.org/Linux.zip',
  win32: 'https://files.ioquake3.org/Windows.zip',
};
const Q3_POINT_RELEASE = 'https://files.ioquake3.org/quake3-latest-pk3s.zip';

const Q3_SERVER_CFG = `// Outpost's starter config — edit freely. Loaded at every start (+exec server.cfg).
seta sv_hostname "Outpost Quake III"
seta sv_maxclients 12
seta g_motd "Welcome!"
seta g_gametype 0          // 0 FFA, 1 duel, 3 team DM, 4 CTF
seta fraglimit 30
seta timelimit 15
seta g_forcerespawn 5
seta bot_minplayers 0      // set to e.g. 4 to fill empty slots with bots

// Map rotation
set d1 "map q3dm17 ; set nextmap vstr d2"
set d2 "map q3dm6 ; set nextmap vstr d3"
set d3 "map q3dm7 ; set nextmap vstr d4"
set d4 "map q3tourney2 ; set nextmap vstr d1"
set nextmap "vstr d2"
`;

/**
 * Quake III Arena on ioquake3: the open-source engine's dedicated server plus id's free point-release
 * data (pak1–8). The base game data, baseq3/pak0.pk3, is commercial and has to come from the
 * owner's own copy — the preset refuses to start until it's uploaded.
 */
export async function installQuake3(instanceDir: string, onLog?: LogFn): Promise<void> {
  const build = IOQ3_BUILDS[process.platform];
  if (!build || process.arch !== 'x64') {
    throw new Error(`ioquake3 publishes dedicated servers for 64-bit Linux and Windows — not ${process.platform}/${process.arch}`);
  }
  fs.mkdirSync(instanceDir, { recursive: true });
  const engine = await fetchZip(build, path.join(instanceDir, '_ioq3.zip'), onLog);
  onLog?.(`==> Extracted ${extractUnder(engine, 'ioquake3/', instanceDir)} engine files`);
  const paks = await fetchZip(Q3_POINT_RELEASE, path.join(instanceDir, '_q3paks.zip'), onLog);
  onLog?.(`==> Extracted ${extractUnder(paks, 'quake3-latest-pk3s/', instanceDir)} point-release pak files`);

  const cfg = path.join(instanceDir, 'baseq3', 'server.cfg');
  if (!fs.existsSync(cfg)) {
    fs.writeFileSync(cfg, Q3_SERVER_CFG);
    onLog?.('==> Wrote a starter baseq3/server.cfg');
  }
  if (!fs.existsSync(path.join(instanceDir, 'baseq3', 'pak0.pk3'))) {
    onLog?.(
      '==> One more step: Quake III’s main game data (baseq3/pak0.pk3) isn’t free to download. Copy it from your own copy of the game ' +
        '(Steam: steamapps/common/Quake 3 Arena/baseq3/pak0.pk3, or GOG) and upload it to baseq3/ in File Management, then start the server.'
    );
  }
}
