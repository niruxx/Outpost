import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, downloadUrl, type UploadProgress } from '../../api/client.js';
import { Button, Card, CardTitle, ErrorText, Field, Input, Notice, Select, Spinner } from '../../components/ui.js';
import { useConfirm } from '../../components/ConfirmDialog.js';
import { useToast } from '../../components/Toast.js';
import { UploadTracker } from '../../components/UploadTracker.js';
import { useServerDetail } from './ServerContext.js';
import { CoreKeeperCharacterCard } from './CoreKeeperCharacterCard.js';
import { formatBytes } from './StatusTab.js';

const fileKinds = [
  ['world', 'World save', '.world.gzip'],
  ['info', 'World info', '.worldinfo'],
  ['map', 'Cartography map', '.mapparts.gzip'],
  ['generation', 'Generation settings', '.json'],
] as const;
type Slot = { slot: number; name: string | null; hasWorld: boolean; occupied: boolean; bytes: number; files: string[] };
type Worlds = { active: number; initialized: boolean; revision: string; slots: Slot[]; backup?: string | null };

function CoreKeeperWorldsCard() {
  const { serverId, server, running, can } = useServerDetail();
  const confirm = useConfirm();
  const toast = useToast();
  const [view, setView] = useState<Worlds | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [slot, setSlot] = useState('');
  const base = `/servers/${serverId}/game-controls/core-keeper/worlds`;
  const stopped = !!server && !running && ['stopped', 'crashed'].includes(server.status);
  const canWrite = can('files.write') && can('settings') && can('backups.create');

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await api.get<Worlds>(base);
      if (!signal?.aborted) { setView(next); setError(''); }
    } catch (err) {
      if (!signal?.aborted) setError(err instanceof Error ? err.message : 'Could not load world slots.');
    }
  }, [base]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, stopped]);

  async function save(action: 'select' | 'remove' | 'import', target: number, upload?: FormData) {
    if (!view || busy || !canWrite || !stopped) return false;
    if (action === 'remove' && !await confirm({
      title: `Remove world slot ${target}?`,
      message: 'Outpost will create a full instance backup and move the slot’s files to the File Management recycle bin.',
      confirmLabel: 'Back up and remove world',
      tone: 'danger',
    })) return false;
    setBusy(true);
    setError('');
    try {
      const destination = `${base}/${target}/${action}`;
      if (upload) upload.append('revision', view.revision);
      const next = upload
        ? await api.upload<Worlds>(destination, upload, setProgress)
        : await api.post<Worlds>(destination, { revision: view.revision });
      setView(next);
      const message = action === 'select' ? `Slot ${target} selected for the next start` : action === 'remove' ? `Slot ${target} moved to the recycle bin` : `World imported into slot ${target}`;
      toast.success(next.backup ? `${message}. Backup created.` : message);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change this world slot.');
      return false;
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function importWorld(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!slot) return;
    const form = event.currentTarget;
    const upload = new FormData();
    for (const [name, file] of new FormData(form)) if (file instanceof File && file.size) upload.append(name, file);
    if (await save('import', Number(slot), upload)) { setSlot(''); form.reset(); }
  }

  const available = view?.slots.filter((entry) => !entry.occupied || entry.hasWorld) ?? [];
  const empty = available.filter((entry) => !entry.occupied);
  const shown = view?.slots.filter((entry) => entry.slot === view.active || entry.occupied) ?? [];
  return (
    <Card className="min-w-0 space-y-4 p-4 sm:p-5">
      <CardTitle action={<Button disabled={busy} onClick={() => void load()}>Refresh</Button>}>World slots</CardTitle>
      <p className="text-sm text-ink-400">Choose the world Core Keeper loads at its next start. Selecting an unused slot creates a new world on startup. Outpost backs up the instance before changing world files or the selected slot.</p>
      {!stopped && <Notice tone="info">Stop Core Keeper and wait for it to finish saving before downloading or changing worlds.</Notice>}
      {view && !view.initialized && <Notice tone="info">Start and stop the server once to create its configuration before switching slots.</Notice>}
      <ErrorText>{error}</ErrorText>
      {!view && !error && <Spinner />}
      {view && (
        <>
          <ul className="divide-y divide-surface-700 rounded-xl border border-surface-700">
            {shown.map((entry) => (
              <li key={entry.slot} className="flex flex-wrap items-center justify-between gap-3 p-3">
                <div className="min-w-0 flex-1 basis-40">
                  <p className="break-words text-sm font-medium text-ink-100">Slot {entry.slot}{entry.name ? ` · ${entry.name}` : ''}</p>
                  <p className="text-xs text-ink-400">{[entry.slot === view.active ? 'Selected' : '', entry.hasWorld ? formatBytes(entry.bytes) : entry.occupied ? 'Companion or recovery files only' : 'Empty'].filter(Boolean).join(' · ')}</p>
                </div>
                <div className="flex max-w-full flex-wrap items-center gap-2">
                  {stopped && entry.files.map((kind) => (
                    <a key={kind} className="px-2 py-1 text-xs text-accent-400 underline" download href={downloadUrl(`${base}/${entry.slot}/files/${kind}`)}>
                      Download {fileKinds.find(([name]) => name === kind)?.[1].toLowerCase()}
                    </a>
                  ))}
                  {canWrite && entry.occupied && entry.slot !== view.active && <Button variant="danger" disabled={busy || !stopped} onClick={() => void save('remove', entry.slot)}>Remove slot</Button>}
                </div>
              </li>
            ))}
          </ul>
          {canWrite && (
            <div className="space-y-4">
              <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => {
                event.preventDefault();
                const selected = new FormData(event.currentTarget).get('selected-slot');
                if (typeof selected === 'string' && selected) void save('select', Number(selected));
              }}>
                <div className="w-full min-w-0 sm:w-64">
                  <Field label="World slot for next start">
                    <Select name="selected-slot" required defaultValue="" disabled={busy || !stopped || !view.initialized}>
                      <option value="">Choose a slot</option>
                      {available.filter((entry) => entry.slot !== view.active).map((entry) => (
                        <option key={entry.slot} value={entry.slot}>Slot {entry.slot} · {entry.hasWorld ? entry.name || 'Existing world' : 'New world'}</option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <Button type="submit" disabled={busy || !stopped || !view.initialized}>Select slot</Button>
              </form>
              <form className="space-y-3 border-t border-surface-700 pt-4" onSubmit={importWorld}>
                <h3 className="text-sm font-medium text-ink-100">Import an existing world</h3>
                <p className="text-xs text-ink-400">If you include world info, choose the same numbered slot as the source.</p>
                <fieldset disabled={busy || !stopped || !empty.length} className="min-w-0 space-y-3">
                  <Field label="Destination slot">
                    <Select value={slot} required onChange={(event) => setSlot(event.target.value)}>
                      <option value="">{empty.length ? 'Choose an unused slot' : 'No unused slots'}</option>
                      {empty.map((entry) => <option key={entry.slot} value={entry.slot}>Slot {entry.slot}</option>)}
                    </Select>
                  </Field>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {fileKinds.map(([kind, label, extension]) => <Field key={kind} label={kind === 'world' ? label : `${label} (optional)`}>
                      <Input className="min-w-0" name={kind} type="file" accept={extension} required={kind === 'world'} />
                    </Field>)}
                  </div>
                  <Button type="submit" variant="primary">Back up and import world</Button>
                </fieldset>
              </form>
            </div>
          )}
          <UploadTracker progress={progress} />
          {busy && !progress && <p className="inline-flex items-center gap-2 text-sm text-ink-400" role="status"><Spinner /> Applying world change…</p>}
        </>
      )}
    </Card>
  );
}

export function CoreKeeperTab() {
  const { server, serverId, can } = useServerDetail();
  if (server?.steam_preset !== 'core_keeper' || server.platform !== 'steam') return null;
  return (
    <div className="space-y-5" key={serverId}>
      {can('files.read') && <CoreKeeperWorldsCard />}
      <CoreKeeperCharacterCard />
    </div>
  );
}
