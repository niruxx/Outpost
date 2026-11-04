// prismarine-nbt and prismarine-provider-anvil have no published type definitions.
// Minimal ambient declarations covering only what mapService.ts actually uses.

declare module 'prismarine-provider-anvil' {
  export interface PCChunk {
    minY: number;
    worldHeight: number;
    getBlockType(pos: { x: number; y: number; z: number }): number;
    getBlock(pos: { x: number; y: number; z: number }): { name: string; type: number };
  }

  export interface AnvilInstance {
    load(x: number, z: number): Promise<PCChunk | null>;
  }

  export interface AnvilConstructor {
    new (worldPath: string): AnvilInstance;
  }

  export function Anvil(version: string): AnvilConstructor;
}

declare module 'prismarine-nbt' {
  export interface NbtTag { type: string; value: any; name?: string }
  export function parse(buffer: Buffer, format?: 'big' | 'little' | 'littleVarint'): Promise<{ parsed: NbtTag; type: string }>;
  export function simplify(nbt: unknown): Record<string, unknown>;
  export function writeUncompressed(value: NbtTag, format?: 'big' | 'little' | 'littleVarint'): Buffer;
  const nbt: {
    parse: typeof parse;
    simplify: typeof simplify;
    writeUncompressed: typeof writeUncompressed;
  };
  export default nbt;
}
