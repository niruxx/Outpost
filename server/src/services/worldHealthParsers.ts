import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import * as nbt from 'prismarine-nbt';

export interface WorldFinding { code: string; severity: 'error' | 'warning'; message: string; chunk?: number; x?: number; z?: number }
export interface WorldFileCheck { file: string; kind: 'region' | 'level' | 'terraria'; hash: string; bytes: number; findings: WorldFinding[]; checked: number; cells?: string; identity?: string; title?: string; version?: number; rx?: number; rz?: number; padSafe?: boolean; companion?: boolean; externalChunks?: boolean }
export const digest = (buffer: Buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
export function confinedFile(root: string, relative: string) {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).some(p => p === '..') || relative.includes('\0')) throw new Error('Invalid world path');
  const target = path.resolve(root, relative), base = fs.realpathSync(root);
  if (target !== path.resolve(root) && !target.startsWith(path.resolve(root) + path.sep)) throw new Error('World path escapes instance');
  let cursor = root; for (const part of relative.split(/[\\/]/).filter(Boolean)) { cursor = path.join(cursor, part); if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error('World symlinks are excluded'); }
  if (fs.existsSync(target)) { const real = fs.realpathSync(target); if (real !== base && !real.startsWith(base + path.sep)) throw new Error('World path escapes instance'); }
  return target;
}
export function readWorldBytes(root: string, relative: string, maximum = 128 * 1048576) {
  const file = confinedFile(root, relative), fd = fs.openSync(file, 'r');
  try {
    const before = fs.fstatSync(fd); if (!before.isFile() || before.size > maximum) throw new Error('World file exceeds the bounded read size');
    const bytes = Buffer.alloc(before.size); let at = 0;
    while (at < bytes.length) { const read = fs.readSync(fd, bytes, at, bytes.length - at, at); if (!read) throw new Error('World file changed during reading'); at += read; }
    const after = fs.fstatSync(fd); if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('World file changed during reading');
    return bytes;
  } finally { fs.closeSync(fd); }
}
function unpack(bytes: Buffer, compression: number) {
  if (compression === 1) return zlib.gunzipSync(bytes, { maxOutputLength: 32 * 1048576 });
  if (compression === 2) return zlib.inflateSync(bytes, { maxOutputLength: 32 * 1048576 });
  if (compression === 3 && bytes.length <= 32 * 1048576) return bytes;
  throw new Error('Unsupported compression or decompressed size limit');
}
export function inspectLevel(buffer: Buffer, file: string): WorldFileCheck {
  const result: WorldFileCheck = { file, kind: 'level', hash: digest(buffer), bytes: buffer.length, findings: [], checked: 0 };
  try {
    const parsed = nbt.parseUncompressed(unpack(buffer, 1));
    const data = parsed.value.Data;
    if (!data || data.type !== 'compound') throw new Error('Missing Data compound');
    result.title = typeof data.value.LevelName?.value === 'string' ? data.value.LevelName.value : undefined;
    const generation = data.value.WorldGenSettings;
    const seed = data.value.RandomSeed ?? (generation?.type === 'compound' ? generation.value.seed : undefined);
    if (seed) result.identity = JSON.stringify(seed.value);
    result.checked = 1;
  } catch (err) { result.findings.push({ code: 'level-unreadable', severity: 'error', message: `level.dat cannot be decoded: ${err instanceof Error ? err.message : 'invalid NBT'}` }); }
  return result;
}
/** Read-only Anvil checks. No provider API is used, because some providers modify headers on open. */
export function inspectRegion(buffer: Buffer, file: string, external?: (name: string) => Buffer): WorldFileCheck {
  const match = path.basename(file).match(/^r\.(-?\d+)\.(-?\d+)\.mca(?:\.bak)?$/);
  const rx = Number(match?.[1] ?? 0), rz = Number(match?.[2] ?? 0);
  const result: WorldFileCheck = { file, kind: 'region', hash: digest(buffer), bytes: buffer.length, findings: [], checked: 0, rx, rz };
  const cells = Array<string>(1024).fill('.');
  const issue = (code: string, severity: 'error' | 'warning', message: string, chunk?: number) => { result.findings.push({ code, severity, message, ...(chunk !== undefined ? { chunk, x: rx * 32 + chunk % 32, z: rz * 32 + Math.floor(chunk / 32) } : {}) }); if (chunk !== undefined) cells[chunk] = severity === 'error' ? '!' : cells[chunk] === '!' ? '!' : '?'; };
  if (buffer.length < 8192) { issue('region-header', 'error', 'Region file is shorter than its two header sectors.'); result.cells = '?'.repeat(1024); return result; }
  const owners = new Map<number, number>(); const invalid = new Set<number>();
  for (let i = 0; i < 1024; i++) {
    const location = buffer.readUInt32BE(i * 4), offset = location >>> 8, sectors = location & 255;
    if (!location) continue; cells[i] = '+';
    if (offset < 2 || !sectors || (offset + sectors) * 4096 > Math.ceil(buffer.length / 4096) * 4096) { issue('chunk-location', 'error', 'Chunk location points into the header, has no sectors, or extends past the file.', i); invalid.add(i); continue; }
    for (let sector = offset; sector < offset + sectors; sector++) {
      const owner = owners.get(sector);
      if (owner !== undefined) { if (!invalid.has(owner)) issue('chunk-overlap', 'error', 'Two chunk entries claim the same sector.', owner); if (!invalid.has(i)) issue('chunk-overlap', 'error', 'Two chunk entries claim the same sector.', i); invalid.add(owner); invalid.add(i); }
      else owners.set(sector, i);
    }
  }
  for (let i = 0; i < 1024; i++) {
    const location = buffer.readUInt32BE(i * 4); if (!location || invalid.has(i)) continue;
    const start = (location >>> 8) * 4096, allocated = (location & 255) * 4096;
    try {
      if (start + 5 > buffer.length) throw new Error('Chunk header is truncated');
      const length = buffer.readUInt32BE(start), tag = buffer[start + 4], compression = tag & 127;
      if (tag & 128) result.externalChunks = true;
      if (length < 1 || length + 4 > allocated || start + 4 + length > buffer.length) throw new Error('Chunk payload length is outside its allocation');
      if (![1, 2, 3].includes(compression)) { issue('chunk-compression', 'warning', `Compression ${compression} is not supported by this checker (including LZ4/custom formats).`, i); continue; }
      let bytes: Buffer;
      if (tag & 128) { result.externalChunks = true; if (length !== 1 || !external) throw new Error('External chunk metadata is invalid'); bytes = external(`c.${rx * 32 + i % 32}.${rz * 32 + Math.floor(i / 32)}.mcc`); }
      else bytes = buffer.subarray(start + 5, start + 4 + length);
      const parsed = nbt.parseUncompressed(unpack(bytes, compression));
      const value = parsed.value.Level?.type === 'compound' ? parsed.value.Level.value : parsed.value;
      const x = value.xPos?.value, z = value.zPos?.value;
      const terrain = path.basename(path.dirname(file)) === 'region';
      if ((terrain && (typeof x !== 'number' || typeof z !== 'number')) || (typeof x === 'number' && x !== rx * 32 + i % 32) || (typeof z === 'number' && z !== rz * 32 + Math.floor(i / 32))) throw new Error('Chunk coordinates are absent or disagree with the region slot');
      result.checked++;
    } catch (err) { const text = err instanceof Error ? err.message : 'Invalid compressed NBT'; issue(/size limit|maxOutputLength|larger than/i.test(text) ? 'chunk-limit' : 'chunk-unreadable', /size limit|maxOutputLength|larger than/i.test(text) ? 'warning' : 'error', text, i); }
  }
  if (buffer.length % 4096) {
    result.padSafe = result.findings.length === 0;
    issue('region-padding', 'warning', 'Region length is not sector-aligned. If all chunk records pass, zero-padding the unused tail is available.');
  }
  result.cells = cells.join(''); return result;
}
function readString(buffer: Buffer, cursor: { at: number }) {
  let length = 0, shift = 0;
  for (let n = 0; n < 5; n++) { if (cursor.at >= buffer.length) throw new Error('Truncated string length'); const byte = buffer[cursor.at++]; length += (byte & 127) * 2 ** shift; if (!(byte & 128)) { if (length > 4096 || cursor.at + length > buffer.length) throw new Error('World string is truncated or too large'); const value = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(cursor.at, cursor.at + length)); cursor.at += length; return value; } shift += 7; }
  throw new Error('Invalid string length');
}
/** Structural envelope checks only: tile/chest/NPC semantic data is not rewritten or certified. */
export function inspectTerraria(buffer: Buffer, file: string): WorldFileCheck {
  const result: WorldFileCheck = { file, kind: 'terraria', hash: digest(buffer), bytes: buffer.length, findings: [], checked: 0 };
  try {
    if (buffer.length < 4) throw new Error('World file is truncated');
    const version = buffer.readUInt32LE(0); result.version = version;
    if (version < 140 || version > 323) { result.findings.push({ code: 'terraria-version', severity: 'warning', message: `World format ${version} is outside this checker's supported 140–323 envelope. It is not being labeled corrupt.` }); return result; }
    if (buffer.length >= 11 && buffer.toString('ascii', 4, 11) === 'xindong') { result.findings.push({ code: 'terraria-edition', severity: 'warning', message: 'Chinese-edition worlds are not supported by this desktop checker.' }); return result; }
    if (buffer.length < 28 || buffer.toString('ascii', 4, 11) !== 'relogic' || buffer[11] !== 2) throw new Error('Invalid desktop world signature or file type');
    const count = buffer.readInt16LE(24); if (count < 6 || count > 32 || 28 + count * 4 > buffer.length) throw new Error('Section table is invalid or truncated');
    const pointers = Array.from({ length: count }, (_, i) => buffer.readInt32LE(26 + i * 4));
    const bits = buffer.readInt16LE(26 + count * 4), headerEnd = 28 + count * 4 + Math.ceil(bits / 8);
    if (bits < 0 || headerEnd !== pointers[0]) throw new Error('Tile-frame header length does not match the first section boundary');
    if (pointers.some((p, i) => p < headerEnd || p >= buffer.length || (i > 0 && p < pointers[i - 1]))) throw new Error('World sections overlap, run backward, or extend past the file');
    const cursor = { at: pointers[0] }; result.title = readString(buffer, cursor);
    if (version >= 179) { if (version === 179) cursor.at += 4; else readString(buffer, cursor); cursor.at += 8; }
    let guid = ''; if (version >= 181) { guid = buffer.subarray(cursor.at, cursor.at + 16).toString('hex'); cursor.at += 16; }
    if (cursor.at + 28 > pointers[1]) throw new Error('World identity or dimensions are truncated');
    const id = buffer.readInt32LE(cursor.at); result.identity = `${id}:${guid}`;
    const height = buffer.readInt32LE(cursor.at + 20), width = buffer.readInt32LE(cursor.at + 24);
    if (width <= 0 || height <= 0 || width > 100000 || height > 100000) throw new Error('World dimensions are invalid');
    const footer = { at: pointers.at(-1)! };
    if (buffer[footer.at++] !== 1 || readString(buffer, footer) !== result.title || footer.at + 4 > buffer.length || buffer.readInt32LE(footer.at) !== id) throw new Error('World footer is truncated or does not match its identity');
    result.checked = count;
  } catch (err) { result.findings.push({ code: 'terraria-structure', severity: 'error', message: err instanceof Error ? err.message : 'Invalid world envelope' }); }
  return result;
}
export function inspectWorldFile(root: string, file: string, kind: WorldFileCheck['kind']): WorldFileCheck {
  const target = confinedFile(root, file), stat = fs.statSync(target);
  if (!stat.isFile()) throw new Error('World input is not a regular file');
  const maximum = kind === 'terraria' ? 128 * 1048576 : kind === 'region' ? 64 * 1048576 : 8 * 1048576;
  if (stat.size > maximum) return { file, kind, hash: '', bytes: stat.size, checked: 0, findings: [{ code: 'file-limit', severity: 'warning', message: 'File exceeds the bounded checker size. No corruption verdict or automatic fix is offered.' }] };
  const buffer = readWorldBytes(root, file, maximum);
  if (kind === 'region') return inspectRegion(buffer, file, name => readWorldBytes(root, path.posix.join(path.posix.dirname(file), name), 32 * 1048576));
  return kind === 'level' ? inspectLevel(buffer, file) : inspectTerraria(buffer, file);
}
