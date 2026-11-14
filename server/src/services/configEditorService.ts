import path from 'node:path';
import { parseDocument } from 'yaml';
import TOML from '@iarna/toml';
import { XMLValidator } from 'fast-xml-parser';
import { profileFor } from './gameControlProfiles.js';

export function analyzeConfig(name: string, content: string, format = false, server?: Parameters<typeof profileFor>[0]) {
  const extension = path.extname(name).toLowerCase();
  const diagnostics: { line: number; message: string; severity: string }[] = [];
  let formatted = content;
  let supported = true;
  const selected = server && profileFor(server);
  const profile = selected?.file === name.replace(/\\/g, '/') ? selected : undefined;
  const hints = profile?.fields.filter(f => !f.launch).map(f => ({ key: f.key, type: f.type, min: f.min, max: f.max, options: f.options, help: f.help ?? f.label })) ?? [];
  if (path.basename(name) === 'server.properties') hints.push(
    { key: 'server-port', type: 'number', min: 1, max: 65535, options: undefined, help: 'Game port' },
    { key: 'max-players', type: 'number', min: 1, max: undefined, options: undefined, help: 'Maximum player count' },
    { key: 'gamemode', type: 'select', min: undefined, max: undefined, options: ['survival', 'creative', 'adventure', 'spectator'], help: 'Java supports spectator; Bedrock support depends on version.' },
    { key: 'difficulty', type: 'select', min: undefined, max: undefined, options: ['peaceful', 'easy', 'normal', 'hard'], help: 'World difficulty; Java also accepts 0–3.' });
  try {
    if (['.json', '.mcmeta'].includes(extension)) formatted = JSON.stringify(JSON.parse(content), null, 2) + '\n';
    else if (['.yml', '.yaml'].includes(extension)) {
      const doc = parseDocument(content); if (doc.errors.length) throw doc.errors[0];
      doc.toJS({ maxAliasCount: 100 }); formatted = doc.toString();
    } else if (extension === '.toml') formatted = TOML.stringify(TOML.parse(content));
    else if (extension === '.xml') {
      const result = XMLValidator.validate(content);
      if (result !== true) diagnostics.push({ line: result.err.line, message: result.err.msg, severity: 'error' });
    } else if (['.properties', '.ini'].includes(extension)) {
      const seen = new Set<string>();
      content.split('\n').forEach((line, i) => {
        if (!line.trim() || /^\s*[#!;]/.test(line) || /^\s*\[.*\]\s*$/.test(line)) return;
        const match = line.match(/^\s*([^=:\s]+)\s*[=:]\s*(.*)$/);
        if (!match) { diagnostics.push({ line: i + 1, message: 'Expected key=value (continued properties are not checked).', severity: 'warning' }); return; }
        const [, key, value] = match;
        if (seen.has(key)) diagnostics.push({ line: i + 1, message: `Duplicate key: ${key}`, severity: 'warning' });
        seen.add(key);
        if (/^(server-port|server-portv6|query.port|rcon.port)$/.test(key) && (!/^\d+$/.test(value.trim()) || +value < 1 || +value > 65535)) diagnostics.push({ line: i + 1, message: `${key} must be between 1 and 65535.`, severity: 'error' });
      });
    } else supported = false;
  } catch (error) {
    const e = error as Error & { line?: number; linePos?: { line: number }[] };
    diagnostics.push({ line: e.linePos?.[0]?.line ?? e.line ?? Number(e.message.match(/line (\d+)/)?.[1] ?? 1), message: e.message, severity: 'error' });
  }
  return { diagnostics, supported, hints, formatted: format && !diagnostics.some(d => d.severity === 'error') ? formatted : undefined,
    hint: `${supported ? 'Syntax validation enabled.' : 'Plain-text mode: this format has no syntax validator.'} Ports: 1–65535. Formatting changes the draft; TOML formatting removes comments. XML is validated without reformatting.` };
}
