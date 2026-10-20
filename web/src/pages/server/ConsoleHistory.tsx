import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, downloadUrl } from '../../api/client.js';
import { Button, Input, Modal, Select, Spinner } from '../../components/ui.js';
import { useToast } from '../../components/Toast.js';
import { useConfirm } from '../../components/ConfirmDialog.js';
import { formatBytes } from './StatusTab.js';

interface HistoryFile {
  name: string;
  date: string;
  part: number;
  sizeBytes: number;
  compressed: boolean;
}
interface HistoryView {
  lines: string[];
  total: number;
  matched: number;
  truncated: boolean;
}

/** Past console logs: pick a day, search it, download it. */
export function ConsoleHistory({ serverId, open, onClose, canDelete }: { serverId: string; open: boolean; onClose: () => void; canDelete: boolean }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [files, setFiles] = useState<HistoryFile[] | null>(null);
  const [retention, setRetention] = useState(30);
  const [selected, setSelected] = useState('');
  const [query, setQuery] = useState('');
  const [view, setView] = useState<HistoryView | null>(null);
  const [loading, setLoading] = useState(false);
  const base = `/servers/${serverId}/console-logs`;

  const loadList = useCallback(async () => {
    try {
      const r = await api.get<{ files: HistoryFile[]; retentionDays: number }>(base);
      setFiles(r.files);
      setRetention(r.retentionDays);
      setSelected((s) => (s && r.files.some((f) => f.name === s) ? s : r.files[0]?.name ?? ''));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to load log history');
      setFiles([]);
    }
  }, [base, toast]);

  useEffect(() => {
    if (open) loadList();
  }, [open, loadList]);

  const loadFile = useCallback(
    async (name: string, q: string) => {
      if (!name) return setView(null);
      setLoading(true);
      try {
        setView(await api.get<HistoryView>(`${base}/${encodeURIComponent(name)}?limit=5000${q ? `&q=${encodeURIComponent(q)}` : ''}`));
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : 'Failed to read the log');
      } finally {
        setLoading(false);
      }
    },
    [base, toast]
  );

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => loadFile(selected, query), query ? 300 : 0);
    return () => clearTimeout(t);
  }, [open, selected, query, loadFile]);

  async function remove() {
    if (!(await confirm({ title: 'Delete log', message: `Delete the console log ${selected}?`, confirmLabel: 'Delete', tone: 'danger' }))) return;
    try {
      const r = await api.delete<{ files: HistoryFile[] }>(`${base}/${encodeURIComponent(selected)}`);
      setFiles(r.files);
      setSelected(r.files[0]?.name ?? '');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to delete');
    }
  }

  const label = (f: HistoryFile) => `${f.date}${f.part > 1 ? ` (part ${f.part})` : ''} — ${formatBytes(f.sizeBytes)}${f.compressed ? ', compressed' : ''}`;

  return (
    <Modal open={open} onClose={onClose} title="Console log history" size="xl">
      {!files ? (
        <Spinner />
      ) : files.length === 0 ? (
        <p className="text-sm text-ink-400">No saved console logs yet — they’re written as the server prints.</p>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={selected} onChange={(e) => setSelected(e.target.value)} className="!w-auto min-w-[16rem]">
              {files.map((f) => (
                <option key={f.name} value={f.name}>
                  {label(f)}
                </option>
              ))}
            </Select>
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search this log…" className="!w-auto min-w-[12rem] flex-1" />
            {selected && (
              <a href={downloadUrl(`${base}/${encodeURIComponent(selected)}/download`)} className="ui-btn state-layer inline-flex items-center rounded-full border border-surface-600 px-4 py-2 text-sm text-ink-100">
                Download
              </a>
            )}
            {canDelete && selected && (
              <Button variant="ghost" onClick={remove}>
                Delete
              </Button>
            )}
          </div>
          {view && (
            <p className="text-xs text-ink-400">
              {query ? `${view.matched.toLocaleString()} of ${view.total.toLocaleString()} lines match` : `${view.total.toLocaleString()} lines`}
              {view.truncated ? ' — showing the last 5,000; download for everything' : ''}
            </p>
          )}
          <div className="ui-terminal console-view h-[55vh] overflow-y-auto rounded-2xl bg-surface-1000 px-4 py-3 text-[12px] leading-relaxed text-slate-300">
            {loading ? (
              <Spinner />
            ) : view && view.lines.length ? (
              view.lines.map((l, i) => (
                <div key={i} className={`whitespace-pre-wrap break-all ${/^\[\d\d:\d\d:\d\d\] !/.test(l) ? 'text-red-400' : /\[Outpost\]/.test(l) ? 'text-sky-400' : ''}`}>
                  {l}
                </div>
              ))
            ) : (
              <p className="text-slate-500">{query ? 'Nothing matches.' : 'Empty.'}</p>
            )}
          </div>
          <p className="text-xs text-ink-500">Logs are kept {retention === 0 ? 'forever' : `for ${retention} days`} (Configuration → Console logs). Past days are compressed.</p>
        </div>
      )}
    </Modal>
  );
}
