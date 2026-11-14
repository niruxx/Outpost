// Standalone worker: copied outside the checkout before launch so builds cannot replace it.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

const directory = process.argv[2];
const input = JSON.parse(fs.readFileSync(path.join(directory, 'launch.json'), 'utf8'));
const state: any = { version: 1, serverId: input.serverId, token: input.token, workerPid: process.pid, startedAt: Date.now(), pid: null, innerPid: null, ready: false, exited: false, code: null, signal: null, manualStop: false, context: input.context };
const save = () => { const file = path.join(directory, 'state.json'); fs.writeFileSync(file + '.tmp', JSON.stringify(state), { mode: 0o600 }); fs.renameSync(file + '.tmp', file); };
let sequence = 0, bytes = 0;
const history: any[] = [], clients = new Set<net.Socket>();
const send = (socket: net.Socket, event: any) => { if (socket.writableLength > 2 * 1024 * 1024) { socket.destroy(); return; } socket.write(JSON.stringify(event) + '\n'); };
const emit = (event: any) => {
  event.seq = ++sequence;
  history.push(event); bytes += JSON.stringify(event).length;
  while (bytes > 2 * 1024 * 1024 && history.length > 1) bytes -= JSON.stringify(history.shift()).length;
  for (const socket of clients) send(socket, event);
};
const child = spawn(input.cmd, input.args, { cwd: input.cwd, env: input.env, shell: input.shell, windowsHide: true, detached: input.detached, stdio: input.sandboxed ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'] });
state.pid = child.pid ?? null;
const ready = input.ready ? new RegExp(input.ready.source, input.ready.flags) : null;
for (const [stream, pipe] of [['stdout', child.stdout], ['stderr', child.stderr]] as const) {
  pipe!.setEncoding('utf8');
  pipe!.on('data', (data: string) => { if (!state.ready && (!ready || ready.test(data))) { state.ready = true; save(); } emit({ type: stream, data }); });
}
let info = '';
child.stdio[3]?.on('data', (chunk: Buffer) => { info = (info + chunk.toString()).slice(-8192); const match = info.match(/"child-pid":\s*(\d+)/); if (match) { state.innerPid = Number(match[1]); save(); } emit({ type: 'fd3', data: chunk.toString() }); });
child.stdin!.on('error', () => {});
const exited = (code: number | null, signal: string | null) => { if (state.exited) return; state.exited = true; state.code = code; state.signal = signal; save(); emit({ type: 'exit', code, signal }); };
child.on('error', error => { emit({ type: 'stderr', data: `[Outpost supervisor] ${error.message}\n` }); exited(null, null); });
child.on('exit', exited);
function signalChild(signal: NodeJS.Signals) {
  if (state.exited) return;
  if (input.detached && child.pid) { try { process.kill(-child.pid, signal); return; } catch {} }
  if (input.sandboxed && state.innerPid) { try { process.kill(state.innerPid, signal); return; } catch {} }
  child.kill(signal);
}
const server = net.createServer(socket => {
  socket.on('error', () => {});
  const timer = setTimeout(() => socket.destroy(), 5000); timer.unref();
  let buffer = '', authenticated = false;
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 1024 * 1024) { socket.destroy(); return; }
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      let request: any; try { request = JSON.parse(line); } catch { socket.destroy(); return; }
      if (!authenticated) {
        if (request.token !== input.token) { socket.destroy(); return; }
        authenticated = true; clearTimeout(timer); send(socket, { type: 'hello', state }); continue;
      }
      if (request.type === 'resume') { clients.add(socket); for (const event of history) if (event.seq > (request.after ?? 0)) send(socket, event); if (state.exited && !history.some(e => e.type === 'exit')) send(socket, { type: 'exit', code: state.code, signal: state.signal }); }
      if (request.type === 'stdin' && !state.exited) child.stdin!.write(String(request.data));
      if (request.type === 'signal') signalChild(request.signal);
      if (request.type === 'manualStop') { state.manualStop = true; save(); const timer = setTimeout(() => signalChild('SIGKILL'), (input.context.config.stopTimeoutSec ?? 60) * 1000); timer.unref(); }
      if (request.type === 'dispose' && state.exited) { socket.end(); server.close(); for (const client of clients) client.destroy(); setTimeout(() => process.exit(0), 50); }
    }
  });
  socket.on('close', () => { clients.delete(socket); clearTimeout(timer); });
});
server.listen(0, '127.0.0.1', () => { state.port = (server.address() as net.AddressInfo).port; if (!ready) state.ready = true; save(); fs.unlinkSync(path.join(directory, 'launch.json')); });
// Panel lifecycle signals must not be forwarded to game processes.
process.on('SIGINT', () => {});
process.on('SIGTERM', () => {});
