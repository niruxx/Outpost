import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';
export interface HostPty {
  readonly pid: number;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  pause(): void; resume(): void; kill(): void;
}

/** Isolate native PTY errors and platform-specific cleanup in a disposable helper process. */
export function spawnHostPty(file: string, args: string[], options: { cols: number; rows: number; cwd: string; env: Record<string, string> }): Promise<HostPty> {
  return new Promise((resolve, reject) => {
    const development = new URL(import.meta.url).pathname.endsWith('.ts');
    const child = fork(new URL(development ? './terminalPtyWorker.ts' : './terminalPtyWorker.js', import.meta.url), [], {
      windowsHide: true, execArgv: development ? ['--import', import.meta.resolve('tsx')] : [], cwd: options.cwd, env: options.env,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const events = new EventEmitter();
    let ready = false, ended = false, killed = false;
    let killTimer: NodeJS.Timeout | undefined;
    let diagnostic = '';
    child.stderr?.on('data', (data: Buffer) => { diagnostic = (diagnostic + data.toString()).slice(-2000); });
    const send = (message: object) => { if (child.connected) child.send(message, () => {}); };
    const deadline = setTimeout(() => { reject(new Error('Terminal backend startup timed out')); child.kill(); }, 15_000);
    const exit = (exitCode: number, signal?: number) => {
      if (ended) return;
      ended = true; events.emit('terminalExit', { exitCode, signal });
    };
    child.on('error', (error) => {
      clearTimeout(deadline);
      if (!ready) reject(error); else exit(1);
    });
    child.on('exit', (code) => {
      clearTimeout(deadline); if (killTimer) clearTimeout(killTimer);
      if (!ready) reject(new Error(diagnostic || 'Terminal backend exited before starting'));
      else exit(code ?? 1);
    });
    child.on('message', (message: { type: string; pid: number; data: string; exitCode: number; signal?: number; message: string }) => {
      if (message.type === 'ready') {
        clearTimeout(deadline); ready = true;
        const subscribe = <T>(name: string, listener: (value: T) => void) => {
          events.on(name, listener); return { dispose: () => { events.off(name, listener); } };
        };
        resolve({
          pid: message.pid,
          onData: (listener) => subscribe('data', listener),
          onExit: (listener) => subscribe('terminalExit', listener),
          write: (data) => send({ type: 'input', data }),
          resize: (cols, rows) => send({ type: 'resize', cols, rows }),
          pause: () => send({ type: 'pause' }), resume: () => send({ type: 'resume' }),
          kill: () => {
            if (killed) return; killed = true;
            send({ type: 'close' });
            killTimer = setTimeout(() => child.kill(), 2000); killTimer.unref();
          },
        });
      } else if (message.type === 'output') events.emit('data', message.data);
      else if (message.type === 'exit') exit(message.exitCode, message.signal);
      else if (message.type === 'error') {
        if (!ready) { clearTimeout(deadline); reject(new Error(message.message)); child.kill(); }
        else { events.emit('data', `\r\nTerminal backend: ${message.message}\r\n`); exit(1); child.kill(); }
      }
    });
    send({ type: 'start', file, args, ...options });
  });
}
