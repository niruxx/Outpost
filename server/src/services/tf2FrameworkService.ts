import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import AdmZip from 'adm-zip';
import { HttpError } from '../utils/asyncHandler.js';
import { tf2Path } from './tf2Service.js';
import type { ServerRecord } from '../types/index.js';

const exec = promisify(execFile);
/** Official Source 1 builds; CS2's Metamod 2.x / CounterStrikeSharp are incompatible with TF2. */
export async function installTf2Frameworks(server: ServerRecord, log: (line: string) => void) {
  if (!fs.existsSync(tf2Path(server, 'gameinfo.txt'))) throw new HttpError(409, 'Install the TF2 server first');
  if (!['win32', 'linux'].includes(process.platform)) throw new HttpError(400, 'Automatic framework installation supports Windows and Linux hosts');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-tf2-frameworks-'));
  try {
    const platform = process.platform === 'win32' ? 'windows' : 'linux';
    for (const [label, base, prefix] of [
      ['Metamod:Source', 'https://mms.alliedmods.net/mmsdrop/1.12', 'mmsource'],
      ['SourceMod', 'https://sm.alliedmods.net/smdrop/1.12', 'sourcemod'],
    ]) {
      const response = await fetch(`${base}/${prefix}-latest-${platform}`, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new HttpError(502, `Could not find the latest ${label} build`);
      const name = (await response.text()).trim();
      if (!new RegExp(`^${prefix}-[\\w.-]+-${platform}\\.${platform === 'linux' ? 'tar\\.gz' : 'zip'}$`).test(name)) throw new HttpError(502, `Unexpected ${label} download name`);
      log(`Downloading ${label}: ${name}`);
      const download = await fetch(`${base}/${name}`, { signal: AbortSignal.timeout(120_000) });
      if (!download.ok || !download.body) throw new HttpError(502, `${label} download failed`);
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of download.body as unknown as AsyncIterable<Uint8Array>) {
        bytes += chunk.length;
        if (bytes > 100 * 1048576) throw new HttpError(413, 'Framework download is too large');
        chunks.push(Buffer.from(chunk));
      }
      const stage = path.join(temp, prefix);
      fs.mkdirSync(stage);
      const archive = path.join(temp, name);
      fs.writeFileSync(archive, Buffer.concat(chunks));
      if (platform === 'windows') {
        const zip = new AdmZip(archive);
        for (const entry of zip.getEntries()) {
          if (entry.isDirectory) continue;
          const rel = entry.entryName;
          if (!/^(addons|cfg)\//.test(rel) || rel.split('/').includes('..') || rel.includes('\\')) throw new HttpError(502, 'Unexpected framework archive layout');
          const file = path.join(stage, rel);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, entry.getData());
        }
      } else {
        // These archives come exclusively from AlliedModders, never from a user URL.
        const { stdout } = await exec('tar', ['-tzf', archive], { timeout: 30_000, maxBuffer: 4 * 1048576, windowsHide: true });
        if (stdout.split(/\r?\n/).filter(Boolean).some((n) => n.startsWith('/') || n.split('/').includes('..'))) throw new HttpError(502, 'Unsafe framework archive path');
        await exec('tar', ['-xzf', archive, '-C', stage], { timeout: 60_000, windowsHide: true });
      }
      function copy(dir: string) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const file = path.join(dir, entry.name);
          const relative = path.relative(stage, file).split(path.sep).join('/');
          if (entry.isSymbolicLink()) throw new HttpError(502, 'Framework archive contains a symbolic link');
          if (!/^(addons|cfg)(\/|$)/.test(relative)) throw new HttpError(502, 'Unexpected framework directory');
          if (entry.isDirectory()) copy(file);
          else {
            const target = tf2Path(server, relative);
            // Preserve the user's plugin configuration when updating frameworks.
            if (fs.existsSync(target) && /^(cfg\/|addons\/sourcemod\/configs\/)/.test(relative)) continue;
            const pluginName = relative.match(/^addons\/sourcemod\/plugins\/([^/]+\.smx)$/)?.[1];
            if (pluginName && fs.existsSync(tf2Path(server, `addons/sourcemod/plugins/disabled/${pluginName}`))) continue;
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(file, target);
            if (process.platform !== 'win32') fs.chmodSync(target, fs.statSync(file).mode & 0o777);
          }
        }
      }
      copy(stage);
      log(`${label} installed`);
    }
    const vdf = tf2Path(server, 'addons/metamod.vdf');
    if (!fs.existsSync(vdf)) fs.writeFileSync(vdf, '"Plugin"\n{\n  "file" "../tf/addons/metamod/bin/server"\n}\n');
    log('Restart TF2, then use "meta list" and "sm plugins list" in Console to verify loading.');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
