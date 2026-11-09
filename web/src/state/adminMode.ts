import { useEffect, useSyncExternalStore } from 'react';
import { api } from '../api/client.js';

/** What /api/host-files reports about the host and this browser session's Admin Mode. */
export interface HostFilesStatus {
  platform: string;
  serviceUser: string;
  home: string;
  root: string;
  admin: {
    available: boolean;
    needsPassword: boolean;
    /** Outpost already runs as root / elevated, so there is nothing to switch. */
    alwaysOn: boolean;
    reason: string | null;
    active: boolean;
    since: string | null;
    idleMinutes: number;
  };
}

// One shared store, so the top-bar button and the file manager always agree.
let status: HostFilesStatus | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const set = (next: HostFilesStatus | null) => {
  status = next;
  emit();
};

/** Forget the cached status (sign-out), so the next account doesn't see the previous one's state. */
export function resetAdminMode() {
  set(null);
}

export function refreshAdminMode(): Promise<void> {
  loading ??= api
    .get<HostFilesStatus>('/host-files')
    .then(set)
    .catch(() => set(null))
    .finally(() => {
      loading = null;
    });
  return loading;
}

export async function enableAdminMode(password: string): Promise<void> {
  set(await api.post<HostFilesStatus>('/host-files/admin', { password }));
}

export async function disableAdminMode(): Promise<void> {
  set(await api.delete<HostFilesStatus>('/host-files/admin'));
}

/** Admin Mode state for administrators; `enabled: false` skips the request for everyone else. */
export function useAdminMode(enabled = true) {
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => status
  );
  useEffect(() => {
    if (!enabled) return;
    if (!status) void refreshAdminMode();
    // Admin Mode ends server-side after idling; keep the indicator honest.
    const timer = window.setInterval(() => void refreshAdminMode(), 60_000);
    return () => window.clearInterval(timer);
  }, [enabled]);
  return enabled ? current : null;
}
