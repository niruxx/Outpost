import { HttpError } from '../utils/asyncHandler.js';
import { getServer } from './serverService.js';
import { gamerulesOf, sanitizeGamerules, supportsGamerules } from './gameruleService.js';
import { tf2SettingsOf, sanitizeTf2, isTf2 } from './tf2Service.js';
import { cs2SettingsOf, saveCs2Settings, applyPreset, isCs2 } from './cs2Service.js';
import { saveGameControls } from './gameControlsService.js';

export function changesBetween(before: unknown, after: unknown, prefix = ''): { key: string; before: unknown; after: unknown }[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
    const a = before as Record<string, unknown>, b = after as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap(k => changesBetween(a[k], b[k], prefix ? `${prefix}.${k}` : k));
  }
  const secret = /password|secret|token|gslt|login/i.test(prefix);
  return [{ key: prefix, before: secret ? (before ? '[hidden]' : '[empty]') : before ?? null, after: secret ? (after ? '[changed]' : '[empty]') : after ?? null }];
}
export function previewGameChange(serverId: string, kind: string, input: Record<string, unknown>) {
  const server = getServer(serverId); if (!server) throw new HttpError(404, 'Instance not found');
  let before: unknown, after: unknown;
  if (kind === 'gamerules' && supportsGamerules(server)) { before = gamerulesOf(server); after = sanitizeGamerules(input, gamerulesOf(server)); }
  else if (kind === 'tf2' && isTf2(server)) { before = tf2SettingsOf(server); after = sanitizeTf2({ ...input, ...(input.password === '' && !input.clearPassword ? { password: undefined } : {}), ...(input.gslt === '' && !input.clearGslt ? { gslt: undefined } : {}) }, tf2SettingsOf(server)); }
  else if (['cs2', 'cs2-preset'].includes(kind) && isCs2(server)) { before = cs2SettingsOf(server); const body = { ...input }; if (body.password === '••••••') delete body.password; if (body.gslt === '••••••') delete body.gslt; after = kind === 'cs2' ? saveCs2Settings(server, body, true) : applyPreset(server, String(input.preset), true).settings; }
  else if (kind === 'game-controls') { const result = saveGameControls(server, input, true)!; before = result.before; after = result.after; }
  else throw new HttpError(400, 'Unsupported configuration preview');
  return { changes: changesBetween(before, after), note: kind === 'gamerules' ? 'Saved rules apply automatically when ready if enabled. Apply now sends commands to the running server.' : 'Startup settings apply on the next start. Use explicit live controls to apply supported changes now.' };
}
