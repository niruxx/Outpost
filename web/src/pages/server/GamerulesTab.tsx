import { useEffect, useState } from 'react';
import { api, ApiError } from '../../api/client.js';
import { Badge, Button, Card, CardTitle, ErrorText, Field, Notice, Select, Spinner } from '../../components/ui.js';
import { useToast } from '../../components/Toast.js';
import { useServerDetail } from './ServerContext.js';
import { useUnsavedChanges } from '../../lib/unsaved.js';

interface Settings {
  preset: string | null;
  autoApply: boolean;
  naming: 'auto' | 'legacy' | 'modern';
  rules: Record<string, boolean>;
}
interface View {
  settings: Settings;
  rules: { id: string; label: string; default: boolean }[];
  presets: { id: string; label: string; description: string; rules: Record<string, boolean> }[];
  commands: string[];
  modern: boolean;
  platform: string;
  running: boolean;
}
export function GamerulesTab() {
  const { serverId, server, can } = useServerDetail();
  const toast = useToast();
  const [view, setView] = useState<View | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const base = `/servers/${serverId}/gamerules`;
  const dirty = !!draft && !!view && JSON.stringify(draft) !== JSON.stringify(view.settings);
  useUnsavedChanges(dirty, 'Gamerules');
  const apply = (v: View) => { setView(v); setDraft(v.settings); };
  useEffect(() => {
    let cancelled = false;
    setView(null); setDraft(null); setError('');
    api.get<View>(base).then((v) => { if (!cancelled) apply(v); }).catch((err) => { if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load gamerules'); });
    return () => { cancelled = true; };
  }, [base]);
  async function save(now: boolean) {
    if (!draft) return;
    setBusy(true); setError('');
    try {
      apply(await api.put<View>(base, draft));
      if (now) {
        const result = await api.post<View & { sent: number }>(`${base}/apply`);
        apply(result);
        toast.success(`${result.sent} gamerules sent. Check Console for server responses.`);
      } else toast.success('Gamerules saved');
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Could not save gamerules'); }
    finally { setBusy(false); }
  }
  if (!view || !draft) return error ? <ErrorText>{error}</ErrorText> : <Spinner />;
  return (
    <div className="space-y-5">
      <Notice tone="info">Save a preset to configure the world automatically after each server start, or save and apply it now. These rules persist in the world. Turning off automatic application does not undo rules already applied.</Notice>
      <Card className="p-5">
        <CardTitle action={draft.autoApply && <Badge tone="green">Apply after startup</Badge>}>Gamerule presets</CardTitle>
        <fieldset disabled={!can('settings') || busy} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {view.presets.map((p) => (
              <button key={p.id} type="button" onClick={() => setDraft({ ...draft, preset: p.id, autoApply: true, rules: { ...p.rules } })} className={`state-layer rounded-2xl border p-4 text-left ${draft.preset === p.id ? 'border-accent-400 bg-secondary-container' : 'border-surface-600 bg-surface-900'}`}>
                <span className="block font-medium text-ink-100">{p.label}</span>
                <span className="mt-1 block text-xs text-ink-400">{p.description}</span>
              </button>
            ))}
          </div>
          <p className="text-xs text-ink-400">Presets change gamerules only. They keep the current difficulty, game mode, time of day and weather.</p>
          <label className="flex items-center gap-2 text-sm text-ink-200"><input type="checkbox" checked={draft.autoApply} onChange={(e) => setDraft({ ...draft, autoApply: e.target.checked })} />Automatically apply saved rules when the server is ready</label>
          {view.platform === 'java' && <Field label="Java gamerule names">
            <Select value={draft.naming} onChange={(e) => setDraft({ ...draft, naming: e.target.value as Settings['naming'] })}>
              <option value="auto">Automatic from Minecraft version</option>
              <option value="legacy">Java 1.21.10 and earlier</option>
              <option value="modern">Java 1.21.11 and later</option>
            </Select>
            <p className="mt-1 text-xs text-ink-400">Use a manual format if a custom build reports an unrecognized version.</p>
          </Field>}
          <div className="grid gap-3 sm:grid-cols-2">
            {view.rules.map((r) => <Field key={r.id} label={r.label}>
              <Select value={draft.rules[r.id] === undefined ? '' : String(draft.rules[r.id])} onChange={(e) => {
                const rules = { ...draft.rules };
                if (e.target.value === '') delete rules[r.id]; else rules[r.id] = e.target.value === 'true';
                setDraft({ ...draft, preset: null, rules });
              }}>
                <option value="">Leave unchanged</option><option value="true">On</option><option value="false">Off</option>
              </Select>
            </Field>)}
          </div>
        </fieldset>
        <ErrorText>{error}</ErrorText>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button variant="primary" disabled={!can('settings') || busy} onClick={() => void save(false)}>{busy ? 'Working…' : 'Save gamerules'}</Button>
          <Button disabled={!can('settings') || !can('console') || busy || server?.status !== 'running' || !Object.keys(draft.rules).length} onClick={() => void save(true)}>Save &amp; apply now</Button>
          {dirty && <Button variant="ghost" disabled={busy} onClick={() => setDraft(view.settings)}>Discard changes</Button>}
        </div>
      </Card>
      <Card className="p-5">
        <CardTitle>Saved commands</CardTitle>
        <p className="mb-3 text-xs text-ink-400">{view.platform === 'bedrock' ? 'Bedrock' : view.modern ? 'Modern Java' : 'Legacy Java'} commands for the saved settings. Console shows the game’s response when they run.</p>
        {view.commands.length ? <pre className="overflow-x-auto rounded-xl bg-surface-950 p-3 text-xs text-ink-200">{view.commands.join('\n')}</pre> : <p className="text-sm text-ink-400">Choose a preset or individual rules to get started.</p>}
      </Card>
    </div>
  );
}
