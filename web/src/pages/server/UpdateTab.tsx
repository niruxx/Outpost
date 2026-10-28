import { ModVersionsCard } from './ModVersionsCard.js';
import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useServerDetail } from './ServerContext.js';
import { useConsoleSocket } from '../../hooks/useConsoleSocket.js';
import { api, ApiError } from '../../api/client.js';
import type { UpdateCheckResult } from '../../api/types.js';
import { useToast } from '../../components/Toast.js';
import { Badge, Button, Card, ErrorText, Spinner } from '../../components/ui.js';
import { AutoUpdateCard } from './AutoUpdateCard.js';

const PRESERVED_BY_PLATFORM: Record<string, string[]> = {
  bedrock: ['worlds/', 'server.properties', 'allowlist.json', 'permissions.json'],
  java: ['world saves', 'server.properties', 'whitelist.json / ops.json / banned-*.json'],
  steam: ['save data (anything outside the game’s depot manifest)', 'config files you’ve edited via the Files tab'],
};

export function UpdateTab() {
  const { serverId, server, running, can, refresh } = useServerDetail();
  const canWrite = can('update');
  const { status: liveStatus, installProgress } = useConsoleSocket(serverId);
  const toast = useToast();
  const [check, setCheck] = useState<UpdateCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [backupFirst, setBackupFirst] = useState(true);
  const [starting, setStarting] = useState(false);
  const [targetVersion, setTargetVersion] = useState('');
  const [versions, setVersions] = useState<string[]>([]);
  useEffect(() => {
    if (server?.platform !== 'java') return;
    setTargetVersion('');
    api.get<{ versions: { version: string }[] }>(`/servers/catalog/versions?loader=${server.loader}`).then(r => setVersions(r.versions.map(v => v.version))).catch(e => setError(e.message));
  }, [server?.loader, serverId]);

  async function runCheck() {
    setChecking(true);
    setError('');
    try {
      const res = await api.get<UpdateCheckResult>(`/servers/${serverId}/update/check`);
      setCheck(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to check for updates');
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    runCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  const isUpdating = liveStatus === 'updating' || server?.status === 'updating';

  async function startUpdate() {
    if (running) return toast.error('Stop the server before updating');
    setStarting(true);
    setError('');
    try {
      if (backupFirst) {
        toast.show('Creating a safety backup before updating…');
        await api.post(`/servers/${serverId}/backups`, { label: 'pre-update' });
      }
      await api.post(`/servers/${serverId}/update`, targetVersion ? { targetVersion } : undefined);
      toast.success('Update started — watch progress below');
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to start update');
    } finally {
      setStarting(false);
    }
  }

  if (!server) return null;
  const preserved = PRESERVED_BY_PLATFORM[server.platform] ?? [];

  return (
    <div className="stagger space-y-6">
      <Card className="p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-medium text-ink-100">Version status</h2>
          <Button className="!px-2.5 !py-1 text-xs" onClick={runCheck} disabled={checking}>
            {checking ? 'Checking…' : 'Check again'}
          </Button>
        </div>

        {checking && !check ? (
          <div className="flex items-center gap-2 py-4 text-sm text-ink-500">
            <Spinner /> Checking for updates…
          </div>
        ) : check ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-xs text-ink-500">Current</p>
                <p className="font-medium text-ink-200">
                  {check.currentVersion}
                  {check.currentBuild ? ` (build ${check.currentBuild})` : ''}
                </p>
              </div>
              <div>
                <p className="text-xs text-ink-500">Latest available</p>
                <p className="font-medium text-ink-200">
                  {check.latestVersion ?? '—'}
                  {check.latestBuild ? ` (build ${check.latestBuild})` : ''}
                </p>
              </div>
            </div>
            <Badge tone={check.updateAvailable ? 'yellow' : 'green'}>
              {check.updateAvailable ? 'Update available' : 'Up to date'}
            </Badge>
            {check.note && <p className="text-xs text-ink-500">{check.note}</p>}
          </div>
        ) : null}
        <ErrorText>{error}</ErrorText>
      </Card>

      {server.platform === 'java' && <Card className="space-y-3 p-5">
        <h2 className="font-medium text-ink-100">Server version</h2>
        <p className="text-sm text-ink-400">Installed: {server.loader} {server.version}. Select a newer or older Minecraft version, then apply below. Mods must support the selected Minecraft version. Downgrading an existing world can damage it; restore a matching backup when moving backwards.</p>
        <select aria-label="Target Minecraft version" className="ui-input w-full" value={targetVersion} onChange={e => setTargetVersion(e.target.value)}>
          <option value="">Current Minecraft version (latest server build)</option>
          {versions.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
      </Card>}
      <ModVersionsCard />
      <Card className="p-5">
        <h2 className="mb-2 text-base font-medium text-ink-100">What's preserved</h2>
        <p className="mb-2 text-sm text-ink-400">
          Updating replaces the server software in place. These are never touched:
        </p>
        <ul className="mb-4 list-inside list-disc space-y-1 text-sm text-ink-300">
          {preserved.map((p) => (
            <li key={p} className="font-mono text-xs text-success-400">
              {p}
            </li>
          ))}
        </ul>

        {running && (
          <p className="mb-3 rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-sm text-yellow-400">
            Stop the server before updating.
          </p>
        )}

        {canWrite && (
          <>
            <label className="mb-3 flex items-center gap-2 text-sm text-ink-300">
              <input type="checkbox" checked={backupFirst} onChange={(e) => setBackupFirst(e.target.checked)} />
              Create a backup first (recommended)
            </label>
            <Button variant="primary" disabled={running || starting || isUpdating} onClick={startUpdate}>
              {starting ? 'Starting…' : isUpdating ? 'Updating…' : targetVersion ? `Install Minecraft ${targetVersion}` : 'Update now'}
            </Button>
          </>
        )}
      </Card>

      {isUpdating && (
        <Card className="p-5">
          <div className="mb-1 flex items-center justify-between text-xs text-ink-400">
            <span className="inline-flex items-center gap-1.5">
              <Spinner className="h-3 w-3 text-accent-400" />
              {installProgress?.message ?? 'Updating…'}
            </span>
            <span>{installProgress?.pct ?? 0}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-surface-700">
            <motion.div
              className="h-full bg-gradient-to-r from-accent-500 to-accent-400"
              animate={{ width: `${installProgress?.pct ?? 5}%` }}
              transition={{ type: 'spring', stiffness: 120, damping: 20 }}
            />
          </div>
          <p className="mt-2 text-xs text-ink-500">Full output is streaming on the Console tab.</p>
        </Card>
      )}

      <AutoUpdateCard />
    </div>
  );
}
