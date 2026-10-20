import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../../api/client.js';
import { Badge, Button, Input, Modal, Notice, Spinner } from '../../components/ui.js';
import { useToast } from '../../components/Toast.js';

interface ConfigFile {
  path: string;
  size: number;
  kind: 'json' | 'text';
  example: boolean;
  target: string | null;
  targetExists: boolean;
}
interface ConfigContent {
  path: string;
  content: string;
  hasBackup: boolean;
}
type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const SECRET = /pass(word)?|secret|token|api_?key|webhook|connection_?string/i;

/** "EnableFallbackAllocation" / "chat_prefix" → "Enable fallback allocation" / "Chat prefix". */
function label(key: string) {
  const words = key
    .replace(/[_\-.]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Strict JSON only: a file with comments would lose them through the form, so it stays raw. */
function parseStrict(text: string): { ok: true; value: Json } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) as Json };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Same leniency as the server (and CounterStrikeSharp): comments and trailing commas allowed. */
function lenientError(text: string): string | null {
  const stripped = text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str: string | undefined) => str ?? '').replace(/,(\s*[}\]])/g, '$1');
  try {
    JSON.parse(stripped);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

function indentOf(text: string): string | number {
  const m = text.match(/\n([ \t]+)\S/);
  if (!m) return 2;
  return m[1].startsWith('\t') ? '\t' : m[1].length;
}

/** Edits a plugin's config files: a form for JSON, a text editor for everything (and for JSON too). */
export function PluginConfigModal({ serverId, folder, onClose }: { serverId: string; folder: string | null; onClose: () => void }) {
  const toast = useToast();
  const base = `/servers/${serverId}/cs2/plugins/${encodeURIComponent(folder ?? '')}/configs`;
  const [files, setFiles] = useState<ConfigFile[] | null>(null);
  const [running, setRunning] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<ConfigContent | null>(null);
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'form' | 'raw'>('form');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!folder) return;
    setFiles(null);
    setSelected(null);
    setLoaded(null);
    api
      .get<{ files: ConfigFile[]; running: boolean }>(base)
      .then((r) => {
        setFiles(r.files);
        setRunning(r.running);
        setSelected(r.files.find((f) => !f.example)?.path ?? r.files[0]?.path ?? null);
      })
      .catch((err) => toast.error(err instanceof ApiError ? err.message : 'Failed to load'));
  }, [base, folder, toast]);

  useEffect(() => {
    if (!selected) return;
    setLoaded(null);
    api
      .get<ConfigContent>(`${base}/file?path=${encodeURIComponent(selected)}`)
      .then((r) => {
        setLoaded(r);
        setText(r.content);
        setMode('form');
      })
      .catch((err) => toast.error(err instanceof ApiError ? err.message : 'Failed to load'));
  }, [base, selected, toast]);

  const file = files?.find((f) => f.path === selected) ?? null;
  const strict = useMemo(() => (file?.kind === 'json' ? parseStrict(text) : null), [file, text]);
  const formAvailable = file?.kind === 'json' && strict?.ok === true && typeof strict.value === 'object' && strict.value !== null;
  const jsonError = file?.kind === 'json' ? lenientError(text) : null;
  const dirty = loaded !== null && text !== loaded.content;
  const effectiveMode = formAvailable ? mode : 'raw';

  const save = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const r = await api.put<ConfigContent>(`${base}/file`, { path: selected, content: text });
      setLoaded(r);
      setText(r.content);
      toast.success(running ? 'Saved — restart the server (or reload the plugin) to apply it' : 'Saved — applies on the next start');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };
  const revert = async () => {
    if (!selected || !confirm('Put back the version from before the last save?')) return;
    setBusy(true);
    try {
      const r = await api.post<ConfigContent>(`${base}/revert`, { path: selected });
      setLoaded(r);
      setText(r.content);
      toast.success('Previous version restored');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };
  const useExample = async (f: ConfigFile) => {
    try {
      const r = await api.post<{ created: string; files: ConfigFile[] }>(`${base}/use-example`, { path: f.path });
      setFiles(r.files);
      setSelected(r.created);
      toast.success(`Created ${r.created.split('/').pop()} from the example`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed');
    }
  };
  const close = () => {
    if (dirty && !confirm('Discard your unsaved changes?')) return;
    onClose();
  };

  return (
    <Modal open={!!folder} onClose={close} title={`${folder ?? ''} — configuration`} size="xl">
      {!files ? (
        <Spinner />
      ) : files.length === 0 ? (
        <Notice>
          No config files yet. Most plugins write theirs the first time they load — start the server once (with plugins on), then come back. Configs live in <span className="font-mono">addons/counterstrikesharp/configs/plugins/{folder}</span>.
        </Notice>
      ) : (
        <div className="grid gap-4 md:grid-cols-[14rem_minmax(0,1fr)]">
          {/* Files */}
          <div className="space-y-1">
            {files.map((f) => (
              <div key={f.path}>
                <button
                  type="button"
                  onClick={() => {
                    if (f.path === selected || (dirty && !confirm('Discard your unsaved changes?'))) return;
                    setSelected(f.path);
                  }}
                  className={`w-full truncate rounded-lg px-2 py-1.5 text-left text-xs ${f.path === selected ? 'bg-accent-500/15 text-ink-100' : 'text-ink-300 hover:bg-surface-800'}`}
                  title={f.path}
                >
                  <span className="block truncate font-mono">{f.path.split('/').pop()}</span>
                  <span className="block truncate text-[10px] text-ink-500">{f.path.split('/').slice(0, -1).join('/')}</span>
                </button>
                {f.example && !f.targetExists && (
                  <button type="button" className="ml-2 text-[11px] text-accent-400 hover:underline" onClick={() => useExample(f)}>
                    Use this → {f.target?.split('/').pop()}
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* Editor */}
          <div className="min-w-0">
            {!loaded || !file ? (
              <Spinner />
            ) : (
              <>
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-400">{file.path}</span>
                  {file.example && <Badge tone="yellow">example — the plugin doesn’t read this one</Badge>}
                  {dirty && <Badge tone="blue">unsaved</Badge>}
                  {formAvailable && (
                    <span className="flex overflow-hidden rounded-lg border border-surface-600 text-xs">
                      {(['form', 'raw'] as const).map((m) => (
                        <button key={m} type="button" onClick={() => setMode(m)} className={`px-2.5 py-1 ${effectiveMode === m ? 'bg-surface-700 text-ink-100' : 'text-ink-400'}`}>
                          {m === 'form' ? 'Form' : 'Raw'}
                        </button>
                      ))}
                    </span>
                  )}
                </div>
                {file.kind === 'json' && !formAvailable && !jsonError && <p className="mb-2 text-[11px] text-ink-500">This file has comments, so it’s edited as text (a form would drop them).</p>}

                {effectiveMode === 'form' && strict?.ok ? (
                  <div className="max-h-[60vh] overflow-y-auto pr-1">
                    <JsonForm value={strict.value} onChange={(v) => setText(JSON.stringify(v, null, indentOf(loaded.content)) + (loaded.content.endsWith('\n') ? '\n' : ''))} />
                  </div>
                ) : (
                  <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    spellCheck={false}
                    rows={22}
                    className="ui-input w-full rounded-lg border border-surface-500 bg-transparent px-3 py-2 font-mono text-xs leading-relaxed text-ink-100 outline-none focus:border-accent-400"
                  />
                )}
                {jsonError && <p className="mt-2 text-xs text-red-400">Not valid JSON: {jsonError}</p>}

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button variant="primary" disabled={busy || !dirty || !!jsonError} onClick={save}>
                    {busy ? 'Saving…' : 'Save'}
                  </Button>
                  <Button variant="ghost" disabled={busy || !dirty} onClick={() => setText(loaded.content)}>
                    Discard changes
                  </Button>
                  {loaded.hasBackup && (
                    <Button variant="ghost" disabled={busy} onClick={revert}>
                      Undo last save
                    </Button>
                  )}
                  <span className="flex-1" />
                  <span className="text-[11px] text-ink-500">Applies when the plugin next loads — restart the server.</span>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Recursive form over a JSON value. Objects become labelled groups; primitives get matching inputs. */
function JsonForm({ value, onChange }: { value: Json; onChange: (v: Json) => void }) {
  if (Array.isArray(value)) return <JsonArray value={value} onChange={onChange} />;
  if (value === null || typeof value !== 'object') return <JsonPrimitive name="" value={value} onChange={onChange} />;
  const entries = Object.entries(value);
  if (!entries.length) return <p className="text-xs text-ink-500">(empty — add entries in Raw)</p>;
  return (
    <div className="space-y-2">
      {entries.map(([k, v]) =>
        v !== null && typeof v === 'object' ? (
          <details key={k} open={entries.length <= 12} className="rounded-xl border border-surface-700 px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium text-ink-200">
              {label(k)} <span className="font-mono text-[10px] text-ink-500">{k}</span>
            </summary>
            <div className="mt-2">
              <JsonForm value={v} onChange={(nv) => onChange({ ...value, [k]: nv })} />
            </div>
          </details>
        ) : (
          <JsonPrimitive key={k} name={k} value={v} onChange={(nv) => onChange({ ...value, [k]: nv })} />
        ),
      )}
    </div>
  );
}

function JsonPrimitive({ name, value, onChange }: { name: string; value: Json; onChange: (v: Json) => void }) {
  const [reveal, setReveal] = useState(false);
  const caption = name && (
    <span className="min-w-0 flex-1">
      <span className="block truncate text-sm text-ink-200">{label(name)}</span>
      <span className="block truncate font-mono text-[10px] text-ink-500">{name}</span>
    </span>
  );
  if (typeof value === 'boolean')
    return (
      <label className="flex cursor-pointer items-center gap-3">
        {caption}
        <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4" />
      </label>
    );
  const secret = SECRET.test(name) && typeof value === 'string' && value !== '';
  return (
    <div className="flex flex-wrap items-center gap-3">
      {caption}
      <span className="flex w-full items-center gap-1 sm:w-64">
        <Input
          type={typeof value === 'number' ? 'number' : secret && !reveal ? 'password' : 'text'}
          step="any"
          value={value === null ? '' : String(value)}
          placeholder={value === null ? 'null' : undefined}
          onChange={(e) => {
            const raw = e.target.value;
            if (typeof value === 'number') onChange(raw === '' || Number.isNaN(Number(raw)) ? value : Number(raw));
            else onChange(value === null && raw === '' ? null : raw);
          }}
          className="!py-1 font-mono text-xs"
        />
        {secret && (
          <button type="button" className="text-[11px] text-ink-400 hover:text-ink-200" onClick={() => setReveal(!reveal)}>
            {reveal ? 'hide' : 'show'}
          </button>
        )}
      </span>
    </div>
  );
}

/** Lists of plain values are editable (add / remove); lists of objects edit each item in place. */
function JsonArray({ value, onChange }: { value: Json[]; onChange: (v: Json) => void }) {
  const primitive = value.every((v) => v === null || typeof v !== 'object');
  if (!primitive)
    return (
      <div className="space-y-2">
        {value.map((item, i) => (
          <div key={i} className="rounded-lg bg-surface-900 p-2">
            <JsonForm value={item} onChange={(nv) => onChange(value.map((x, j) => (j === i ? nv : x)))} />
          </div>
        ))}
        <p className="text-[11px] text-ink-500">Add or remove entries in Raw.</p>
      </div>
    );
  const sample = value.find((v) => v !== null);
  return (
    <div className="space-y-1">
      {value.map((item, i) => (
        <div key={i} className="flex items-center gap-1">
          <JsonPrimitive name="" value={item} onChange={(nv) => onChange(value.map((x, j) => (j === i ? nv : x)))} />
          <button type="button" className="text-xs text-ink-500 hover:text-red-400" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label="Remove">
            ✕
          </button>
        </div>
      ))}
      <button type="button" className="text-xs text-accent-400 hover:underline" onClick={() => onChange([...value, typeof sample === 'number' ? 0 : typeof sample === 'boolean' ? false : ''])}>
        + Add
      </button>
    </div>
  );
}
