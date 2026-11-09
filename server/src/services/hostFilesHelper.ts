/**
 * Privileged helper for the Host File Manager's Admin Mode (compare Cockpit's privileged bridge).
 *
 * Started by Outpost through `sudo`, it reads one JSON request per line on stdin and answers one
 * JSON line per request on stdout. It only performs the operations in HOST_FILE_OPS, imports
 * nothing from the panel (no database, no secrets) and exits when Outpost closes its stdin.
 */
import readline from 'node:readline';
import { HOST_FILE_OPS, HostFileError } from './hostFileOps.js';

const write = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`);

write({ ready: true, uid: process.getuid?.() ?? null });

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
  const op = HOST_FILE_OPS[request.op as keyof typeof HOST_FILE_OPS] as ((args: unknown) => Promise<unknown>) | undefined;
  if (typeof request.op !== 'string' || !Object.hasOwn(HOST_FILE_OPS, request.op) || !op) {
    write({ id, ok: false, status: 400, error: 'Unknown operation' });
    return;
  }
  op(request.args ?? {}).then(
    (result) => write({ id, ok: true, result: result ?? null }),
    (err) => write({ id, ok: false, status: err instanceof HostFileError ? err.status : 500, error: err instanceof Error ? err.message : 'Operation failed' })
  );
});
lines.on('close', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
