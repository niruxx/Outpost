import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { setVisibleInterval } from '../../lib/perf.js';
import { useServerDetail } from './ServerContext.js';
import { api, ApiError } from '../../api/client.js';
import { Badge, Button, Card, CardTitle, Field, Input, Notice, Spinner } from '../../components/ui.js';
import { Icon } from '../../components/icons.js';
import { useToast } from '../../components/Toast.js';

interface GmodView {
  settings: { gamemode: string; map: string; maxPlayers: number; hostname: string; loadingUrl: string; hasPassword: boolean; hasGslt: boolean };
  content: { gamemodes: string[]; maps: string[] };
  css: { installed: boolean; mounted: boolean; path: string; job: { startedAt: string; error: string | null; running: boolean } | null };
  running: boolean;
}

export const isGmodServer = (s: { platform: string; steam_preset?: string | null; steam_app_id?: string | null }) =>
  s.platform === 'steam' && (s.steam_preset === 'gmod' || (!s.steam_preset && s.steam_app_id === '4020'));

/** Garry's Mod: gamemode, map, slots, hostname/password, and mounting CS:S content. */
export function GmodTab() {
  const { serverId, can } = useServerDetail();
  const toast = useToast();
  const canEdit = can('settings');
  const base = `/servers/${serverId}/gmod`;
  const [data, setData] = useState<GmodView | null>(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ gamemode: '', map: '', maxPlayers: '16', hostname: '', loadingUrl: '', password: '', gslt: '' });
  const [busy, setBusy] = useState('');

  const apply = (v: GmodView, resetForm = true) => {
    setData(v);
    if (resetForm) {
      const s = v.settings;
      setForm({ gamemode: s.gamemode, map: s.map, maxPlayers: String(s.maxPlayers), hostname: s.hostname, loadingUrl: s.loadingUrl, password: '', gslt: '' });
    }
  };

  useEffect(() => {
    api
      .get<GmodView>(base)
      .then((v) => apply(v))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load'));
  }, [base]);

  // Poll only while the CS:S download runs.
  const downloading = !!data?.css.job?.running;
  useEffect(() => {
    if (!downloading) return;
    const t = setVisibleInterval(() => {
      api.get<GmodView>(base).then((v) => apply(v, false)).catch(() => {});
    }, 5000);
    return () => t();
  }, [base, downloading]);

  if (error && !data) return <Notice tone="error">{error}</Notice>;
  if (!data) return <Spinner />;
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function save(extra: Record<string, unknown> = {}) {
    setBusy('save');
    try {
      const v = await api.put<GmodView>(base, { ...form, maxPlayers: Number(form.maxPlayers), ...extra });
      apply(v);
      toast.success(v.running ? 'Saved — restart the server to apply' : 'Saved');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Save failed');
    } finally {
      setBusy('');
    }
  }

  async function css(action: 'install' | 'mount' | 'unmount') {
    setBusy(action);
    try {
      const v = action === 'install' ? await api.post<GmodView>(`${base}/css`, {}) : await api.put<GmodView>(`${base}/css`, { mounted: action === 'mount' });
      apply(v, false);
      if (action === 'install') toast.success('Downloading CS:S content — progress is in the console');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="space-y-5">
      <Card className="p-5">
        <CardTitle
          action={
            canEdit && (
              <Button variant="primary" onClick={() => save()} disabled={busy !== ''}>
                {busy === 'save' ? <Spinner /> : null} Save
              </Button>
            )
          }
        >
          Server
        </CardTitle>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Gamemode">
            <Input list="gmod-gamemodes" value={form.gamemode} disabled={!canEdit} onChange={set('gamemode')} />
            <datalist id="gmod-gamemodes">
              {data.content.gamemodes.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </Field>
          <Field label="Map">
            <Input list="gmod-maps" value={form.map} disabled={!canEdit} onChange={set('map')} />
            <datalist id="gmod-maps">
              {data.content.maps.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </Field>
          <Field label="Max players">
            <Input type="number" min={1} max={128} value={form.maxPlayers} disabled={!canEdit} onChange={set('maxPlayers')} />
          </Field>
          <Field label="Server name (hostname)">
            <Input value={form.hostname} disabled={!canEdit} onChange={set('hostname')} placeholder="Leave blank to keep server.cfg’s" />
          </Field>
          <Field label={`Join password${data.settings.hasPassword ? ' (set)' : ''}`}>
            <Input type="password" autoComplete="new-password" value={form.password} disabled={!canEdit} onChange={set('password')} placeholder={data.settings.hasPassword ? 'Unchanged' : 'None'} />
          </Field>
          <Field label="Loading screen URL">
            <Input value={form.loadingUrl} disabled={!canEdit} onChange={set('loadingUrl')} placeholder="https://…" />
          </Field>
          <Field label={`Server login token (GSLT)${data.settings.hasGslt ? ' (set)' : ''}`}>
            <Input value={form.gslt} disabled={!canEdit} onChange={set('gslt')} placeholder={data.settings.hasGslt ? 'Unchanged' : 'Optional'} />
          </Field>
        </div>
        {canEdit && (data.settings.hasPassword || data.settings.hasGslt) && (
          <div className="mt-3 flex flex-wrap gap-2">
            {data.settings.hasPassword && (
              <Button variant="ghost" onClick={() => save({ clearPassword: true })}>
                Remove password
              </Button>
            )}
            {data.settings.hasGslt && (
              <Button variant="ghost" onClick={() => save({ clearGslt: true })}>
                Remove token
              </Button>
            )}
          </div>
        )}
        <p className="mt-3 text-xs text-ink-500">
          Gamemodes and maps in the lists come from the server, its <Link to="../plugins" className="underline">Addons</Link>, Workshop items and mounted content — you can also type any name. Hostname,
          password and loading screen are written to garrysmod/cfg/server.cfg.
        </p>
      </Card>

      <Card className="p-5">
        <CardTitle>Counter-Strike: Source content</CardTitle>
        <p className="mb-4 text-sm text-ink-400">
          TTT and many community maps use CS:S textures and models — without them players see missing textures and ERROR signs. Outpost downloads the free CS:S dedicated server (about 2 GB) into this
          instance and mounts it.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          {data.css.mounted ? <Badge tone="green">Mounted</Badge> : data.css.installed ? <Badge tone="yellow">Downloaded, not mounted</Badge> : <Badge tone="neutral">Not installed</Badge>}
          {downloading && (
            <span className="flex items-center gap-2 text-sm text-ink-300">
              <Spinner /> Downloading — see the console
            </span>
          )}
          {canEdit && !downloading && (
            <>
              <Button onClick={() => css('install')} disabled={busy !== ''}>
                <Icon name="update" className="h-4 w-4" /> {data.css.installed ? 'Update content' : 'Download & mount'}
              </Button>
              {data.css.installed && (
                <Button variant="ghost" onClick={() => css(data.css.mounted ? 'unmount' : 'mount')} disabled={busy !== ''}>
                  {data.css.mounted ? 'Unmount' : 'Mount'}
                </Button>
              )}
            </>
          )}
        </div>
        {data.css.job?.error && (
          <div className="mt-3">
            <Notice tone="error">{data.css.job.error}</Notice>
          </div>
        )}
        {data.css.mounted && data.running && <p className="mt-3 text-xs text-ink-500">Restart the server if it was running when the content was mounted.</p>}
      </Card>
    </div>
  );
}
