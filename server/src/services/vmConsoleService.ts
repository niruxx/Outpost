import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';
import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { authenticate } from '../auth/tokens.js';
import { HttpError } from '../utils/asyncHandler.js';
import { libvirtClient, libvirtSettings, validateLibvirtSettings } from './libvirtService.js';
import { requireVmPermission } from './vmAccessService.js';
import { logAudit } from './userService.js';
import { terminalOriginAllowed } from './hostTerminalService.js';

interface Ticket { token: string; uuid: string; protocol: 'vnc' | 'spice'; uri: string; expires: number; opened: number; uses: number; active: number }
const tickets = new Map<string, Ticket>();
let active = 0;
export function consoleIdentity(token: string, uuid: string) {
  const auth = authenticate(token);
  if (!auth || auth.apiKey) throw new HttpError(403, 'Sign in interactively to use a VM console');
  requireVmPermission(auth.sub, uuid, 'console');
  return auth;
}
export function createVmConsoleTicket(token: string, uuid: string, protocol: unknown) {
  const identity = consoleIdentity(token, uuid);
  if (protocol !== 'vnc' && protocol !== 'spice') throw new HttpError(400, 'Select vnc or spice');
  const now = Date.now();
  for (const [id, ticket] of tickets) if (!ticket.active && ticket.expires < now) tickets.delete(id);
  if (tickets.size >= 100 || [...tickets.values()].filter(t => authenticate(t.token)?.sub === identity.sub).length >= 4) throw new HttpError(429, 'Too many pending console sessions');
  const ticket = crypto.randomBytes(32).toString('base64url');
  tickets.set(ticket, { token, uuid, protocol, uri: libvirtSettings().uri, expires: now + 60_000, opened: now, uses: 0, active: 0 });
  return { ticket, protocol, expiresInSeconds: 60 };
}
export function claimConsoleTicket(id: string) {
  const ticket = tickets.get(id);
  if (!ticket || ticket.expires < Date.now() || ticket.uri !== libvirtSettings().uri || !libvirtSettings().enabled) throw new HttpError(403, 'Console ticket expired; reconnect');
  consoleIdentity(ticket.token, ticket.uuid);
  // SPICE opens separate display, input, cursor and audio channels using the same URI.
  if (ticket.uses >= (ticket.protocol === 'vnc' ? 1 : 12) || active >= 32) throw new HttpError(429, 'Console channel limit reached');
  ticket.uses++; ticket.active++; active++;
  return ticket;
}
export function sshConsoleArgs(uri: string, port: number, address = '127.0.0.1') {
  validateLibvirtSettings({ enabled: true, uri });
  const remote = new URL(uri);
  const host = remote.hostname.replace(/^\[|\]$/g, '');
  return ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15', ...(remote.port ? ['-p', remote.port] : []), ...(remote.username ? ['-l', remote.username] : []), '-W', `${address === '::1' ? '[::1]' : '127.0.0.1'}:${port}`, '--', host];
}
type DisplayResolver = (uuid: string, protocol: 'vnc' | 'spice') => Promise<{ host: string; port: number }>;
export function registerVmConsole(server: Server, display: DisplayResolver = (uuid, protocol) => libvirtClient().display(uuid, protocol)) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    if (url.pathname !== '/ws/vm-console') return;
    try {
      if (!terminalOriginAllowed(req)) throw new HttpError(403, 'Console origin rejected');
      const ticket = claimConsoleTicket(url.searchParams.get('ticket') ?? '');
      let reserved = true;
      const abandon = () => { if (reserved) { reserved = false; ticket.active--; active--; } };
      socket.once('close', abandon);
      try { wss.handleUpgrade(req, socket, head, ws => { reserved = false; socket.off('close', abandon); void attach(ws, ticket, display); }); }
      catch (error) { abandon(); throw error; }
    } catch { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); }
  });
}
async function attach(ws: WebSocket, ticket: Ticket, display: DisplayResolver) {
  let input: Duplex | undefined, output: Duplex | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const stop = () => {
    if (stopped) return; stopped = true;
    if (timer) clearInterval(timer);
    input?.destroy(); if (output !== input) output?.destroy(); child?.kill();
    ticket.active--; active--;
    ws.close();
  };
  ws.once('close', stop); ws.once('error', stop);
  // Pause the socket while virsh resolves the endpoint, retaining early browser handshake bytes.
  ws.pause();
  try {
    const identity = consoleIdentity(ticket.token, ticket.uuid);
    const endpoint = await display(ticket.uuid, ticket.protocol);
    if (stopped) return;
    if (ticket.uri !== libvirtSettings().uri) throw new HttpError(403, 'Connection changed');
    if (ticket.uri.startsWith('qemu+ssh://')) {
      child = spawn('ssh', sshConsoleArgs(ticket.uri, endpoint.port, endpoint.host), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      input = child.stdin! as unknown as Duplex; output = child.stdout! as unknown as Duplex;
      child.stderr?.resume(); child.once('error', stop); child.once('exit', stop);
    } else { input = output = net.connect({ host: endpoint.host, port: endpoint.port, timeout: 15_000 }); (input as net.Socket).once('connect', () => (input as net.Socket).setTimeout(0)); input.once('timeout', stop); }
    input.on('error', stop); output.on('error', stop); output.once('end', stop);
    ws.on('message', (data, binary) => {
      if (!binary) { stop(); return; }
      if (input!.writableLength > 8 * 1024 * 1024) { stop(); return; }
      if (!input!.write(data)) { ws.pause(); input!.once('drain', () => { if (!stopped) ws.resume(); }); }
    });
    output.on('data', (data: Buffer) => {
      if (ws.readyState !== WebSocket.OPEN) { stop(); return; }
      if (ws.bufferedAmount > 8 * 1024 * 1024) { stop(); return; }
      output!.pause(); ws.send(data, { binary: true }, error => { if (error) stop(); else if (!stopped) output!.resume(); });
    });
    ws.resume();
    logAudit(identity.sub, identity.username, 'libvirt.console', ticket.uuid, ticket.protocol);
    timer = setInterval(() => {
      try {
        consoleIdentity(ticket.token, ticket.uuid);
        if (!libvirtSettings().enabled || ticket.uri !== libvirtSettings().uri || Date.now() - ticket.opened > 8 * 60 * 60_000) stop();
      } catch { stop(); }
    }, 3000); timer.unref();
  } catch { ws.close(1011, 'Console unavailable; check display configuration and SSH access'); stop(); }
}
