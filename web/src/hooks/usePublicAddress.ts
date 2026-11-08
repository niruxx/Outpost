import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import type { PublicAddressInfo } from '../api/types.js';

/** This network's public IP, shared by every instance. Undefined while loading, null if it failed. */
export function usePublicAddress(): PublicAddressInfo | null | undefined {
  const [info, setInfo] = useState<PublicAddressInfo | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    api
      .get<PublicAddressInfo>('/system/public-address')
      .then((res) => !cancelled && setInfo(res))
      .catch(() => !cancelled && setInfo(null));
    return () => {
      cancelled = true;
    };
  }, []);
  return info;
}
