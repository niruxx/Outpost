import { useRef, useState, type FormEvent } from 'react';
import { Button, Card, CardTitle, ErrorText, Field, Input, Select } from '../../components/ui.js';
import { useToast } from '../../components/Toast.js';
import {
  type CharacterSave, characterNumber, CORE_KEEPER_SKILLS, parseCoreKeeperCharacter, setCharacterItem, setCharacterSkill,
} from '../../lib/coreKeeperCharacter.js';

export function CoreKeeperCharacterCard() {
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [save, setSave] = useState<CharacterSave | null>(null);
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState('');
  const [slot, setSlot] = useState(0);
  const [skillID, setSkillID] = useState(0);
  const [entityKey, setEntityKey] = useState(0);

  async function open(file: File) {
    setError('');
    try {
      if (!/^\d+\.json$/i.test(file.name) || file.size > 8 * 1024 * 1024) throw new Error('Choose a numbered .json file from the Core Keeper saves folder, up to 8 MB.');
      setSave(parseCoreKeeperCharacter(await file.text()));
      setFileName(file.name);
      setSlot(0);
      setSkillID(0);
      setEntityKey((value) => value + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the character save.');
    }
  }

  function update(event: FormEvent<HTMLFormElement>, change: (form: FormData, current: CharacterSave) => CharacterSave) {
    event.preventDefault();
    if (!save) return;
    setError('');
    try {
      setSave(change(new FormData(event.currentTarget), save));
      toast.success('Character edits applied to this copy');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the character.');
    }
  }

  function download() {
    if (!save) return;
    try {
      const content = JSON.stringify(save);
      const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = fileName;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch {
      setError('Could not serialize this character save.');
    }
  }

  const item = save?.inventory[slot];
  const skill = save?.skills.find((row) => row.skillID === skillID);
  const points = save?.skillTalentTreeDatas.find((row) => row.skillTreeID === skillID)?.points;
  const talents = Array.from({ length: Math.max(7, points?.length ?? 0) }, (_, index) => points?.[index] ?? 0);
  const stats = [
    { key: 'coinAmount', label: 'Ancient coins', min: 0 },
    { key: 'maxHealth', label: 'Saved maximum health', min: 0 },
  ] as const;
  const shownStats = stats.filter(({ key }) => typeof save?.[key] === 'number');

  return (
    <Card className="min-w-0 space-y-4 p-4 sm:p-5">
      <CardTitle>Character save editor</CardTitle>
      <p className="text-sm text-ink-400">Open a player’s PC character save from their <code>saves</code> folder. The file stays in this browser. Download an edited copy and keep the original before replacing the local save with the game closed.</p>
      <div className="flex flex-wrap items-center gap-2">
        <input type="file" accept=".json" ref={fileInput} className="hidden" aria-label="Character JSON file" onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void open(file);
        }} />
        <Button onClick={() => fileInput.current?.click()}>Open character save</Button>
        {save && <Button variant="primary" onClick={download}>Download edited save</Button>}
        {fileName && <span className="break-all text-xs text-ink-400">{fileName}</span>}
      </div>
      <ErrorText>{error}</ErrorText>
      {save && item && (
        <div className="space-y-4">
          {!!shownStats.length && (
            <form key={`stats-${entityKey}-${shownStats.map(({ key }) => save[key]).join('-')}`} className="space-y-3 border-t border-surface-700 pt-4" onSubmit={(event) => update(event, (form, current) => {
              const changes = shownStats.map(({ key, min }) => [key, characterNumber(String(form.get(key)), min)]);
              return { ...current, ...Object.fromEntries(changes) };
            })}>
              <h3 className="text-sm font-medium text-ink-100">Character stats</h3>
              <div className="grid gap-2 sm:grid-cols-2">
                {shownStats.map(({ key, label, min }) => <Field key={key} label={label}><Input name={key} type="number" min={min} defaultValue={save[key]} required /></Field>)}
              </div>
              <Button type="submit">Apply stats</Button>
            </form>
          )}
          <div className="space-y-3 border-t border-surface-700 pt-4">
            <h3 className="text-sm font-medium text-ink-100">Inventory</h3>
            <Field label="Inventory slot">
              <Select value={slot} onChange={(event) => setSlot(Number(event.target.value))}>
                {save.inventory.map(({ objectID, amount }, index) => (
                  <option value={index} key={index}>Slot {index + 1} · {objectID ? `Item ${objectID} × ${amount}` : 'Empty'}</option>
                ))}
              </Select>
            </Field>
            <form key={`item-${slot}-${entityKey}-${item.objectID}-${item.amount}`} className="space-y-3" onSubmit={(event) => update(event, (form, current) =>
              setCharacterItem(current, slot, characterNumber(String(form.get('item')), 1), characterNumber(String(form.get('amount')), 1))
            )}>
              <div className="grid gap-2 sm:grid-cols-2">
                <Field label="Item object ID"><Input name="item" type="number" min={1} defaultValue={item.objectID || undefined} required /></Field>
                <Field label="Quantity"><Input name="amount" type="number" min={1} defaultValue={item.amount || 1} required /></Field>
              </div>
              <p className="text-xs text-ink-400">Use an item object ID and a stack size supported by the game version. Setting an item in an occupied slot replaces it.</p>
              <div className="flex flex-wrap gap-2">
                <Button type="submit">{item.objectID ? 'Apply item change' : 'Add item'}</Button>
                {!!item.objectID && <Button type="button" onClick={() => {
                  setSave(setCharacterItem(save, slot, 0, 0));
                  setError('');
                }}>Clear slot</Button>}
              </div>
            </form>
          </div>
          <div className="space-y-3 border-t border-surface-700 pt-4">
            <h3 className="text-sm font-medium text-ink-100">Skills and talents</h3>
            <Field label="Skill">
              <Select value={skillID} onChange={(event) => setSkillID(Number(event.target.value))}>
                {CORE_KEEPER_SKILLS.map((name, id) => <option key={id} value={id}>{name}</option>)}
              </Select>
            </Field>
            <form key={`skill-${skillID}-${entityKey}-${skill?.value}-${talents.join('-')}`} className="space-y-3" onSubmit={(event) => update(event, (form, current) =>
              setCharacterSkill(current, skillID, characterNumber(String(form.get('xp'))), talents.map((_, index) => characterNumber(String(form.get(`talent-${index}`)), 0, 5)))
            )}>
              <Field label="Skill XP"><Input name="xp" type="number" min={0} defaultValue={skill?.value ?? 0} required /></Field>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {talents.map((point, index) => <Field key={index} label={`Talent ${index + 1}`}><Input type="number" name={`talent-${index}`} min={0} max={5} defaultValue={point} required /></Field>)}
              </div>
              <p className="text-xs text-ink-400">Use the talent order in the save. The game applies its own XP, point budget, and prerequisite rules.</p>
              <div className="flex flex-wrap gap-2">
                <Button type="submit">Apply skill and talents</Button>
                <Button type="button" disabled={!talents.some(Boolean)} onClick={() => {
                  setSave(setCharacterSkill(save, skillID, skill?.value ?? 0, talents.map(() => 0)));
                  setError('');
                }}>Reset talent points</Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </Card>
  );
}
