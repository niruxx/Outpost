declare module 'archiver' {
  import type { Readable, Transform } from 'node:stream';
  import type { ZlibOptions } from 'node:zlib';

  export class ZipArchive extends Transform {
    constructor(options?: { zlib?: ZlibOptions });
    append(source: Buffer | string | Readable, options: {
      name: string; type?: 'file' | 'directory'; mode?: number; date?: Date; store?: boolean;
    }): this;
    finalize(): Promise<void>;
    abort(): this;
  }
}
