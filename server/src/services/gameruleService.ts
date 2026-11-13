import { prep } from '../db/db.js';
import { HttpError } from '../utils/asyncHandler.js';
import { isMinecraftPlatform, isProxyLoader, type ServerRecord } from '../types/index.js';

export const RULES = [
  { id: 'keepInventory', modern: 'keep_inventory', label: 'Keep inventory on death', default: false },
  { id: 'mobGriefing', modern: 'mob_griefing', label: 'Allow mobs to change blocks', default: true },
  { id: 'doDaylightCycle', modern: 'advance_time', label: 'Day and night cycle', default: true },
  { id: 'doWeatherCycle', modern: 'advance_weather', label: 'Weather cycle', default: true },
  { id: 'doMobSpawning', modern: 'spawn_mobs', label: 'Natural mob spawning', default: true },
  { id: 'naturalRegeneration', modern: 'natural_health_regeneration', label: 'Natural health regeneration', default: true },
  { id: 'doFireTick', modern: 'fire_spread_radius_around_player', label: 'Fire spreads', default: true },
] as const;
type RuleId = typeof RULES[number]['id'];
export interface GameruleSettings {
  preset: string | null;
  autoApply: boolean;
  naming: 'auto' | 'legacy' | 'modern';
  rules: Partial<Record<RuleId, boolean>>;
}
const defaults = Object.fromEntries(RULES.map((r) => [r.id, r.default])) as Record<RuleId, boolean>;
export const GAMERULE_PRESETS = [
  { id: 'survival', label: 'Survival', description: 'Standard survival rules, including item drops on death.', rules: defaults },
  { id: 'friendly', label: 'Friendly survival', description: 'Keep inventory, protect builds from mobs, and prevent fire spread.', rules: { ...defaults, keepInventory: true, mobGriefing: false, doFireTick: false } },
  { id: 'building', label: 'Building', description: 'Keep inventory, freeze daylight and weather, and disable natural mob spawning and fire spread.', rules: { ...defaults, keepInventory: true, mobGriefing: false, doFireTick: false, doDaylightCycle: false, doWeatherCycle: false, doMobSpawning: false } },
  { id: 'challenge', label: 'Survival challenge', description: 'Survival with natural health regeneration disabled.', rules: { ...defaults, naturalRegeneration: false } },
];

export function supportsGamerules(server: ServerRecord) {
  return isMinecraftPlatform(server.platform) && !isProxyLoader(server.loader);
}
export function gamerulesOf(server: ServerRecord): GameruleSettings {
  let stored: Partial<GameruleSettings> = {};
  try { stored = JSON.parse(server.game_settings ?? '{}').gamerules ?? {}; } catch { /* defaults */ }
  return { preset: null, autoApply: false, naming: 'auto', rules: {}, ...stored };
}
export function sanitizeGamerules(input: Record<string, unknown>, previous: GameruleSettings): GameruleSettings {
  const next = { ...previous, rules: { ...previous.rules } };
  if (input.preset !== undefined) {
    if (input.preset === null) next.preset = null;
    else {
      const preset = GAMERULE_PRESETS.find((p) => p.id === input.preset);
      if (!preset) throw new HttpError(400, 'Unknown gamerule preset');
      next.preset = preset.id;
      next.rules = { ...preset.rules };
    }
  }
  if (input.autoApply !== undefined) {
    if (typeof input.autoApply !== 'boolean') throw new HttpError(400, 'Auto apply must be true or false');
    next.autoApply = input.autoApply;
  }
  if (input.naming !== undefined) {
    if (!['auto', 'legacy', 'modern'].includes(String(input.naming))) throw new HttpError(400, 'Unknown gamerule naming format');
    next.naming = input.naming as GameruleSettings['naming'];
  }
  if (input.rules !== undefined) {
    if (!input.rules || typeof input.rules !== 'object' || Array.isArray(input.rules)) throw new HttpError(400, 'Rules must be an object');
    const rules: GameruleSettings['rules'] = {};
    for (const [key, value] of Object.entries(input.rules)) {
      if (!RULES.some((r) => r.id === key) || typeof value !== 'boolean') throw new HttpError(400, `Invalid gamerule: ${key}`);
      rules[key as RuleId] = value;
    }
    next.rules = rules;
    if (input.preset === undefined) next.preset = null;
  }
  return next;
}
export function saveGamerules(server: ServerRecord, input: Record<string, unknown>) {
  const next = sanitizeGamerules(input, gamerulesOf(server));
  const row = prep('SELECT game_settings FROM servers WHERE id = ?').get(server.id) as { game_settings: string | null };
  const raw = JSON.parse(row.game_settings ?? '{}');
  prep('UPDATE servers SET game_settings = ? WHERE id = ?').run(JSON.stringify({ ...raw, gamerules: next }), server.id);
  return next;
}
export function usesModernGamerules(server: ServerRecord, settings = gamerulesOf(server)) {
  if (server.platform !== 'java') return false;
  if (settings.naming !== 'auto') return settings.naming === 'modern';
  const version = server.version;
  const snapshot = version.match(/^(\d{2})w(\d{2})[a-z]$/i);
  if (snapshot) return Number(snapshot[1]) > 25 || (Number(snapshot[1]) === 25 && Number(snapshot[2]) >= 44);
  const v = version.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!v) return false;
  const [, major, minor, patch] = v.map(Number);
  return major >= 26 || major > 1 || (major === 1 && (minor > 21 || (minor === 21 && patch >= 11)));
}
export function gameruleCommands(server: ServerRecord, settings = gamerulesOf(server)): string[] {
  if (!supportsGamerules(server)) return [];
  const modern = usesModernGamerules(server, settings);
  return RULES.filter((r) => settings.rules[r.id] !== undefined).map((r) => {
    const value = settings.rules[r.id]!;
    const name = server.platform === 'bedrock' ? r.id.toLowerCase() : modern ? r.modern : r.id;
    // Java 1.21.11 replaced doFireTick with a radius; 128 is the normal enabled radius.
    const rendered = modern && r.id === 'doFireTick' ? (value ? '128' : '0') : String(value);
    return `gamerule ${name} ${rendered}`;
  });
}
