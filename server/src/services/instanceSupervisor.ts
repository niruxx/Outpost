import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from '../utils/paths.js';
import type { LaunchConfig } from './launchConfig.js';

export interface SupervisorLaunch {
  cmd: string; args: string[]; cwd: string; env: Record<string, string>; shell: boolean;
  detached: boolean; sandboxed: boolean; ready: { source: string; flags: string } | null;
  context: { config: LaunchConfig; cwd: string; groupKill: boolean; sandboxed: boolean; coreKeeper?: boolean };
}
export interface SupervisorState { version: number; serverId: string; token: string; port: number; pid: number; workerPid: number; innerPid: number | null; startedAt: number; ready: boolean; exited: boolean; manualStop: boolean; code: number | null; signal: string | null; context: SupervisorLaunch['context'] }
const root = () => path.join(DATA_DIR, 'instance-supervisors');
export const supervisorLocation = (id: string) => path.join(root(), crypto.createHash('sha256').update(id).digest('hex'));
export function supervisorStates(): SupervisorState[] {
  if (!fs.existsSync(root())) return [];
  return fs.readdirSync(root(), { withFileTypes: true }).flatMap(entry => {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) return [];
    const directory = path.join(root(), entry.name), file = path.join(directory, 'state.json');
    if (!fs.existsSync(file)) {
      if (fs.existsSync(path.join(directory, 'launch.json'))) throw new Error('An instance supervisor launch is still unresolved; refusing duplicate startup');
      return [];
    }
    const state = JSON.parse(fs.readFileSync(file, 'utf8')) as SupervisorState;
    if (state.version !== 1 || typeof state.serverId !== 'string' || !/^[a-f0-9]{64}$/.test(state.token)) throw new Error('Invalid instance supervisor metadata');
    return [state];
  });
}
export interface SupervisedChild extends ChildProcessWithoutNullStreams { detach(): void; markManualStop(): void; stopCoreKeeper(): void; resume(): void; supervisorState: SupervisorState }
export async function connectSupervisor(state: SupervisorState): Promise<SupervisedChild> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(state.port, '127.0.0.1');
    const child: any = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdio = [null, child.stdout, child.stderr, new PassThrough()];
    const send = (event: any) => socket.write(JSON.stringify(event) + '\n');
    child.stdin = new Writable({ write(data, _encoding, done) { if (socket.destroyed) { done(new Error('Supervisor connection unavailable')); return; } send({ type: 'stdin', data: data.toString() }); done(); } });
    child.kill = (signal = 'SIGTERM') => { send({ type: 'signal', signal }); return true; };
    child.markManualStop = () => send({ type: 'manualStop' });
    child.stopCoreKeeper = () => send({ type: 'stopCoreKeeper' });
    child.detach = () => { detached = true; socket.destroy(); };
    const cursorFile = path.join(supervisorLocation(state.serverId), 'cursor.json');
    let after = 0;
    try { const cursor = JSON.parse(fs.readFileSync(cursorFile, 'utf8')); if (cursor.token === state.token) after = cursor.seq; } catch {}
    child.resume = () => send({ type: 'resume', after });
    let detached = false, connected = false, buffer = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Instance supervisor handshake timed out')); }, 5000);
    socket.on('connect', () => send({ token: state.token }));
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 4 * 1024 * 1024) { socket.destroy(); return; }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let event: any; try { event = JSON.parse(line); } catch { continue; }
        if (event.seq) { try { fs.writeFileSync(cursorFile, JSON.stringify({ token: state.token, seq: event.seq }), { mode: 0o600 }); } catch {} }
        if (event.type === 'hello') { if (event.state?.token !== state.token || event.state?.serverId !== state.serverId || event.state?.version !== 1) { socket.destroy(); reject(new Error('Supervisor identity or protocol mismatch')); return; } clearTimeout(timer); connected = true; child.pid = event.state.pid; child.supervisorState = event.state; resolve(child); }
        if (event.type === 'stdout' || event.type === 'stderr') child[event.type].write(event.data);
        if (event.type === 'fd3') child.stdio[3].write(event.data);
        if (event.type === 'exit') {
          try { const file = path.join(supervisorLocation(state.serverId), 'state.json'); const saved = JSON.parse(fs.readFileSync(file, 'utf8')); if (saved.token === state.token) fs.unlinkSync(file); } catch {}
          detached = true; send({ type: 'dispose' }); child.emit('exit', event.code, event.signal); socket.end(); }
      }
    });
    socket.on('error', error => { if (!connected) { clearTimeout(timer); reject(error); } });
    socket.on('close', () => { clearTimeout(timer); if (!connected) reject(new Error('Supervisor connection closed')); else if (!detached) child.emit('error', new Error('Instance supervisor disconnected; game state is unknown. Restart the panel to reconnect.')); });
  });
}
export async function spawnSupervised(serverId: string, launch: SupervisorLaunch): Promise<SupervisedChild> {
  fs.mkdirSync(root(), { recursive: true, mode: 0o700 });
  fs.chmodSync(root(), 0o700);
  const compiled = fileURLToPath(new URL('./instanceSupervisorWorker.js', import.meta.url));
  let source: Buffer;
  if (fs.existsSync(compiled)) source = fs.readFileSync(compiled);
  else {
    // tsx watch runs from src; workers must still be standalone JS snapshots.
    const ts = await import('typescript');
    const input = fs.readFileSync(fileURLToPath(new URL('./instanceSupervisorWorker.ts', import.meta.url)), 'utf8');
    source = Buffer.from(ts.transpileModule(input, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
  }
  const directory = supervisorLocation(serverId);
  if (fs.existsSync(directory)) {
    let state: SupervisorState | null;
    try { state = JSON.parse(fs.readFileSync(path.join(directory, 'state.json'), 'utf8')); } catch {
      if (fs.existsSync(path.join(directory, 'state.json')) || fs.existsSync(path.join(directory, 'launch.json'))) throw new Error('Previous supervisor launch is unresolved; refusing a duplicate process');
      state = null;
    }
    if (state) {
      try {
        const previous = await connectSupervisor(state);
        if (!previous.supervisorState.exited) { previous.detach(); throw new Error('Instance already has a running supervisor'); }
        previous.on('error', () => {});
        previous.resume();
      } catch (error) { if (!state.exited) throw error; }
    }
    // Fixed private metadata paths only; never remove game files.
    for (const name of ['state.json', 'state.json.tmp', 'launch.json']) { try { fs.unlinkSync(path.join(directory, name)); } catch {} }
  } else fs.mkdirSync(directory, { mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const token = crypto.randomBytes(32).toString('hex');
  const worker = path.join(root(), `worker-${crypto.createHash('sha256').update(source).digest('hex')}.mjs`);
  if (!fs.existsSync(worker)) fs.writeFileSync(worker, source, { mode: 0o600 });
  fs.writeFileSync(path.join(directory, 'launch.json'), JSON.stringify({ ...launch, serverId, token }), { mode: 0o600 });
  const proc = spawn(process.execPath, [worker, directory], { detached: true, windowsHide: true, stdio: 'ignore' });
  let failure: Error | null = null; proc.on('error', error => { failure = error; }); proc.unref();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    try { const state = JSON.parse(fs.readFileSync(path.join(directory, 'state.json'), 'utf8')); if (state.token === token && state.port) return await connectSupervisor(state); } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Instance supervisor did not become ready; refusing a duplicate launch');
}
