import { useCallback, useEffect, useState } from 'react';
import { setVisibleInterval } from '../../lib/perf.js';
import { useServerDetail } from './ServerContext.js';
import { api, ApiError } from '../../api/client.js';
import { Badge, Button, Card, CardTitle, ErrorText, Field, Input, Notice, Select, Spinner } from '../../components/ui.js';
import { useToast } from '../../components/Toast.js';
import { useConfirm } from '../../components/ConfirmDialog.js';
import { useAuth } from '../../state/AuthContext.js';
import type { WineConfig, WineStatus } from '../../api/types.js';

interface WineView {
  status: WineStatus;
  config: WineConfig;
  settings: { arch: 'win64' | 'win32'; resolution: string; debug: string };
  prefix: { exists: boolean; arch: string | null; windowsVersion: string | null; verbs: string[] };
  busy: string | null;
  running: boolean;
  verbs: { verb: string; label: string }[];
  windowsVersions: string[];
}

const VERSION_LABEL: Record<string, string> = {
  win11: 'Windows 11',
  win10: 'Windows 10',
  win81: 'Windows 8.1',
  win8: 'Windows 8',
  win7: 'Windows 7',
  win2008r2: 'Windows Server 2008 R2',
  win2008: 'Windows Server 2008',
  vista: 'Windows Vista',
  win2003: 'Windows Server 2003',
  winxp: 'Windows XP',
};

/** Wine for one instance: how it launches the server, and what's installed in its prefix. */
export function WineTab() {
  const { serverId, can } = useServerDetail();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const toast = useToast();
  const confirm = useConfirm();
  const [data, setData] = useState<WineView | null>(null);
  const [draft, setDraft] = useState<WineConfig>({ mode: 'auto' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [customVerbs, setCustomVerbs] = useState('');
  const [installer, setInstaller] = useState('');
  const [installerArgs, setInstallerArgs] = useState('');
  const canEdit = can('launch');
  const base = `/servers/${serverId}/wine`;

  const load = useCallback(async () => {
    try {
      const v = await api.get<WineView>(base);
      setData(v);
      setError('');
      return v;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load Wine settings');
      return null;
    }
  }, [base]);

  useEffect(() => {
    load().then((v) => v && setDraft(v.config));
  }, [load]);

  // While a Wine job runs, keep the view fresh (progress itself is in the console).
  useEffect(() => {
    if (!data?.busy) return;
    const t = setVisibleInterval(load, 3000);
    return () => t();
  }, [data?.busy, load]);

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setBusy('');
    }
  }

  if (error) return <ErrorText>{error}</ErrorText>;
  if (!data) return <Spinner />;
  const { status, prefix } = data;
  const set = (patch: Partial<WineConfig>) => setDraft((d) => ({ ...d, ...patch }));
  const dirty = JSON.stringify(draft) !== JSON.stringify(data.config);
  const blocked = !canEdit || !!data.busy || data.running;
  const archMismatch = prefix.exists && prefix.arch && prefix.arch !== (draft.arch ?? 'win64');

  const save = () =>
    run('save', async () => {
      const v = await api.put<WineView>(base, draft);
      setData(v);
      setDraft(v.config);
      toast.success('Wine settings saved — they apply on the next start');
    });

  const jobStarted = (v: WineView, msg: string) => {
    setData(v);
    toast.success(msg);
  };

  return (
    <div className="space-y-5">
      {!status.supported && <Notice tone="info">{status.hint}</Notice>}
      {status.supported && !status.available && <Notice tone="warning">{status.hint}</Notice>}
      {data.busy && (
        <Notice tone="info">
          <span className="inline-flex items-center gap-2">
            <Spinner /> Wine is busy: {data.busy}. Progress shows in the Console.
          </span>
        </Notice>
      )}

      <Card className="p-5">
        <CardTitle action={<Badge tone={status.available ? 'green' : 'neutral'}>{status.available ? status.version ?? 'Wine' : 'Wine not installed'}</Badge>}>Launch with Wine</CardTitle>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Run through Wine">
            <Select value={draft.mode} disabled={!canEdit} onChange={(e) => set({ mode: e.target.value as WineConfig['mode'] })}>
              <option value="auto">Automatically (.exe or Windows-only games)</option>
              <option value="always">Always</option>
              <option value="never">Never</option>
            </Select>
          </Field>
          <Field label="Windows version">
            <Select value={draft.windowsVersion ?? ''} disabled={!canEdit} onChange={(e) => set({ windowsVersion: (e.target.value || undefined) as WineConfig['windowsVersion'] })}>
              <option value="">Wine’s default</option>
              {data.windowsVersions.map((v) => (
                <option key={v} value={v}>
                  {VERSION_LABEL[v] ?? v}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Prefix architecture">
            <Select value={draft.arch ?? 'win64'} disabled={!canEdit} onChange={(e) => set({ arch: e.target.value === 'win32' ? 'win32' : undefined })}>
              <option value="win64">64-bit (runs 32- and 64-bit programs)</option>
              <option value="win32">32-bit only (some old servers need this)</option>
            </Select>
          </Field>
          <Field label="DLL overrides (WINEDLLOVERRIDES)">
            <Input value={draft.dllOverrides ?? ''} disabled={!canEdit} onChange={(e) => set({ dllOverrides: e.target.value || undefined })} placeholder="e.g. d3d9=n,b;xinput1_3=n" className="font-mono" />
          </Field>
          <Field label="Debug output (WINEDEBUG)">
            <Input value={draft.debug ?? ''} disabled={!canEdit} onChange={(e) => set({ debug: e.target.value || undefined })} placeholder="-all (quiet)" className="font-mono" />
          </Field>
          <Field label="Virtual screen size">
            <Input
              value={draft.resolution ?? ''}
              disabled={!canEdit || !draft.virtualDisplay}
              onChange={(e) => set({ resolution: e.target.value || undefined })}
              placeholder="1024x768x24"
              className="font-mono"
            />
          </Field>
          {isAdmin && (
            <Field label="Wine build (admin)">
              <Input value={draft.binary ?? ''} onChange={(e) => set({ binary: e.target.value || undefined })} placeholder={status.path ?? 'auto-detected'} className="font-mono" />
            </Field>
          )}
        </div>
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm text-ink-300">
          <label className="flex items-center gap-2">
            <input type="checkbox" disabled={!canEdit} checked={!!draft.virtualDisplay} onChange={(e) => set({ virtualDisplay: e.target.checked || undefined })} />
            Virtual screen (Xvfb) for servers that open a window{draft.virtualDisplay && !status.xvfb ? ' — xvfb-run isn’t installed' : ''}
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" disabled={!canEdit} checked={!!draft.esync} onChange={(e) => set({ esync: e.target.checked || undefined })} />
            esync
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" disabled={!canEdit} checked={!!draft.fsync} onChange={(e) => set({ fsync: e.target.checked || undefined })} />
            fsync
          </label>
        </div>
        {archMismatch && (
          <div className="mt-3">
            <Notice tone="warning">This instance’s prefix is {prefix.arch}. Reset the prefix below to switch it to {draft.arch ?? 'win64'}.</Notice>
          </div>
        )}
        <p className="mt-3 text-xs text-ink-500">
          esync/fsync can speed up servers on Wine builds that support them (Wine-staging, Proton). A new Windows version is applied before the next start.
        </p>
        {canEdit && (
          <div className="mt-4 flex gap-2">
            <Button variant="primary" disabled={!dirty || busy === 'save'} onClick={save}>
              Save
            </Button>
            {dirty && (
              <Button variant="ghost" onClick={() => setDraft(data.config)}>
                Discard
              </Button>
            )}
          </div>
        )}
      </Card>

      <Card className="p-5">
        <CardTitle action={<Badge tone={prefix.exists ? 'green' : 'yellow'}>{prefix.exists ? `${prefix.arch ?? ''} prefix` : 'Not set up'}</Badge>}>Wine prefix</CardTitle>
        <p className="mb-3 text-sm text-ink-400">
          This instance’s own Windows environment, in <span className="font-mono">.wine</span>. It’s set up on the first start under Wine, or now.
          {prefix.windowsVersion && ` Windows version: ${VERSION_LABEL[prefix.windowsVersion] ?? prefix.windowsVersion}.`}
        </p>
        {data.running && <p className="mb-3 text-xs text-yellow-400">Stop the server to change its prefix or install dependencies.</p>}
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={blocked || !status.available}
              onClick={() => run('init', async () => jobStarted(await api.post<WineView>(`${base}/prefix`), 'Setting up Wine — progress shows in the Console'))}
            >
              {prefix.exists ? 'Re-apply settings' : 'Set up now'}
            </Button>
            {prefix.exists && (
              <Button
                variant="danger"
                disabled={blocked}
                onClick={async () => {
                  const ok = await confirm({
                    title: 'Reset Wine prefix',
                    message: 'Delete this instance’s Wine prefix (.wine) and everything installed into it? The server files themselves are kept; a fresh prefix is made on the next start.',
                    confirmLabel: 'Reset',
                    tone: 'danger',
                  });
                  if (ok) run('reset', async () => jobStarted(await api.delete<WineView>(`${base}/prefix`), 'Wine prefix reset'));
                }}
              >
                Reset prefix
              </Button>
            )}
          </div>
        )}
      </Card>

      <Card className="p-5">
        <CardTitle action={<Badge tone={status.winetricks ? 'green' : 'neutral'}>{status.winetricks ? 'winetricks' : 'winetricks downloads on first use'}</Badge>}>Dependencies</CardTitle>
        <p className="mb-3 text-sm text-ink-400">Install runtimes the server needs into its prefix with winetricks. Check the game’s server docs for what it requires.</p>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {data.verbs.map((v) => {
            const installed = prefix.verbs.includes(v.verb);
            return (
              <label key={v.verb} className="flex items-center gap-2 text-sm text-ink-300">
                <input
                  type="checkbox"
                  disabled={!canEdit}
                  checked={picked.includes(v.verb)}
                  onChange={(e) => setPicked((p) => (e.target.checked ? [...p, v.verb] : p.filter((x) => x !== v.verb)))}
                />
                <span className="font-mono text-xs text-ink-200">{v.verb}</span>
                <span className="truncate text-xs text-ink-500">{v.label}</span>
                {installed && <Badge tone="green">installed</Badge>}
              </label>
            );
          })}
        </div>
        {prefix.verbs.filter((v) => !data.verbs.some((x) => x.verb === v)).length > 0 && (
          <p className="mt-2 text-xs text-ink-400">Also installed: {prefix.verbs.filter((v) => !data.verbs.some((x) => x.verb === v)).join(', ')}</p>
        )}
        {canEdit && (
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div className="min-w-[14rem] flex-1">
              <Field label="Other winetricks verbs">
                <Input value={customVerbs} onChange={(e) => setCustomVerbs(e.target.value)} placeholder="e.g. vcrun6 dinput8" className="font-mono" />
              </Field>
            </div>
            <Button
              variant="primary"
              disabled={blocked || !status.available || (!picked.length && !customVerbs.trim())}
              onClick={() =>
                run('verbs', async () => {
                  const verbs = [...picked, ...customVerbs.split(/[\s,]+/).filter(Boolean)];
                  jobStarted(await api.post<WineView>(`${base}/winetricks`, { verbs }), `Installing ${verbs.length} dependenc${verbs.length === 1 ? 'y' : 'ies'} — progress shows in the Console`);
                  setPicked([]);
                  setCustomVerbs('');
                })
              }
            >
              Install
            </Button>
          </div>
        )}
      </Card>

      {canEdit && (
        <Card className="p-5">
          <CardTitle>Run a Windows installer</CardTitle>
          <p className="mb-3 text-sm text-ink-400">
            Runs an .exe or .msi from the instance folder inside its prefix — e.g. a redistributable the game ships. Upload it in File Management first. .msi files install silently unless you give your own arguments.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[14rem] flex-1">
              <Field label="Installer (path in the instance)">
                <Input value={installer} onChange={(e) => setInstaller(e.target.value)} placeholder="redist/vc_redist.x64.exe" className="font-mono" />
              </Field>
            </div>
            <div className="min-w-[10rem] flex-1">
              <Field label="Arguments">
                <Input value={installerArgs} onChange={(e) => setInstallerArgs(e.target.value)} placeholder="/quiet /norestart" className="font-mono" />
              </Field>
            </div>
            <Button
              disabled={blocked || !status.available || !installer.trim()}
              onClick={() =>
                run('installer', async () => jobStarted(await api.post<WineView>(`${base}/run`, { path: installer, args: installerArgs }), 'Installer started — progress shows in the Console'))
              }
            >
              Run
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
