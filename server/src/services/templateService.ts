import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { prep } from '../db/db.js';
import { HttpError } from '../utils/asyncHandler.js';
import { instanceDir, safeJoinReal } from '../utils/paths.js';
import { launchConfigOf, type LaunchConfig } from './launchConfig.js';
import { dockerConfigOf } from './containerService.js';
import { autoUpdateOf } from './autoUpdateService.js';
import { rconConfigOf } from './rconService.js';
import { findPresetFor } from './steamGames.js';
import { ALL_LOADERS, type Loader, type ServerRecord } from '../types/index.js';

/**
 * Server templates ("eggs"): a portable JSON description of how to create an instance — game and
 * version, memory, launch settings, container config, automatic updates, RCON, and small config files
 * — with variables the person creating from it fills in. Exported from any instance (secrets
 * stripped), imported from a file, and used from the New instance dialog.
 */

export const TEMPLATE_FORMAT = 'outpost-template';
export const TEMPLATE_VERSION = 1;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES_BYTES = 2 * 1024 * 1024;
const VAR_KEY = /^[A-Z][A-Z0-9_]{0,31}$/;
const SECRET_KEY = /pass(word)?|secret|token|api[_-]?key|private|credential|auth/i;

export interface TemplateVariable {
  key: string;
  label: string;
  description?: string;
  default: string;
  required?: boolean;
}

export interface TemplateInstance {
  platform: ServerRecord['platform'];
  loader: ServerRecord['loader'];
  version: string;
  minMemoryMb?: number;
  maxMemoryMb?: number;
  defaultPort?: number;
  extraArgs?: string;
  extraJavaArgs?: string;
  steamAppId?: string | null;
  steamPreset?: string | null;
  steamExtraFlags?: string;
  /** Custom Steam App IDs: the server executable (relative path). */
  customExecutable?: string | null;
  launch?: LaunchConfig;
  docker?: Record<string, unknown> | null;
  autoUpdate?: Record<string, unknown> | null;
  rcon?: { enabled: boolean; protocol: string; port: number; useForConsole: boolean } | null;
}

export interface OutpostTemplate {
  format: typeof TEMPLATE_FORMAT;
  version: number;
  name: string;
  description: string;
  author: string;
  exportedAt: string;
  instance: TemplateInstance;
  variables: TemplateVariable[];
  files: { path: string; content: string }[];
}

export interface StoredTemplate {
  id: string;
  name: string;
  description: string;
  platform: string;
  createdBy: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');

/** Checks and normalises a template (from an import or an export). Throws a 400 on anything off. */
export function validateTemplate(input: unknown): OutpostTemplate {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'Not a template file');
  const raw = input as Record<string, any>;
  if (raw.format !== TEMPLATE_FORMAT) throw new HttpError(400, 'Not an Outpost template (format should be "outpost-template")');
  if (typeof raw.version !== 'number' || raw.version > TEMPLATE_VERSION) throw new HttpError(400, `This template needs a newer Outpost (template version ${raw.version})`);
  const name = str(raw.name, 80).trim();
  if (!name) throw new HttpError(400, 'Template needs a name');
  const inst = (raw.instance ?? {}) as Record<string, any>;
  if (!['java', 'bedrock', 'steam', 'custom', 'docker'].includes(inst.platform)) throw new HttpError(400, 'Template has an unknown platform');
  if (!ALL_LOADERS.includes(inst.loader as Loader)) throw new HttpError(400, 'Template has an unknown server type');

  const variables: TemplateVariable[] = [];
  for (const v of Array.isArray(raw.variables) ? raw.variables.slice(0, 30) : []) {
    if (!v || typeof v.key !== 'string' || !VAR_KEY.test(v.key)) throw new HttpError(400, `Variable keys must be UPPER_SNAKE_CASE (got ${JSON.stringify(v?.key)})`);
    if (['PORT', 'NAME', 'ID', 'DIR', 'MIN_MEMORY', 'MAX_MEMORY'].includes(v.key)) throw new HttpError(400, `{{${v.key}}} is built in — pick another variable name`);
    variables.push({ key: v.key, label: str(v.label, 80) || v.key, description: str(v.description, 300) || undefined, default: str(v.default, 500), required: v.required === true });
  }

  const files: { path: string; content: string }[] = [];
  let total = 0;
  for (const f of Array.isArray(raw.files) ? raw.files.slice(0, 50) : []) {
    const p = str(f?.path, 300).replace(/\\/g, '/').replace(/^\/+/, '');
    if (!p || p.split('/').includes('..') || /^[A-Za-z]:/.test(p)) throw new HttpError(400, `Template file path isn’t allowed: ${f?.path}`);
    if (typeof f.content !== 'string') throw new HttpError(400, `Template file ${p} has no text content`);
    const size = Buffer.byteLength(f.content);
    if (size > MAX_FILE_BYTES) throw new HttpError(400, `Template file ${p} is over 256 KB`);
    total += size;
    if (total > MAX_FILES_BYTES) throw new HttpError(400, 'Template files add up to more than 2 MB');
    files.push({ path: p, content: f.content });
  }

  const num = (v: unknown, min: number, max: number) => (Number.isFinite(Number(v)) && Number(v) >= min && Number(v) <= max ? Math.round(Number(v)) : undefined);
  return {
    format: TEMPLATE_FORMAT,
    version: TEMPLATE_VERSION,
    name,
    description: str(raw.description, 2000),
    author: str(raw.author, 80),
    exportedAt: str(raw.exportedAt, 40) || new Date().toISOString(),
    instance: {
      platform: inst.platform,
      loader: inst.loader,
      version: str(inst.version, 200),
      minMemoryMb: num(inst.minMemoryMb, 128, 1024 * 1024),
      maxMemoryMb: num(inst.maxMemoryMb, 128, 1024 * 1024),
      defaultPort: num(inst.defaultPort, 1, 65535),
      extraArgs: str(inst.extraArgs, 2000),
      extraJavaArgs: str(inst.extraJavaArgs, 2000),
      steamAppId: typeof inst.steamAppId === 'string' && /^\d+$/.test(inst.steamAppId) ? inst.steamAppId : null,
      steamPreset: typeof inst.steamPreset === 'string' ? inst.steamPreset.slice(0, 60) : null,
      steamExtraFlags: str(inst.steamExtraFlags, 500),
      customExecutable: typeof inst.customExecutable === 'string' ? inst.customExecutable.slice(0, 300) : null,
      launch: inst.launch && typeof inst.launch === 'object' ? (inst.launch as LaunchConfig) : undefined,
      docker: inst.docker && typeof inst.docker === 'object' ? inst.docker : null,
      autoUpdate: inst.autoUpdate && typeof inst.autoUpdate === 'object' ? inst.autoUpdate : null,
      rcon:
        inst.rcon && typeof inst.rcon === 'object'
          ? { enabled: inst.rcon.enabled === true, protocol: inst.rcon.protocol === 'webrcon' ? 'webrcon' : 'source', port: num(inst.rcon.port, 1, 65535) ?? 25575, useForConsole: inst.rcon.useForConsole === true }
          : null,
    },
    variables,
    files,
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Blanks values that look like secrets in key=value / key: value config lines. */
export function scrubSecrets(text: string): string {
  return text.replace(/^(\s*[\w.\-]*(?:pass(?:word)?|secret|token|api[_-]?key|private[_-]?key|credential)[\w.\-]*\s*[=:]\s*)(.+)$/gim, (_m, head: string, value: string) =>
    /^["']/.test(value.trim()) ? `${head}""` : head
  );
}

function isText(buf: Buffer): boolean {
  if (buf.includes(0)) return false;
  return !buf.toString('utf8').includes('�');
}

/** Builds a template from an instance. `filePaths` are instance-relative text files to include. */
export function exportTemplate(server: ServerRecord, opts: { name?: string; description?: string; author: string; filePaths: string[] }): OutpostTemplate {
  const launch = { ...launchConfigOf(server) };
  if (launch.env) launch.env = launch.env.map((e) => (SECRET_KEY.test(e.key) ? { key: e.key, value: '' } : e));
  if (launch.wine?.binary) launch.wine = { ...launch.wine, binary: undefined };
  delete launch.javaPath; // a path on this host

  const docker = dockerConfigOf(server);
  const au = autoUpdateOf(server);
  const rcon = rconConfigOf(server);
  const dir = instanceDir(server.id);
  const files: { path: string; content: string }[] = [];
  let total = 0;
  for (const rel of opts.filePaths.slice(0, 50)) {
    let abs: string;
    try {
      abs = safeJoinReal(dir, rel);
    } catch {
      throw new HttpError(400, `${rel} isn’t inside the instance`);
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new HttpError(400, `${rel} doesn’t exist`);
    const buf = fs.readFileSync(abs);
    if (buf.length > MAX_FILE_BYTES) throw new HttpError(400, `${rel} is over 256 KB — templates hold small config files only`);
    if (!isText(buf)) throw new HttpError(400, `${rel} isn’t a text file`);
    total += buf.length;
    if (total > MAX_FILES_BYTES) throw new HttpError(400, 'Selected files add up to more than 2 MB');
    files.push({ path: rel.replace(/\\/g, '/').replace(/^\/+/, ''), content: scrubSecrets(buf.toString('utf8')) });
  }

  return validateTemplate({
    format: TEMPLATE_FORMAT,
    version: TEMPLATE_VERSION,
    name: opts.name?.trim() || server.name,
    description: opts.description ?? '',
    author: opts.author,
    exportedAt: new Date().toISOString(),
    instance: {
      platform: server.platform,
      loader: server.loader,
      version: server.version,
      minMemoryMb: server.min_memory_mb,
      maxMemoryMb: server.max_memory_mb,
      defaultPort: server.server_port,
      extraArgs: server.extra_args,
      extraJavaArgs: server.extra_java_args,
      steamAppId: server.steam_app_id,
      steamPreset: server.steam_preset,
      steamExtraFlags: server.steam_extra_flags,
      customExecutable: server.platform === 'steam' && !findPresetFor(server) ? server.jar_file : null,
      launch: Object.keys(launch).length ? launch : undefined,
      docker: docker ? { ...docker, env: docker.env.map((e) => (SECRET_KEY.test(e.key) ? { key: e.key, value: '' } : e)) } : null,
      autoUpdate: au.enabled ? { enabled: true, schedule: au.schedule, warnMinutes: au.warnMinutes, warnCommand: au.warnCommand, backupFirst: au.backupFirst, notifyOnly: au.notifyOnly } : null,
      rcon: rcon ? { enabled: rcon.enabled, protocol: rcon.protocol, port: rcon.port, useForConsole: rcon.useForConsole } : null,
    },
    variables: [],
    files,
  });
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export function listTemplates(): StoredTemplate[] {
  return (prep('SELECT id, name, description, platform, created_by, created_at FROM templates ORDER BY name COLLATE NOCASE').all() as any[]).map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    platform: r.platform,
    createdBy: r.created_by,
    createdAt: r.created_at,
  }));
}

export function getTemplate(id: string): OutpostTemplate | null {
  const row = prep('SELECT data FROM templates WHERE id = ?').get(id) as { data: string } | undefined;
  if (!row) return null;
  return validateTemplate(JSON.parse(row.data));
}

export function saveTemplate(tpl: OutpostTemplate, createdBy: string): string {
  const id = crypto.randomUUID();
  prep('INSERT INTO templates (id, name, description, platform, data, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    tpl.name,
    tpl.description,
    tpl.instance.platform,
    JSON.stringify(tpl),
    createdBy,
    new Date().toISOString()
  );
  return id;
}

export function deleteTemplate(id: string): boolean {
  return Number(prep('DELETE FROM templates WHERE id = ?').run(id).changes) > 0;
}

// ---------------------------------------------------------------------------
// Creating from a template
// ---------------------------------------------------------------------------

/** Values for each template variable: given, else default; required ones must be non-empty. */
export function resolveVariables(tpl: OutpostTemplate, given: unknown): Record<string, string> {
  const input = given && typeof given === 'object' ? (given as Record<string, unknown>) : {};
  const out: Record<string, string> = {};
  for (const v of tpl.variables) {
    const value = typeof input[v.key] === 'string' ? (input[v.key] as string) : v.default;
    if (v.required && !value.trim()) throw new HttpError(400, `“${v.label}” is required by this template`);
    if (value.length > 500 || /[\r\n]/.test(value)) throw new HttpError(400, `“${v.label}” must be one line`);
    out[v.key] = value;
  }
  return out;
}

/** Replaces {{KEY}} for the template's own variables (built-ins like {{PORT}} are left for launch time). */
export function substitute(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}

function substituteDeep<T>(value: T, vars: Record<string, string>): T {
  if (typeof value === 'string') return substitute(value, vars) as T;
  if (Array.isArray(value)) return value.map((v) => substituteDeep(v, vars)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteDeep(v, vars)])) as T;
  return value;
}

/** The template's instance settings with variables filled in. */
export function instantiate(tpl: OutpostTemplate, vars: Record<string, string>): TemplateInstance {
  return substituteDeep(tpl.instance, vars);
}

/** Writes the template's files into a (new) instance, variables filled in. */
export function writeTemplateFiles(serverId: string, tpl: OutpostTemplate, vars: Record<string, string>) {
  const dir = instanceDir(serverId);
  for (const f of tpl.files) {
    const abs = safeJoinReal(dir, f.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, substitute(f.content, vars));
  }
}
