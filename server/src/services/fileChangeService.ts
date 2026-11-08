import fs from 'node:fs';

const MAX_BYTES = 128 * 1024;
export interface FileSnapshot { text?: string; reason?: string; exists: boolean }

/** Bound reads before loading content, including uploads over binary or large files. */
export function snapshotFile(target: string): FileSnapshot {
  try {
    if (fs.statSync(target).size > MAX_BYTES) return { exists: true, reason: 'File exceeds the 128 KB history limit.' };
    return snapshotBuffer(fs.readFileSync(target));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, text: '' };
    throw err;
  }
}

export function snapshotBuffer(buffer: Buffer): FileSnapshot {
  if (buffer.length > MAX_BYTES) return { exists: true, reason: 'File exceeds the 128 KB history limit.' };
  const text = buffer.toString('utf8');
  if (text.includes('\0') || !Buffer.from(text).equals(buffer)) return { exists: true, reason: 'Binary file content is not recorded.' };
  return { exists: true, text };
}

function mask(text: string): string {
  return text.split('\n').map((line) => /password|passphrase|secret|token|api[_-]?key|private[_-]?key|credential|authorization|cookie/i.test(line) ? '[Sensitive line hidden]' : line).join('\n');
}

/** Store only the changed region, with a line number and common secret fields masked. */
export function fileChange(filePath: string, before: FileSnapshot, after: FileSnapshot): string | undefined {
  if (before.text !== undefined && before.text === after.text && before.exists === after.exists) return undefined;
  if (before.reason || after.reason) return JSON.stringify({ path: filePath, reason: before.reason ?? after.reason });
  if (/\.pem$|\.key$|(^|[/\\])\.env|id_rsa|id_ed25519/i.test(filePath) || /-----BEGIN .*PRIVATE KEY-----/.test((before.text ?? '') + (after.text ?? ''))) {
    return JSON.stringify({ path: filePath, reason: 'Sensitive file content is not recorded.' });
  }
  const oldLines = mask(before.text ?? '').split('\n');
  const newLines = mask(after.text ?? '').split('\n');
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let endOld = oldLines.length, endNew = newLines.length;
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) { endOld--; endNew--; }
  return JSON.stringify({ path: filePath, created: !before.exists, line: start + 1, before: oldLines.slice(start, endOld).join('\n'), after: newLines.slice(start, endNew).join('\n'), reason: start === oldLines.length && start === newLines.length ? 'Only sensitive content changed.' : undefined });
}
