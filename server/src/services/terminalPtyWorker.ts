import type { HostPty } from './terminalPty.js';

let pty: HostPty | undefined;
let closing = false;
let pendingOutput = 0, parentPaused = false, paused = false;
const send = (message: object) => { if (process.connected) process.send?.(message, () => {}); };
function syncFlow() {
  if (!pty || closing) return;
  if ((parentPaused || pendingOutput > 256 * 1024) && !paused) { paused = true; pty.pause(); }
  else if (!parentPaused && pendingOutput < 64 * 1024 && paused) { paused = false; pty.resume(); }
}
function close() {
  if (closing) return;
  closing = true;
  try { pty?.kill(); } catch { /* already exited */ }
  // Native Windows backends can leave a conout worker alive after the shell dies.
  // Exiting this dedicated helper releases those handles without affecting Outpost.
  setTimeout(() => process.exit(0), 1000);
}
process.on('disconnect', close);
process.on('SIGTERM', close);
process.on('message', async (msg: { type: string; file: string; args: string[]; cols: number; rows: number; cwd: string; env: Record<string, string>; data: string }) => {
  if (closing) return;
  try {
    if (msg.type === 'start' && !pty) {
      const moduleName = 'node-pty'; // Optional native dependency: do not require it to compile the panel.
      const backend = await import(moduleName);
      if (closing) return;
      const child: HostPty = backend.spawn(msg.file, msg.args, { name: 'xterm-256color', cols: msg.cols, rows: msg.rows, cwd: msg.cwd, env: msg.env });
      pty = child;
      send({ type: 'ready', pid: child.pid });
      child.onData((data) => {
        if (closing || !process.connected) return;
        pendingOutput += data.length;
        process.send?.({ type: 'output', data }, () => { pendingOutput -= data.length; syncFlow(); });
        syncFlow();
      });
      child.onExit(({ exitCode, signal }) => {
        if (closing) return;
        closing = true;
        if (process.connected) process.send?.({ type: 'exit', exitCode, signal }, () => process.exit(0));
        else process.exit(0);
      });
    } else if (msg.type === 'input') pty?.write(msg.data);
    else if (msg.type === 'resize') pty?.resize(msg.cols, msg.rows);
    else if (msg.type === 'pause') { parentPaused = true; syncFlow(); }
    else if (msg.type === 'resume') { parentPaused = false; syncFlow(); }
    else if (msg.type === 'close') close();
  } catch (error) {
    send({ type: 'error', message: error instanceof Error ? error.message : 'Terminal backend failed' }); close();
  }
});
