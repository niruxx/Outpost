import { useEffect, useRef, useState } from 'react';
import { api, ApiError, downloadUrl } from '../api/client.js';
import { Badge, Button, Card, CardTitle } from './ui.js';
import { useToast } from './Toast.js';
import { useConfirm } from './ConfirmDialog.js';
import type { TemplateSummary } from './CreateFromTemplateModal.js';

/** Configuration → Server templates: the library everyone can create from; admins import and delete. */
export function TemplatesCard({ isAdmin }: { isAdmin: boolean }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [list, setList] = useState<TemplateSummary[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.get<{ templates: TemplateSummary[] }>('/templates').then((r) => setList(r.templates)).catch(() => setList([]));
  }, []);
  if (!list) return null;

  async function importFile(file: File) {
    try {
      const json = JSON.parse(await file.text());
      const r = await api.post<{ templates: TemplateSummary[] }>('/templates', json);
      setList(r.templates);
      toast.success(`Imported “${json.name ?? file.name}”`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : err instanceof SyntaxError ? 'That file isn’t valid JSON' : 'Import failed');
    }
  }
  async function remove(x: TemplateSummary) {
    if (!(await confirm({ title: 'Delete template', message: `Delete the template “${x.name}”? Instances made from it aren’t affected.`, confirmLabel: 'Delete', tone: 'danger' }))) return;
    try {
      setList((await api.delete<{ templates: TemplateSummary[] }>(`/templates/${x.id}`)).templates);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to delete');
    }
  }

  return (
    <Card className="p-5">
      <CardTitle
        action={
          isAdmin && (
            <>
              <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0]).finally(() => (e.target.value = ''))} />
              <Button onClick={() => fileRef.current?.click()}>Import</Button>
            </>
          )
        }
      >
        Server templates
      </CardTitle>
      <p className="mb-3 text-sm text-ink-400">
        Ready-made setups to create instances from (New instance → From a template). Save any instance as a template from its Configuration page, or import a template file someone shared.
      </p>
      {list.length === 0 ? (
        <p className="text-sm text-ink-500">No templates yet.</p>
      ) : (
        <div className="divide-y divide-surface-700 overflow-hidden rounded-2xl bg-surface-900">
          {list.map((x) => (
            <div key={x.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-ink-100">{x.name}</span>
                {x.description && <span className="block truncate text-xs text-ink-400">{x.description}</span>}
              </span>
              <Badge>{x.platform}</Badge>
              <a href={downloadUrl(`/templates/${x.id}/download`)} className="state-layer rounded-full px-3 py-1 text-sm font-medium text-accent-400">
                Export
              </a>
              {isAdmin && (
                <Button variant="ghost" onClick={() => remove(x)}>
                  Delete
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
