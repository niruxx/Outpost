import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { setVisibleInterval } from './perf.js';

/**
 * A newest-first list from an endpoint returning `{ [key]: T[], nextBefore }`: the first page
 * loads immediately, new items are prepended every `pollMs` (while the tab is visible), and
 * `loadMore` pages backwards. Changing `url` starts over.
 */
export function usePagedFeed<T extends { id: number }, K extends string>(url: string | null, key: K, pollMs = 10_000) {
  const [items, setItems] = useState<T[] | null>(null);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useRef(url);
  current.current = url;

  const sep = (u: string) => (u.includes('?') ? '&' : '?');

  const refresh = useCallback(async (initial: boolean) => {
    if (!url) return;
    try {
      const res = await api.get<Record<K, T[]> & { nextBefore: number | null }>(url);
      if (current.current !== url) return;
      setError(null);
      if (initial) {
        setItems(res[key]);
        setNextBefore(res.nextBefore);
      } else {
        // Prepend only what's new, keeping pages already loaded further down.
        setItems((prev) => {
          if (!prev) return res[key];
          const top = prev[0]?.id ?? 0;
          const fresh = res[key].filter((i) => i.id > top);
          return fresh.length ? [...fresh, ...prev] : prev;
        });
      }
    } catch (err) {
      if (current.current === url) setError(err instanceof Error ? err.message : 'Failed to load');
    }
  }, [url, key]);

  useEffect(() => {
    setItems(null);
    setNextBefore(null);
    setError(null);
    if (!url) return;
    void refresh(true);
    return setVisibleInterval(() => void refresh(false), pollMs);
  }, [url, refresh, pollMs]);

  const loadMore = useCallback(async () => {
    if (!url || !nextBefore) return;
    setLoadingMore(true);
    try {
      const res = await api.get<Record<K, T[]> & { nextBefore: number | null }>(`${url}${sep(url)}before=${nextBefore}`);
      if (current.current !== url) return;
      setItems((prev) => [...(prev ?? []), ...res[key]]);
      setNextBefore(res.nextBefore);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load more');
    } finally {
      setLoadingMore(false);
    }
  }, [url, key, nextBefore]);

  return { items, nextBefore, loadingMore, loadMore, error };
}
