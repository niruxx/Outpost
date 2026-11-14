import { useEffect, useState } from 'react';
import { getToken } from '../api/client.js';
import type { BannerArtwork } from '../api/types.js';

/** Fetch with the session header, so private artwork never puts credentials in image URLs. */
export function BannerImage({ serverId, artwork }: { serverId: string; artwork: BannerArtwork }) {
  const [url, setUrl] = useState<string | null>(null), [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); let objectUrl: string | null = null;
    setUrl(null); setFailed(false);
    const token = getToken(); if (!token) return;
    void fetch(`/api/servers/${encodeURIComponent(serverId)}/banner?v=${encodeURIComponent(artwork.version)}`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal })
      .then(async (res) => { if (!res.ok || !['image/png', 'image/jpeg', 'image/webp'].includes(res.headers.get('content-type')?.split(';')[0] ?? '')) throw new Error('Banner unavailable'); return res.blob(); })
      .then((blob) => { if (!controller.signal.aborted) { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); } })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [serverId, artwork.version]);
  return url && !failed ? <img src={url} alt="" draggable={false} onError={() => setFailed(true)} className="absolute inset-0 h-full w-full object-cover" style={{ objectPosition: `${artwork.positionX}% ${artwork.positionY}%` }} /> : null;
}
