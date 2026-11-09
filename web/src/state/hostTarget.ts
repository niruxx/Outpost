import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { api } from '../api/client.js';
import { disableAdminMode as disableLocal, enableAdminMode as enableLocal, useAdminMode, type HostFilesStatus } from './adminMode.js';

/**
 * Which host the Host pages act on: this one, or a linked Outpost node (proxied through
 * /api/remote-host/:nodeId). Kept per browser tab.
 */
export interface HostTarget {
  nodeId: string | null;
  name: string | null;
}

const KEY = 'outpost_host_target';
let target: HostTarget = (() => {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as HostTarget;
  } catch {
    // ignore
  }
  return { nodeId: null, name: null };
})();
const listeners = new Set<() => void>();

export function setHostTarget(next: HostTarget) {
  target = next;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // private mode
  }
  listeners.forEach((l) => l());
}

export function useHostTarget(): HostTarget {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => target
  );
}

/** API path for the selected host: /host/… locally, /remote-host/<id>/… for a linked host. */
export function hostApi(path: string, t: HostTarget = target): string {
  return t.nodeId ? `/remote-host/${encodeURIComponent(t.nodeId)}${path}` : `/host${path}`;
}

/** Admin Mode for the selected host. Locally this is the same session the top-bar button shows. */
export function useHostAdmin() {
  const t = useHostTarget();
  const local = useAdminMode(!t.nodeId);
  const [remote, setRemote] = useState<(HostFilesStatus & { hostname?: string }) | null>(null);
  const [remoteError, setRemoteError] = useState('');

  const refreshRemote = useCallback(async () => {
    if (!t.nodeId) return;
    try {
      setRemote(await api.get(hostApi('/admin-mode', t)));
      setRemoteError('');
    } catch (err) {
      setRemote(null);
      setRemoteError(err instanceof Error ? err.message : 'Unreachable');
    }
  }, [t]);

  useEffect(() => {
    setRemote(null);
    if (!t.nodeId) return;
    void refreshRemote();
    const timer = window.setInterval(() => void refreshRemote(), 60_000);
    return () => window.clearInterval(timer);
  }, [t, refreshRemote]);

  const status = t.nodeId ? remote : local;
  return {
    target: t,
    status,
    error: t.nodeId ? remoteError : '',
    active: !!status?.admin.active,
    enable: async (password: string) => {
      if (!t.nodeId) return enableLocal(password);
      setRemote(await api.post(hostApi('/admin-mode', t), { password }));
    },
    disable: async () => {
      if (!t.nodeId) return disableLocal();
      setRemote(await api.delete(hostApi('/admin-mode', t)));
    },
  };
}
