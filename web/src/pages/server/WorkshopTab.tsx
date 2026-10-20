import { useCallback, useEffect, useState } from 'react';
import { setVisibleInterval } from '../../lib/perf.js';
import { useServerDetail } from './ServerContext.js';
import { api, ApiError } from '../../api/client.js';
import { Badge, Button, Card, CardTitle, ErrorText, Field, Input, Notice, Select, Spinner } from '../../components/ui.js';
import { Icon } from '../../components/icons.js';
import { useToast } from '../../components/Toast.js';
import { useConfirm } from '../../components/ConfirmDialog.js';
import { formatBytes } from './StatusTab.js';

interface WorkshopItem {
  id: string;
  title: string;
  kind: 'map' | 'mod' | 'item';
  folder: string | null;
  modIds: string[];
  sizeBytes: number;
  previewUrl: string | null;
  updatedAt: number;
  installedAt: number | null;
  status: 'pending' | 'installed' | 'failed';
  error: string | null;
}

type Mode = 'zomboid' | 'bo3' | 'gmod' | 'ark' | 'arma';

interface WorkshopView {
  support: { appId: string; mode: Mode; needsLogin: boolean } | null;
  state: { items: WorkshopItem[]; activeMod: string | null; startMap: string | null; loginUser: string | null };
  applying: boolean;
  ini: { found: boolean; path: string; workshopItems: string[] } | null;
}

const workshopUrl = (id: string) => `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`;

const GAME: Record<Mode, string> = {
  zomboid: 'Project Zomboid',
  bo3: 'Black Ops III',
  gmod: 'Garry’s Mod',
  ark: 'ARK',
  arma: 'Arma 3',
};

/** Games whose server downloads Workshop items itself — Outpost only keeps the list. */
const selfDownloading = (mode: Mode) => mode === 'zomboid' || mode === 'ark';
/** Games that load mods in list order. */
const ordered = (mode: Mode) => mode === 'zomboid' || mode === 'ark' || mode === 'arma';

const INTRO: Record<Mode, string> = {
  zomboid: 'Add Workshop items and Outpost writes them into the server’s settings (WorkshopItems= and Mods=). The server downloads them itself when it starts.',
  bo3: 'Add Workshop maps and mods and Outpost downloads them with steamcmd, then installs maps into usermaps/ and mods into mods/. Black Ops III Workshop content needs a Steam account that owns the game.',
  gmod: 'Add Workshop addons, maps or whole collections. Outpost downloads them into garrysmod/addons and lists them with resource.AddWorkshop, so players download the same content when they join.',
  ark: 'Add Workshop mods and Outpost passes them to the server (?GameModIds= with -automanagedmods). ARK downloads and updates them itself on start — the first start after adding mods takes longer. Mods load top to bottom.',
  arma: 'Add Workshop mods and Outpost downloads them into @<id> folders (lower-cased on Linux), copies their keys into keys/ and loads them with -mod=, top to bottom. Arma 3 Workshop content needs a Steam account that owns the game.',
};

function installedAt(mode: Mode, item: WorkshopItem): string | null {
  if (!item.folder) return null;
  if (mode === 'bo3') return item.kind === 'map' ? `usermaps/${item.folder}` : `mods/${item.folder}`;
  if (mode === 'gmod') return `garrysmod/addons/${item.folder}`;
  if (mode === 'arma') return item.folder;
  return null;
}

function statusBadge(item: WorkshopItem, mode: Mode) {
  if (item.status === 'failed') return <Badge tone="red">Failed</Badge>;
  if (item.status === 'pending') return <Badge tone="yellow">{selfDownloading(mode) ? 'Not saved yet' : 'Not installed'}</Badge>;
  if (!selfDownloading(mode) && (item.installedAt ?? 0) < item.updatedAt) return <Badge tone="blue">Update available</Badge>;
  return <Badge tone="green">{selfDownloading(mode) ? 'Listed' : 'Installed'}</Badge>;
}

function ItemRow({
  item,
  mode,
  canEdit,
  first,
  last,
  onChanged,
}: {
  item: WorkshopItem;
  mode: Mode;
  canEdit: boolean;
  first: boolean;
  last: boolean;
  onChanged: (v: WorkshopView) => void;
}) {
  const { serverId } = useServerDetail();
  const toast = useToast();
  const confirm = useConfirm();
  const [modIds, setModIds] = useState(item.modIds.join(', '));
  useEffect(() => setModIds(item.modIds.join(', ')), [item.modIds]);
  const base = `/servers/${serverId}/workshop/items/${item.id}`;

  async function patch(body: object) {
    try {
      onChanged(await api.patch<WorkshopView>(base, body));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to save');
    }
  }
  async function remove() {
    const ok = await confirm({
      title: 'Remove Workshop item',
      message: !selfDownloading(mode) && item.folder ? `Remove “${item.title}” and delete its installed files?` : `Remove “${item.title}” from the list?`,
      confirmLabel: 'Remove',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      onChanged(await api.delete<WorkshopView>(base));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to remove');
    }
  }

  return (
    <div className="flex flex-wrap items-start gap-3 px-4 py-3">
      {item.previewUrl ? (
        <img src={item.previewUrl} alt="" className="h-14 w-14 shrink-0 rounded-lg object-cover" loading="lazy" />
      ) : (
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-surface-700 text-xl">🧩</div>
      )}
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <a href={workshopUrl(item.id)} target="_blank" rel="noreferrer" className="truncate text-sm font-medium text-ink-100 hover:underline">
            {item.title}
          </a>
          {statusBadge(item, mode)}
        </div>
        <p className="text-xs text-ink-400">
          {item.id} · {item.sizeBytes ? formatBytes(item.sizeBytes) : 'size unknown'}
          {installedAt(mode, item) && ` · ${installedAt(mode, item)}`}
        </p>
        {item.error && <p className="text-xs text-red-400">{item.error}</p>}
        {mode === 'zomboid' && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <span className="text-xs text-ink-400">Mod ID{item.modIds.length === 1 ? '' : 's'}</span>
            <Input
              value={modIds}
              disabled={!canEdit}
              onChange={(e) => setModIds(e.target.value)}
              onBlur={() => {
                const next = modIds.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
                if (next.join() !== item.modIds.join()) patch({ modIds: next });
              }}
              placeholder="from the item’s page, e.g. tsarslib"
              className="!w-auto min-w-[12rem] flex-1 !py-1 font-mono text-xs"
            />
          </div>
        )}
      </div>
      {canEdit && (
        <div className="flex shrink-0 items-center gap-2">
          {ordered(mode) && (
            <div className="flex flex-col">
              <button type="button" disabled={first} onClick={() => patch({ move: 'up' })} className="state-layer rounded p-0.5 text-ink-400 disabled:opacity-30" aria-label="Load earlier">
                <Icon name="chevronUp" className="h-4 w-4" />
              </button>
              <button type="button" disabled={last} onClick={() => patch({ move: 'down' })} className="state-layer rounded p-0.5 text-ink-400 disabled:opacity-30" aria-label="Load later">
                <Icon name="chevronDown" className="h-4 w-4" />
              </button>
            </div>
          )}
          {mode === 'bo3' && (
            <Select value={item.kind === 'item' ? '' : item.kind} onChange={(e) => patch({ kind: e.target.value })} className="!w-auto !py-1 text-xs" aria-label="Type">
              {item.kind === 'item' && <option value="">Type?</option>}
              <option value="map">Map</option>
              <option value="mod">Mod</option>
            </Select>
          )}
          <Button variant="ghost" onClick={remove} aria-label={`Remove ${item.title}`}>
            <Icon name="trash" className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}

export function WorkshopTab() {
  const { serverId, can } = useServerDetail();
  const toast = useToast();
  const [data, setData] = useState<WorkshopView | null>(null);
  const [error, setError] = useState('');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState<'' | 'add' | 'apply' | 'import' | 'login'>('');
  const [guard, setGuard] = useState('');
  const [steamUser, setSteamUser] = useState('');
  const [steamPass, setSteamPass] = useState('');
  const [editingLogin, setEditingLogin] = useState(false);
  const canEdit = can('plugins');
  const base = `/servers/${serverId}/workshop`;

  const load = useCallback(async () => {
    try {
      setData(await api.get<WorkshopView>(base));
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load the Workshop list');
    }
  }, [base]);

  useEffect(() => {
    load();
  }, [load]);

  // While BO3 items download in the background, keep the list fresh.
  useEffect(() => {
    if (!data?.applying) return;
    const t = setVisibleInterval(load, 3000);
    return () => t();
  }, [data?.applying, load]);

  async function run<T>(key: typeof busy, fn: () => Promise<T>) {
    setBusy(key);
    try {
      return await fn();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Something went wrong');
      return undefined;
    } finally {
      setBusy('');
    }
  }

  if (error) return <ErrorText>{error}</ErrorText>;
  if (!data) return <Spinner />;
  if (!data.support) {
    return (
      <Card className="p-5">
        <CardTitle>Steam Workshop</CardTitle>
        <Notice tone="info">
          This game doesn’t have Workshop support in Outpost yet. Supported so far: Project Zomboid, Garry’s Mod, ARK: Survival Evolved, Arma 3 and Call of Duty: Black Ops III.
        </Notice>
      </Card>
    );
  }
  const { support, state } = data;
  const mode = support.mode;
  const maps = state.items.filter((i) => i.kind === 'map' && i.status === 'installed' && i.folder);
  const mods = state.items.filter((i) => i.kind === 'mod' && i.status === 'installed' && i.folder);
  const pending = state.items.filter((i) => i.status !== 'installed' || (!selfDownloading(mode) && (i.installedAt ?? 0) < i.updatedAt)).length;

  const add = () =>
    run('add', async () => {
      const res = await api.post<WorkshopView & { added: number; skipped: { id: string; reason: string }[] }>(`${base}/items`, { input });
      setData(res);
      setInput('');
      if (res.added) toast.success(`Added ${res.added} item${res.added === 1 ? '' : 's'}`);
      for (const s of res.skipped.slice(0, 3)) toast.error(`${s.id}: ${s.reason}`);
    });

  const apply = () =>
    run('apply', async () => {
      const res = await api.post<WorkshopView & { message: string }>(`${base}/apply`, { guardCode: guard || undefined });
      setData(res);
      setGuard('');
      toast.success(res.message);
    });

  return (
    <div className="space-y-5">
      <Card className="p-5">
        <CardTitle
          action={
            <a
              href={`https://steamcommunity.com/app/${support.appId}/workshop/`}
              target="_blank"
              rel="noreferrer"
              className="text-sm font-medium text-accent-400 hover:underline"
            >
              Browse the Workshop ↗
            </a>
          }
        >
          Steam Workshop
        </CardTitle>
        <p className="mb-4 text-sm text-ink-400">
          {INTRO[mode]}
        </p>

        {canEdit && (
          <div className="space-y-2">
            <Field label="Workshop item or collection IDs / links">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                rows={2}
                placeholder="https://steamcommunity.com/sharedfiles/filedetails/?id=2392709985  — or several IDs separated by spaces"
                className="ui-input w-full rounded-lg border border-surface-500 bg-transparent px-3 py-2 font-mono text-xs text-ink-100 outline-none focus:border-accent-400"
              />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" disabled={!input.trim() || busy === 'add'} onClick={add}>
                <Icon name="plus" className="h-4 w-4" /> {busy === 'add' ? 'Looking up…' : 'Add'}
              </Button>
              {mode === 'zomboid' && data.ini?.found && data.ini.workshopItems.length > 0 && state.items.length === 0 && (
                <Button
                  disabled={busy === 'import'}
                  onClick={() =>
                    run('import', async () => {
                      const res = await api.post<WorkshopView & { added: number }>(`${base}/import`);
                      setData(res);
                      toast.success(`Imported ${res.added} item${res.added === 1 ? '' : 's'} from the server’s settings`);
                    })
                  }
                >
                  Import {data.ini.workshopItems.length} already in the server’s settings
                </Button>
              )}
            </div>
          </div>
        )}
      </Card>

      {support.needsLogin && (
        <Card className="p-5">
          <CardTitle action={state.loginUser ? <Badge tone="green">{state.loginUser}</Badge> : <Badge tone="yellow">Not set</Badge>}>Steam account</CardTitle>
          <p className="mb-3 text-sm text-ink-400">
            Used only to download Workshop items. It must own {GAME[mode]}. The password stays on this panel; consider a separate Steam account for servers.
          </p>
          {state.loginUser && !editingLogin ? (
            can('settings') && (
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => setEditingLogin(true)}>Change</Button>
                <Button
                  variant="ghost"
                  onClick={() => run('login', async () => setData(await api.put<WorkshopView>(`${base}/login`, { username: '', password: '' })))}
                >
                  Remove
                </Button>
              </div>
            )
          ) : can('settings') ? (
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[10rem] flex-1">
                <Field label="Username">
                  <Input value={steamUser} onChange={(e) => setSteamUser(e.target.value)} autoComplete="off" />
                </Field>
              </div>
              <div className="min-w-[10rem] flex-1">
                <Field label="Password">
                  <Input type="password" value={steamPass} onChange={(e) => setSteamPass(e.target.value)} autoComplete="new-password" />
                </Field>
              </div>
              <Button
                variant="primary"
                disabled={!steamUser.trim() || !steamPass || busy === 'login'}
                onClick={() =>
                  run('login', async () => {
                    setData(await api.put<WorkshopView>(`${base}/login`, { username: steamUser, password: steamPass }));
                    setSteamUser('');
                    setSteamPass('');
                    setEditingLogin(false);
                    toast.success('Steam account saved');
                  })
                }
              >
                Save
              </Button>
            </div>
          ) : (
            <p className="text-sm text-ink-500">Ask someone with the “Edit configuration” permission to add one.</p>
          )}
        </Card>
      )}

      <Card className="p-5">
        <CardTitle action={<span className="text-xs text-ink-400">{state.items.length} item{state.items.length === 1 ? '' : 's'}</span>}>Items</CardTitle>
        {state.items.length === 0 ? (
          <p className="text-sm text-ink-500">Nothing added yet.</p>
        ) : (
          <div className="divide-y divide-surface-700 overflow-hidden rounded-2xl bg-surface-900">
            {state.items.map((item, n) => (
              <ItemRow key={item.id} item={item} mode={mode} canEdit={canEdit} first={n === 0} last={n === state.items.length - 1} onChanged={setData} />
            ))}
          </div>
        )}

        {mode === 'bo3' && (maps.length > 0 || mods.length > 0) && (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Field label="Start on map">
              <Select
                value={state.startMap ?? ''}
                disabled={!canEdit}
                onChange={(e) => run('apply', async () => setData(await api.put<WorkshopView>(`${base}/options`, { startMap: e.target.value || null })))}
              >
                <option value="">Map rotation from server.cfg</option>
                {maps.map((m) => (
                  <option key={m.id} value={m.folder!}>
                    {m.title} ({m.folder})
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Load mod">
              <Select
                value={state.activeMod ?? ''}
                disabled={!canEdit}
                onChange={(e) => run('apply', async () => setData(await api.put<WorkshopView>(`${base}/options`, { activeMod: e.target.value || null })))}
              >
                <option value="">None (custom maps only)</option>
                {mods.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.title}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}

        {canEdit && state.items.length > 0 && (
          <div className="mt-5 flex flex-wrap items-end gap-2">
            {support.needsLogin && (
              <div className="w-56">
                <Field label="Steam Guard code (if asked)">
                  <Input value={guard} onChange={(e) => setGuard(e.target.value.toUpperCase().slice(0, 5))} placeholder="ABC12" className="font-mono" />
                </Field>
              </div>
            )}
            <Button variant="primary" disabled={!!busy || data.applying || (support.needsLogin && !state.loginUser)} onClick={apply}>
              {data.applying ? (
                <>
                  <Spinner /> Downloading — see Console
                </>
              ) : mode === 'zomboid' ? (
                'Save to server settings'
              ) : mode === 'ark' ? (
                'Save mod list'
              ) : (
                `Download & install${pending ? ` (${pending})` : ''}`
              )}
            </Button>
            <span className="text-xs text-ink-500">Restart the server afterwards to load the changes.</span>
          </div>
        )}
        {mode === 'zomboid' && data.ini && !data.ini.found && (
          <div className="mt-4">
            <Notice tone="info">Start the server once so it creates {data.ini.path}; then Outpost can write your mods into it.</Notice>
          </div>
        )}
      </Card>
    </div>
  );
}
