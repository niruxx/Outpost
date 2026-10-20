import fs from 'node:fs';
import { isModded } from './moddedService.js';
import path from 'node:path';
import { PNG } from 'pngjs';
import { Anvil } from 'prismarine-provider-anvil';
import { instanceDir, mapCachePath } from '../utils/paths.js';
import { readServerProperties } from './propertiesService.js';
import { renderBedrockMap } from './bedrockMapService.js';
import { HttpError } from '../utils/asyncHandler.js';
import type { LogFn } from '../utils/download.js';
import type { Loader, ServerRecord } from '../types/index.js';
import {
  type MapMeta,
  SKIP_TOP_SURFACE,
  EXACT_COLORS,
  MAX_WATER_DEPTH_SAMPLE,
  colorForBlockName,
  shadeForWaterDepth,
  computeBlocksPerPixel,
  writeMapPng,
  writeMapMeta,
} from './mapShared.js';

export type { MapMeta } from './mapShared.js';

/** Java worlds render via the Anvil/NBT format; Bedrock worlds via their LevelDB store
 *  (see bedrockMapService.ts). Both are pure-JS, no native dependencies required. */
export function isMapCapable(loader: Loader): boolean {
  return loader === 'vanilla' || loader === 'paper' || loader === 'purpur' || loader === 'spigot' || loader === 'bedrock' || isModded(loader);
}

// The exact Minecraft version string barely matters for parsing: the on-disk chunk NBT layout
// has been unchanged since 1.18, so prismarine-chunk's "1.18" parser correctly reads any newer
// world too, even ones prismarine's own version list doesn't explicitly know about yet.
const CHUNK_FORMAT_FALLBACKS = ['1.21.1', '1.20.4', '1.19.4', '1.18.2', '1.18'];

const REGION_RE = /^r\.(-?\d+)\.(-?\d+)\.mca$/;

// --- World location ---------------------------------------------------------

function worldDirFor(server: ServerRecord): string {
  const props = readServerProperties(server.id, server.platform);
  const levelName = props.find((p) => p.key === 'level-name')?.value?.trim() || 'world';
  const dir = path.join(instanceDir(server.id), levelName);
  if (!fs.existsSync(path.join(dir, 'region'))) {
    throw new HttpError(404, `No world found yet at "${levelName}" — start the server at least once so it generates spawn chunks.`);
  }
  return dir;
}

async function openAnvil(worldDir: string, version: string) {
  const candidates = [version, ...CHUNK_FORMAT_FALLBACKS];
  let lastErr: unknown;
  for (const candidate of candidates) {
    try {
      const AnvilCtor = Anvil(candidate);
      const anvil = new AnvilCtor(worldDir);
      return anvil;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`Could not initialize a chunk parser for version "${version}": ${lastErr instanceof Error ? lastErr.message : lastErr}`);
}

// --- Rendering ---------------------------------------------------------

export async function renderMap(server: ServerRecord, onLog?: LogFn): Promise<MapMeta> {
  if (!isMapCapable(server.loader)) {
    throw new HttpError(400, 'Map rendering currently supports Java worlds (Vanilla/Paper/Purpur/Spigot) and Bedrock worlds.');
  }

  if (server.platform === 'bedrock') {
    return renderBedrockMap(server, onLog);
  }

  const worldDir = worldDirFor(server);
  const regionDir = path.join(worldDir, 'region');
  const regionFiles = fs
    .readdirSync(regionDir)
    .map((name) => ({ name, match: name.match(REGION_RE) }))
    .filter((f): f is { name: string; match: RegExpMatchArray } => !!f.match)
    .map((f) => ({ name: f.name, rx: Number(f.match[1]), rz: Number(f.match[2]) }));

  if (regionFiles.length === 0) {
    throw new HttpError(404, 'The world folder exists but has no region files yet — nothing has been generated/explored.');
  }
  onLog?.(`==> Found ${regionFiles.length} region file(s) in ${path.relative(instanceDir(server.id), worldDir)}`);

  let minChunkX = Infinity, maxChunkX = -Infinity, minChunkZ = Infinity, maxChunkZ = -Infinity;
  for (const r of regionFiles) {
    minChunkX = Math.min(minChunkX, r.rx * 32);
    maxChunkX = Math.max(maxChunkX, r.rx * 32 + 31);
    minChunkZ = Math.min(minChunkZ, r.rz * 32);
    maxChunkZ = Math.max(maxChunkZ, r.rz * 32 + 31);
  }

  const widthBlocksFull = (maxChunkX - minChunkX + 1) * 16;
  const heightBlocksFull = (maxChunkZ - minChunkZ + 1) * 16;
  const blocksPerPixel = computeBlocksPerPixel(widthBlocksFull, heightBlocksFull);
  const widthPx = Math.ceil(widthBlocksFull / blocksPerPixel);
  const heightPx = Math.ceil(heightBlocksFull / blocksPerPixel);
  const minBlockX = minChunkX * 16;
  const minBlockZ = minChunkZ * 16;

  onLog?.(`==> World spans ${widthBlocksFull}x${heightBlocksFull} blocks -> rendering at ${blocksPerPixel} block(s)/pixel (${widthPx}x${heightPx}px)`);

  // Anvil's path argument must point directly at the region/ folder, not the world root —
  // it builds region-file paths as `${path}/r.x.z.mca` with no further subdirectory.
  const anvil = await openAnvil(regionDir, server.version);
  const png = new PNG({ width: widthPx, height: heightPx });
  png.data.fill(0); // fully transparent where nothing has been explored

  let chunksRendered = 0;
  let lastLoggedPct = -1;
  const totalChunks = regionFiles.length * 1024;
  let chunksChecked = 0;

  for (const region of regionFiles) {
    for (let cxLocal = 0; cxLocal < 32; cxLocal++) {
      for (let czLocal = 0; czLocal < 32; czLocal++) {
        chunksChecked++;
        const chunkX = region.rx * 32 + cxLocal;
        const chunkZ = region.rz * 32 + czLocal;

        // Skip chunks that don't map to at least one sampled pixel at this scale, to avoid
        // decompressing/parsing NBT we'd immediately throw away on heavily downsampled worlds.
        const baseBlockX = chunkX * 16;
        const baseBlockZ = chunkZ * 16;
        if (blocksPerPixel > 1 && baseBlockX % blocksPerPixel >= 16 && baseBlockZ % blocksPerPixel >= 16) continue;

        let chunk;
        try {
          chunk = await anvil.load(chunkX, chunkZ);
        } catch {
          continue; // corrupt/partial chunk — skip rather than fail the whole render
        }
        if (!chunk) continue;
        chunksRendered++;

        for (let lx = 0; lx < 16; lx += blocksPerPixel) {
          for (let lz = 0; lz < 16; lz += blocksPerPixel) {
            const worldX = baseBlockX + lx;
            const worldZ = baseBlockZ + lz;
            const px = Math.floor((worldX - minBlockX) / blocksPerPixel);
            const py = Math.floor((worldZ - minBlockZ) / blocksPerPixel);
            if (px < 0 || px >= widthPx || py < 0 || py >= heightPx) continue;

            const color = sampleColumn(chunk, lx, lz);
            if (!color) continue;
            const idx = (widthPx * py + px) << 2;
            png.data[idx] = color.r;
            png.data[idx + 1] = color.g;
            png.data[idx + 2] = color.b;
            png.data[idx + 3] = 255;
          }
        }
      }
    }
    const pct = Math.round((chunksChecked / totalChunks) * 100);
    if (pct >= lastLoggedPct + 20) {
      lastLoggedPct = pct;
      onLog?.(`  ... ${pct}% (${chunksRendered} chunk(s) with data so far)`);
    }
  }

  await writeMapPng(png, server.id);

  const result: MapMeta = {
    generatedAt: new Date().toISOString(),
    widthPx,
    heightPx,
    blocksPerPixel,
    minBlockX,
    minBlockZ,
    chunksRendered,
    regionsScanned: regionFiles.length,
  };
  writeMapMeta(server.id, result);
  onLog?.(`==> Map rendered: ${widthPx}x${heightPx}px from ${chunksRendered} chunk(s)`);
  return result;
}

function sampleColumn(chunk: import('prismarine-provider-anvil').PCChunk, lx: number, lz: number): { r: number; g: number; b: number } | null {
  const topY = chunk.minY + chunk.worldHeight - 1;
  let waterDepth = 0;
  for (let y = topY; y >= chunk.minY; y--) {
    const pos = { x: lx, y, z: lz };
    if (chunk.getBlockType(pos) === 0) continue; // air
    const block = chunk.getBlock(pos);
    if (SKIP_TOP_SURFACE.has(block.name)) continue;
    if (block.name === 'water' || block.name === 'flowing_water') {
      waterDepth++;
      if (waterDepth <= MAX_WATER_DEPTH_SAMPLE) continue;
      return shadeForWaterDepth(EXACT_COLORS.stone, waterDepth);
    }
    const [r, g, b] = colorForBlockName(block.name);
    return waterDepth > 0 ? shadeForWaterDepth([r, g, b], waterDepth) : { r, g, b };
  }
  return null; // column is entirely air/void — leave transparent
}

export function getMapMeta(serverId: string): MapMeta | null {
  const { meta } = mapCachePath(serverId);
  if (!fs.existsSync(meta)) return null;
  try {
    return JSON.parse(fs.readFileSync(meta, 'utf8'));
  } catch {
    return null;
  }
}

export function getMapImagePath(serverId: string): string {
  const { image } = mapCachePath(serverId);
  if (!fs.existsSync(image)) throw new HttpError(404, 'No map has been generated yet');
  return image;
}
