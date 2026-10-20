import { useEffect, useState } from 'react';
import { api, ApiError } from '../api/client.js';
import type { ServerRecord } from '../api/types.js';
import { Button, ErrorText, Field, Input, Modal, Select, Spinner } from './ui.js';
import { t } from '../i18n/index.js';

export interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  platform: string;
  createdAt: string;
}
interface TemplateVariable {
  key: string;
  label: string;
  description?: string;
  default: string;
  required?: boolean;
}
interface FullTemplate {
  name: string;
  description: string;
  author: string;
  instance: { platform: string; loader: string; version: string; defaultPort?: number; minMemoryMb?: number; maxMemoryMb?: number; steamPreset?: string | null };
  variables: TemplateVariable[];
  files: { path: string }[];
}

const PLATFORM: Record<string, string> = { java: 'Minecraft: Java', bedrock: 'Minecraft: Bedrock', steam: 'Steam', custom: 'Custom process', docker: 'Container' };

/** New instance → From a template: pick one, fill in its variables, create. */
export function CreateFromTemplateModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (s: ServerRecord) => void }) {
  const [list, setList] = useState<TemplateSummary[] | null>(null);
  const [id, setId] = useState('');
  const [tpl, setTpl] = useState<FullTemplate | null>(null);
  const [name, setName] = useState('');
  const [port, setPort] = useState('');
  const [vars, setVars] = useState<Record<string, string>>({});
  const [eula, setEula] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    api
      .get<{ templates: TemplateSummary[] }>('/templates')
      .then((r) => {
        setList(r.templates);
        setId((cur) => cur || r.templates[0]?.id || '');
      })
      .catch(() => setList([]));
  }, [open]);

  useEffect(() => {
    if (!id) return setTpl(null);
    api
      .get<{ template: FullTemplate }>(`/templates/${id}`)
      .then((r) => {
        setTpl(r.template);
        setName((n) => n || r.template.name);
        setPort(String(r.template.instance.defaultPort ?? ''));
        setVars(Object.fromEntries(r.template.variables.map((v) => [v.key, v.default])));
        setError('');
      })
      .catch(() => setTpl(null));
  }, [id]);

  async function create() {
    setBusy(true);
    setError('');
    try {
      const { server } = await api.post<{ server: ServerRecord }>('/servers', {
        templateId: id,
        name: name.trim(),
        serverPort: port ? Number(port) : undefined,
        variables: vars,
        acceptEula: eula,
      });
      onCreated(server);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="New instance from a template" size="lg">
      {!list ? (
        <Spinner />
      ) : list.length === 0 ? (
        <p className="text-sm text-ink-400">{t('No templates yet — import one under Configuration → Server templates, or save an instance as a template.')}</p>
      ) : (
        <div className="space-y-4">
          <Field label="Template">
            <Select value={id} onChange={(e) => setId(e.target.value)}>
              {list.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name} — {PLATFORM[x.platform] ?? x.platform}
                </option>
              ))}
            </Select>
          </Field>
          {tpl && (
            <>
              <div className="rounded-2xl bg-surface-900 p-3 text-xs text-ink-300">
                {tpl.description && <p className="mb-1 whitespace-pre-wrap text-sm text-ink-200">{tpl.description}</p>}
                <p>
                  {PLATFORM[tpl.instance.platform] ?? tpl.instance.platform} · {tpl.instance.loader} {tpl.instance.version}
                  {tpl.instance.maxMemoryMb ? ` · ${tpl.instance.maxMemoryMb} MB` : ''}
                  {tpl.files.length ? ` · ${tpl.files.length} config file(s)` : ''}
                  {tpl.author ? ` · by ${tpl.author}` : ''}
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Instance name">
                  <Input value={name} onChange={(e) => setName(e.target.value)} />
                </Field>
                {tpl.instance.platform !== 'docker' && (
                  <Field label="Port">
                    <Input type="number" min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value)} />
                  </Field>
                )}
              </div>
              {tpl.variables.length > 0 && (
                <div className="grid gap-3 sm:grid-cols-2">
                  {tpl.variables.map((v) => (
                    <Field key={v.key} label={`${v.label}${v.required ? ' *' : ''}`}>
                      <Input value={vars[v.key] ?? ''} onChange={(e) => setVars({ ...vars, [v.key]: e.target.value })} placeholder={v.default} />
                      {v.description && <span className="mt-1 block text-[11px] text-ink-500">{v.description}</span>}
                    </Field>
                  ))}
                </div>
              )}
              {tpl.instance.platform === 'java' && (
                <label className="flex items-start gap-2 text-sm text-ink-300">
                  <input type="checkbox" className="mt-0.5" checked={eula} onChange={(e) => setEula(e.target.checked)} />
                  <span>
                    I accept the{' '}
                    <a className="text-accent-500 underline" href="https://aka.ms/MinecraftEULA" target="_blank" rel="noreferrer">
                      Minecraft EULA
                    </a>
                  </span>
                </label>
              )}
              <ErrorText>{error}</ErrorText>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={onClose}>
                  Cancel
                </Button>
                <Button variant="primary" disabled={busy || !name.trim() || (tpl.instance.platform === 'java' && !eula)} onClick={create}>
                  {busy ? t('Creating…') : t('Create')}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
