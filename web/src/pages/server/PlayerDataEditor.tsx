import { useEffect, useState } from 'react';
import { api, ApiError } from '../../api/client.js';
import type { PlayerData, PlayerItem } from '../../api/types.js';
import { Badge, Button, ErrorText, Field, Input, Modal, Notice, Select, Spinner } from '../../components/ui.js';

const GAME_MODES = ['Survival', 'Creative', 'Adventure', 'Spectator'];
const DIMENSIONS = ['minecraft:overworld', 'minecraft:the_nether', 'minecraft:the_end'];
const ABILITIES: { key: keyof PlayerData['abilities']; label: string }[] = [
  { key: 'mayfly', label: 'Can fly' },
  { key: 'flying', label: 'Flying' },
  { key: 'invulnerable', label: 'Invulnerable' },
  { key: 'instabuild', label: 'Instant build' },
  { key: 'mayBuild', label: 'Can build' },
];

function slotLabel(slot: number, ender: boolean): string {
  if (ender) return `Chest ${slot}`;
  if (slot >= 0 && slot <= 8) return `Hotbar ${slot + 1}`;
  if (slot >= 9 && slot <= 35) return `Main ${slot - 8}`;
  if (slot >= 100 && slot <= 103) return ['Boots', 'Leggings', 'Chestplate', 'Helmet'][slot - 100];
  if (slot === -106) return 'Offhand';
  return `Slot ${slot}`;
}

type Tab = 'stats' | 'inventory' | 'ender' | 'live';

/** Edits a Java player's saved .dat file; when they're online, offers live console actions instead. */
export function PlayerDataEditor({
  serverId,
  uuid,
  running,
  canWrite,
  onClose,
}: {
  serverId: string;
  uuid: string | null;
  running: boolean;
  canWrite: boolean;
  onClose: () => void;
}) {
  const [data, setData] = useState<PlayerData | null>(null);
  const [draft, setDraft] = useState<PlayerData | null>(null);
  const [clearEffects, setClearEffects] = useState(false);
  const [tab, setTab] = useState<Tab>('stats');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!uuid) return;
    setData(null);
    setDraft(null);
    setError('');
    setNotice('');
    setClearEffects(false);
    api
      .get<{ player: PlayerData }>(`/servers/${serverId}/playerdata/${uuid}`)
      .then((res) => {
        setData(res.player);
        setDraft(structuredClone(res.player));
        setTab(res.player.online ? 'live' : 'stats');
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load player data'));
  }, [serverId, uuid]);

  const readOnly = !canWrite || !!data?.online;

  function set<K extends keyof PlayerData>(key: K, value: PlayerData[K]) {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  }

  function numField(key: keyof PlayerData, label: string, step = 1) {
    const value = draft?.[key] as number | null | undefined;
    return (
      <Field label={label}>
        <Input
          type="number"
          step={step}
          disabled={readOnly || value === null}
          value={value ?? ''}
          placeholder={value === null ? 'not stored' : undefined}
          onChange={(e) => set(key, (e.target.value === '' ? 0 : Number(e.target.value)) as never)}
        />
      </Field>
    );
  }

  async function save() {
    if (!data || !draft) return;
    setBusy(true);
    setError('');
    setNotice('');
    const patch: Record<string, unknown> = {};
    const scalar = ['health', 'foodLevel', 'foodSaturation', 'xpLevel', 'xpProgress', 'xpTotal', 'score', 'gameMode', 'selectedSlot', 'air', 'fire', 'dimension'] as const;
    for (const k of scalar) if (draft[k] !== data[k] && draft[k] !== null) patch[k] = draft[k];
    if (JSON.stringify(draft.pos) !== JSON.stringify(data.pos) && draft.pos) patch.pos = draft.pos;
    if (JSON.stringify(draft.abilities) !== JSON.stringify(data.abilities)) patch.abilities = draft.abilities;
    if (JSON.stringify(draft.inventory) !== JSON.stringify(data.inventory)) patch.inventory = draft.inventory;
    if (JSON.stringify(draft.enderItems) !== JSON.stringify(data.enderItems)) patch.enderItems = draft.enderItems;
    const changedAttrs = draft.attributes.filter((a, i) => a.base !== data.attributes[i]?.base);
    if (changedAttrs.length) patch.attributes = changedAttrs;
    if (clearEffects) patch.clearEffects = true;
    if (!Object.keys(patch).length) {
      setBusy(false);
      setNotice('Nothing changed.');
      return;
    }
    try {
      const res = await api.put<{ player: PlayerData }>(`/servers/${serverId}/playerdata/${data.uuid}`, patch);
      setData(res.player);
      setDraft(structuredClone(res.player));
      setClearEffects(false);
      setNotice('Saved. A backup of the previous file was kept as <uuid>.dat.outpost-bak.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save player data');
    } finally {
      setBusy(false);
    }
  }

  async function live(action: string, body?: Record<string, unknown>) {
    if (!data?.name) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api.post(`/servers/${serverId}/players/${encodeURIComponent(data.name)}/${action}`, body);
      setNotice(`Sent ${action} to ${data.name}.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Failed to run ${action}`);
    } finally {
      setBusy(false);
    }
  }

  const title = data ? `Player data — ${data.name ?? data.uuid}` : 'Player data';

  return (
    <Modal open={!!uuid} onClose={onClose} title={title} size="xl">
      {!draft && !error && (
        <div className="flex justify-center py-10">
          <Spinner className="h-6 w-6" />
        </div>
      )}
      <ErrorText>{error}</ErrorText>
      {notice && <p className="mb-3 text-sm text-success-400">{notice}</p>}
      {draft && data && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-xs text-ink-400">
            <span className="font-mono">{data.uuid}</span>
            {data.online && <Badge tone="green" pulse>online</Badge>}
            {data.dataVersion !== null && <Badge>data v{data.dataVersion}</Badge>}
          </div>
          {data.online && (
            <Notice tone="warning">
              {data.name} is online, so their saved file is read-only (the server would overwrite it on logout). Use the live actions, or kick them to edit the file.
            </Notice>
          )}

          <div className="flex flex-wrap gap-1.5">
            {(['stats', 'inventory', 'ender', 'live'] as Tab[]).map((t) => (
              <Button key={t} variant={tab === t ? 'primary' : 'default'} onClick={() => setTab(t)}>
                {{ stats: 'Stats & attributes', inventory: `Inventory (${draft.inventory.length})`, ender: `Ender chest (${draft.enderItems.length})`, live: 'Live actions' }[t]}
              </Button>
            ))}
          </div>

          {tab === 'stats' && (
            <div className="space-y-5">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {numField('health', 'Health', 0.5)}
                {numField('foodLevel', 'Food (0–20)')}
                {numField('foodSaturation', 'Saturation', 0.1)}
                {numField('air', 'Air (max 300)')}
                {numField('xpLevel', 'XP level')}
                {numField('xpProgress', 'XP progress (0–1)', 0.01)}
                {numField('xpTotal', 'Total XP')}
                {numField('score', 'Score')}
                <Field label="Game mode">
                  <Select disabled={readOnly || draft.gameMode === null} value={draft.gameMode ?? 0} onChange={(e) => set('gameMode', Number(e.target.value))}>
                    {GAME_MODES.map((m, i) => (
                      <option key={m} value={i}>
                        {m}
                      </option>
                    ))}
                  </Select>
                </Field>
                {numField('selectedSlot', 'Selected hotbar slot (0–8)')}
                {numField('fire', 'Fire ticks')}
              </div>

              <div>
                <h4 className="mb-2 text-sm font-semibold text-ink-200">Location</h4>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {(['X', 'Y', 'Z'] as const).map((axis, i) => (
                    <Field key={axis} label={axis}>
                      <Input
                        type="number"
                        step={0.5}
                        disabled={readOnly || !draft.pos}
                        value={draft.pos?.[i] ?? ''}
                        onChange={(e) => {
                          const pos = [...(draft.pos ?? [0, 0, 0])] as [number, number, number];
                          pos[i] = Number(e.target.value);
                          set('pos', pos);
                        }}
                      />
                    </Field>
                  ))}
                  <Field label="Dimension">
                    <Input list="outpost-dimensions" disabled={readOnly} value={draft.dimension ?? ''} onChange={(e) => set('dimension', e.target.value)} />
                    <datalist id="outpost-dimensions">
                      {DIMENSIONS.map((d) => (
                        <option key={d} value={d} />
                      ))}
                    </datalist>
                  </Field>
                </div>
              </div>

              <div>
                <h4 className="mb-2 text-sm font-semibold text-ink-200">Abilities</h4>
                <div className="flex flex-wrap gap-4">
                  {ABILITIES.map(({ key, label }) => (
                    <label key={key} className="flex items-center gap-2 text-sm text-ink-200">
                      <input
                        type="checkbox"
                        disabled={readOnly}
                        checked={draft.abilities[key]}
                        onChange={(e) => set('abilities', { ...draft.abilities, [key]: e.target.checked })}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </div>

              {draft.attributes.length > 0 && (
                <div>
                  <h4 className="mb-2 text-sm font-semibold text-ink-200">Attributes (base values)</h4>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {draft.attributes.map((a, i) => (
                      <Field key={a.id} label={a.id.replace(/^minecraft:/, '')}>
                        <Input
                          type="number"
                          step={0.01}
                          disabled={readOnly}
                          value={a.base}
                          onChange={(e) => {
                            const attributes = draft.attributes.map((x, j) => (j === i ? { ...x, base: Number(e.target.value) } : x));
                            set('attributes', attributes);
                          }}
                        />
                      </Field>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <h4 className="mb-2 text-sm font-semibold text-ink-200">Active effects ({data.effects.length})</h4>
                {data.effects.length === 0 ? (
                  <p className="text-sm text-ink-500">None.</p>
                ) : (
                  <>
                    <ul className="mb-2 space-y-1 text-sm text-ink-300">
                      {data.effects.map((e) => (
                        <li key={e.id}>
                          {e.id.replace(/^minecraft:/, '')} {e.amplifier + 1} — {e.duration < 0 ? '∞' : `${Math.round(e.duration / 20)}s`}
                        </li>
                      ))}
                    </ul>
                    <label className="flex items-center gap-2 text-sm text-ink-200">
                      <input type="checkbox" disabled={readOnly} checked={clearEffects} onChange={(e) => setClearEffects(e.target.checked)} />
                      Clear all effects on save
                    </label>
                  </>
                )}
              </div>
            </div>
          )}

          {tab === 'inventory' && <ItemTable items={draft.inventory} ender={false} readOnly={readOnly} onChange={(v) => set('inventory', v)} />}
          {tab === 'ender' && <ItemTable items={draft.enderItems} ender readOnly={readOnly} onChange={(v) => set('enderItems', v)} />}
          {tab === 'live' && <LiveActions online={data.online} running={running} canWrite={canWrite} busy={busy} onAction={live} />}

          {tab !== 'live' && canWrite && (
            <div className="flex justify-end gap-2 border-t border-surface-700 pt-4">
              <Button variant="ghost" disabled={busy} onClick={() => { setDraft(structuredClone(data)); setClearEffects(false); }}>
                Reset
              </Button>
              <Button variant="primary" disabled={busy || readOnly} onClick={save}>
                {busy ? 'Saving…' : 'Save to player file'}
              </Button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function ItemTable({ items, ender, readOnly, onChange }: { items: PlayerItem[]; ender: boolean; readOnly: boolean; onChange: (items: PlayerItem[]) => void }) {
  const update = (i: number, patch: Partial<PlayerItem>) => onChange(items.map((it, j) => (j === i ? { ...it, ...patch } : it)));

  function addItem() {
    const used = new Set(items.map((i) => i.slot));
    const max = ender ? 26 : 35;
    let slot = 0;
    while (used.has(slot) && slot <= max) slot++;
    if (slot > max) return;
    onChange([...items, { slot, id: 'minecraft:stone', count: 1 }]);
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-ink-400">
        Changing an item's id drops its enchantments/components; keeping the same id in the same slot preserves them.
        {!ender && ' Slots: 0–8 hotbar, 9–35 main, 100–103 armor, -106 offhand (pre-1.21.5).'}
      </p>
      {items.length === 0 && <p className="text-sm text-ink-500">Empty.</p>}
      {items.map((it, i) => (
        <div key={i} className="grid grid-cols-[6rem_1fr_6rem_auto] items-end gap-2">
          <Field label={slotLabel(it.slot, ender)}>
            <Input type="number" disabled={readOnly} value={it.slot} onChange={(e) => update(i, { slot: Number(e.target.value) })} />
          </Field>
          <Field label={it.hasExtra ? 'Item id (has extra data)' : 'Item id'}>
            <Input disabled={readOnly} value={it.id} onChange={(e) => update(i, { id: e.target.value, hasExtra: false })} />
          </Field>
          <Field label="Count">
            <Input type="number" min={1} max={99} disabled={readOnly} value={it.count} onChange={(e) => update(i, { count: Number(e.target.value) })} />
          </Field>
          <Button variant="danger" disabled={readOnly} onClick={() => onChange(items.filter((_, j) => j !== i))}>
            Remove
          </Button>
        </div>
      ))}
      {!readOnly && (
        <div className="flex gap-2 pt-1">
          <Button onClick={addItem}>Add item</Button>
          {items.length > 0 && (
            <Button variant="danger" onClick={() => onChange([])}>
              Clear all
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function LiveActions({
  online,
  running,
  canWrite,
  busy,
  onAction,
}: {
  online: boolean;
  running: boolean;
  canWrite: boolean;
  busy: boolean;
  onAction: (action: string, body?: Record<string, unknown>) => void;
}) {
  const [levels, setLevels] = useState('30');
  const [item, setItem] = useState('minecraft:diamond');
  const [count, setCount] = useState('1');
  const disabled = !canWrite || !running || !online || busy;

  return (
    <div className="space-y-5">
      {(!running || !online) && <Notice>Live actions run through the server console and need the server running with the player online.</Notice>}
      <div>
        <h4 className="mb-2 text-sm font-semibold text-ink-200">Game mode</h4>
        <div className="flex flex-wrap gap-1.5">
          {GAME_MODES.map((m) => (
            <Button key={m} disabled={disabled} onClick={() => onAction('gamemode', { mode: m.toLowerCase() })}>
              {m}
            </Button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="XP levels">
          <Input type="number" value={levels} onChange={(e) => setLevels(e.target.value)} />
        </Field>
        <Button disabled={disabled} onClick={() => onAction('xp-set-levels', { amount: Math.max(0, Math.trunc(Number(levels))) })}>
          Set levels
        </Button>
        <Button disabled={disabled} onClick={() => onAction('xp-add-levels', { amount: Math.trunc(Number(levels)) })}>
          Add levels
        </Button>
        <Button disabled={disabled} onClick={() => onAction('xp-add-points', { amount: Math.trunc(Number(levels)) })}>
          Add points
        </Button>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Item">
          <Input value={item} onChange={(e) => setItem(e.target.value)} />
        </Field>
        <Field label="Count">
          <Input type="number" min={1} value={count} onChange={(e) => setCount(e.target.value)} />
        </Field>
        <Button disabled={disabled} onClick={() => onAction('give', { item: item.trim().toLowerCase(), count: Math.trunc(Number(count)) })}>
          Give
        </Button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button disabled={disabled} onClick={() => onAction('heal')}>Heal</Button>
        <Button disabled={disabled} onClick={() => onAction('feed')}>Feed</Button>
        <Button disabled={disabled} onClick={() => onAction('clear-effects')}>Clear effects</Button>
        <Button variant="danger" disabled={disabled} onClick={() => confirm("Clear this player's entire inventory?") && onAction('clear-inventory')}>Clear inventory</Button>
        <Button variant="danger" disabled={disabled} onClick={() => confirm('Kill this player?') && onAction('kill')}>Kill</Button>
      </div>
    </div>
  );
}
