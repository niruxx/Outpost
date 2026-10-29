import { SteamAccountSelect } from '../../components/SteamAccountSelect.js';
import { useEffect, useState } from 'react';
import { DatabasesCard } from './DatabasesCard.js';
import { BackupStorageCard } from './BackupStorageCard.js';
import { useServerDetail } from './ServerContext.js';
import { api, ApiError } from '../../api/client.js';
import type { PropertyEntry, RestartPolicy } from '../../api/types.js';
import { Button, Card, ErrorText, Field, Input, Select } from '../../components/ui.js';
import { InstanceAdminCards } from './AdminCards.js';
import { LaunchCard } from './LaunchCard.js';
import { DockerCard } from './DockerCard.js';
import { IsolationCard } from './IsolationCard.js';
import { RconCard } from './RconCard.js';
import { TemplateCard } from './TemplateCard.js';
import { StatusPageCard } from './StatusPageCard.js';
import { LimitsCard } from './LimitsCard.js';
import { isMinecraftPlatform, isProxyLoader } from '../../api/types.js';

export function SettingsTab() {
  const { server, can, canConfig, refresh } = useServerDetail();
  const canWrite = can('settings') || canConfig('property', 'server-ip') || ['name', 'minMemoryMb', 'maxMemoryMb', 'serverPort', 'extraJavaArgs', 'extraArgs', 'autoStart', 'steamLogin', 'steamExtraFlags', 'restartPolicy', 'restartDelaySec', 'restartMaxAttempts'].some((key) => canConfig('setting', key));
  const [name, setName] = useState('');
  const [minMemoryMb, setMinMemoryMb] = useState(1024);
  const [maxMemoryMb, setMaxMemoryMb] = useState(2048);
  const [serverPort, setServerPort] = useState(25565);
  const [extraJavaArgs, setExtraJavaArgs] = useState('');
  const [extraArgs, setExtraArgs] = useState('');
  const [autoStart, setAutoStart] = useState(false);
  const [restartPolicy, setRestartPolicy] = useState<RestartPolicy>('never');
  const [restartDelaySec, setRestartDelaySec] = useState(10);
  const [restartMaxAttempts, setRestartMaxAttempts] = useState(0);
  const [serverIp, setServerIp] = useState('');
  const [steamLogin, setSteamLogin] = useState('anonymous');
  const [steamExtraFlags, setSteamExtraFlags] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!server) return;
    setName(server.name);
    setMinMemoryMb(server.min_memory_mb);
    setMaxMemoryMb(server.max_memory_mb);
    setServerPort(server.server_port);
    setExtraJavaArgs(server.extra_java_args);
    setExtraArgs(server.extra_args);
    setAutoStart(!!server.auto_start);
    setRestartPolicy(server.restart_policy ?? 'never');
    setRestartDelaySec(server.restart_delay_sec ?? 10);
    setRestartMaxAttempts(server.restart_max_attempts ?? 0);
    setSteamLogin(server.steam_login || 'anonymous');
    setSteamExtraFlags(server.steam_extra_flags || '');
    if (server.platform === 'java') {
      api
        .get<{ properties: PropertyEntry[] }>(`/servers/${server.id}/properties`)
        .then((res) => setServerIp(res.properties.find((p) => p.key === 'server-ip')?.value ?? ''))
        .catch(() => {});
    }
    // Polling replaces the server object every three seconds; only initialize on instance changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server?.id]);

  async function saveGeneral() {
    setSaving(true);
    setSaveError('');
    setSaved(false);
    try {
      await api.patch(`/servers/${server!.id}`, Object.fromEntries(Object.entries({
        name,
        minMemoryMb,
        maxMemoryMb,
        serverPort,
        extraJavaArgs,
        extraArgs,
        autoStart,
        restartPolicy,
        restartDelaySec,
        restartMaxAttempts,
        ...(server!.platform === 'steam' ? { steamLogin: steamLogin.trim() || 'anonymous', steamExtraFlags } : {}),
      }).filter(([key]) => canConfig('setting', key))));
      if (server!.platform === 'java' && canConfig('property', 'server-ip')) {
        await api.put(`/servers/${server!.id}/properties`, { updates: { 'server-ip': serverIp } });
      }
      await refresh();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  if (!server) return null;

  return (
    <div className="stagger space-y-6">
      <Card className="p-5">
        <h2 className="mb-4 text-base font-medium text-ink-100">General</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Instance name">
            <Input value={name} onChange={(e) => setName(e.target.value)} disabled={!canConfig('setting', 'name')} />
          </Field>
          <Field label="Port">
            <Input type="number" value={serverPort} onChange={(e) => setServerPort(Number(e.target.value))} disabled={!canConfig('setting', 'serverPort')} />
          </Field>
          {server.platform === 'java' && (
            <Field label="Bind IP address (server-ip)">
              <Input
                value={serverIp}
                onChange={(e) => setServerIp(e.target.value)}
                disabled={!canConfig('property', 'server-ip')}
                placeholder="0.0.0.0 (all interfaces)"
              />
            </Field>
          )}
          {server.platform !== 'steam' && (
            <>
              <Field label={server.platform === 'custom' ? 'Min memory (MB) — {{MIN_MEMORY}}' : 'Min memory (MB)'}>
                <Input type="number" value={minMemoryMb} onChange={(e) => setMinMemoryMb(Number(e.target.value))} disabled={!canConfig('setting', 'minMemoryMb')} />
              </Field>
              <Field label={server.platform === 'custom' ? 'Max memory (MB) — {{MAX_MEMORY}}' : 'Max memory (MB)'}>
                <Input type="number" value={maxMemoryMb} onChange={(e) => setMaxMemoryMb(Number(e.target.value))} disabled={!canConfig('setting', 'maxMemoryMb')} />
              </Field>
            </>
          )}
          {server.platform === 'java' && (
            <Field label="Extra JVM args">
              <Input value={extraJavaArgs} onChange={(e) => setExtraJavaArgs(e.target.value)} disabled={!canConfig('setting', 'extraJavaArgs')} placeholder="-XX:+UseG1GC" />
            </Field>
          )}
          <Field label={server.platform === 'java' || server.platform === 'bedrock' ? 'Extra server args' : 'Extra launch args'}>
            <Input value={extraArgs} onChange={(e) => setExtraArgs(e.target.value)} disabled={!canConfig('setting', 'extraArgs')} />
          </Field>
          {server.platform === 'steam' && (
            <>
              <SteamAccountSelect value={steamLogin} onChange={setSteamLogin} disabled={!canConfig('setting', 'steamLogin')} />
              <Field label="Steam login">
                <Input value={steamLogin} onChange={(e) => setSteamLogin(e.target.value)} disabled={!canConfig('setting', 'steamLogin')} placeholder="anonymous" />
              </Field>
              <Field label="Extra steamcmd flags">
                <Input
                  value={steamExtraFlags}
                  onChange={(e) => setSteamExtraFlags(e.target.value)}
                  disabled={!canConfig('setting', 'steamExtraFlags')}
                  placeholder="e.g. -beta staging"
                />
              </Field>
            </>
          )}
        </div>
        {server.platform === 'steam' && (
          <p className="mt-2 text-xs text-ink-500">
            Steam login and extra flags apply the next time this server is installed or updated via steamcmd (not
            retroactively). Login defaults to <span className="font-mono">anonymous</span>; a real{' '}
            <span className="font-mono">username password</span> is needed for games that require an owned license —
            interactive Steam Guard prompts aren't supported.
          </p>
        )}
        <label className="mt-4 flex items-center gap-2 text-sm text-ink-300">
          <input type="checkbox" checked={autoStart} onChange={(e) => setAutoStart(e.target.checked)} disabled={!canConfig('setting', 'autoStart')} />
          Automatically start this instance when the panel boots
        </label>

        <div className="mt-5 rounded-2xl bg-surface-900 p-4">
          <p className="mb-1 text-sm font-medium text-ink-100">Automatic restart</p>
          <p className="mb-3 text-xs text-ink-400">
            Bring the instance back up when its process stops on its own. Stopping it from the panel never triggers a restart, and
            pressing Stop while a restart is pending cancels it.
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Restart when it">
              <Select value={restartPolicy} onChange={(e) => setRestartPolicy(e.target.value as RestartPolicy)} disabled={!canConfig('setting', 'restartPolicy')}>
                <option value="never">Never restart automatically</option>
                <option value="on-crash">Crashes or fails (non-zero exit / killed)</option>
                <option value="always">Stops for any reason (incl. in-game stop)</option>
              </Select>
            </Field>
            <Field label="Wait before restarting (seconds)">
              <Input
                type="number"
                min={1}
                max={3600}
                value={restartDelaySec}
                onChange={(e) => setRestartDelaySec(Number(e.target.value))}
                disabled={!canConfig('setting', 'restartDelaySec') || restartPolicy === 'never'}
              />
            </Field>
            <Field label="Give up after (attempts, 0 = never)">
              <Input
                type="number"
                min={0}
                max={10000}
                value={restartMaxAttempts}
                onChange={(e) => setRestartMaxAttempts(Number(e.target.value))}
                disabled={!canConfig('setting', 'restartMaxAttempts') || restartPolicy === 'never'}
              />
            </Field>
          </div>
          {restartPolicy !== 'never' && (
            <p className="mt-3 text-xs text-ink-500">
              {restartMaxAttempts === 0
                ? 'It keeps restarting for as long as it keeps stopping.'
                : `It stops trying after ${restartMaxAttempts} restart${restartMaxAttempts === 1 ? '' : 's'} in a row.`}{' '}
              A run of 10 minutes or more counts as healthy and resets the count.
            </p>
          )}
        </div>
        <p className="mt-2 text-xs text-ink-500">
          Memory and argument changes take effect the next time the server starts.
        </p>
        <ErrorText>{saveError}</ErrorText>
        {canWrite && (
          <div className="mt-4 flex items-center gap-3">
            <Button variant="primary" onClick={saveGeneral} disabled={saving}>
              {saving ? 'Saving…' : 'Save changes'}
            </Button>
            {saved && <span className="text-sm text-success-500">Saved</span>}
          </div>
        )}
      </Card>

      <BackupStorageCard />
      {server.platform === 'docker' ? <DockerCard /> : <LaunchCard />}
      <IsolationCard />
      <LimitsCard />
      {server.platform !== 'docker' && <DatabasesCard />}
      {server.platform !== 'docker' && server.platform !== 'bedrock' && <RconCard />}
      <StatusPageCard />
      <TemplateCard />

      {!isMinecraftPlatform(server.platform) || isProxyLoader(server.loader) ? (
        <Card className="p-5">
          <h2 className="mb-2 text-base font-medium text-ink-100">Config files</h2>
          <p className="text-sm text-ink-400">
            {isProxyLoader(server.loader)
              ? `Proxies have no server.properties — backends, join order and forwarding are on the Network tab, and the rest of ${server.loader === 'velocity' ? 'velocity.toml' : 'config.yml'} is in File Management.`
              : `${server.platform === 'custom' ? 'Custom instances keep their config in their own files' : "This game's config files aren't edited here"} — open File Management to view or edit whatever config file it writes (INI, JSON, or otherwise).`}
          </p>
        </Card>
      ) : (
        <PropertiesEditor serverId={server.id} canWrite={canWrite} />
      )}

      <InstanceAdminCards />
    </div>
  );
}

function PropertiesEditor({ serverId, canWrite }: { serverId: string; canWrite: boolean }) {
  const { canConfig } = useServerDetail();
  const [properties, setProperties] = useState<PropertyEntry[] | null>(null);
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [feedback, setFeedback] = useState('');

  async function load() {
    try {
      const res = await api.get<{ properties: PropertyEntry[] }>(`/servers/${serverId}/properties`);
      setProperties(res.properties);
      setEdited({});
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load properties');
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  async function save() {
    if (Object.keys(edited).length === 0) return;
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const res = await api.put<{ properties: PropertyEntry[]; liveQueued: string[]; restartRequired: string[] }>(`/servers/${serverId}/properties`, { updates: edited });
      setProperties(res.properties);
      setEdited({});
      setFeedback([
        res.liveQueued.length ? `Live commands sent for: ${res.liveQueued.join(', ')}. Check Console for results.` : '',
        res.restartRequired.length ? `Applies on next start: ${res.restartRequired.join(', ')}.` : '',
      ].filter(Boolean).join(' '));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save properties');
    } finally {
      setSaving(false);
    }
  }

  if (!properties) return <p className="text-sm text-ink-500">Loading properties…</p>;

  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-medium text-ink-100">server.properties</h2>
        <p className="text-xs text-ink-500">Supported Java settings apply through the live console; other settings apply on next start.</p>
      </div>

      <div className="max-h-96 overflow-y-auto rounded-md border border-surface-700">
        <table className="w-full text-sm">
          <tbody>
            {properties.map((p) => (
              <tr key={p.key} className="border-b border-surface-800 last:border-0">
                <td className="w-1/3 px-3 py-1.5 font-mono text-xs text-ink-400">{p.key}</td>
                <td className="px-3 py-1.5">
                  <input
                    className="w-full rounded bg-transparent px-1 py-0.5 font-mono text-xs text-ink-100 focus:bg-surface-800 focus:outline-none"
                    value={edited[p.key] ?? p.value}
                    disabled={!canConfig('property', p.key) || saving}
                    onChange={(e) => setEdited((prev) => ({ ...prev, [p.key]: e.target.value }))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(canWrite || canConfig('property', newKey.trim())) && (
        <div className="mt-3 flex items-end gap-2">
          <Field label="New key">
            <Input value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="motd" />
          </Field>
          <Field label="Value">
            <Input value={newValue} onChange={(e) => setNewValue(e.target.value)} />
          </Field>
          <Button
            onClick={() => {
              if (!newKey.trim() || !canConfig('property', newKey.trim())) return;
              setEdited((prev) => ({ ...prev, [newKey.trim()]: newValue }));
              setProperties((prev) => prev?.some((p) => p.key === newKey.trim()) ? prev : [...(prev ?? []), { key: newKey.trim(), value: newValue }]);
              setNewKey('');
              setNewValue('');
            }}
          >
            Add
          </Button>
        </div>
      )}

      <ErrorText>{error}</ErrorText>
      {feedback && <p className="mt-3 text-sm text-ink-400">{feedback}</p>}

      {(canWrite || Object.keys(edited).length > 0) && (
        <div className="mt-4 flex items-center gap-3">
          <Button variant="primary" onClick={save} disabled={saving || Object.keys(edited).length === 0}>
            {saving ? 'Saving…' : `Save ${Object.keys(edited).length || ''} change(s)`}
          </Button>
          {saved && <span className="text-sm text-success-500">Saved</span>}
        </div>
      )}
    </Card>
  );
}
