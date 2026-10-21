import dgram from 'node:dgram';

/**
 * Valve's server query protocol (A2S) — what the Steam server browser uses to show a server's
 * name, map and players. Handles the challenge handshake (A2S_INFO has required one since 2020)
 * and multi-packet responses; bzip2-compressed split packets (only very old Source builds sent
 * them) are reported as an error.
 * https://developer.valvesoftware.com/wiki/Server_queries
 */

export interface A2sInfo {
  name: string;
  map: string;
  folder: string;
  game: string;
  appId: number | null;
  players: number;
  maxPlayers: number;
  bots: number;
  serverType: string;
  environment: string;
  passworded: boolean;
  vac: boolean;
  version: string | null;
  keywords: string | null;
  /** Round-trip time of the info query, in ms. */
  pingMs: number;
}

export interface A2sPlayer {
  name: string;
  score: number;
  durationSec: number;
}

export interface A2sOptions {
  timeoutMs?: number;
  /** GoldSrc (Half-Life 1 engine) splits long replies with a different header. */
  goldsrc?: boolean;
}

const HEADER = Buffer.from([0xff, 0xff, 0xff, 0xff]);
const INFO_REQUEST = Buffer.concat([HEADER, Buffer.from('TSource Engine Query\0', 'latin1')]);
const S2C_CHALLENGE = 0x41;

class Reader {
  offset = 0;
  constructor(private buf: Buffer) {}
  get remaining() {
    return this.buf.length - this.offset;
  }
  byte() {
    if (this.remaining < 1) throw new Error('Truncated A2S reply');
    return this.buf.readUInt8(this.offset++);
  }
  short() {
    const v = this.buf.readUInt16LE(this.offset);
    this.offset += 2;
    return v;
  }
  long() {
    const v = this.buf.readInt32LE(this.offset);
    this.offset += 4;
    return v;
  }
  float() {
    const v = this.buf.readFloatLE(this.offset);
    this.offset += 4;
    return v;
  }
  longlong() {
    const v = this.buf.readBigUInt64LE(this.offset);
    this.offset += 8;
    return v;
  }
  string() {
    const end = this.buf.indexOf(0, this.offset);
    if (end < 0) throw new Error('Truncated A2S reply');
    const s = this.buf.toString('utf8', this.offset, end);
    this.offset = end + 1;
    return s;
  }
}

const SERVER_TYPE: Record<string, string> = { d: 'dedicated', l: 'listen', p: 'SourceTV' };
const ENVIRONMENT: Record<string, string> = { l: 'Linux', w: 'Windows', m: 'macOS', o: 'macOS' };

/** Parses an A2S_INFO reply payload (after the 0xFFFFFFFF header), Source or old GoldSrc style. */
export function parseInfo(payload: Buffer, pingMs = 0): A2sInfo {
  const r = new Reader(payload);
  const kind = r.byte();
  if (kind === 0x6d) {
    // Obsolete GoldSrc reply
    r.string(); // address
    const name = r.string();
    const map = r.string();
    const folder = r.string();
    const game = r.string();
    const players = r.byte();
    const maxPlayers = r.byte();
    r.byte(); // protocol
    const serverType = String.fromCharCode(r.byte()).toLowerCase();
    const environment = String.fromCharCode(r.byte()).toLowerCase();
    const passworded = r.byte() === 1;
    if (r.byte() === 1) {
      r.string();
      r.string();
      r.byte();
      r.long();
      r.long();
      r.byte();
      r.byte();
    }
    const vac = r.byte() === 1;
    const bots = r.remaining ? r.byte() : 0;
    return { name, map, folder, game, appId: null, players, maxPlayers, bots, serverType: SERVER_TYPE[serverType] ?? serverType, environment: ENVIRONMENT[environment] ?? environment, passworded, vac, version: null, keywords: null, pingMs };
  }
  if (kind !== 0x49) throw new Error(`Unexpected A2S_INFO reply type 0x${kind.toString(16)}`);
  r.byte(); // protocol
  const name = r.string();
  const map = r.string();
  const folder = r.string();
  const game = r.string();
  const shortId = r.short();
  const players = r.byte();
  const maxPlayers = r.byte();
  const bots = r.byte();
  const serverType = String.fromCharCode(r.byte()).toLowerCase();
  const environment = String.fromCharCode(r.byte()).toLowerCase();
  const passworded = r.byte() === 1;
  const vac = r.byte() === 1;
  if (shortId === 2400) {
    // The Ship
    r.byte();
    r.byte();
    r.byte();
  }
  let version: string | null = null;
  let keywords: string | null = null;
  let appId: number | null = shortId || null;
  if (r.remaining) {
    version = r.string();
    if (r.remaining) {
      const edf = r.byte();
      if (edf & 0x80) r.short(); // game port
      if (edf & 0x10) r.longlong(); // SteamID
      if (edf & 0x40) {
        r.short();
        r.string();
      }
      if (edf & 0x20) keywords = r.string();
      if (edf & 0x01) appId = Number(r.longlong() & 0xffffffn);
    }
  }
  return { name, map, folder, game, appId, players, maxPlayers, bots, serverType: SERVER_TYPE[serverType] ?? serverType, environment: ENVIRONMENT[environment] ?? environment, passworded, vac, version, keywords, pingMs };
}

/** Parses an A2S_PLAYER reply payload (after the 0xFFFFFFFF header). */
export function parsePlayers(payload: Buffer): A2sPlayer[] {
  const r = new Reader(payload);
  const kind = r.byte();
  if (kind !== 0x44) throw new Error(`Unexpected A2S_PLAYER reply type 0x${kind.toString(16)}`);
  const count = r.byte();
  const players: A2sPlayer[] = [];
  for (let i = 0; i < count && r.remaining > 0; i++) {
    try {
      r.byte(); // index (always 0 on most games)
      const name = r.string();
      const score = r.long();
      const duration = r.float();
      players.push({ name, score, durationSec: Math.max(0, Math.round(duration)) });
    } catch {
      break; // some games over-report the count; keep what parsed
    }
  }
  // Connecting clients show up with an empty name — they aren't really on the server yet.
  return players.filter((p) => p.name !== '');
}

/**
 * Sends `request` and resolves with the reassembled reply payload (header stripped). Answers a
 * challenge once by calling `withChallenge` to build the retry.
 */
function exchange(host: string, port: number, request: Buffer, withChallenge: (challenge: Buffer) => Buffer, opts: A2sOptions): Promise<{ payload: Buffer; ms: number }> {
  const timeoutMs = opts.timeoutMs ?? 2500;
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket(host.includes(':') ? 'udp6' : 'udp4');
    let sentAt = Date.now();
    let challenged = false;
    const parts = new Map<number, Buffer>();
    let total = 0;
    const done = (err: Error | null, payload?: Buffer) => {
      clearTimeout(timer);
      socket.close();
      if (err) reject(err);
      else resolve({ payload: payload!, ms: Date.now() - sentAt });
    };
    const timer = setTimeout(() => done(new Error(`No reply from ${host}:${port} (is the query port right, and the server up?)`)), timeoutMs);

    const handleSingle = (msg: Buffer) => {
      const payload = msg.subarray(4);
      if (payload[0] === S2C_CHALLENGE && payload.length >= 5 && !challenged) {
        challenged = true;
        sentAt = Date.now();
        socket.send(withChallenge(payload.subarray(1, 5)), port, host);
        return;
      }
      done(null, payload);
    };

    socket.on('message', (msg) => {
      try {
        if (msg.length < 5) return;
        const head = msg.readInt32LE(0);
        if (head === -1) return handleSingle(msg);
        if (head !== -2) return;
        const id = msg.readInt32LE(4);
        let number: number;
        let body: Buffer;
        if (opts.goldsrc) {
          total = msg[8] & 0x0f;
          number = msg[8] >> 4;
          body = msg.subarray(9);
        } else {
          if (id & 0x80000000) return done(new Error('The server sent a compressed reply, which isn’t supported'));
          total = msg[8];
          number = msg[9];
          body = msg.subarray(12); // id, total, number, max packet size
        }
        parts.set(number, body);
        if (total && parts.size === total) {
          const whole = Buffer.concat([...parts.keys()].sort((a, b) => a - b).map((k) => parts.get(k)!));
          if (whole.readInt32LE(0) !== -1) return done(new Error('Malformed multi-packet reply'));
          handleSingle(whole);
        }
      } catch (err) {
        done(err instanceof Error ? err : new Error(String(err)));
      }
    });
    socket.on('error', (err) => done(err));
    socket.send(request, port, host, (err) => {
      if (err) done(err);
    });
  });
}

export async function queryInfo(host: string, port: number, opts: A2sOptions = {}): Promise<A2sInfo> {
  const { payload, ms } = await exchange(host, port, INFO_REQUEST, (c) => Buffer.concat([INFO_REQUEST, c]), opts);
  return parseInfo(payload, ms);
}

export async function queryPlayers(host: string, port: number, opts: A2sOptions = {}): Promise<A2sPlayer[]> {
  const request = (challenge: Buffer) => Buffer.concat([HEADER, Buffer.from([0x55]), challenge]);
  const { payload } = await exchange(host, port, request(Buffer.from([0xff, 0xff, 0xff, 0xff])), request, opts);
  return parsePlayers(payload);
}
