/**
 * Privileged helper for the Host File Manager's Admin Mode (compare Cockpit's privileged bridge).
 *
 * Started by Outpost through `sudo`, it reads one JSON request per line on stdin and answers one
 * JSON line per request on stdout (plus `{id, progress}` lines while long operations run). It only
 * performs the operations in HOST_FILE_OPS and HOST_ADMIN_OPS, imports nothing from the panel (no
 * database, no secrets) and exits when Outpost closes its stdin.
 */
import readline from 'node:readline';
import { HOST_FILE_OPS, HostFileError } from './hostFileOps.js';
import { HOST_ADMIN_OPS } from './hostAdminOps.js';

const OPS: Record<string, (args: unknown, emit: (chunk: string) => void) => Promise<unknown>> = {
  ...(HOST_FILE_OPS as unknown as Record<string, (args: unknown) => Promise<unknown>>),
  ...(HOST_ADMIN_OPS as unknown as Record<string, (args: unknown, emit: (chunk: string) => void) => Promise<unknown>>),
};

const write = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`);

write({ ready: true, uid: process.getuid?.() ?? null });

let inFlight = 0;
let closed = false;
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  let request: { id?: unknown; op?: unknown; args?: unknown };
  try {
    request = JSON.parse(line);
  } catch {
    return; // not a request (e.g. a password line sudo didn't need): ignore it
  }
  if (typeof request?.id !== 'number') return;
  const id = request.id;
  const op = typeof request.op === 'string' && Object.hasOwn(OPS, request.op) ? OPS[request.op] : undefined;
  if (!op) {
    write({ id, ok: false, status: 400, error: 'Unknown operation' });
    return;
  }
  const emit = (chunk: string) => write({ id, progress: chunk });
  inFlight++;
  Promise.resolve()
    .then(() => op(request.args ?? {}, emit))
    .then(
      (result) => write({ id, ok: true, result: result ?? null }),
      (err) => write({ id, ok: false, status: err instanceof HostFileError ? err.status : 500, error: err instanceof Error ? err.message : 'Operation failed' })
    )
    .finally(() => {
      inFlight--;
      if (closed && inFlight === 0) process.exit(0);
    });
});
// Outpost closed stdin: finish what is running (never abandon a package transaction halfway), then exit.
lines.on('close', () => {
  closed = true;
  if (inFlight === 0) process.exit(0);
});
process.on('SIGTERM', () => process.exit(0));
