export const CORE_KEEPER_SKILLS = [
  'Mining', 'Running', 'Melee', 'Vitality', 'Crafting', 'Ranged',
  'Gardening', 'Fishing', 'Cooking', 'Magic', 'Summoning', 'Explosives',
];

type Item = { objectID: number; amount: number } & Record<string, unknown>;
type Skill = { skillID: number; value: number };
type Talents = { skillTreeID: number; points: number[] };
export type CharacterSave = {
  characterGuid: string;
  inventory: Item[];
  coinAmount?: number;
  maxHealth?: number;
  skills: Skill[];
  skillTalentTreeDatas: Talents[];
} & Record<string, unknown>;

const MAX_INT = 2147483647;
const integer = (value: unknown, min = 0, max = MAX_INT): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

export function parseCoreKeeperCharacter(text: string): CharacterSave {
  const source = text.replace(/^\uFEFF/, '');
  // Parse only JSON saves. Hex or encrypted files cannot be edited using this format.
  let data: CharacterSave;
  try { data = JSON.parse(source); }
  catch { throw new Error('Open an unencrypted Core Keeper character JSON save.'); }
  if (!data || typeof data.characterGuid !== 'string' || !data.characterGuid ||
    !Array.isArray(data.inventory) || !data.inventory.length ||
    !data.inventory.every((item) => item && integer(item.objectID) && integer(item.amount)) ||
    !Array.isArray(data.skills) || !data.skills.every((skill) => skill && integer(skill.skillID) && integer(skill.value)) ||
    new Set(data.skills.map((skill) => skill.skillID)).size !== data.skills.length ||
    !Array.isArray(data.skillTalentTreeDatas) ||
    !data.skillTalentTreeDatas.every((tree) => tree && integer(tree.skillTreeID) && Array.isArray(tree.points) && tree.points.length <= 64 && tree.points.every((point) => integer(point))) ||
    new Set(data.skillTalentTreeDatas.map((tree) => tree.skillTreeID)).size !== data.skillTalentTreeDatas.length) {
    throw new Error('This file does not match the supported Core Keeper character save format.');
  }
  // JavaScript cannot round-trip 64-bit integers in older browsers. Refuse to rewrite such
  // saves instead of silently changing unrelated character data.
  const pending: unknown[] = [data];
  let seen = 0;
  while (pending.length) {
    const node = pending.pop();
    if (++seen > 200_000) throw new Error('This character save contains too many fields.');
    if (typeof node === 'number' && (!Number.isFinite(node) || Number.isInteger(node) && !Number.isSafeInteger(node))) {
      throw new Error('This save contains numbers that cannot be preserved exactly.');
    }
    if (node && typeof node === 'object') for (const value of Object.values(node)) pending.push(value);
  }
  return data;
}

export function characterNumber(input: string, min = 0, max = MAX_INT) {
  const number = Number(input);
  if (!/^\d+$/.test(input) || !integer(number, min, max)) throw new Error(`Enter a whole number between ${min} and ${max}.`);
  return number;
}

export function setCharacterItem(save: CharacterSave, slot: number, objectID: number, amount: number): CharacterSave {
  const item = save.inventory[slot];
  if (!integer(slot, 0, save.inventory.length - 1) || !item || !integer(objectID) || !integer(amount, objectID ? 1 : 0)) {
    throw new Error('Choose a valid slot, item ID, and quantity.');
  }
  const inventory = [...save.inventory];
  inventory[slot] = objectID && item.objectID === objectID
    ? { ...item, amount }
    : { objectID, amount: objectID ? amount : 0, variation: 0, variationUpdateCount: 0 };
  return { ...save, inventory };
}

export function setCharacterSkill(save: CharacterSave, skillID: number, value: number, points: number[]): CharacterSave {
  const skill = save.skills.find((row) => row.skillID === skillID);
  const tree = save.skillTalentTreeDatas.find((row) => row.skillTreeID === skillID);
  if (!integer(skillID, 0, CORE_KEEPER_SKILLS.length - 1) || !integer(value) ||
    points.length < 1 || points.length > 64 || points.some((point) => !integer(point, 0, 5)) ||
    points.reduce((sum, point) => sum + point, 0) > 25 || (value === 0 && points.some(Boolean))) {
    throw new Error('Use 0–5 points per talent and up to 25 per skill. A skill with zero XP cannot have allocated points.');
  }
  const skills = skill ? save.skills.map((row) => row === skill ? { ...row, value } : row) : [...save.skills, { skillID, value }];
  const skillTalentTreeDatas = tree
    ? save.skillTalentTreeDatas.map((row) => row === tree ? { ...row, points } : row)
    : [...save.skillTalentTreeDatas, { skillTreeID: skillID, points }];
  return { ...save, skills, skillTalentTreeDatas };
}
