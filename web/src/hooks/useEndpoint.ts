import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import type { EndpointInfo } from '../api/types.js';

/** Where players connect to an instance. Re-fetched when the port (or anything in `deps`) changes. */
export function useEndpoint(serverId: string | undefined, port: number | undefined): EndpointInfo | null {
  const [result, setResult] = useState<{ serverId: string; port: number; endpoint: EndpointInfo | null } | null>(null);
  useEffect(() => {
    if (!serverId || port === undefined) return;
    let cancelled = false;
    api
      .get<EndpointInfo>(`/servers/${serverId}/endpoint`)
      .then((endpoint) => !cancelled && setResult({ serverId, port, endpoint }))
      .catch(() => !cancelled && setResult({ serverId, port, endpoint: null }));
    return () => {
      cancelled = true;
    };
  }, [serverId, port]);
  return result && result.serverId === serverId && result.port === port ? result.endpoint : null;
}
