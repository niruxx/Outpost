import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnHostPty, type HostPty } from './terminalPty.js';
import { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage, Server } from 'node:http';
import { authenticate } from '../auth/tokens.js';
import { getUserById, logAudit } from './userService.js';
import { HttpError } from '../utils/asyncHandler.js';
import { envVar } from '../utils/env.js';
import { probeTerminalBackend } from './hostSetupService.js';

export interface TerminalOptions { mode: 'service' | 'root' | 'user'; username?: string; cols: number; rows: number }
interface Ticket { token: string; userId: string; options: TerminalOptions; expires: number }
const tickets = new Map<string, Ticket>();
const sessions = new Map<string, { userId: string; stop: (reason: string) => void }>();
const IDLE_MS = 30 * 60_000;
const MAX_AGE_MS = 8 * 60 * 60_000;
const MAX_SESSIONS = 8;
const MAX_USER_SESSIONS = 2;

export function validateTerminalOptions(input: unknown, platform: NodeJS.Platform = process.platform): TerminalOptions {
  const raw = input as Partial<TerminalOptions> | null;
  if (!raw || !['service', 'root', 'user'].includes(raw.mode ?? '')) throw new HttpError(400, 'Choose a service, root or user session');
  if (platform === 'win32' && raw.mode !== 'service') throw new HttpError(400, 'Windows terminals run as the Outpost service account');
  if (raw.mode === 'user' && (typeof raw.username !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}\$?$/.test(raw.username))) throw new HttpError(400, 'Enter a valid operating system username');
  const cols = raw.cols ?? 100, rows = raw.rows ?? 30;
  if (!Number.isInteger(cols) || cols < 20 || cols > 300 || !Number.isInteger(rows) || rows < 2 || rows > 120) throw new HttpError(400, 'Terminal dimensions must be 20–300 columns and 2–120 rows');
  return { mode: raw.mode!, ...(raw.mode === 'user' ? { username: raw.username } : {}), cols, rows };
}

/** Only current admins signed in interactively can obtain or use a host shell. */
export function terminalIdentity(token: string) {
  const auth = authenticate(token);
  if (!auth || auth.apiKey || auth.role !== 'admin') throw new HttpError(403, 'Sign in with an administrator account to use the host terminal. API keys are not accepted.');
  const user = getUserById(auth.sub);
  if (!user || user.role !== 'admin') throw new HttpError(403, 'Current administrator access required');
  return { id: user.id, username: user.username };
}

export async function terminalStatus() {
  const { available, error } = await probeTerminalBackend();
  const account = os.userInfo();
  return { available, error, platform: process.platform, serviceUser: account.username, isRoot: process.getuid?.() === 0, idleMinutes: IDLE_MS / 60_000, maxSessionsPerAdmin: MAX_USER_SESSIONS };
}

export function createTerminalTicket(token: string, input: unknown) {
  const identity = terminalIdentity(token);
  const options = validateTerminalOptions(input);
  for (const [id, ticket] of tickets) if (ticket.expires <= Date.now()) tickets.delete(id);
  if (tickets.size >= 100 || [...tickets.values()].filter((t) => t.userId === identity.id).length >= 4) throw new HttpError(429, 'Too many pending terminal connections. Try again in 30 seconds.');
  if (sessions.size >= MAX_SESSIONS || [...sessions.values()].filter((s) => s.userId === identity.id).length >= MAX_USER_SESSIONS) throw new HttpError(429, 'Terminal session limit reached. Close another session first.');
  const ticket = crypto.randomBytes(32).toString('base64url');
  tickets.set(ticket, { token, userId: identity.id, options, expires: Date.now() + 30_000 });
  return { ticket, expiresInSeconds: 30 };
}
export function consumeTerminalTicket(id: string) {
  const ticket = tickets.get(id);
  tickets.delete(id);
  if (!ticket || ticket.expires <= Date.now()) throw new HttpError(403, 'Terminal connection ticket expired or was already used');
  terminalIdentity(ticket.token);
  return ticket;
}

export function terminalCommand(options: TerminalOptions, platform = process.platform, uid = process.getuid?.()) {
  const account = os.userInfo();
  const home = fs.existsSync(account.homedir) ? account.homedir : process.cwd();
  if (platform === 'win32') return { file: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoLogo', '-NoProfile'], cwd: home };
  if (options.mode !== 'service') {
    const user = options.mode === 'root' ? 'root' : options.username!;
    // su needs no password when the service is root. Otherwise sudo prompts inside the PTY.
    return uid === 0 ? { file: 'su', args: ['-', user], cwd: '/' } : { file: 'sudo', args: ['-i', '-u', user], cwd: home };
  }
  const shell = account.shell && !/(nologin|false)$/.test(account.shell) && fs.existsSync(account.shell) ? account.shell : fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
  return { file: shell, args: ['-l'], cwd: home };
}

export function terminalOriginAllowed(req: IncomingMessage) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) return false;
    const configured = envVar('TERMINAL_ORIGIN');
    return configured ? origin === new URL(configured).origin : parsed.host === req.headers.host;
  } catch { return false; }
}

export async function attachHostTerminal(ws: WebSocket, ticket: Ticket) {
  let pty: HostPty;
  const identity = terminalIdentity(ticket.token);
  // Reserve before awaiting the native module, so simultaneous upgrades obey the limit.
  if (sessions.size >= MAX_SESSIONS || [...sessions.values()].filter((s) => s.userId === identity.id).length >= MAX_USER_SESSIONS) throw new HttpError(429, 'Terminal session limit reached');
  const sessionId = crypto.randomUUID();
  let closed = false, started = false, pending = 0, paused = false;
  const openedAt = Date.now(); let lastInputAt = openedAt;
  let timer: NodeJS.Timeout | undefined;
  const subscriptions: { dispose(): void }[] = [];
  const send = (message: object) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); };
  const stop = (reason: string) => {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    sessions.delete(sessionId);
    for (const sub of subscriptions) sub.dispose();
    try { pty?.kill(); } catch { /* already exited */ }
    if (started) logAudit(identity.id, identity.username, 'terminal.close', sessionId, reason);
    send({ type: 'closed', reason });
    ws.close(1000, reason.slice(0, 120));
  };
  sessions.set(sessionId, { userId: identity.id, stop });
  ws.once('close', () => stop('Browser disconnected'));
  ws.once('error', () => stop('Connection error'));
  try {
    if (closed || ws.readyState !== WebSocket.OPEN) { stop('Browser disconnected'); return; }
    terminalIdentity(ticket.token);
    // Only carry OS/locale settings into the shell, not panel credentials from the service environment.
    const env: Record<string, string> = {};
    for (const key of ['PATH', 'Path', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERDOMAIN']) if (process.env[key]) env[key] = process.env[key]!;
    env.TERM = 'xterm-256color'; env.COLORTERM = 'truecolor';
    const command = terminalCommand(ticket.options);
    pty = await spawnHostPty(command.file, command.args, { cols: ticket.options.cols, rows: ticket.options.rows, cwd: command.cwd, env });
    if (closed || ws.readyState !== WebSocket.OPEN) { pty.kill(); return; }
    terminalIdentity(ticket.token);
    started = true;
    logAudit(identity.id, identity.username, 'terminal.open', sessionId, JSON.stringify({ mode: ticket.options.mode, user: ticket.options.username ?? (ticket.options.mode === 'root' ? 'root' : os.userInfo().username), pid: pty.pid }));
    send({ type: 'ready', sessionId, pid: pty.pid });
    subscriptions.push(pty.onData((data) => {
      if (closed) return;
      if (ws.bufferedAmount > 2 * 1024 * 1024) { stop('Terminal connection could not keep up'); return; }
      pending += data.length;
      send({ type: 'output', data });
      if (pending > 256 * 1024 && !paused) { paused = true; pty.pause(); }
    }));
    subscriptions.push(pty.onExit(({ exitCode, signal }) => {
      send({ type: 'exit', exitCode, signal });
      stop(`Shell exited (${exitCode})`);
    }));
    ws.on('message', (data, binary) => {
      if (closed) return;
      try {
        terminalIdentity(ticket.token);
        if (binary || data.toString().length > 64 * 1024) throw new HttpError(400, 'Invalid terminal message');
        const msg = JSON.parse(data.toString());
        if (msg.type === 'input') {
          if (typeof msg.data !== 'string' || msg.data.length > 32 * 1024) throw new HttpError(400, 'Terminal input is too large');
          lastInputAt = Date.now(); pty.write(msg.data);
        } else if (msg.type === 'resize') {
          const size = validateTerminalOptions({ ...ticket.options, cols: msg.cols, rows: msg.rows });
          pty.resize(size.cols, size.rows);
        } else if (msg.type === 'ack') {
          if (!Number.isInteger(msg.length) || msg.length < 0 || msg.length > pending) throw new HttpError(400, 'Invalid terminal acknowledgement');
          pending -= msg.length;
          if (paused && pending < 64 * 1024) { paused = false; pty.resume(); }
        } else if (msg.type === 'close') stop('Session ended by administrator');
        else throw new HttpError(400, 'Unknown terminal message');
      } catch (error) { stop(error instanceof Error ? error.message : 'Invalid terminal message'); }
    });
    let alive = true;
    ws.on('pong', () => { alive = true; });
    timer = setInterval(() => {
      try { terminalIdentity(ticket.token); } catch { stop('Administrator session is no longer valid'); return; }
      if (Date.now() - lastInputAt > IDLE_MS) { stop('Terminal idle timeout (30 minutes)'); return; }
      if (Date.now() - openedAt > MAX_AGE_MS) { stop('Terminal reached its eight-hour session limit'); return; }
      if (!alive) { stop('Terminal connection lost'); ws.terminate(); return; }
      alive = false; ws.ping();
    }, 15_000);
    timer.unref();
  } catch (error) {
    send({ type: 'error', message: `Unable to start terminal: ${error instanceof Error ? error.message : 'PTY backend unavailable'}` });
    stop('Terminal could not be started');
  }
}

export function registerHostTerminal(server: Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    if (url.pathname !== '/ws/host-terminal') return;
    try {
      if (!terminalOriginAllowed(req)) throw new HttpError(403, 'Terminal origin rejected');
      const ticket = consumeTerminalTicket(url.searchParams.get('ticket') ?? '');
      wss.handleUpgrade(req, socket, head, (ws) => {
        void attachHostTerminal(ws, ticket).catch((error) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : 'Terminal rejected' }));
          ws.close(1008, 'Terminal access rejected');
        });
      });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 403;
      socket.end(`HTTP/1.1 ${status} Forbidden\r\nConnection: close\r\n\r\n`);
    }
  });
  return wss;
}
export function stopHostTerminals() {
  tickets.clear();
  for (const session of [...sessions.values()]) session.stop('Outpost is shutting down');
}
