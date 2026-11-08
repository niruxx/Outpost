import { useEffect, useState } from 'react';
import { useServerDetail } from './ServerContext.js';
import { api, ApiError } from '../../api/client.js';
import type { LaunchConfig, LaunchInfo } from '../../api/types.js';
import { Button, Card, CardTitle, ErrorText, Notice, Spinner } from '../../components/ui.js';
import { Icon } from '../../components/icons.js';
import { LaunchEditor, cleanLaunchConfig } from '../../components/LaunchEditor.js';
import { useToast } from '../../components/Toast.js';
import { useConfirm } from '../../components/ConfirmDialog.js';

/** Launch customization for one instance: which binary/jar runs, with what, and how it stops/restarts. */
export function LaunchCard() {
  const { server, can, isAdmin, running } = useServerDetail();
  const toast = useToast();
  const confirm = useConfirm();
  const [info, setInfo] = useState<LaunchInfo | null>(null);
  const [draft, setDraft] = useState<LaunchConfig>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const editable = can('launch');

  useEffect(() => {
    if (!server) return;
    api
      .get<LaunchInfo>(`/servers/${server.id}/launch`)
      .then((res) => {
        setInfo(res);
        setDraft(res.config);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load launch settings'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server?.id]);

  if (!server) return null;

  async function save(config: LaunchConfig) {
    setSaving(true);
    setError('');
    try {
      const res = await api.put<LaunchInfo>(`/servers/${server!.id}/launch`, { config: cleanLaunchConfig(config) });
      setInfo((prev) => ({ ...(prev as LaunchInfo), ...res }));
      setDraft(res.config);
      toast.success(running ? 'Launch settings saved — restart to apply them' : 'Launch settings saved');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  async function reset() {
    const ok = await confirm({
      title: 'Reset launch settings',
      message: server!.platform === 'custom' ? 'Custom instances need an executable, so this only clears the optional settings.' : 'Go back to the built-in launch command for this game?',
      confirmLabel: 'Reset',
    });
    if (ok) save(server!.platform === 'custom' ? { executable: draft.executable, useShell: draft.useShell } : {});
  }

  const dirty = JSON.stringify(cleanLaunchConfig(draft)) !== JSON.stringify(cleanLaunchConfig(info?.config ?? {}));

  return (
    <Card className="p-5">
      <CardTitle action={<Icon name="rocket" className="h-5 w-5 text-ink-400" />}>Launch</CardTitle>
      <p className="mb-4 text-sm text-ink-400">
        Choose exactly which server binary {server.platform === 'java' ? 'or jar ' : ''}starts, with which arguments and environment, and how it
        stops and restarts. Leave a field empty to keep the built-in behaviour.
      </p>

      {info === null ? (
        error ? <ErrorText>{error}</ErrorText> : <Spinner />
      ) : (
        <>
          <div className="mb-5 rounded-2xl bg-surface-1000 p-3">
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-ink-500">Resolved command</p>
            {info.preview ? (
              <code className="block whitespace-pre-wrap break-all font-mono text-xs text-success-400">{info.preview}</code>
            ) : (
              <p className="text-xs text-yellow-400">{info.previewError}</p>
            )}
          </div>

          {!editable && (
            <div className="mb-4">
              <Notice tone="info">
                Changing the launch command lets someone run any program on this host, so it needs the “Edit launch command” permission, which
                an admin has to grant you.
              </Notice>
            </div>
          )}

          <LaunchEditor value={draft} onChange={setDraft} platform={server.platform} isAdmin={isAdmin} disabled={!editable} />

          <ErrorText>{error}</ErrorText>
          {editable && (
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <Button variant="primary" disabled={saving || !dirty} onClick={() => save(draft)}>
                {saving ? 'Saving…' : 'Save launch settings'}
              </Button>
              <Button variant="ghost" disabled={saving} onClick={reset}>
                Reset to defaults
              </Button>
              {running && <span className="text-xs text-ink-400">Changes apply the next time the server starts.</span>}
            </div>
          )}
        </>
      )}
    </Card>
  );
}
