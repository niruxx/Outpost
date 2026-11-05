import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../state/AuthContext.js';

/**
 * Pinned instances — a per-account, per-browser list kept in localStorage. Pinned instances
 * sort first on the Instances page and get their own sidebar group. Every hook instance listens
 * for changes, so pinning from a card updates the sidebar immediately (and other tabs too).
 */
const EVENT = 'outpost:pins';
const keyFor = (userId: string) => `outpost_pins:${userId}`;

function read(userId: string | undefined): string[] {
  if (!userId) return [];
  try {
    const value = JSON.parse(localStorage.getItem(keyFor(userId)) ?? '[]');
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function usePinnedInstances(): { pinned: string[]; isPinned: (id: string) => boolean; toggle: (id: string) => void } {
  const { user } = useAuth();
  const userId = user?.id;
  const [pinned, setPinned] = useState<string[]>(() => read(userId));

  useEffect(() => {
    const sync = () => setPinned(read(userId));
    sync();
    const onStorage = (e: StorageEvent) => {
      if (userId && e.key === keyFor(userId)) sync();
    };
    window.addEventListener(EVENT, sync);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener('storage', onStorage);
    };
  }, [userId]);

  const toggle = useCallback((id: string) => {
    if (!userId) return;
    const current = read(userId);
    const next = current.includes(id) ? current.filter((p) => p !== id) : [...current, id];
    try {
      localStorage.setItem(keyFor(userId), JSON.stringify(next));
    } catch {
      /* storage blocked — pins just won't persist */
    }
    setPinned(next);
    window.dispatchEvent(new Event(EVENT));
  }, [userId]);

  const isPinned = useCallback((id: string) => pinned.includes(id), [pinned]);
  return { pinned, isPinned, toggle };
}
