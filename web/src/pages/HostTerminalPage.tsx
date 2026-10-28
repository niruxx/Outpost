import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Layout, PageHeader } from '../components/Layout.js';
import { Badge, Button, Card, ErrorText, Field, Input, Notice, Select, Spinner } from '../components/ui.js';
import { api } from '../api/client.js';

interface TerminalStatus {
  available: boolean; error: string | null; platform: string; serviceUser: string;
  isRoot: boolean; idleMinutes: number; maxSessionsPerAdmin: number;
}
interface SessionRequest { id: number; mode: 'service' | 'root' | 'user'; username?: string }
type ConnectionState = 'connecting' | 'connected' | 'closed';

export function HostTerminalPage() {
  const [status, setStatus] = useState<TerminalStatus | null>(null);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<SessionRequest['mode']>('service');
  const [username, setUsername] = useState('');
  const [session, setSession] = useState<SessionRequest | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('closed');
  const [loading, setLoading] = useState(true);
  const endSession = useRef<() => void>(() => {});
  const clear = useRef<() => void>(() => {});
  const fullscreen = useRef<HTMLDivElement>(null);
  const active = connection !== 'closed';
  async function load() {
    setLoading(true); setError('');
    try { setStatus(await api.get<TerminalStatus>('/terminal')); }
    catch (err) { setError(err instanceof Error ? err.message : 'Unable to load terminal'); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  function start() {
    setConnection('connecting');
    setSession({ id: Date.now(), mode, ...(mode === 'user' ? { username: username.trim() } : {}) });
  }
  return <Layout><div className="flex min-h-full flex-col gap-5 p-4 sm:p-8">
    <PageHeader title="Host Console" subtitle="Open an interactive terminal on the Outpost host, outside any game instance." />
    <ErrorText>{error}</ErrorText>
    {loading && <Spinner />}
    {status && <Card className="space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-medium text-ink-100">New terminal session</h2><Badge tone={connection === 'connected' ? 'green' : 'neutral'}>{connection === 'connecting' ? 'Connecting' : connection === 'connected' ? 'Connected' : 'Disconnected'}</Badge></div>
      <p className="text-sm text-ink-300">Outpost runs as <strong>{status.serviceUser}</strong>{status.isRoot ? ' (root)' : ''}. This terminal can manage host files, services and software with the selected OS account’s permissions.</p>
      {!status.available && <Notice tone="warning">{status.error}<div className="mt-2"><Button onClick={load}>Check again</Button></div></Notice>}
      <div className="flex flex-wrap items-end gap-3"><div className="min-w-60 flex-1"><Field label="Run as"><Select value={mode} onChange={(e) => setMode(e.target.value as SessionRequest['mode'])} disabled={active}>
        <option value="service">Service account ({status.serviceUser})</option>
        {status.platform !== 'win32' && <><option value="root">Root{status.isRoot ? '' : ' (via sudo)'}</option><option value="user">Named operating system user</option></>}
      </Select></Field></div>
      {mode === 'user' && <div className="min-w-48 flex-1"><Field label="OS username"><Input autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="e.g. outpost" disabled={active} /></Field></div>}
      <Button variant="primary" onClick={start} disabled={active || !status.available || (mode === 'user' && !/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}\$?$/.test(username.trim()))}>New session</Button>
      <Button variant="danger" disabled={!active} onClick={() => endSession.current()}>End session</Button>
      </div>
      <p className="text-xs text-ink-400">{status.platform === 'win32' ? 'PowerShell uses the Windows service account’s existing privileges. This console does not elevate through UAC.' : 'Root and named-user sessions use the host’s existing sudo policy. Enter your operating system password in the terminal if prompted; Outpost does not store it.'}</p>
      <p className="text-xs text-ink-400">Navigating away closes the session. Sessions also close after {status.idleMinutes} minutes without input. Up to {status.maxSessionsPerAdmin} sessions per admin can run in separate tabs.</p>
    </Card>}
    <div ref={fullscreen} className="flex min-h-[480px] flex-1 flex-col overflow-hidden rounded-2xl border border-surface-600 bg-[#101310] p-3 sm:p-4">
      <div className="mb-3 flex items-center justify-between gap-3"><span className="text-sm font-medium text-ink-200">{session ? session.mode === 'root' ? 'Root shell' : session.mode === 'user' ? `Shell · ${session.username}` : `Shell · ${status?.serviceUser ?? 'service account'}` : 'Host terminal'}</span><div className="flex gap-2"><Button variant="ghost" disabled={!session} onClick={() => clear.current()}>Clear display</Button><Button variant="ghost" onClick={() => fullscreen.current?.requestFullscreen?.().catch((err) => setError(err.message))}>Fullscreen</Button></div></div>
      {session ? <HostTerminal key={session.id} request={session} onState={setConnection} endSession={endSession} clear={clear} /> : <div className="flex min-h-80 flex-1 items-center justify-center p-8 text-center text-sm text-ink-400">Choose an account and select New session to open a shell.</div>}
    </div>
  </div></Layout>;
}

function HostTerminal({ request, onState, endSession, clear }: {
  request: SessionRequest; onState: (state: ConnectionState) => void;
  endSession: React.MutableRefObject<() => void>; clear: React.MutableRefObject<() => void>;
}) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!container.current) return;
    let cancelled = false, ended = false, socket: WebSocket | null = null, ready = false;
    const term = new Terminal({ cursorBlink: true, fontSize: 14, fontFamily: 'Cascadia Code, Consolas, monospace', scrollback: 5000, allowProposedApi: false, theme: { background: '#101310', foreground: '#e0e4dc', cursor: '#9fda86', selectionBackground: '#43583c' } });
    const fit = new FitAddon(); term.loadAddon(fit); term.open(container.current);
    const send = (message: object) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
    const resize = () => {
      if (cancelled) return;
      fit.fit();
      if (ready) send({ type: 'resize', cols: Math.min(300, Math.max(20, term.cols)), rows: Math.min(120, Math.max(2, term.rows)) });
    };
    const observer = new ResizeObserver(resize); observer.observe(container.current); resize();
    const input = term.onData((data) => {
      if (!ready) return;
      // Keep large pastes within the per-message limit; escape sequences remain ordered.
      for (let i = 0; i < data.length; i += 8192) send({ type: 'input', data: data.slice(i, i + 8192) });
    });
    clear.current = () => term.clear();
    endSession.current = () => {
      ended = true; ready = false; send({ type: 'close' }); socket?.close(); onState('closed');
    };
    onState('connecting');
    term.writeln('\x1b[90mOpening a host terminal…\x1b[0m');
    void api.post<{ ticket: string }>('/terminal/ticket', { mode: request.mode, username: request.username, cols: Math.min(300, Math.max(20, term.cols)), rows: Math.min(120, Math.max(2, term.rows)) }).then(({ ticket }) => {
      if (cancelled || ended) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${proto}//${window.location.host}/ws/host-terminal?ticket=${encodeURIComponent(ticket)}`);
      socket.onmessage = (event) => {
        if (cancelled) return;
        const msg = JSON.parse(event.data);
        if (msg.type === 'ready') { ready = true; onState('connected'); resize(); term.focus(); }
        else if (msg.type === 'output') term.write(msg.data, () => { if (!cancelled) send({ type: 'ack', length: msg.data.length }); });
        else if (msg.type === 'exit') term.writeln(`\r\n\x1b[90mShell exited with code ${msg.exitCode}.\x1b[0m`);
        else if (msg.type === 'error') term.writeln(`\r\n\x1b[31m${msg.message}\x1b[0m`);
        else if (msg.type === 'closed') { ready = false; onState('closed'); term.writeln(`\r\n\x1b[90m${msg.reason}\x1b[0m`); }
      };
      socket.onclose = () => { if (!cancelled) { ready = false; onState('closed'); term.writeln('\r\n\x1b[90mDisconnected. Select New session to open another shell.\x1b[0m'); } };
      socket.onerror = () => { if (!cancelled) term.writeln('\r\n\x1b[31mTerminal connection failed. Check your sign-in and reverse proxy WebSocket settings.\x1b[0m'); };
    }).catch((err) => { if (!cancelled) { onState('closed'); term.writeln(`\r\n\x1b[31m${err instanceof Error ? err.message : 'Unable to open terminal'}\x1b[0m`); } });
    return () => {
      cancelled = true; ready = false; observer.disconnect(); input.dispose();
      send({ type: 'close' }); socket?.close(); term.dispose(); clear.current = () => {}; endSession.current = () => {};
    };
  }, [request, onState, endSession, clear]);
  return <div ref={container} className="min-h-80 flex-1" style={{ height: 'max(400px, 55vh)' }} aria-label="Interactive host terminal" />;
}
