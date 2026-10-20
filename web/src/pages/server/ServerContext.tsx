import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
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
  const [server, setServer] = useState<ServerRecord | null>(null);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [running, setRunning] = useState(false);
  const [permissions, setPermissions] = useState<ServerPermission[]>([]);
  const [autoRestart, setAutoRestart] = useState<AutoRestartState | null>(null);
  const [owner, setOwner] = useState<{ id: string; username: string } | null>(null);
  const [suspendedMessage, setSuspendedMessage] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function refresh() {
    if (!serverId) return;
    try {
      const res = await api.get<{
        server: ServerRecord;
        runtime: RuntimeInfo | null;
        running: boolean;
        permissions: ServerPermission[];
        autoRestart?: AutoRestartState;
        owner?: { id: string; username: string } | null;
      }>(
        `/servers/${serverId}`
      );
      setServer(res.server);
      setPermissions(res.permissions ?? []);
      setAutoRestart(res.autoRestart ?? null);
      setOwner(res.owner ?? null);
      setRuntime(res.runtime);
      setRunning(res.running);
      setSuspendedMessage(null);
      setLoadError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 423) {
        setSuspendedMessage(err.message);
        setServer(null);
      } else {
        setLoadError(err instanceof ApiError ? err.message : 'Failed to load instance');
      }
    }
  }

  useEffect(() => {
    setServer(null);
    setSuspendedMessage(null);
    setLoadError(null);
    refresh();
    const interval = setVisibleInterval(refresh, 3000);
    return () => interval();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  const isAdmin = user?.role === 'admin';
  // Admins can still manage a suspended instance; its lock applies to everyone else.
  const locked = !!server?.suspended && !isAdmin;
  const can = (permission: ServerPermission) => !locked && permissions.includes(permission);
  const canWrite = !locked && permissions.some((p) => p !== 'files.read');

  return (
    <ServerDetailContext.Provider
      value={{ serverId: serverId!, server, runtime, running, canWrite, can, permissions, autoRestart, owner, isOwner: !!owner && owner.id === user?.id, isAdmin, suspendedMessage, loadError, refresh }}
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
