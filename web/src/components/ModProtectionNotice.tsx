import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { setVisibleInterval } from '../lib/perf.js';
import { Notice } from './ui.js';
export function ModProtectionNotice({ serverId }: { serverId: string }) {
  const [state, setState] = useState<{ protectedUploads: boolean; realtimeEnabled: boolean; hold: boolean } | null>(null);
  useEffect(() => { let active = true; const load = () => api.get<NonNullable<typeof state>>(`/servers/${serverId}/antivirus`).then(s => { if (active) setState(s); }).catch(() => { if (active) setState(null); }); void load(); const stop = setVisibleInterval(load, 10000); return () => { active = false; stop(); }; }, [serverId]);
  return <Notice tone={state?.hold ? 'error' : state?.protectedUploads ? 'info' : 'warning'}>{state ? state.hold ? 'Antivirus findings: this instance cannot start until the findings are resolved and a full clean scan succeeds.' : state.protectedUploads ? `Mod uploads, including supported JAR/ZIP contents, are scanned before installation.${state.realtimeEnabled ? ' Live mod-folder monitoring is also enabled.' : ''}` : 'Mod upload scanning is disabled on this host.' : 'Mod antivirus status is unavailable.'} <Link className="underline" to={`/instances/${serverId}/configuration?section=antivirus`}>View malware protection</Link></Notice>;
}
