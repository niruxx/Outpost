import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { setVisibleInterval } from '../../lib/perf.js';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '../../api/client.js';
import type { AutoRestartState, RuntimeInfo, ServerPermission, ServerRecord } from '../../api/types.js';
import { useAuth } from '../../state/AuthContext.js';

interface ServerDetailState {
  serverId: string;
  server: ServerRecord | null;
  runtime: RuntimeInfo | null;
  running: boolean;
  /** True when the user holds at least one permission that changes something. */
  canWrite: boolean;
  /** Whether the signed-in user holds a specific permission on this instance. */
  can: (permission: ServerPermission) => boolean;
  canConfig: (kind: 'setting' | 'property', key: string) => boolean;
  permissions: ServerPermission[];
  /** A scheduled automatic restart after the process exited on its own. */
  autoRestart: AutoRestartState | null;
  /** Who the instance belongs to (its creator, or whoever an admin handed it to). */
  owner: { id: string; username: string } | null;
  isOwner: boolean;
  isAdmin: boolean;
  /** Set when the API refuses access because the instance is suspended (non-admins only). */
  suspendedMessage: string | null;
  /** Any other load failure (deleted, no access, …). */
  loadError: string | null;
  refresh: () => Promise<void>;
}

const ServerDetailContext = createContext<ServerDetailState | null>(null);

export function ServerDetailProvider({ children, serverId: explicitId }: { children: ReactNode; serverId?: string }) {
  const params = useParams<{ serverId: string }>();
  const serverId = explicitId ?? params.serverId;
  const { user } = useAuth();
  interface DetailSnapshot {
    serverId: string | undefined; server: ServerRecord | null; runtime: RuntimeInfo | null;
    running: boolean; configAccess: Record<string, boolean>; permissions: ServerPermission[];
    autoRestart: AutoRestartState | null; owner: { id: string; username: string } | null;
    suspendedMessage: string | null; loadError: string | null;
  }
  const empty = { server: null, runtime: null, running: false, configAccess: {}, permissions: [], autoRestart: null, owner: null, suspendedMessage: null, loadError: null };
  const [snapshot, setSnapshot] = useState<DetailSnapshot>({ ...empty, serverId });
  const activeId = useRef(serverId), mounted = useRef(false), serial = useRef(0), pending = useRef<number | null>(null);
  activeId.current = serverId;

  const refresh = useCallback(async () => {
    if (!serverId || !mounted.current || activeId.current !== serverId) return;
    const sequence = ++serial.current; pending.current = sequence;
    const current = () => mounted.current && activeId.current === serverId && sequence === serial.current;
    try {
      const res = await api.get<{
        server: ServerRecord; runtime: RuntimeInfo | null; running: boolean;
        configAccess?: Record<string, boolean>; permissions: ServerPermission[];
        autoRestart?: AutoRestartState; owner?: { id: string; username: string } | null;
      }>(`/servers/${serverId}`);
      if (!current()) return;
      if (res.server.id !== serverId) throw new Error('The instance response did not match the requested instance');
      setSnapshot({ serverId, server: res.server, runtime: res.runtime, running: res.running,
        configAccess: res.configAccess ?? {}, permissions: res.permissions ?? [], autoRestart: res.autoRestart ?? null,
        owner: res.owner ?? null, suspendedMessage: null, loadError: null });
    } catch (err) {
      if (!current()) return;
      const denied = err instanceof ApiError && [401, 403, 404, 423].includes(err.status);
      setSnapshot(old => ({ ...(old.serverId === serverId && !denied ? old : { ...empty, serverId }),
        suspendedMessage: err instanceof ApiError && err.status === 423 ? err.message : null,
        loadError: err instanceof Error ? err.message : 'Failed to load instance' }));
    } finally { if (pending.current === sequence) pending.current = null; }
  }, [serverId]);

  useEffect(() => {
    mounted.current = true; pending.current = null;
    setSnapshot({ ...empty, serverId });
    void refresh();
    // Skip overlapping polls on slow links; explicit refreshes still supersede older reads.
    const stop = setVisibleInterval(() => { if (pending.current === null) void refresh(); }, 3000);
    return () => { mounted.current = false; serial.current++; pending.current = null; stop(); };
  }, [serverId, refresh]);

  // Routing changes before effects run. Never expose the previous instance's data or grants.
  const details: DetailSnapshot = snapshot.serverId === serverId ? snapshot : { ...empty, serverId };
  const { server, runtime, running, configAccess, permissions, autoRestart, owner, suspendedMessage, loadError } = details;

  const isAdmin = user?.role === 'admin';
  // Admins can still manage a suspended instance; its lock applies to everyone else.
  const locked = !server || (!!server.suspended && !isAdmin);
  const can = (permission: ServerPermission) => !locked && permissions.includes(permission) && !(permission === 'settings' && Object.values(configAccess).includes(false));
  const canConfig = (kind: 'setting' | 'property', key: string) => {
    const alias = kind === 'setting' && key === 'serverPort' ? 'property.server-port' : kind === 'property' && key === 'server-port' ? 'setting.serverPort' : null;
    return !locked && (isAdmin || ((alias ? configAccess[alias] !== false : true) && (configAccess[`${kind}.${key}`] ?? permissions.includes('settings'))));
  };
  const canWrite = !locked && permissions.some((p) => p !== 'files.read');

  return (
    <ServerDetailContext.Provider
      value={{ serverId: serverId!, server, runtime, running, canWrite, can, canConfig, permissions, autoRestart, owner, isOwner: !!owner && owner.id === user?.id, isAdmin, suspendedMessage, loadError, refresh }}
    >
      {children}
    </ServerDetailContext.Provider>
  );
}

export function useServerDetail(): ServerDetailState {
  const ctx = useContext(ServerDetailContext);
  if (!ctx) throw new Error('useServerDetail must be used within ServerDetailProvider');
  return ctx;
}
