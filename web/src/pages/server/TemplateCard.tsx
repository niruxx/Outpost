import { useEffect, useState } from 'react';
import { useServerDetail } from './ServerContext.js';
import { api, ApiError, downloadUrl } from '../../api/client.js';
import { Button, Card, CardTitle, Field, Input } from '../../components/ui.js';
import { useToast } from '../../components/Toast.js';
import { useAuth } from '../../state/AuthContext.js';
import { formatBytes } from './StatusTab.js';

interface Variable {
  key: string;
  label: string;
  default: string;
}

/** Configuration → Template: export this instance's setup, or save it into the template library. */
export function TemplateCard() {
  const { serverId, server, can } = useServerDetail();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const toast = useToast();
  const [files, setFiles] = useState<{ path: string; sizeBytes: number }[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [variables, setVariables] = useState<Variable[]>([]);
  const [saving, setSaving] = useState(false);
  const base = `/servers/${serverId}/template`;

  useEffect(() => {
    if (!can('settings')) return;
    api
      .get<{ files: { path: string; sizeBytes: number }[] }>(`${base}/files`)
      .then((r) => {
        setFiles(r.files);
        setPicked(r.files.filter((f) => /^(server\.properties|server\.cfg|serverconfig\.xml)$/i.test(f.path.split('/').pop() ?? '')).map((f) => f.path));
      })
      .catch(() => setFiles([]));
  }, [base, can]);

  if (!can('settings') || !server || !files) return null;
  const query = new URLSearchParams({ files: picked.join(','), ...(name ? { name } : {}), ...(description ? { description } : {}) }).toString();

  async function saveToLibrary() {
    setSaving(true);
    try {
      await api.post(base, { files: picked, name: name || server!.name, description, variables: variables.filter((v) => v.key) });
      toast.success('Saved to the template library (Configuration → Server templates)');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="p-5">
      <CardTitle>Template</CardTitle>
      <p className="mb-3 text-sm text-ink-400">
        Share this instance’s setup — game and version, memory, launch settings, automatic updates, RCON and the config files you tick. Passwords, tokens and Steam logins are left out.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Template name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={server.name} />
        </Field>
        <Field label="Description">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What it’s for, what’s set up" />
        </Field>
      </div>
      {files.length > 0 && (
        <div className="mt-3">
          <p className="mb-1.5 text-xs font-medium text-ink-300">Config files to include</p>
          <div className="grid max-h-48 gap-1 overflow-y-auto rounded-xl bg-surface-900 p-2 sm:grid-cols-2">
            {files.map((f) => (
              <label key={f.path} className="flex items-center gap-2 truncate text-xs text-ink-300">
                <input type="checkbox" checked={picked.includes(f.path)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, f.path] : p.filter((x) => x !== f.path)))} />
                <span className="truncate font-mono">{f.path}</span>
                <span className="text-ink-500">{formatBytes(f.sizeBytes)}</span>
              </label>
            ))}
          </div>
        </div>
      )}
      {isAdmin && (
        <div className="mt-3">
          <div className="mb-1.5 flex items-center justify-between">
            <p className="text-xs font-medium text-ink-300">Variables (asked when creating — use {'{{KEY}}'} in args, env or files)</p>
            <button type="button" className="text-xs font-medium text-accent-400" onClick={() => setVariables([...variables, { key: '', label: '', default: '' }])}>
              + Add variable
            </button>
          </div>
          {variables.map((v, i) => (
            <div key={i} className="mb-2 grid grid-cols-[1fr_1fr_1fr_auto] gap-2">
              <Input value={v.key} onChange={(e) => setVariables(variables.map((x, j) => (j === i ? { ...x, key: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') } : x)))} placeholder="KEY" className="font-mono" />
              <Input value={v.label} onChange={(e) => setVariables(variables.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} placeholder="Label" />
              <Input value={v.default} onChange={(e) => setVariables(variables.map((x, j) => (j === i ? { ...x, default: e.target.value } : x)))} placeholder="Default" />
              <Button variant="ghost" onClick={() => setVariables(variables.filter((_, j) => j !== i))}>
                Remove
              </Button>
            </div>
          ))}
        </div>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <a href={downloadUrl(`${base}/export?${query}`)} className="ui-btn state-layer inline-flex items-center rounded-full bg-secondary-container px-4 py-2 text-sm font-medium text-secondary-on-container">
          Export file
        </a>
        {isAdmin && (
          <Button variant="primary" disabled={saving} onClick={saveToLibrary}>
            Save as template
          </Button>
        )}
      </div>
    </Card>
  );
}
