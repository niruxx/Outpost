import { useEffect, useState } from 'react';
import { useServerDetail } from './ServerContext.js';
import { api, ApiError } from '../../api/client.js';
import { Badge, Button, Card, CardTitle, Field, Input, Notice, Select } from '../../components/ui.js';
import { useToast } from '../../components/Toast.js';

interface AutoUpdateConfig {
  enabled: boolean;
  schedule: string;
  warnMinutes: number;
  warnCommand: string;
  backupFirst: boolean;
  notifyOnly: boolean;
  allowVersionChange: boolean;
  lastCheckAt: string | null;
  lastResult: string | null;
}
interface AutoUpdateView {
  config: AutoUpdateConfig;
  support: { supported: boolean; reason: string | null };
  schedules: { value: string; label: string }[];
  busy: boolean;
}

/** Update tab → Automatic updates: scheduled checks, in-game warning, snapshot, update, restart. */
export function AutoUpdateCard() {
  const { serverId, server, can } = useServerDetail();
  const toast = useToast();
  const [data, setData] = useState<AutoUpdateView | null>(null);
  const [draft, setDraft] = useState<AutoUpdateConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const base = `/servers/${serverId}/auto-update`;
  const canEdit = can('update');

  const load = () =>
    api
      .get<AutoUpdateView>(base)
      .then((v) => {
        setData(v);
        setDraft((d) => d ?? v.config);
      })
      .catch(() => setData(null));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);
  useEffect(() => {
    if (!data?.busy) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.busy]);

  if (!data || !draft) return null;
  const set = (patch: Partial<AutoUpdateConfig>) => setDraft({ ...draft, ...patch });
  const dirty = (['enabled', 'schedule', 'warnMinutes', 'warnCommand', 'backupFirst', 'notifyOnly', 'allowVersionChange'] as const).some((k) => draft[k] !== data.config[k]);

  async function save() {
    setSaving(true);
    try {
      const { lastCheckAt: _a, lastResult: _b, ...body } = draft!;
      const v = await api.put<AutoUpdateView>(base, body);
      setData(v);
      setDraft(v.config);
      toast.success(v.config.enabled ? 'Automatic updates on' : 'Automatic updates saved');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }
  async function runNow() {
    try {
      setData(await api.post<AutoUpdateView>(`${base}/run`));
      toast.success('Checking for updates — progress shows in the Console');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to start');
    }
  }

  return (
    <div className="space-y-0">
      <Card className="p-5">
        <CardTitle action={<Badge tone={data.config.enabled ? 'green' : 'neutral'}>{data.config.enabled ? (data.config.notifyOnly ? 'Notify only' : 'On') : 'Off'}</Badge>}>Automatic updates</CardTitle>
        {!data.support.supported ? (
          <Notice tone="info">{data.support.reason}</Notice>
        ) : (
          <>
            <p className="mb-3 text-sm text-ink-400">
              Outpost checks on a schedule. When there’s a new build it warns players in-game, stops the server, takes a snapshot, updates, and starts it again.
            </p>
            <fieldset disabled={!canEdit} className="space-y-3">
              <label className="flex items-center gap-2 text-sm text-ink-200">
                <input type="checkbox" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
                Check for updates automatically
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="How often">
                  <Select value={draft.schedule} onChange={(e) => set({ schedule: e.target.value })}>
                    {!data.schedules.some((s) => s.value === draft.schedule) && <option value={draft.schedule}>Custom ({draft.schedule})</option>}
                    {data.schedules.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Warn players first">
                  <Select value={draft.warnMinutes} onChange={(e) => set({ warnMinutes: Number(e.target.value) })}>
                    {[0, 1, 5, 10, 15, 30].map((m) => (
                      <option key={m} value={m}>
                        {m === 0 ? 'No warning' : `${m} minute${m === 1 ? '' : 's'} before`}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              {draft.warnMinutes > 0 && (
                <Field label="Warning command ({minutes} is filled in)">
                  <Input value={draft.warnCommand} onChange={(e) => set({ warnCommand: e.target.value })} placeholder="say Restarting for an update in {minutes} minute(s)" className="font-mono" />
                </Field>
              )}
              <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-ink-300">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={draft.backupFirst} onChange={(e) => set({ backupFirst: e.target.checked })} />
                  Snapshot before updating
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={draft.notifyOnly} onChange={(e) => set({ notifyOnly: e.target.checked })} />
                  Only notify (don’t apply)
                </label>
                {server?.loader === 'vanilla' && (
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={draft.allowVersionChange} onChange={(e) => set({ allowVersionChange: e.target.checked })} />
                    Follow new Minecraft versions (upgrades the world)
                  </label>
                )}
              </div>
            </fieldset>
            {data.config.lastCheckAt && (
              <p className="mt-3 text-xs text-ink-400">
                Last check {new Date(data.config.lastCheckAt).toLocaleString()}: {data.config.lastResult}
              </p>
            )}
            {canEdit && (
              <div className="mt-4 flex flex-wrap gap-2">
                <Button variant="primary" disabled={!dirty || saving} onClick={save}>
                  Save
                </Button>
                <Button disabled={data.busy} onClick={runNow}>
                  {data.busy ? 'Working…' : 'Check & update now'}
                </Button>
              </div>
            )}
            <p className="mt-3 text-xs text-ink-500">Webhook alerts for “Update available / applied / failed” can be turned on under Configuration → Notifications.</p>
          </>
        )}
      </Card>
    </div>
  );
}
