import fs from 'node:fs';
import path from 'node:path';
import { instanceDir } from '../utils/paths.js';

/**
 * File change history. Every edit made through Outpost (file manager, uploads, SFTP, the
 * Configuration tab's server.properties, plugin config editors…) is stored with its audit entry,
 * so the Activity views can show what changed in the file, who changed it and when.
 *
 * Only the changed region is kept, plus a few unchanged lines on each side for context. Secret-
 * looking lines are masked before anything is stored, and key/env files are never recorded.
 */

/** Files above this size are recorded as "changed" without their content. */
const MAX_BYTES = 128 * 1024;
/** The stored before/after region is cut at this many characters each. */
const MAX_REGION_CHARS = 64 * 1024;
/** Unchanged lines kept on each side of the change. */
const CONTEXT_LINES = 3;
/** Above this many LCS cells the +/- counts fall back to the region sizes. */
const MAX_COUNT_CELLS = 1_000_000;

export interface FileSnapshot {
  exists: boolean;
  text?: string;
  reason?: string;
  directory?: boolean;
}

export type FileChangeKind = 'created' | 'edited' | 'deleted' | 'renamed';

/** What's stored in `audit_log.file_change` (JSON). Older rows only have path/created/line/before/after/reason. */
export interface FileChangeRecord {
  path: string;
  kind: FileChangeKind;
  /** Previous path, for renames and moves. */
  from?: string;
  directory?: boolean;
  /** Set when the content isn't shown (binary, too large, sensitive…). */
  reason?: string;
  /** 1-based line where the changed region starts (the same in both versions). */
  line?: number;
  /** The changed lines before and after (older records stored them "\n"-joined). */
  before?: string[] | string;
  after?: string[] | string;
  contextBefore?: string[];
  contextAfter?: string[];
  added?: number;
  removed?: number;
  truncated?: boolean;
  /** Legacy field, kept so the viewer can read either shape. */
  created?: boolean;
}

const MISSING: FileSnapshot = { exists: false, text: '' };

/**
 * Reads a file for the history, bounded before loading. Never throws: a folder, an unreadable file
 * or a vanished one still yields a snapshot, so recording history can't break the write itself.
 */
export function snapshotFile(target: string): FileSnapshot {
  try {
    const stat = fs.statSync(target);
    if (stat.isDirectory()) return { exists: true, directory: true };
    if (stat.size > MAX_BYTES) return { exists: true, reason: 'File exceeds the 128 KB history limit.' };
    return snapshotBuffer(fs.readFileSync(target));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return MISSING;
    return { exists: true, reason: 'The file could not be read for the history.' };
  }
}

export function snapshotBuffer(buffer: Buffer): FileSnapshot {
  if (buffer.length > MAX_BYTES) return { exists: true, reason: 'File exceeds the 128 KB history limit.' };
  const text = buffer.toString('utf8');
  if (text.includes('\0') || !Buffer.from(text).equals(buffer)) return { exists: true, reason: 'Binary file content is not recorded.' };
  return { exists: true, text };
}

const SECRET_LINE = /password|passphrase|secret|token|api[_-]?key|private[_-]?key|credential|authorization|cookie/i;
const SENSITIVE_FILE = /\.pem$|\.key$|(^|[/\\])\.env|id_rsa|id_ed25519/i;

function mask(text: string): string[] {
  return text.split(/\r?\n/).map((line) => (SECRET_LINE.test(line) ? '[Sensitive line hidden]' : line));
}

/** Line counts of what was added and removed, via LCS when the region is small enough. */
function countChanges(a: string[], b: string[]): { added: number; removed: number } {
  const n = a.length, m = b.length;
  if (!n || !m || (n + 1) * (m + 1) > MAX_COUNT_CELLS) return { added: m, removed: n };
  let prev = new Uint32Array(m + 1);
  let curr = new Uint32Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) curr[j] = a[i] === b[j] ? prev[j + 1] + 1 : Math.max(prev[j], curr[j + 1]);
    [prev, curr] = [curr, prev];
  }
  const common = prev[0];
  return { added: m - common, removed: n - common };
}

/** Keeps whole lines, up to MAX_REGION_CHARS characters in all. */
function clip(lines: string[]): { lines: string[]; cut: boolean } {
  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    total += lines[i].length + 1;
    if (total > MAX_REGION_CHARS) return { lines: lines.slice(0, i), cut: true };
  }
  return { lines, cut: false };
}

function kindOf(before: FileSnapshot, after: FileSnapshot): FileChangeKind {
  if (!before.exists && after.exists) return 'created';
  if (before.exists && !after.exists) return 'deleted';
  return 'edited';
}

/** The change between two snapshots, as stored JSON — or undefined when nothing changed. */
export function fileChange(filePath: string, before: FileSnapshot, after: FileSnapshot): string | undefined {
  const kind = kindOf(before, after);
  if (!before.exists && !after.exists) return undefined;
  if (kind === 'edited' && before.text !== undefined && before.text === after.text) return undefined;
  const base = { path: filePath, kind };
  if (before.directory || after.directory) {
    return kind === 'edited' ? undefined : JSON.stringify({ ...base, directory: true, reason: kind === 'deleted' ? 'Folder deleted with everything in it.' : 'Folder created.' } satisfies FileChangeRecord);
  }
  if (before.reason || after.reason) return JSON.stringify({ ...base, reason: before.reason ?? after.reason } satisfies FileChangeRecord);
  if (SENSITIVE_FILE.test(filePath) || /-----BEGIN .*PRIVATE KEY-----/.test((before.text ?? '') + (after.text ?? ''))) {
    return JSON.stringify({ ...base, reason: 'Sensitive file content is not recorded.' } satisfies FileChangeRecord);
  }

  // A missing file has no lines at all (not one empty line), so a creation is all additions.
  const oldLines = before.exists && before.text ? mask(before.text) : [];
  const newLines = after.exists && after.text ? mask(after.text) : [];
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let endOld = oldLines.length, endNew = newLines.length;
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) { endOld--; endNew--; }
  if (kind === 'edited' && start === endOld && start === endNew) {
    return JSON.stringify({ ...base, reason: 'Only hidden (sensitive) lines changed.' } satisfies FileChangeRecord);
  }

  const removedLines = oldLines.slice(start, endOld);
  const addedLines = newLines.slice(start, endNew);
  // Arrays, not joined text: "no lines" and "one empty line" must stay distinguishable.
  const beforeText = clip(removedLines);
  const afterText = clip(addedLines);
  const record: FileChangeRecord = {
    ...base,
    line: start + 1,
    before: beforeText.lines,
    after: afterText.lines,
    contextBefore: oldLines.slice(Math.max(0, start - CONTEXT_LINES), start),
    contextAfter: oldLines.slice(endOld, endOld + CONTEXT_LINES),
    ...countChanges(removedLines, addedLines),
    ...(beforeText.cut || afterText.cut ? { truncated: true } : {}),
  };
  return JSON.stringify(record);
}

/** A rename or move. Content doesn't change, so only the two paths are stored. */
export function renameChange(from: string, to: string, directory = false): string {
  return JSON.stringify({ path: to, from, kind: 'renamed', ...(directory ? { directory: true } : {}) } satisfies FileChangeRecord);
}

/** Path of a file inside an instance, as the file manager shows it ("plugins/x/config.yml"). */
export function instanceRelative(serverId: string, absolute: string): string {
  return path.relative(instanceDir(serverId), absolute).split(path.sep).join('/');
}

/**
 * Snapshots `absolute`, runs `write`, snapshots it again and returns the change. Use around any
 * code that edits a file the user cares about:
 *   const change = await recordFileChange(abs, rel, () => fs.writeFileSync(abs, text));
 */
export async function recordFileChange(absolute: string, relative: string, write: () => unknown): Promise<string | undefined> {
  const before = snapshotFile(absolute);
  await write();
  return fileChange(relative, before, snapshotFile(absolute));
}

/** Synchronous `recordFileChange`, for services that write with the sync fs API. */
export function recordFileChangeSync(absolute: string, relative: string, write: () => void): string | undefined {
  const before = snapshotFile(absolute);
  write();
  return fileChange(relative, before, snapshotFile(absolute));
}

/** The stored path of a change, for the `file_path` column ("history of this file"). */
export function changePath(change: string | undefined): string | null {
  if (!change) return null;
  try {
    const p = (JSON.parse(change) as { path?: unknown }).path;
    return typeof p === 'string' ? p.slice(0, 1000) : null;
  } catch {
    return null;
  }
}
