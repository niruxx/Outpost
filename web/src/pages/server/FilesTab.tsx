import { FileUploadQueue } from '../../components/FileUploadQueue.js';
import { FileWorkspaceTools } from '../../components/FileWorkspaceTools.js';
import { useUnsavedChanges } from '../../lib/unsaved.js';


import { useCallback, useEffect, useState } from 'react';
import { SftpConnectInfo } from '../../components/SftpCard.js';
import { useServerDetail } from './ServerContext.js';
import { api, ApiError, downloadUrl } from '../../api/client.js';
import type { FileEntry } from '../../api/types.js';
import { Button, Card, ErrorText, Input } from '../../components/ui.js';
import { useConfirm } from '../../components/ConfirmDialog.js';
import { Icon } from '../../components/icons.js';
import { copyToClipboard, useContextMenu, type MenuItems } from '../../components/ContextMenu.js';
import { useToast } from '../../components/Toast.js';
import { FileHistoryModal } from '../../components/FileHistory.js';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

const EDITABLE_EXT = /\.(txt|properties|json|yml|yaml|conf|cfg|toml|log|md|sh|bat|xml|mcmeta)$/i;

/** One listing row; its own component so each row can bind its right-click menu. */
function FileRow({ menu, children, style }: { menu: () => MenuItems; children: React.ReactNode; style: React.CSSProperties }) {
  const contextMenu = useContextMenu(menu);
  return (
    <div
      {...contextMenu}
      style={style}
      className="animate-fade-in-up flex items-center gap-2 px-3 py-2 transition-colors hover:bg-surface-800/50 sm:gap-3 sm:px-4"
    >
      {children}
    </div>
  );
}

export function FilesTab() {
  const { serverId, can, isAdmin, isOwner } = useServerDetail();
  const canWrite = can('files.write');
  // File history lives with the instance's activity, which admins and the owner can see.
  const canSeeHistory = isAdmin || isOwner;
  const [historyPath, setHistoryPath] = useState<string | null>(null);
  const confirm = useConfirm();
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState('');
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [editorContent, setEditorContent] = useState('');
  const [editorDirty, setEditorDirty] = useState(false);
  const [editorSaving, setEditorSaving] = useState(false);
  const [revision, setRevision] = useState('');
  const [diagnostics, setDiagnostics] = useState<{line: number; message: string; severity: string}[]>([]);
  const [hint, setHint] = useState('');
  const [schemaHints, setSchemaHints] = useState<{key:string;type:string;min?:number;max?:number;options?:string[];help:string}[]>([]);
  useUnsavedChanges(editorDirty, editingPath ?? 'File editor');
  useEffect(() => {
    if (!editingPath) return;
    let live = true;
    const timer = setTimeout(() => { api.post<{diagnostics: typeof diagnostics; hint: string; hints: typeof schemaHints}>(`/servers/${serverId}/files/validate`, {path: editingPath, content: editorContent}).then(r => {if (live) {setDiagnostics(r.diagnostics); setHint(r.hint); setSchemaHints(r.hints);}}).catch(() => { if (live) setHint('Validation unavailable. Use Validate to retry.'); }); }, 400);
    return () => {live = false; clearTimeout(timer);};
  }, [editingPath, editorContent, serverId]);
  async function validateEditor(format = false) {
    try { const r = await api.post<{diagnostics: typeof diagnostics; hint: string; hints: typeof schemaHints; formatted?: string}>(`/servers/${serverId}/files/validate`, {path: editingPath, content: editorContent, format}); setDiagnostics(r.diagnostics); setHint(r.hint); setSchemaHints(r.hints); if (r.formatted !== undefined && r.formatted !== editorContent) {setEditorContent(r.formatted); setEditorDirty(true);} return r.diagnostics; } catch (e) {setError((e as Error).message); return null;}
  }
  const toast = useToast();

  const fileUrl = (entry: FileEntry) => downloadUrl(`/servers/${serverId}/files/download?path=${encodeURIComponent(entry.path)}`);
  const copy = (text: string, what: string) =>
    copyToClipboard(text).then((ok) => (ok ? toast.success(`${what} copied`) : toast.error('Copy failed')));

  const entryMenu = (entry: FileEntry) => (): MenuItems => [
    { heading: entry.name },
    entry.isDirectory
      ? { label: 'Open', icon: 'folder', onSelect: () => setPath(entry.path) }
      : { label: canWrite && EDITABLE_EXT.test(entry.name) ? 'Edit' : 'Open', icon: 'edit', onSelect: () => openFile(entry) },
    !entry.isDirectory && { label: 'Download', icon: 'download', onSelect: () => window.open(fileUrl(entry), '_blank') },
    'separator',
    canWrite && { label: 'Rename…', icon: 'edit', onSelect: () => renameEntry(entry) },
    canSeeHistory && !entry.isDirectory && { label: 'Change history', icon: 'history', onSelect: () => setHistoryPath(entry.path) },
    'separator',
    { label: 'Copy name', icon: 'copy', onSelect: () => copy(entry.name, 'Name') },
    { label: 'Copy path', icon: 'copy', onSelect: () => copy(`/${entry.path}`, 'Path') },
    'separator',
    canWrite && { label: 'Delete', icon: 'trash', danger: true, onSelect: () => deleteEntry(entry) },
  ];

  const folderMenu = useContextMenu((): MenuItems => [
    canWrite && { label: 'New folder…', icon: 'folder', onSelect: createFolder },
    canWrite && { label: 'Upload files…', icon: 'upload', onSelect: () => document.querySelector<HTMLInputElement>('[data-upload-instance]')?.click() },
    { label: 'Refresh', icon: 'refresh', onSelect: () => load(path) },
    'separator',
    !!path && { label: 'Up one level', icon: 'chevronUp', onSelect: () => setPath(path.split('/').slice(0, -1).join('/')) },
    { label: 'Copy current path', icon: 'copy', onSelect: () => copy(`/${path}`, 'Path') },
  ]);

  const load = useCallback(
    async (target: string) => {
      try {
        const res = await api.get<{ entries: FileEntry[] }>(`/servers/${serverId}/files/list?path=${encodeURIComponent(target)}`);
        setEntries(res.entries);
        setError('');
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Failed to list files');
      }
    },
    [serverId]
  );

  useEffect(() => {
    load(path);
  }, [path, load]);

  async function openFile(entry: FileEntry) {
    if (!EDITABLE_EXT.test(entry.name) && entry.size > 512 * 1024) {
      window.open(downloadUrl(`/servers/${serverId}/files/download?path=${encodeURIComponent(entry.path)}`), '_blank');
      return;
    }
    try {
      const res = await api.get<{ content: string; revision: string }>(`/servers/${serverId}/files/content?path=${encodeURIComponent(entry.path)}`);
      setEditingPath(entry.path);
      setEditorContent(res.content); setRevision(res.revision); setError(''); setDiagnostics([]);
      setEditorDirty(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to open file');
    }
  }

  async function saveFile() {
    if (!editingPath) return;
    setEditorSaving(true);
    const problems = await validateEditor();
    if (!problems) { setEditorSaving(false); return; }
    if (problems.some(d => d.severity === 'error') && !await confirm({title: 'Save invalid configuration?', message: 'Validation found errors. The server may fail to load this configuration.', confirmLabel: 'Save anyway', tone: 'danger'})) { setEditorSaving(false); return; }
    setEditorSaving(true);
    try {
      const saved = await api.put<{revision: string}>(`/servers/${serverId}/files/content`, { path: editingPath, content: editorContent, revision });
      setRevision(saved.revision);
      setEditorDirty(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save file');
    } finally {
      setEditorSaving(false);
    }
  }

  async function createFolder() {
    const name = window.prompt('New folder name');
    if (!name) return;
    try {
      await api.post(`/servers/${serverId}/files/mkdir`, { path: path ? `${path}/${name}` : name });
      await load(path);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create folder');
    }
  }

  async function deleteEntry(entry: FileEntry) {
    const ok = await confirm({
      title: entry.isDirectory ? 'Delete folder' : 'Delete file',
      message: `Delete ${entry.name}? You can restore it from the recycle bin for 30 days.`,
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api.delete(`/servers/${serverId}/files?path=${encodeURIComponent(entry.path)}`);
      await load(path);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete');
    }
  }

  async function renameEntry(entry: FileEntry) {
    const name = window.prompt('Rename to', entry.name);
    if (!name || name === entry.name) return;
    const to = path ? `${path}/${name}` : name;
    try {
      await api.post(`/servers/${serverId}/files/rename`, { from: entry.path, to });
      await load(path);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to rename');
    }
  }

  if (editingPath) {
    return (
      <div className="flex h-[calc(100dvh-8.5rem)] min-h-[20rem] flex-col gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2 sm:gap-3">
          <Button
            variant="ghost"
            onClick={async () => {
              if (editorDirty) {
                const ok = await confirm({
                  title: 'Discard changes',
                  message: 'Discard unsaved changes to this file?',
                  confirmLabel: 'Discard',
                  tone: 'danger',
                });
                if (!ok) return;
              }
              setEditingPath(null); setEditorDirty(false);
            }}
          >
            ← Back
          </Button>
          <span className="min-w-0 truncate font-mono text-sm text-ink-300" title={editingPath}>
            {editingPath}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {canSeeHistory && (
              <Button variant="ghost" onClick={() => setHistoryPath(editingPath)} title="See who changed this file, when, and what changed">
                <Icon name="history" className="h-4 w-4" /> History
              </Button>
            )}
            {canWrite && (
              <><Button onClick={() => validateEditor()}>Validate</Button><Button disabled={editorSaving} onClick={async () => {setEditorSaving(true); try {await validateEditor(true);} finally {setEditorSaving(false);}}}>Format draft</Button><Button data-save-shortcut variant="primary" onClick={saveFile} disabled={!editorDirty || editorSaving}>
                {editorSaving ? 'Saving…' : 'Save'}
              </Button></>
            )}
          </div>
        </div>
        <FileHistoryModal serverId={serverId} path={historyPath} onClose={() => setHistoryPath(null)} />
        <ErrorText>{error}</ErrorText>
        <div className="max-h-36 overflow-auto text-xs" aria-live="polite"><p className="text-ink-400">{hint}</p>{schemaHints.length > 0 && <details><summary>Configuration schema hints ({schemaHints.length})</summary>{schemaHints.map(h => <p key={h.key}><code>{h.key}</code>: {h.type} {h.min !== undefined ? `minimum ${h.min}` : ''} {h.max !== undefined ? `maximum ${h.max}` : ''} {h.options?.join(', ')} ? {h.help}</p>)}</details>}{diagnostics.map((d,i) => <p key={i} className={d.severity === 'error' ? 'text-red-400' : 'text-amber-400'}>Line {d.line}: {d.message}</p>)}</div>
        <textarea aria-label={`Edit ${editingPath}`}
          className="console-view flex-1 resize-none rounded-lg border border-surface-700 bg-surface-900 p-4 text-[13px] text-ink-200 focus:outline-none focus:ring-2 focus:ring-accent-600/60"
          value={editorContent}
          spellCheck={false}
          readOnly={!canWrite || editorSaving}
          onChange={(e) => {
            setEditorContent(e.target.value);
            setEditorDirty(true);
          }}
        />
      </div>
    );
  }

  const segments = path ? path.split('/') : [];

  return (
    <div className="space-y-3">
      <SftpConnectInfo serverId={serverId} />
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <button className="text-sm text-accent-500 hover:underline" onClick={() => setPath('')}>
            server
          </button>
          {segments.map((seg, i) => (
            <span key={i} className="flex min-w-0 items-center gap-2 text-sm text-ink-400">
              /
              <button className="truncate hover:text-accent-500 hover:underline" onClick={() => setPath(segments.slice(0, i + 1).join('/'))}>
                {seg}
              </button>
            </span>
          ))}
        </div>
        {canWrite && (
          <div className="flex gap-2">

            <Button onClick={createFolder}>New folder</Button>
          </div>
        )}
      </div>

      {canWrite && <FileUploadQueue serverId={serverId} basePath={path} onChanged={() => load(path)} />}
      <FileWorkspaceTools serverId={serverId} canWrite={canWrite} onChanged={() => load(path)} onOpen={entry => openFile({name: entry.path.split('/').pop()!, path: entry.path, size: entry.size, isDirectory: false, modifiedAt: ''})} />
      <ErrorText>{error}</ErrorText>

      <Card {...folderMenu} className="divide-y divide-surface-800">
        {entries === null ? (
          <p className="px-4 py-3 text-sm text-ink-500">Loading…</p>
        ) : entries.length === 0 ? (
          <p className="px-4 py-3 text-sm text-ink-500">This folder is empty.</p>
        ) : (
          entries.map((entry, i) => (
            <FileRow key={entry.path} menu={entryMenu(entry)} style={{ animationDelay: `${Math.min(i, 20) * 18}ms` }}>
              <button
                className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left text-sm"
                onClick={() => (entry.isDirectory ? setPath(entry.path) : openFile(entry))}
              >
                <span className="shrink-0">{entry.isDirectory ? '📁' : '📄'}</span>
                <span className="min-w-0">
                  <span className="block truncate text-ink-200">{entry.name}</span>
                  {/* Phones: size and date go under the name instead of in their own columns. */}
                  <span className="block truncate text-xs text-ink-500 sm:hidden">
                    {entry.isDirectory ? '' : `${formatSize(entry.size)} · `}
                    {new Date(entry.modifiedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                  </span>
                </span>
              </button>
              <span className="hidden w-20 shrink-0 text-right text-xs text-ink-500 sm:block">
                {entry.isDirectory ? '' : formatSize(entry.size)}
              </span>
              <span className="hidden w-36 shrink-0 text-right text-xs text-ink-500 md:block">
                {new Date(entry.modifiedAt).toLocaleString()}
              </span>
              <div className="flex shrink-0 gap-0.5 sm:gap-1">
                {!entry.isDirectory && (
                  <a
                    className="flex items-center rounded p-2 text-xs text-ink-400 hover:bg-surface-700 hover:text-ink-200 sm:px-2 sm:py-1"
                    href={fileUrl(entry)}
                    title="Download"
                    aria-label={`Download ${entry.name}`}
                  >
                    <Icon name="update" className="h-4 w-4 sm:hidden" />
                    <span className="hidden sm:inline">Download</span>
                  </a>
                )}
                {canWrite && (
                  <>
                    <button
                      className="flex items-center rounded p-2 text-xs text-ink-400 hover:bg-surface-700 hover:text-ink-200 sm:px-2 sm:py-1"
                      onClick={() => renameEntry(entry)}
                      title="Rename"
                      aria-label={`Rename ${entry.name}`}
                    >
                      <Icon name="edit" className="h-4 w-4 sm:hidden" />
                      <span className="hidden sm:inline">Rename</span>
                    </button>
                    <button
                      className="flex items-center rounded p-2 text-xs text-red-400 hover:bg-red-500/10 sm:px-2 sm:py-1"
                      onClick={() => deleteEntry(entry)}
                      title="Delete"
                      aria-label={`Delete ${entry.name}`}
                    >
                      <Icon name="trash" className="h-4 w-4 sm:hidden" />
                      <span className="hidden sm:inline">Delete</span>
                    </button>
                  </>
                )}
              </div>
            </FileRow>
          ))
        )}
      </Card>
      <FileHistoryModal serverId={serverId} path={historyPath} onClose={() => setHistoryPath(null)} />
    </div>
  );
}
