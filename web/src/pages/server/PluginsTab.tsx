import { useCallback, useEffect, useRef, useState } from 'react';
import { useServerDetail } from './ServerContext.js';
import { api, ApiError } from '../../api/client.js';
import type { AddonSupport, InstalledPlugin, ServerRecord } from '../../api/types.js';
import { isProxyLoader, PLUGIN_CAPABLE_LOADERS } from '../../api/types.js';
import { useToast } from '../../components/Toast.js';
import { useConfirm } from '../../components/ConfirmDialog.js';
import { PluginSearchModal } from '../../components/PluginSearchModal.js';
import { Badge, Button, Card, Notice, Spinner } from '../../components/ui.js';
import { Icon } from '../../components/icons.js';
import { gameKindOf } from '../../components/GameArt.js';

/** Sidebar label for an instance's add-on page — each game calls them something different. */
export function addonNavLabel(server: ServerRecord): string {
  if (PLUGIN_CAPABLE_LOADERS.includes(server.loader) || isProxyLoader(server.loader)) return 'Plugins';
  if (server.loader === 'vanilla') return 'Data Packs';
  if (server.platform === 'bedrock') return 'Add-ons';
  return gameKindOf(server) === 'valheim' ? 'Plugins' : 'Mods';
}

function formatSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb < 1 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${mb.toFixed(1)} MB`;
}

export function PluginsTab() {
  const { serverId, can } = useServerDetail();
  const canWrite = can('plugins');
  const toast = useToast();
  const confirm = useConfirm();
  const [support, setSupport] = useState<AddonSupport | null>(null);
  const [plugins, setPlugins] = useState<InstalledPlugin[] | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [busyFile, setBusyFile] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ support: AddonSupport; plugins: InstalledPlugin[] }>(`/servers/${serverId}/plugins`);
      setSupport(res.support);
      setPlugins(res.plugins);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to load');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  useEffect(() => {
    load();
  }, [load]);

  if (!support || plugins === null) {
    return (
      <div className="flex items-center gap-2 text-sm text-ink-400">
        <Spinner /> Loading…
      </div>
    );
  }

  if (!support.supported) {
    return (
      <Card className="p-8 text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-surface-700 text-ink-300">
          <Icon name="plugin" />
        </div>
        <p className="mb-2 text-base font-medium text-ink-100">No mod support for this instance</p>
        <p className="mx-auto max-w-lg text-sm text-ink-400">{support.reason}</p>
      </Card>
    );
  }

  const profile = support.profile;

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    const form = new FormData();
    Array.from(files).forEach((f) => form.append('files', f));
    setUploading(true);
    try {
      const res = await api.upload<{ installed: string[]; plugins: InstalledPlugin[] }>(`/servers/${serverId}/plugins/upload`, form);
      setPlugins(res.plugins);
      toast.success(`Installed ${res.installed.join(', ')}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function toggle(plugin: InstalledPlugin) {
    setBusyFile(plugin.fileName);
    try {
      const res = await api.post<{ plugins: InstalledPlugin[] }>(`/servers/${serverId}/plugins/${encodeURIComponent(plugin.fileName)}/toggle`, {
        enabled: !plugin.enabled,
      });
      setPlugins(res.plugins);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to toggle');
    } finally {
      setBusyFile(null);
    }
  }

  async function remove(plugin: InstalledPlugin) {
    const ok = await confirm({
      title: `Delete ${profile.singular}`,
      message: `Delete ${plugin.displayName}? This can't be undone.`,
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    setBusyFile(plugin.fileName);
    try {
      await api.delete(`/servers/${serverId}/plugins/${encodeURIComponent(plugin.fileName)}`);
      toast.success(`Deleted ${plugin.displayName}`);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to delete');
    } finally {
      setBusyFile(null);
    }
  }

  const actions = canWrite && (
    <div className="flex flex-wrap gap-2">
      {profile.catalog && (
        <Button variant="primary" onClick={() => setBrowsing(true)}>
          <Icon name="search" className="h-4 w-4" /> Browse {profile.label.toLowerCase()}
        </Button>
      )}
      <Button variant={profile.catalog ? 'default' : 'primary'} disabled={uploading} onClick={() => fileInput.current?.click()}>
        {uploading ? <Spinner /> : <Icon name="upload" className="h-4 w-4" />} Upload {profile.extensions.join(' / ')}
      </Button>
      <input ref={fileInput} type="file" multiple accept={profile.extensions.join(',')} className="hidden" onChange={(e) => upload(e.target.files)} />
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-normal text-ink-50">{profile.label}</h2>
          <p className="mt-1 text-sm text-ink-400">
            Stored in <span className="font-mono text-ink-300">{profile.folder}</span>
          </p>
        </div>
        {actions}
      </div>

      {profile.warning && <Notice tone="warning">{profile.warning}</Notice>}
      {profile.notes.length > 0 && (
        <Notice tone="info">
          <ul className="list-disc space-y-1 pl-4">
            {profile.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </Notice>
      )}

      <Card className="overflow-hidden">
        {plugins.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-ink-400">No {profile.label.toLowerCase()} installed yet.</div>
        ) : (
          <div className="divide-y divide-surface-700">
            {plugins.map((p, i) => (
              <div key={p.fileName} style={{ animationDelay: `${Math.min(i, 20) * 18}ms` }} className="animate-fade-in-up flex items-center gap-3 px-4 py-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-700 text-ink-300">
                  <Icon name="plugin" className="h-[18px] w-[18px]" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink-100">{p.displayName}</p>
                  <p className="truncate text-xs text-ink-400">
                    {formatSize(p.sizeBytes)}
                    {p.detail && ` · ${p.detail}`}
                  </p>
                </div>
                <Badge tone={p.enabled ? 'green' : 'neutral'}>{p.enabled ? 'Enabled' : 'Disabled'}</Badge>
                {canWrite && (
                  <div className="flex gap-1.5">
                    {p.canToggle && (
                      <Button disabled={busyFile === p.fileName} onClick={() => toggle(p)}>
                        {p.enabled ? 'Disable' : 'Enable'}
                      </Button>
                    )}
                    <Button variant="danger" disabled={busyFile === p.fileName} onClick={() => remove(p)}>
                      Delete
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      {profile.catalog && (
        <PluginSearchModal
          open={browsing}
          onClose={() => setBrowsing(false)}
          defaultServerId={serverId}
          catalog={profile.catalog}
          onInstalled={load}
        />
      )}
    </div>
  );
}
