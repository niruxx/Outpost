import { useCallback, useEffect, useMemo, useState } from 'react';
import { setVisibleInterval } from '../../lib/perf.js';
import { formatBytes } from './StatusTab.js';
import { PluginConfigModal } from './Cs2PluginConfig.js';
import { useServerDetail } from './ServerContext.js';
import { api, ApiError } from '../../api/client.js';
import { Badge, Button, Card, CardTitle, ErrorText, Field, Input, Notice, Select, Spinner } from '../../components/ui.js';
import { useToast } from '../../components/Toast.js';
import { Icon } from '../../components/icons.js';

type Mode = 'casual' | 'competitive' | 'wingman' | 'deathmatch' | 'armsrace' | 'custom';
interface Settings {
  mode: Mode;
  map: string;
  workshopMap: string | null;
  workshopCollection: string | null;
  hostname: string;
  password: string;
  maxPlayers: number;
  gslt: string;
  lan: boolean;
  bots: { quota: number; difficulty: number; fill: boolean; joinAfterPlayer: boolean };
  preset: string | null;
  cvars: Record<string, string>;
  admins: string[];
  library: LibraryMap[];
}
interface LibraryMap {
  id: string;
  title: string;
  previewUrl: string | null;
  sizeBytes: number;
}
interface DownloadedMap {
  id: string;
  map: string;
  title: string | null;
}
interface Cs2View {
  settings: Settings;
  modes: { id: Mode; label: string; maxPlayers: number }[];
  presets: { id: string; label: string; description: string; mode: Mode; tip: string | null }[];
  maps: string[];
  workshopMaps: DownloadedMap[];
  running: boolean;
  counterStrikeSharp: boolean;
  commands: { group: string; commands: { command: string; description: string; oneClick?: boolean }[] }[];
  admin: { rconEnabled: boolean; rconPassword: string | null; port: number; address: string | null };
}

const DIFFICULTY = ['Harmless', 'Easy', 'Fair', 'Normal', 'Tough', 'Hard', 'Very hard', 'Expert'];
const PRESET_ICON: Record<string, string> = { surf: '🏄', bhop: '🐇', practice: '🎯', competitive: '🏆', deathmatch: '💥', casual: '🙂' };

/** Counter-Strike 2: mode, maps, presets (surf/bhop…), server identity, bots, cvars, live actions + a command reference. */
export function Cs2Tab() {
  const { serverId, can } = useServerDetail();
  const toast = useToast();
  const [v, setV] = useState<Cs2View | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [cvarRows, setCvarRows] = useState<{ k: string; v: string }[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [changeTo, setChangeTo] = useState('');
  const canEdit = can('settings');
  const canConsole = can('console');
  const base = `/servers/${serverId}/cs2`;

  const apply = useCallback((r: Cs2View) => {
    setV(r);
    setDraft(r.settings);
    setCvarRows(Object.entries(r.settings.cvars).map(([k, val]) => ({ k, v: val })));
  }, []);
  useEffect(() => {
    api
      .get<Cs2View>(base)
      .then(apply)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load'));
  }, [base, apply]);
  const reload = useCallback(() => {
    api
      .get<Cs2View>(base)
      .then(apply)
      .catch(() => {});
  }, [base, apply]);
  // New uploads to game/csgo/maps and freshly downloaded Workshop maps appear without a reload.
  useEffect(() => {
    const t = setVisibleInterval(() => {
      api
        .get<{ maps: string[]; workshopMaps: DownloadedMap[] }>(`${base}/maps`)
        .then((r) => setV((cur) => (cur ? { ...cur, maps: r.maps, workshopMaps: r.workshopMaps } : cur)))
        .catch(() => {});
    }, 30_000);
    return () => t();
  }, [base]);

  if (error) return <ErrorText>{error}</ErrorText>;
  if (!v || !draft) return <Spinner />;
  const set = (patch: Partial<Settings>) => setDraft({ ...draft, ...patch });
  const setBots = (patch: Partial<Settings['bots']>) => setDraft({ ...draft, bots: { ...draft.bots, ...patch } });

  async function run<T>(key: string, fn: () => Promise<T>, ok?: string) {
    setBusy(key);
    try {
      const r = await fn();
      if (ok) toast.success(ok);
      return r;
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Something went wrong');
      return undefined;
    } finally {
      setBusy('');
    }
  }
  const save = () =>
    run(
      'save',
      async () => apply(await api.put<Cs2View>(base, { ...draft, cvars: Object.fromEntries(cvarRows.filter((r) => r.k.trim()).map((r) => [r.k.trim(), r.v])) })),
      v.running ? 'Saved — press “Apply now” to load it (reloads the map), or restart' : 'Saved — applies on the next start',
    );
  const action = (a: string, value?: string, ok?: string) => run(a, () => api.post(`${base}/action`, { action: a, value }), ok);
  const sendRaw = (command: string) => run('cmd', () => api.post(`/servers/${serverId}/command`, { command }), `Sent: ${command}`);

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="min-w-0 space-y-5">
        {/* Presets */}
        <Card className="p-5">
          <CardTitle action={draft.preset && <Badge tone="green">{v.presets.find((p) => p.id === draft.preset)?.label ?? draft.preset}</Badge>}>Server presets</CardTitle>
          <p className="mb-3 text-sm text-ink-400">One click sets the game mode, slots, bots and every cvar the style needs. Your own extra cvars below are kept.</p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {v.presets.map((p) => (
              <button
                key={p.id}
                type="button"
                disabled={!canEdit || !!busy}
                onClick={() =>
                  run('preset', async () => {
                    const r = await api.post<Cs2View & { tip: string | null }>(`${base}/preset`, { preset: p.id });
                    apply(r);
                    toast.success(`${p.label} preset applied${r.running ? ' — press “Apply now”' : ''}`);
                    if (r.tip) toast.success(r.tip);
                  })
                }
                className={`state-layer rounded-2xl border p-3 text-left transition-colors disabled:opacity-50 ${draft.preset === p.id ? 'border-accent-400 bg-secondary-container' : 'border-surface-600 bg-surface-900'}`}
              >
                <span className="block text-sm font-medium text-ink-100">
                  {PRESET_ICON[p.id] ?? '⚙️'} {p.label}
                </span>
                <span className="mt-0.5 block text-xs text-ink-400">{p.description}</span>
              </button>
            ))}
          </div>
        </Card>

        {/* Mode + map */}
        <Card className="p-5">
          <CardTitle>Game mode &amp; map</CardTitle>
          <fieldset disabled={!canEdit} className="grid gap-3 sm:grid-cols-2">
            <Field label="Game mode">
              <Select value={draft.mode} onChange={(e) => set({ mode: e.target.value as Mode })}>
                {v.modes.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Start map">
              <Select
                value={draft.workshopMap ? `ws:${draft.workshopMap}` : draft.map}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val.startsWith('ws:')) set({ workshopMap: val.slice(3) });
                  else set({ map: val, workshopMap: null });
                }}
              >
                <optgroup label="Installed">
                  {!v.maps.includes(draft.map) && <option value={draft.map}>{draft.map}</option>}
                  {v.maps.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </optgroup>
                {(draft.library.length > 0 || draft.workshopMap) && (
                  <optgroup label="Workshop library">
                    {draft.workshopMap && !draft.library.some((m) => m.id === draft.workshopMap) && <option value={`ws:${draft.workshopMap}`}>Workshop {draft.workshopMap}</option>}
                    {draft.library.map((m) => (
                      <option key={m.id} value={`ws:${m.id}`}>
                        {m.title}
                      </option>
                    ))}
                  </optgroup>
                )}
              </Select>
            </Field>
            <Field label="Workshop collection (map pool)">
              <Input value={draft.workshopCollection ?? ''} onChange={(e) => set({ workshopCollection: e.target.value || null })} placeholder="Collection link or ID" className="font-mono" />
            </Field>
          </fieldset>
          <p className="mt-2 text-xs text-ink-500">
            Workshop maps download when the server loads them (it needs internet and a moment the first time). A collection makes its maps available to{' '}
            <span className="font-mono">ds_workshop_changelevel</span> and votes.
          </p>
          {canConsole && v.running && (
            <div className="mt-4 flex flex-wrap items-end gap-2 rounded-2xl bg-surface-900 p-3">
              <div className="min-w-[12rem] flex-1">
                <Field label="Change map now">
                  <Input value={changeTo} onChange={(e) => setChangeTo(e.target.value)} placeholder="de_mirage, or a Workshop link / ID" list="cs2-maps" className="font-mono" />
                  <datalist id="cs2-maps">
                    {v.maps.map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                </Field>
              </div>
              <Button disabled={!changeTo.trim() || !!busy} onClick={() => action('changelevel', changeTo.trim(), 'Changing map…')}>
                Change map
              </Button>
            </div>
          )}
        </Card>

        <MapLibrary
          v={v}
          serverId={serverId}
          canEdit={canEdit}
          canConsole={canConsole}
          onChange={apply}
          onPlay={(id) => action('changelevel', id, 'Loading the map — the server downloads it first if needed')}
          onStartMap={(id) => set({ workshopMap: id })}
          startMap={draft.workshopMap}
        />

        <Cs2Plugins serverId={serverId} canManage={can('plugins')} onFrameworkReady={reload} />

        {/* Server */}
        <Card className="p-5">
          <CardTitle>Server</CardTitle>
          <fieldset disabled={!canEdit} className="grid gap-3 sm:grid-cols-2">
            <Field label="Server name">
              <Input value={draft.hostname} onChange={(e) => set({ hostname: e.target.value })} placeholder="Shown in the server browser" />
            </Field>
            <Field label="Join password (empty = none)">
              <Input value={draft.password} onChange={(e) => set({ password: e.target.value })} autoComplete="off" />
            </Field>
            <Field label="Max players">
              <Input type="number" min={2} max={64} value={draft.maxPlayers} onChange={(e) => set({ maxPlayers: Number(e.target.value) })} />
            </Field>
            <Field label="Game Server Login Token (public listing)">
              <Input value={draft.gslt} onChange={(e) => set({ gslt: e.target.value })} placeholder="32 hex characters" className="font-mono" autoComplete="off" />
            </Field>
          </fieldset>
          <label className="mt-3 flex items-center gap-2 text-sm text-ink-300">
            <input type="checkbox" disabled={!canEdit} checked={draft.lan} onChange={(e) => set({ lan: e.target.checked })} />
            LAN only (not reachable over the internet)
          </label>
          <p className="mt-2 text-xs text-ink-500">
            Without a token the server still works by IP (connect &lt;address&gt; in the console) but won’t be listed. Make one at{' '}
            <a className="text-accent-400 underline" href="https://steamcommunity.com/dev/managegameservers" target="_blank" rel="noreferrer">
              steamcommunity.com/dev/managegameservers
            </a>{' '}
            with app ID 730.
          </p>
        </Card>

        {/* Bots */}
        <Card className="p-5">
          <CardTitle>Bots</CardTitle>
          <fieldset disabled={!canEdit} className="grid gap-3 sm:grid-cols-2">
            <Field label="Number of bots">
              <Input type="number" min={0} max={64} value={draft.bots.quota} onChange={(e) => setBots({ quota: Number(e.target.value) })} />
            </Field>
            <Field label="Difficulty">
              <Select value={draft.bots.difficulty} onChange={(e) => setBots({ difficulty: Number(e.target.value) })}>
                {DIFFICULTY.map((d, i) => (
                  <option key={d} value={i}>
                    {i} — {d}
                  </option>
                ))}
              </Select>
            </Field>
          </fieldset>
          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm text-ink-300">
            <label className="flex items-center gap-2">
              <input type="checkbox" disabled={!canEdit} checked={draft.bots.fill} onChange={(e) => setBots({ fill: e.target.checked })} />
              Fill empty slots (bots leave as players join)
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" disabled={!canEdit} checked={draft.bots.joinAfterPlayer} onChange={(e) => setBots({ joinAfterPlayer: e.target.checked })} />
              Only add bots once a player joins
            </label>
          </div>
        </Card>

        {/* Advanced cvars */}
        <Card className="p-5">
          <CardTitle
            action={
              canEdit && (
                <button type="button" className="text-xs font-medium text-accent-400" onClick={() => setCvarRows([...cvarRows, { k: '', v: '' }])}>
                  + Add cvar
                </button>
              )
            }
          >
            Advanced settings (cvars)
          </CardTitle>
          <p className="mb-3 text-sm text-ink-400">Any server cvar, applied after the preset on every map load — e.g. mp_roundtime 3, sv_airaccelerate 150.</p>
          {cvarRows.length === 0 && <p className="text-sm text-ink-500">None.</p>}
          <div className="space-y-1.5">
            {cvarRows.map((row, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2">
                <Input
                  disabled={!canEdit}
                  value={row.k}
                  onChange={(e) => setCvarRows(cvarRows.map((r, j) => (j === i ? { ...r, k: e.target.value } : r)))}
                  placeholder="cvar"
                  className="!py-1 font-mono text-xs"
                />
                <Input
                  disabled={!canEdit}
                  value={row.v}
                  onChange={(e) => setCvarRows(cvarRows.map((r, j) => (j === i ? { ...r, v: e.target.value } : r)))}
                  placeholder="value"
                  className="!py-1 font-mono text-xs"
                />
                {canEdit && (
                  <Button variant="ghost" onClick={() => setCvarRows(cvarRows.filter((_, j) => j !== i))} aria-label="Remove">
                    <Icon name="trash" className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        </Card>

        {canEdit && (
          <div className="sticky bottom-3 z-10 flex flex-wrap items-center gap-2 rounded-2xl bg-surface-850 p-3 shadow-card">
            <Button variant="primary" disabled={!!busy} onClick={save}>
              Save
            </Button>
            {canConsole && v.running && (
              <Button disabled={!!busy} onClick={() => action('apply', undefined, 'Applying — the map reloads with the new settings')}>
                Apply now (reloads the map)
              </Button>
            )}
            <span className="text-xs text-ink-500">{v.running ? 'Saved settings load with “Apply now” or on restart.' : 'Settings load when the server starts.'}</span>
          </div>
        )}
      </div>

      <CommandsPanel v={v} serverId={serverId} canConsole={canConsole} canEdit={canEdit} onSend={sendRaw} onAction={action} onChange={apply} busy={busy} />
    </div>
  );
}

function CommandsPanel({
  v,
  serverId,
  canConsole,
  canEdit,
  onSend,
  onAction,
  onChange,
  busy,
}: {
  v: Cs2View;
  serverId: string;
  canConsole: boolean;
  canEdit: boolean;
  onSend: (c: string) => void;
  onAction: (a: string, value?: string, ok?: string) => void;
  onChange: (r: Cs2View) => void;
  busy: string;
}) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [cmd, setCmd] = useState('');
  const [admins, setAdmins] = useState(v.settings.admins.join('\n'));
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return v.commands
      .map((g) => ({ ...g, commands: g.commands.filter((c) => !needle || c.command.toLowerCase().includes(needle) || c.description.toLowerCase().includes(needle)) }))
      .filter((g) => g.commands.length);
  }, [q, v.commands]);
  const copy = (text: string) => navigator.clipboard?.writeText(text).then(() => toast.success('Copied'));
  const address = `${v.admin.address ?? window.location.hostname}:${v.admin.port}`;

  return (
    <aside className="space-y-5 xl:sticky xl:top-4 xl:max-h-[calc(100vh-2rem)] xl:self-start xl:overflow-y-auto">
      {canConsole && v.running && (
        <Card className="p-4">
          <CardTitle>Quick actions</CardTitle>
          <div className="flex flex-wrap gap-1.5">
            <Button disabled={!!busy} onClick={() => onAction('restart_round', undefined, 'Round restarting')}>
              Restart round
            </Button>
            <Button disabled={!!busy} onClick={() => onAction('end_warmup', undefined, 'Warmup ended')}>
              End warmup
            </Button>
            <Button disabled={!!busy} onClick={() => onAction('bot_add', undefined, 'Bot added')}>
              Add bot
            </Button>
            <Button disabled={!!busy} onClick={() => onAction('bot_kick', undefined, 'Bots kicked')}>
              Kick bots
            </Button>
            <Button disabled={!!busy} onClick={() => onAction('reload_cfg', undefined, 'Settings re-applied')}>
              Re-apply cvars
            </Button>
          </div>
        </Card>
      )}

      <Card className="p-4">
        <CardTitle>Becoming an admin</CardTitle>
        <div className="space-y-3 text-xs text-ink-300">
          <p>
            Vanilla CS2 has no admin list — admin means <b className="text-ink-100">RCON</b>: anyone with the RCON password can run server commands from the in-game console.
          </p>
          {v.admin.rconEnabled ? (
            v.admin.rconPassword ? (
              <div className="space-y-1 rounded-xl bg-surface-900 p-2 font-mono text-[11px] text-ink-200">
                <p className="font-sans text-ink-400">In CS2, open the console (~) and type:</p>
                {[`rcon_address ${address}`, `rcon_password ${v.admin.rconPassword}`, 'rcon status'].map((l) => (
                  <button key={l} type="button" onClick={() => copy(l)} className="block w-full truncate text-left hover:text-accent-400" title="Copy">
                    {l}
                  </button>
                ))}
                <p className="font-sans text-ink-400">Then prefix any command with rcon, e.g. rcon mp_restartgame 1.</p>
              </div>
            ) : (
              <p className="text-ink-400">RCON is on. Someone with “Edit configuration” can see the password here.</p>
            )
          ) : canEdit ? (
            <Button
              variant="primary"
              onClick={async () => {
                try {
                  onChange(await api.post<Cs2View>(`/servers/${serverId}/cs2/enable-rcon`));
                  toast.success('RCON is on with a new password — restart the server to use it');
                } catch (err) {
                  toast.error(err instanceof ApiError ? err.message : 'Failed');
                }
              }}
            >
              Turn on RCON (make me admin)
            </Button>
          ) : (
            <p className="text-ink-400">Ask someone with “Edit launch command” to turn on RCON.</p>
          )}
          <p>
            Commands can always be run from Outpost’s <b className="text-ink-100">Console</b> tab too (or this list).
          </p>
          <div className="border-t border-surface-700 pt-3">
            <p className="mb-1">
              <b className="text-ink-100">In-game admin menus (!admin, !kick, !map)</b> need a plugin framework: Metamod:Source + CounterStrikeSharp, plus an admin plugin (e.g. CS2-SimpleAdmin).{' '}
              {v.counterStrikeSharp ? <Badge tone="green">CounterStrikeSharp found</Badge> : <Badge>not installed</Badge>}
            </p>
            {v.counterStrikeSharp ? (
              <>
                <Field label="Admins — SteamID64s, one per line (full access, @css/root)">
                  <textarea
                    disabled={!canEdit}
                    value={admins}
                    onChange={(e) => setAdmins(e.target.value)}
                    rows={3}
                    className="ui-input w-full rounded-lg border border-surface-500 bg-transparent px-2 py-1.5 font-mono text-xs text-ink-100 outline-none focus:border-accent-400"
                    placeholder="76561198000000000"
                  />
                </Field>
                {canEdit && (
                  <Button
                    className="mt-2"
                    onClick={async () => {
                      try {
                        onChange(await api.put<Cs2View>(`/servers/${serverId}/cs2`, { admins: admins.split(/\s+/).filter(Boolean) }));
                        toast.success('Admins saved to CounterStrikeSharp — restart or run css_reloadadmins');
                      } catch (err) {
                        toast.error(err instanceof ApiError ? err.message : 'Failed');
                      }
                    }}
                  >
                    Save admins
                  </Button>
                )}
                <p className="mt-1 text-ink-500">Find a SteamID64 at steamid.io. Outpost writes them to addons/counterstrikesharp/configs/admins.json.</p>
              </>
            ) : (
              <p className="text-ink-500">
                Install them in one click under <b className="text-ink-300">Plugins</b>, then list admins here.
              </p>
            )}
          </div>
        </div>
      </Card>

      <Card className="p-4">
        <CardTitle>Commands</CardTitle>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search commands…" className="mb-3" />
        {!v.running && canConsole && (
          <div className="mb-3">
            <Notice tone="info">Start the server to send commands from here.</Notice>
          </div>
        )}
        <div className="space-y-4">
          {groups.map((g) => (
            <div key={g.group}>
              <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-400">{g.group}</p>
              <div className="space-y-1">
                {g.commands.map((c) => (
                  <div key={c.command} className="group rounded-xl px-2 py-1.5 hover:bg-surface-900">
                    <div className="flex items-start gap-2">
                      <span className="min-w-0 flex-1">
                        <span className="block break-all font-mono text-xs text-ink-100">{c.command}</span>
                        <span className="block text-[11px] text-ink-400">{c.description}</span>
                      </span>
                      <span className="flex shrink-0 gap-1 opacity-70 group-hover:opacity-100">
                        <button type="button" title="Copy" onClick={() => copy(c.command)} className="state-layer rounded-full p-1 text-ink-300">
                          <Icon name="copy" className="h-3.5 w-3.5" />
                        </button>
                        {canConsole && v.running && (
                          <button
                            type="button"
                            title={c.oneClick ? 'Send to the server' : 'Edit in the box below, then send'}
                            onClick={() => (c.oneClick ? onSend(c.command) : setCmd(c.command))}
                            className="state-layer rounded-full p-1 text-accent-400"
                          >
                            <Icon name={c.oneClick ? 'play' : 'edit'} className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        {canConsole && v.running && <CommandBox value={cmd} onChange={setCmd} onSend={onSend} />}
      </Card>
    </aside>
  );
}

function CommandBox({ value, onChange, onSend }: { value: string; onChange: (v: string) => void; onSend: (c: string) => void }) {
  return (
    <form
      className="sticky bottom-0 mt-3 flex gap-2 bg-surface-850 pt-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) onSend(value.trim());
        onChange('');
      }}
    >
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder="Command…" className="font-mono text-xs" />
      <Button type="submit">Send</Button>
    </form>
  );
}

/** Workshop maps imported by link or ID; the server downloads each the first time it loads it. */
function MapLibrary({
  v,
  serverId,
  canEdit,
  canConsole,
  onChange,
  onPlay,
  onStartMap,
  startMap,
}: {
  v: Cs2View;
  serverId: string;
  canEdit: boolean;
  canConsole: boolean;
  onChange: (r: Cs2View) => void;
  onPlay: (id: string) => void;
  onStartMap: (id: string) => void;
  startMap: string | null;
}) {
  const toast = useToast();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const library = v.settings.library;
  const downloaded = new Map(v.workshopMaps.map((m) => [m.id, m]));
  // Workshop maps the server has but that were never imported here (e.g. loaded from the console).
  const extra = v.workshopMaps.filter((m) => !library.some((l) => l.id === m.id));

  async function importNow() {
    setBusy(true);
    try {
      const r = await api.post<Cs2View & { added: LibraryMap[]; skipped: { id: string; reason: string }[] }>(`/servers/${serverId}/cs2/library`, { input });
      onChange(r);
      setInput('');
      if (r.added.length) toast.success(r.added.length === 1 ? `Imported “${r.added[0].title}”` : `Imported ${r.added.length} maps`);
      for (const sk of r.skipped.slice(0, 3)) toast.error(`${sk.id}: ${sk.reason}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Import failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5">
      <CardTitle
        action={
          <a href="https://steamcommunity.com/app/730/workshop/" target="_blank" rel="noreferrer" className="text-sm font-medium text-accent-400 hover:underline">
            Browse the Workshop ↗
          </a>
        }
      >
        Map library
      </CardTitle>
      <p className="mb-3 text-sm text-ink-400">
        Import Workshop maps by link or ID — a collection link imports every map in it. They show up in the start-map list; the server downloads each one the first time it loads it.
      </p>
      {canEdit && (
        <form
          className="mb-4 flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (input.trim()) importNow();
          }}
        >
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="https://steamcommunity.com/sharedfiles/filedetails/?id=… or an ID"
            className="min-w-[14rem] flex-1 font-mono text-xs"
          />
          <Button type="submit" variant="primary" disabled={busy || !input.trim()}>
            {busy ? 'Looking up…' : 'Import'}
          </Button>
        </form>
      )}
      {library.length === 0 && extra.length === 0 ? (
        <p className="text-sm text-ink-500">No Workshop maps yet.</p>
      ) : (
        <div className="divide-y divide-surface-700 overflow-hidden rounded-2xl bg-surface-900">
          {library.map((m) => {
            const dl = downloaded.get(m.id);
            return (
              <div key={m.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                {m.previewUrl ? (
                  <img src={m.previewUrl} alt="" loading="lazy" className="h-11 w-16 shrink-0 rounded-lg object-cover" />
                ) : (
                  <div className="h-11 w-16 shrink-0 rounded-lg bg-surface-700" />
                )}
                <span className="min-w-0 flex-1">
                  <a
                    href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${m.id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="block truncate text-sm font-medium text-ink-100 hover:underline"
                  >
                    {m.title}
                  </a>
                  <span className="block truncate text-[11px] text-ink-400">
                    {m.id}
                    {m.sizeBytes ? ` · ${formatBytes(m.sizeBytes)}` : ''}
                    {dl ? ` · map ${dl.map}` : ''}
                  </span>
                </span>
                {dl ? <Badge tone="green">Downloaded</Badge> : <Badge>Downloads on first load</Badge>}
                {startMap === m.id && <Badge tone="blue">Start map</Badge>}
                <span className="flex gap-1">
                  {canEdit && startMap !== m.id && (
                    <Button variant="ghost" onClick={() => onStartMap(m.id)} title="Use as the start map (then Save)">
                      Start map
                    </Button>
                  )}
                  {canConsole && v.running && (
                    <Button variant="ghost" onClick={() => onPlay(m.id)} title="Switch to it now">
                      Play now
                    </Button>
                  )}
                  {canEdit && (
                    <Button
                      variant="ghost"
                      onClick={async () => {
                        try {
                          onChange(await api.delete<Cs2View>(`/servers/${serverId}/cs2/library/${m.id}`));
                        } catch (err) {
                          toast.error(err instanceof ApiError ? err.message : 'Failed');
                        }
                      }}
                      aria-label={`Remove ${m.title}`}
                    >
                      <Icon name="trash" className="h-4 w-4" />
                    </Button>
                  )}
                </span>
              </div>
            );
          })}
          {extra.map((m) => (
            <div key={m.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <div className="h-11 w-16 shrink-0 rounded-lg bg-surface-700" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-ink-100">{m.title ?? m.map}</span>
                <span className="block text-[11px] text-ink-400">{m.id} · downloaded by the server, not in the library</span>
              </span>
              {canEdit && (
                <Button
                  variant="ghost"
                  onClick={async () => {
                    try {
                      onChange(await api.post<Cs2View>(`/servers/${serverId}/cs2/library`, { input: m.id }));
                    } catch (err) {
                      toast.error(err instanceof ApiError ? err.message : 'Failed');
                    }
                  }}
                >
                  Add to library
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

interface Cs2PluginInfo {
  folder: string;
  enabled: boolean;
  swiftly: boolean;
  repo: string | null;
  version: string | null;
  catalogId: string | null;
}
interface CatalogEntry {
  id: string;
  name: string;
  repo: string;
  description: string;
  tags: string[];
  requires?: string[];
  note?: string;
}
interface PluginsView {
  frameworks: { metamod: { installed: boolean; version: string | null }; css: { installed: boolean; version: string | null }; gameinfoPatched: boolean; loaded: boolean; icu: boolean };
  frameworkJob: { state: 'running' | 'failed'; error?: string } | null;
  installed: Cs2PluginInfo[];
  catalog: CatalogEntry[];
  running: boolean;
}

/** Metamod + CounterStrikeSharp, a catalog (speedometers, timers, admin…), installs from any GitHub repo, and on/off/update/remove. */
function Cs2Plugins({ serverId, canManage, onFrameworkReady }: { serverId: string; canManage: boolean; onFrameworkReady: () => void }) {
  const toast = useToast();
  const base = `/servers/${serverId}/cs2/plugins`;
  const [pv, setPv] = useState<PluginsView | null>(null);
  const [busy, setBusy] = useState('');
  const [repo, setRepo] = useState('');
  const [updates, setUpdates] = useState<Record<string, string>>({});
  const [configuring, setConfiguring] = useState<string | null>(null);
  useEffect(() => {
    api
      .get<PluginsView>(base)
      .then(setPv)
      .catch(() => {});
  }, [base]);
  // While Metamod + CounterStrikeSharp download, watch for them to land.
  const installing = pv?.frameworkJob?.state === 'running';
  useEffect(() => {
    if (!installing) return;
    const t = setVisibleInterval(async () => {
      const r = await api.get<PluginsView>(base).catch(() => null);
      if (!r) return;
      setPv(r);
      if (r.frameworkJob?.state === 'running') return;
      if (r.frameworks.css.installed && !r.frameworkJob) {
        toast.success('Metamod + CounterStrikeSharp installed — restart the server to load them');
        onFrameworkReady();
      } else if (r.frameworkJob?.error) toast.error(r.frameworkJob.error);
    }, 2_500);
    return () => t();
  }, [installing, base, toast, onFrameworkReady]);

  async function run(key: string, fn: () => Promise<PluginsView>, ok?: string) {
    setBusy(key);
    try {
      setPv(await fn());
      if (ok) toast.success(ok);
      return true;
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Something went wrong');
      return false;
    } finally {
      setBusy('');
    }
  }
  if (!pv) return null;
  const fw = pv.frameworks;
  const ready = fw.metamod.installed && fw.css.installed;
  const restartHint = pv.running ? ' — restart the server to load it' : '';
  const install = (body: { catalogId?: string; repo?: string }, key: string) =>
    run(key, async () => {
      const r = await api.post<PluginsView & { result: { folders: string[]; version: string } }>(base, body);
      toast.success(`Installed ${r.result.folders.join(', ')} ${r.result.version}${restartHint}`);
      return r;
    });
  const checkUpdates = async () => {
    setBusy('updates');
    try {
      const r = await api.get<{ updates: Record<string, string> }>(`${base}/updates`);
      setUpdates(r.updates);
      const n = Object.keys(r.updates).length;
      toast.success(n ? `${n} update${n === 1 ? '' : 's'} available` : 'Every plugin is up to date');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed');
    } finally {
      setBusy('');
    }
  };
  const installedIds = new Set(pv.installed.map((p) => p.catalogId).filter(Boolean));
  const sourceName = (r: string) => pv.catalog.find((c) => c.repo === r)?.name ?? r;

  return (
    <Card className="p-5">
      <CardTitle
        action={
          ready &&
          pv.installed.some((p) => p.repo) && (
            <Button variant="ghost" disabled={!!busy} onClick={checkUpdates}>
              {busy === 'updates' ? 'Checking…' : 'Check for updates'}
            </Button>
          )
        }
      >
        Plugins
      </CardTitle>
      <p className="mb-3 text-sm text-ink-400">
        Server-side plugins — speedometers, key displays, surf/bhop timers, admin menus. Players don’t install anything. They run on <b className="text-ink-200">Metamod:Source</b> +{' '}
        <b className="text-ink-200">CounterStrikeSharp</b>.
      </p>

      {/* Frameworks */}
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl bg-surface-900 px-3 py-2.5 text-sm">
        <span className="text-ink-200">Metamod:Source</span>
        {fw.metamod.installed ? <Badge tone="green">{fw.metamod.version}</Badge> : <Badge>not installed</Badge>}
        <span className="ml-2 text-ink-200">CounterStrikeSharp</span>
        {fw.css.installed ? <Badge tone="green">{fw.css.version}</Badge> : <Badge>not installed</Badge>}
        {fw.metamod.installed && fw.loaded && !fw.gameinfoPatched && <Badge tone="yellow">re-linked on next start</Badge>}
        {fw.metamod.installed && !fw.loaded && <Badge tone="yellow">off — vanilla CS2</Badge>}
        <span className="flex-1" />
        {canManage && (
          <Button
            variant={ready ? 'ghost' : 'primary'}
            disabled={installing || !!busy}
            onClick={() => run('fw', () => api.post<PluginsView>(`${base}/frameworks`), 'Downloading Metamod + CounterStrikeSharp (~55 MB) — progress is in the Console')}
          >
            {installing ? 'Installing…' : ready ? 'Update frameworks' : 'Install (one click)'}
          </Button>
        )}
      </div>
      {fw.metamod.installed && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border border-surface-600 px-3 py-2.5 text-sm">
          <span className="min-w-0 flex-1">
            <span className="block font-medium text-ink-100">{fw.loaded ? 'Plugins are on' : 'Vanilla CS2 — plugins are off'}</span>
            <span className="block text-xs text-ink-400">
              {fw.loaded
                ? 'Turn them off to start plain CS2 without Metamod or any plugin — e.g. if the server stops loading after a CS2 update. Nothing is deleted.'
                : 'CS2 starts without Metamod, so no plugin loads. Your plugins and their configs are kept for when you turn them back on.'}
            </span>
          </span>
          {canManage && (
            <Button
              variant={fw.loaded ? 'ghost' : 'primary'}
              disabled={!!busy}
              onClick={() =>
                run('load', () => api.post<PluginsView>(`${base}/loading`, { enabled: !fw.loaded }), fw.loaded ? `Plugins off — vanilla CS2 from the next start${restartHint ? ' (restart now)' : ''}` : `Plugins on from the next start${restartHint ? ' (restart now)' : ''}`)
              }
            >
              {fw.loaded ? 'Switch to vanilla' : 'Turn plugins on'}
            </Button>
          )}
        </div>
      )}
      {fw.css.installed && fw.loaded && !fw.icu && (
        <div className="mb-3">
          <Notice tone="warning">
            This host has no ICU library, which CounterStrikeSharp’s .NET runtime needs. Outpost runs it in invariant mode so CS2 can start, but installing ICU is better: <span className="font-mono">sudo apt install libicu-dev</span> (Arch:{' '}
            <span className="font-mono">icu</span>, Fedora: <span className="font-mono">libicu</span>).
          </Notice>
        </div>
      )}
      {pv.frameworkJob?.state === 'failed' && (
        <div className="mb-3">
          <Notice tone="error">Framework install failed: {pv.frameworkJob.error}</Notice>
        </div>
      )}

      {/* Installed */}
      {pv.installed.length > 0 && (
        <div className="mb-4 divide-y divide-surface-700 overflow-hidden rounded-2xl bg-surface-900">
          {pv.installed.map((p) => {
            const upd = p.repo ? updates[p.repo] : undefined;
            return (
              <div key={p.folder} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className={`block truncate text-sm font-medium ${p.enabled ? 'text-ink-100' : 'text-ink-500 line-through'}`}>{p.folder}</span>
                  <span className="block truncate text-[11px] text-ink-400">{p.repo ? `${sourceName(p.repo)} · ${p.version}` : 'added by hand'}</span>
                </span>
                {upd && <Badge tone="blue">{upd} available</Badge>}
                {p.swiftly && (
                  <span title="Built for SwiftlyS2, a different plugin framework — CounterStrikeSharp can’t load it and it can stop other plugins loading. Remove it.">
                    <Badge tone="red">SwiftlyS2 plugin — remove</Badge>
                  </span>
                )}
                {!p.enabled && <Badge>off</Badge>}
                {canManage && (
                  <span className="flex gap-1">
                    {upd && p.repo && (
                      <Button
                        variant="ghost"
                        disabled={!!busy}
                        onClick={async () => {
                          if (await install(p.catalogId ? { catalogId: p.catalogId } : { repo: p.repo! }, `up:${p.folder}`))
                            setUpdates((cur) => Object.fromEntries(Object.entries(cur).filter(([k]) => k !== p.repo)));
                        }}
                      >
                        {busy === `up:${p.folder}` ? 'Updating…' : 'Update'}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      disabled={!!busy}
                      onClick={() =>
                        run(
                          `t:${p.folder}`,
                          () => api.post<PluginsView>(`${base}/${encodeURIComponent(p.folder)}/toggle`, { enabled: !p.enabled }),
                          `${p.folder} turned ${p.enabled ? 'off' : 'on'}${restartHint}`,
                        )
                      }
                    >
                      {p.enabled ? 'Turn off' : 'Turn on'}
                    </Button>
                    {!p.swiftly && (
                      <Button variant="ghost" disabled={!!busy} onClick={() => setConfiguring(p.folder)}>
                        Configure
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      disabled={!!busy}
                      aria-label={`Remove ${p.folder}`}
                      onClick={() => {
                        if (confirm(`Remove ${p.folder}? Its config files are kept.`))
                          run(`rm:${p.folder}`, () => api.delete<PluginsView>(`${base}/${encodeURIComponent(p.folder)}`), `${p.folder} removed`);
                      }}
                    >
                      <Icon name="trash" className="h-4 w-4" />
                    </Button>
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Catalog (dependencies like GameHUD install themselves) */}
      <div className="grid gap-2 sm:grid-cols-2">
        {pv.catalog
          .filter((c) => !c.tags.includes('library'))
          .map((c) => {
            const has = installedIds.has(c.id);
            return (
              <div key={c.id} className="flex flex-col rounded-2xl border border-surface-600 p-3">
                <div className="mb-1 flex items-center gap-2">
                  <a href={`https://github.com/${c.repo}`} target="_blank" rel="noreferrer" className="font-medium text-ink-100 hover:underline">
                    {c.name}
                  </a>
                  {has && <Badge tone="green">installed</Badge>}
                </div>
                <p className="flex-1 text-xs text-ink-400">{c.description}</p>
                {c.note && <p className="mt-1 text-[11px] text-ink-500">{c.note}</p>}
                <div className="mt-2 flex flex-wrap items-center gap-1">
                  {c.tags.slice(0, 4).map((t) => (
                    <span key={t} className="rounded-full bg-surface-800 px-2 py-0.5 text-[10px] text-ink-400">
                      {t}
                    </span>
                  ))}
                  <span className="flex-1" />
                  {canManage && !has && (
                    <Button
                      variant="ghost"
                      disabled={!ready || !!busy}
                      title={ready ? undefined : 'Install Metamod + CounterStrikeSharp first'}
                      onClick={() => install({ catalogId: c.id }, `c:${c.id}`)}
                    >
                      {busy === `c:${c.id}` ? 'Installing…' : 'Install'}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
      </div>

      {/* Any GitHub plugin */}
      {canManage && (
        <form
          className="mt-4 flex flex-wrap gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (repo.trim() && (await install({ repo: repo.trim() }, 'repo'))) setRepo('');
          }}
        >
          <Input
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder="Any CounterStrikeSharp plugin: https://github.com/owner/plugin"
            className="min-w-[14rem] flex-1 font-mono text-xs"
            disabled={!ready}
          />
          <Button type="submit" disabled={!ready || !repo.trim() || !!busy}>
            {busy === 'repo' ? 'Installing…' : 'Install from GitHub'}
          </Button>
        </form>
      )}
      <p className="mt-2 text-[11px] text-ink-500">
        Outpost installs each repo’s latest release. Plugins load on the next start; check with <span className="font-mono">meta list</span> / <span className="font-mono">css_plugins list</span>. CS2
        updates can unhook Metamod — Outpost re-links it before every start.
      </p>
      <PluginConfigModal serverId={serverId} folder={configuring} onClose={() => setConfiguring(null)} />
    </Card>
  );
}
