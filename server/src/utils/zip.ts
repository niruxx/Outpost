import fs from 'node:fs';
import path from 'node:path';
import type AdmZip from 'adm-zip';
import { HttpError } from './asyncHandler.js';
import { safeJoin } from './paths.js';

/** Extracts every entry of a zip into dest, refusing entries that would escape it (zip-slip). */
export function extractZipSafely(zip: AdmZip, dest: string, prefix = '') {
  for (const entry of zip.getEntries()) {
    if (!entry.entryName.startsWith(prefix)) continue;
    const rel = entry.entryName.slice(prefix.length);
    if (!rel) continue;
    let target: string;
    try {
      target = safeJoin(dest, rel);
    } catch {
      throw new HttpError(400, `Archive contains an unsafe path: ${entry.entryName}`);
    }
    if (entry.isDirectory) {
      fs.mkdirSync(target, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry.getData());
    }
  }
}
