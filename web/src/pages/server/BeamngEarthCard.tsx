import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client.js';
import { Button, Card, CardTitle, ErrorText, Notice } from '../../components/ui.js';
import { useToast } from '../../components/Toast.js';
import { beammpInfo } from '../../lib/beammp.js';
import { useServerDetail } from './ServerContext.js';

interface EarthInfo { enabled: boolean; requested: boolean; installed: boolean; version: string | null; map: string | null; releasesUrl: string; clientRequired: boolean }
export function BeamngEarthCard({ onChanged }: { onChanged?: () => void }) {
  const { server, isAdmin, refresh } = useServerDetail();
  const visible = !!server && !!beammpInfo(server);
  const [info, setInfo] = useState<EarthInfo | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const current = useRef<string | null>(null);
  const toast = useToast();
  useEffect(() => {
    const id = server?.id;
    current.current = id ?? null;
    setInfo(null); setError('');
    if (!visible || !id) return;
    api.get<EarthInfo>(`/servers/${id}/beammp/earth`).then(result => { if (current.current === id) setInfo(result); }).catch(error => { if (current.current === id) setError(error instanceof Error ? error.message : 'Could not read Earth setup'); });
    return () => { current.current = null; };
  }, [server?.id, server?.launch_config, visible]);

  async function change(action: 'install' | 'disable') {
    if (!server || busy) return;
    const id = server.id;
    setBusy(true); setError('');
    try {
      const result = await api.post<EarthInfo>(`/servers/${id}/beammp/earth/${action}`);
      if (current.current !== id) return;
      setInfo(result); onChanged?.(); await refresh();
      toast.success(action === 'install' ? 'BeamNG.Earth enabled. Start the server to play.' : 'BeamNG.Earth disabled; the previous map is restored.');
    } catch (error) { if (current.current === id) setError(error instanceof Error ? error.message : 'Earth setup failed'); }
    finally { if (current.current === id) setBusy(false); }
  }
  if (!server || !visible) return null;
  const stopped = ['stopped', 'crashed', 'install_failed'].includes(server.status);
  return <Card aria-label="BeamNG.Earth setup" className="space-y-3 p-5">
    <CardTitle>BeamNG.Earth</CardTitle>
    <p className="text-sm text-ink-300">{info?.enabled ? `Enabled${info.version ? ` — ${info.version}` : ''}` : info?.requested ? 'Earth setup requested — install its files before starting' : 'Turn this BeamMP instance into a streamed Earth multiplayer server.'}</p>
    <p className="text-sm text-ink-400">Setup downloads the official client mod and server plugin and selects the Earth map. Your other mods and cached Earth data are kept.</p>
    <Notice tone="info">Every player needs the matching <a href="https://github.com/TecnaGamer/BeamNG.Earth/releases" target="_blank" rel="noreferrer" className="underline">BeamNG.Earth app</a> running on their own computer{info?.version ? ` (${info.version})` : ''}. Private servers use Direct Connect; public ones appear in the BeamNG.Earth category.</Notice>
    {isAdmin && <div className="flex flex-wrap gap-2">
      <Button variant="primary" disabled={busy || !stopped || !info} onClick={() => change('install')}>{busy ? 'Applying Earth setup…' : info?.enabled ? 'Install latest Earth package' : 'Enable BeamNG.Earth'}</Button>
      {(info?.installed || info?.requested) && <Button variant="ghost" disabled={busy || !stopped} onClick={() => change('disable')}>Disable BeamNG.Earth</Button>}
    </div>}
    {!stopped && isAdmin && <p className="text-xs text-ink-400">Stop the server and finish installation before changing Earth setup.</p>}
    {!isAdmin && <p className="text-xs text-ink-400">An administrator can enable or disable this server setup.</p>}
    {info?.enabled && <p className="text-xs text-ink-400">Installing the latest package replaces Earth plugin files. Keep a copy of custom Lua edits. Disabling keeps the files and restores the previous map.</p>}
    <ErrorText>{error}</ErrorText>
  </Card>;
}
