import { useEffect, useState } from 'react';
import { subscribeActivity } from '../api/client.js';

/** Thin bar pinned to the top of the window while any panel request is in flight. */
export function GlobalActivityBar() {
  const [active, setActive] = useState(0);
  useEffect(() => subscribeActivity(setActive), []);
  if (!active) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-0.5 overflow-hidden" role="progressbar" aria-label="Working…" aria-busy="true">
      <div className="ui-progress-sweep absolute inset-y-0 w-1/3 bg-accent-500 shadow-glow" />
    </div>
  );
}
