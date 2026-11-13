import { HttpError } from '../utils/asyncHandler.js';
import type { GameProfile } from './gameControlProfiles.js';

const escapeRE = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const xmlEscape = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&apos;');
const xmlDecode = (v: string) => v.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const unquote = (v: string) => v.trim().replace(/^"([\s\S]*)"$/, '$1').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
export const quoteCfg = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Split Unreal tuple fields while retaining nested arrays and quoted commas. */
export function splitTuple(text: string): string[] {
  const result: string[] = []; let depth = 0, quoted = false, start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && quoted) { i++; continue; }
    if (c === '"') quoted = !quoted;
    if (!quoted) {
      if (c === '(') depth++; else if (c === ')') depth--;
      if (c === ',' && depth === 0) { result.push(text.slice(start, i)); start = i + 1; }
    }
  }
  if (quoted || depth !== 0) throw new HttpError(409, 'The existing OptionSettings tuple is malformed; fix it in the native configuration editor');
  result.push(text.slice(start)); return result.filter((v) => v.trim());
}

export function readNative(text: string, profile: GameProfile): Record<string, string> {
  const out: Record<string, string> = {};
  if (profile.format === 'palworld') {
    const tuple = text.match(/^\s*OptionSettings\s*=\s*\((.*)\)\s*$/m)?.[1];
    if (tuple !== undefined) for (const part of splitTuple(tuple)) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = unquote(part.slice(i + 1)); }
    return out;
  }
  if (profile.format === 'xml') {
    for (const tag of text.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<property\b[^>]*\/?\s*>/gi)) {
      const name = tag[0].match(/\bname\s*=\s*(["'])(.*?)\1/i)?.[2];
      const value = tag[0].match(/\bvalue\s*=\s*(["'])(.*?)\1/i)?.[2];
      if (name && value !== undefined) out[name] = xmlDecode(value);
    }
    return out;
  }
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line || /^(#|;|\/\/)/.test(line)) continue;
    if (line.startsWith('[')) { section = line.slice(1, line.indexOf(']')); continue; }
    if (profile.format === 'ini' && section !== profile.section) continue;
    let match: RegExpMatchArray | null;
    if (['kv', 'ini'].includes(profile.format)) match = line.match(/^([^=]+)=(.*)$/);
    else if (profile.format === 'arma') match = line.match(/^([A-Za-z_]\w*)\s*=\s*(.*?)\s*;\s*(?:\/\/.*)?$/);
    else if (profile.format === 'commands') match = line.match(/^(\w+)(?:\s+(.*))?$/);
    else match = line.match(/^(?:(?:seta?|sets)\s+)?([A-Za-z_]\w*(?:\.\w+)*)\s+("(?:\\.|[^"\\])*"|[^;\r\n]*?)(?:\s*\/\/.*)?$/);
    if (match) out[match[1].trim()] = unquote(match[2] ?? '');
  }
  if (profile.format === 'commands') out.PVP = Object.hasOwn(out, 'PVE') ? 'PVE' : 'PVP';
  return out;
}

export function patchNative(text: string, profile: GameProfile, updates: Record<string, string>): string {
  if (profile.format === 'launch' || profile.format === 'satisfactory') return text;
  if (profile.format === 'palworld') {
    const m = text.match(/^\s*OptionSettings\s*=\s*\((.*)\)\s*$/m);
    const parts = m ? splitTuple(m[1]) : [];
    const remaining = { ...updates };
    const fields = parts.map((part) => {
      const key = part.slice(0, part.indexOf('=')).trim();
      if (!Object.hasOwn(remaining, key)) return part.trim();
      const rendered = `${key}=${remaining[key]}`; delete remaining[key]; return rendered;
    });
    fields.push(...Object.entries(remaining).map(([k, v]) => `${k}=${v}`));
    const line = `OptionSettings=(${fields.join(',')})`;
    return m ? text.replace(m[0], () => line) : `${text.trimEnd()}\n${text.includes('[/Script/Pal.PalGameWorldSettings]') ? '' : '[/Script/Pal.PalGameWorldSettings]\n'}${line}\n`;
  }
  if (profile.format === 'xml') {
    if (!/<ServerSettings\b/i.test(text) || !/<\/ServerSettings\s*>/i.test(text)) throw new HttpError(409, 'Install the server first, or repair serverconfig.xml: a ServerSettings root is required');
    const remaining = { ...updates };
    const result = text.replace(/<!--[\s\S]*?-->|<property\b[^>]*\/?\s*>/gi, (tag) => {
      if (tag.startsWith('<!--')) return tag;
      const name = tag.match(/\bname\s*=\s*(["'])(.*?)\1/i)?.[2];
      if (!name || !Object.hasOwn(updates, name)) return tag;
      delete remaining[name];
      return tag.replace(/\bvalue\s*=\s*(["'])(.*?)\1/i, () => `value="${xmlEscape(updates[name])}"`);
    });
    const additions = Object.entries(remaining).map(([k, v]) => `  <property name="${k}" value="${xmlEscape(v)}" />`).join('\n');
    return result.replace(/<\/ServerSettings\s*>/i, () => `${additions ? additions + '\n' : ''}</ServerSettings>`);
  }
  const render = (key: string, value: string) => {
    if (profile.format === 'commands') return key === 'PVP' ? value : `${key} ${value}`;
    if (['kv', 'ini'].includes(profile.format)) return `${key}=${value}`;
    if (profile.format === 'arma') return `${key} = ${/^(true|false|\d+(?:\.\d+)?)$/i.test(value) ? value : quoteCfg(value)};`;
    return `${['quake', 'bo3'].includes(profile.format) ? 'set ' : ''}${key} ${quoteCfg(value)}`;
  };
  let section = '', foundSection = false;
  const seen = new Set<string>(); const output: string[] = [];
  const appendMissing = () => { for (const [k, v] of Object.entries(updates)) if (!seen.has(k)) { output.push(render(k, v)); seen.add(k); } };
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(raw)) {
      if (profile.format === 'ini' && section === profile.section) appendMissing();
      section = raw.match(/^\s*\[([^\]]+)\]/)?.[1] ?? '';
      if (section === profile.section) foundSection = true;
    }
    const key = Object.keys(updates).find((k) => {
      if (profile.format === 'ini' && section !== profile.section) return false;
      const escaped = escapeRE(k);
      return new RegExp(profile.format === 'commands' && k === 'PVP' ? '^\\s*(?:PVP|PVE)\\s*$' : `^\\s*${['quake', 'bo3'].includes(profile.format) ? '(?:(?:seta?|sets)\\s+)?' : ''}${escaped}${['kv', 'ini', 'arma'].includes(profile.format) ? '\\s*=' : '\\s'}`, 'i').test(raw);
    });
    if (key) { output.push(render(key, updates[key])); seen.add(key); } else output.push(raw);
  }
  if (profile.format === 'ini' && !foundSection) output.push(`[${profile.section}]`);
  appendMissing();
  return output.join('\n').trimEnd() + '\n';
}

/** Replace only the mission list, balancing braces rather than matching nested classes with regex. */
export function patchArmaMissions(text: string, missions: string[], difficulty: string, preserveParams = false): string {
  const match = /\bclass\s+Missions\s*\{/i.exec(text);
  const block = `class Missions {\n${missions.map((m, i) => `  class Outpost${i + 1} { template = ${quoteCfg(m)}; difficulty = ${quoteCfg(difficulty)}; };`).join('\n')}\n};`;
  if (!match) return text.trimEnd() + '\n' + block + '\n';
  let depth = 1, quoted = false, i = match.index + match[0].length;
  for (; i < text.length && depth; i++) {
    if (text[i] === '"') { if (quoted && text[i + 1] === '"') i++; else quoted = !quoted; }
    if (!quoted) {
      if (text.slice(i, i + 2) === '//') { const end = text.indexOf('\n', i); i = end < 0 ? text.length : end; continue; }
      if (text.slice(i, i + 2) === '/*') { const end = text.indexOf('*/', i + 2); if (end < 0) throw new HttpError(409, 'Unterminated mission comment'); i = end + 1; continue; }
      if (text[i] === '{') depth++; else if (text[i] === '}') depth--;
    }
  }
  if (depth) throw new HttpError(409, 'The existing Missions class is malformed');
  if (text[i] === ';') i++;
  if (preserveParams) {
    const original = text.slice(match.index, i).replace(/\bdifficulty\s*=\s*"[^"\r\n]*"\s*;/g, '');
    const updated = original.replace(/\btemplate\s*=\s*"[^"\r\n]*"\s*;/g, (entry) => `${entry} difficulty = ${quoteCfg(difficulty)};`);
    return text.slice(0, match.index) + updated + text.slice(i);
  }
  return text.slice(0, match.index) + block + text.slice(i);
}
