import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PNG } from 'pngjs';
import { instanceDir, safeJoinReal } from '../utils/paths.js';
import { HttpError } from '../utils/asyncHandler.js';
import type { BannerArtwork } from '../types/index.js';

export const MAX_BANNER_BYTES = 8 * 1048576;
const TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const bannerPath = (id: string, relative: string) => safeJoinReal(instanceDir(id), `.outpost/${relative}`);
const position = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;

/** Probe raster headers before decoding PNG data or accepting large image dimensions. */
export function bannerImageInfo(buffer: Buffer): Pick<BannerArtwork, 'mime' | 'width' | 'height'> {
  if (!buffer.length || buffer.length > MAX_BANNER_BYTES) throw new HttpError(400, 'Banner images must be under 8 MB');
  let mime: BannerArtwork['mime'] | null = null, width = 0, height = 0;
  if (buffer.length >= 33 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && buffer.toString('ascii', 12, 16) === 'IHDR') {
    mime = 'image/png'; width = buffer.readUInt32BE(16); height = buffer.readUInt32BE(20);
  } else if (buffer.length >= 12 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9) {
    let at = 2;
    while (at + 4 <= buffer.length) {
      if (buffer[at++] !== 0xff) break;
      while (buffer[at] === 0xff) at++;
      const marker = buffer[at++]; if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (at + 2 > buffer.length) break;
      const length = buffer.readUInt16BE(at); if (length < 2 || at + length > buffer.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) { height = buffer.readUInt16BE(at + 3); width = buffer.readUInt16BE(at + 5); mime = 'image/jpeg'; break; }
      at += length;
    }
  } else if (buffer.length >= 20 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP' && buffer.readUInt32LE(4) + 8 === buffer.length) {
    let at = 12, raster = false;
    while (at + 8 <= buffer.length) {
      const kind = buffer.toString('ascii', at, at + 4), length = buffer.readUInt32LE(at + 4), data = at + 8;
      if (data + length > buffer.length) break;
      if (kind === 'ANIM' || (kind === 'VP8X' && length >= 10 && (buffer[data] & 2))) throw new HttpError(400, 'Use a still image for banner artwork');
      if (kind === 'VP8X' && length >= 10) { width = 1 + buffer.readUIntLE(data + 4, 3); height = 1 + buffer.readUIntLE(data + 7, 3); }
      if (kind === 'VP8 ' && length >= 10 && buffer.subarray(data + 3, data + 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))) { raster = true; width ||= buffer.readUInt16LE(data + 6) & 0x3fff; height ||= buffer.readUInt16LE(data + 8) & 0x3fff; }
      if (kind === 'VP8L' && length >= 5 && buffer[data] === 0x2f) { const bits = buffer.readUInt32LE(data + 1); raster = true; width ||= 1 + (bits & 0x3fff); height ||= 1 + ((bits >>> 14) & 0x3fff); }
      at = data + length + (length % 2);
    }
    if (raster) mime = 'image/webp';
  }
  if (!mime || width < 32 || height < 16 || width > 8192 || height > 8192 || width * height > 16_000_000) throw new HttpError(400, 'Choose a PNG, JPEG or WebP image between 32×16 and 8192×8192 pixels, up to 16 megapixels');
  if (mime === 'image/png') { try { PNG.sync.read(buffer); } catch { throw new HttpError(400, 'The PNG image is damaged or incomplete'); } }
  return { mime, width, height };
}
export function readBannerArtwork(id: string): BannerArtwork | null {
  try {
    const file = bannerPath(id, 'banner.json');
    if (!fs.existsSync(file) || fs.statSync(file).size > 2048) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof raw.version !== 'string' || !/^[a-f0-9-]{36}$/.test(raw.version) || !TYPES.includes(raw.mime) || !Number.isInteger(raw.width) || !Number.isInteger(raw.height) || !position(raw.positionX) || !position(raw.positionY)) return null;
    if (raw.width < 32 || raw.height < 16 || raw.width > 8192 || raw.height > 8192 || raw.width * raw.height > 16_000_000) return null;
    if (!fs.existsSync(bannerPath(id, `banner-${raw.version}.img`))) return null;
    return { version: raw.version, mime: raw.mime, width: raw.width, height: raw.height, positionX: raw.positionX, positionY: raw.positionY };
  } catch { return null; }
}
function writeMeta(id: string, meta: BannerArtwork) {
  const file = bannerPath(id, 'banner.json'), temp = bannerPath(id, `banner-meta-${crypto.randomUUID()}.tmp`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.writeFileSync(temp, JSON.stringify(meta)); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
export function saveBannerArtwork(id: string, buffer: Buffer): BannerArtwork {
  const info = bannerImageInfo(buffer), old = readBannerArtwork(id);
  const meta: BannerArtwork = { ...info, version: crypto.randomUUID(), positionX: 50, positionY: 50 };
  const file = bannerPath(id, `banner-${meta.version}.img`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buffer, { flag: 'wx' });
  try { writeMeta(id, meta); } catch (err) { fs.unlinkSync(file); throw err; }
  if (old) { const previous = bannerPath(id, `banner-${old.version}.img`); if (fs.existsSync(previous)) fs.unlinkSync(previous); }
  return meta;
}
export function updateBannerPosition(id: string, input: Record<string, unknown>) {
  const current = readBannerArtwork(id);
  if (!current) throw new HttpError(404, 'No custom banner uploaded');
  if (input.version !== current.version) throw new HttpError(409, 'The banner changed. Reload before adjusting its crop.');
  if (!position(input.positionX) || !position(input.positionY)) throw new HttpError(400, 'Banner positions must be between 0 and 100');
  const next = { ...current, positionX: input.positionX as number, positionY: input.positionY as number };
  writeMeta(id, next); return next;
}
export function removeBannerArtwork(id: string, version: unknown) {
  const current = readBannerArtwork(id); if (!current) return;
  if (version !== current.version) throw new HttpError(409, 'The banner changed. Reload before removing it.');
  fs.unlinkSync(bannerPath(id, 'banner.json'));
  const image = bannerPath(id, `banner-${current.version}.img`); if (fs.existsSync(image)) fs.unlinkSync(image);
}
export function bannerFile(id: string, version?: unknown) {
  const meta = readBannerArtwork(id);
  if (!meta || (version !== undefined && version !== meta.version)) throw new HttpError(404, 'Banner artwork not found');
  return { ...meta, file: bannerPath(id, `banner-${meta.version}.img`) };
}
