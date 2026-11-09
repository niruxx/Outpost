import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, downloadUrl, type UploadProgress } from '../api/client.js';
import { Button, Card, ErrorText, Input, Notice, Spinner } from '../components/ui.js';
import { useConfirm } from '../components/ConfirmDialog.js';
import { Icon } from '../components/icons.js';
import { copyToClipboard, useContextMenu, type MenuItems } from '../components/ContextMenu.js';
import { useToast } from '../components/Toast.js';
import { UploadTracker } from '../components/UploadTracker.js';
import { useAdminMode, type HostFilesStatus } from '../state/adminMode.js';

interface HostFileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  modifiedAt: string;
  permissions: string | null;
  owner: string | null;
  group: string | null;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

const EDITABLE_EXT = /(\.(txt|properties|json|ya?ml|conf|cfg|ini|toml|log|md|sh|bash|zsh|bat|ps1|xml|service|timer|socket|env|rules|list|repo|py|js|ts|cnf)|^[^.]+rc|^(hosts|fstab|crontab|sudoers|passwd|group|hostname|resolv\.conf|environment|profile))$/i;

/** Path helpers that follow the host's conventions, not the browser's. */
function pathTools(platform: string) {
  const win = platform === 'win32';
  const sep = win ? '\\' : '/';
  const join = (dir: string, name: string) => (dir.endsWith(sep) ? dir + name : dir + sep + name);
  const parent = (p: string) => {
    const trimmed = p.replace(/[\\/]+$/, '');
    const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
    if (i < 0) return p;
    const up = trimmed.slice(0, i);
    return win ? (/^[a-zA-Z]:$/.test(up) ? `${up}\\` : up || p) : up || '/';
  };
  /** Each clickable crumb: its label and the absolute path it opens. */
  const crumbs = (p: string) => {
    if (win) {
      const parts = p.split(/[\\/]/).filter(Boolean);
      return parts.map((part, i) => ({ label: part, path: i === 0 ? `${part}\\` : parts.slice(0, i + 1).join('\\') }));
    }
    const parts = p.split('/').filter(Boolean);
    return [{ label: '/', path: '/' }, ...parts.map((part, i) => ({ label: part, path: `/${parts.slice(0, i + 1).join('/')}` }))];
  };
  return { sep, join, parent, crumbs };
}

function Row({ menu, children }: { menu: () => MenuItems; children: React.ReactNode }) {
  const contextMenu = useContextMenu(menu);
  return (
    <div {...contextMenu} className="flex items-center gap-2 px-3 py-2 transition-colors hover:bg-surface-800/50 sm:gap-3 sm:px-4">
      {children}
    </div>
  );
}

/** The host's own filesystem, as the service account — or as root while Admin Mode is on. */
export function HostFilesBrowser() {
  const status = useAdminMode();
  if (!status) return <Spinner />;
  return <Browser status={status} key={String(status.admin.active)} />;
}

function Browser({ status }: { status: HostFilesStatus }) {
  const tools = pathTools(status.platform);
  const admin = status.admin.active;
  const confirm = useConfirm();
  const toast = useToast();
  const [path, setPath] = useState(() => sessionStorage.getItem('outpost_host_files_path') || status.home);
  const [pathInput, setPathInput] = useState(path);
  const [entries, setEntries] = useState<HostFileEntry[] | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const fail = (fallback: string) => (err: unknown) => setError(err instanceof ApiError ? err.message : fallback);
  const copy = (text: string, what: string) => copyToClipboard(text).then((ok) => (ok ? toast.success(`${what} copied`) : toast.error('Copy failed')));
  const fileUrl = (entry: HostFileEntry) => downloadUrl(`/host-files/download?path=${encodeURIComponent(entry.path)}`);

  const load = useCallback(async (target: string) => {
    setEntries(null);
    try {
      const res = await api.get<{ path: string; entries: HostFileEntry[] }>(`/host-files/list?path=${encodeURIComponent(target)}`);
      setEntries(res.entries);
      setPathInput(res.path);
      sessionStorage.setItem('outpost_host_files_path', res.path);
      setError('');
    } catch (err) {
      setEntries([]);
      fail('Failed to list files')(err);
    }
  }, []);

  useEffect(() => {
    void load(path);
  }, [path, load]);

  const go = (target: string) => (target === path ? load(target) : setPath(target));

  async function openFile(entry: HostFileEntry) {
    if (!EDITABLE_EXT.test(entry.name) && entry.size > 512 * 1024) {
      window.open(fileUrl(entry), '_blank');
      return;
    }
    try {
      const res = await api.get<{ content: string }>(`/host-files/content?path=${encodeURIComponent(entry.path)}`);
      setEditing(entry.path);
      setContent(res.content);
      setDirty(false);
    } catch (err) {
      fail('Failed to open file')(err);
    }
  }

  async function save() {
    if (!editing) return;
    setSaving(true);
    try {
      await api.put('/host-files/content', { path: editing, content });
      setDirty(false);
      toast.success('Saved');
    } catch (err) {
      fail('Failed to save file')(err);
    } finally {
      setSaving(false);
    }
  }

  async function createFolder() {
    const name = window.prompt('New folder name');
    if (!name) return;
    await api.post('/host-files/mkdir', { path: tools.join(path, name) }).then(() => load(path), fail('Failed to create folder'));
  }

  async function createFile() {
    const name = window.prompt('New file name');
    if (!name) return;
    const target = tools.join(path, name);
    if (entries?.some((e) => e.name === name)) return setError(`${name} already exists`);
    await api.put('/host-files/content', { path: target, content: '' }).then(() => load(path), fail('Failed to create file'));
  }

  async function rename(entry: HostFileEntry) {
    const name = window.prompt('Rename to', entry.name);
    if (!name || name === entry.name) return;
    await api.post('/host-files/rename', { from: entry.path, to: tools.join(tools.parent(entry.path), name) }).then(() => load(path), fail('Failed to rename'));
  }

  async function remove(entry: HostFileEntry) {
    const ok = await confirm({
      title: entry.isDirectory ? 'Delete folder' : 'Delete file',
      message: `Delete ${entry.path}${entry.isDirectory && !entry.isSymlink ? ' and everything in it' : ''}? This cannot be undone.${admin ? ' Admin Mode is on: this runs as root.' : ''}`,
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    await api.delete(`/host-files?path=${encodeURIComponent(entry.path)}`).then(() => load(path), fail('Failed to delete'));
  }

  async function onUpload(files: FileList | null) {
    if (!files?.length || uploadProgress) return;
    const form = new FormData();
    form.append('path', path);
    Array.from(files).forEach((f) => form.append('files', f));
    try {
      await api.upload('/host-files/upload', form, setUploadProgress);
      await load(path);
    } catch (err) {
      fail('Upload failed')(err);
    } finally {
      setUploadProgress(null);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  const entryMenu = (entry: HostFileEntry) => (): MenuItems => [
    { heading: entry.name },
    entry.isDirectory
      ? { label: 'Open', icon: 'folder', onSelect: () => go(entry.path) }
      : { label: 'Open', icon: 'edit', onSelect: () => openFile(entry) },
    !entry.isDirectory && { label: 'Download', icon: 'download', onSelect: () => window.open(fileUrl(entry), '_blank') },
    'separator',
    { label: 'Rename…', icon: 'edit', onSelect: () => rename(entry) },
    { label: 'Copy path', icon: 'copy', onSelect: () => copy(entry.path, 'Path') },
    'separator',
    { label: 'Delete', icon: 'trash', danger: true, onSelect: () => remove(entry) },
  ];

  const folderMenu = useContextMenu((): MenuItems => [
    { label: 'New folder…', icon: 'folder', onSelect: createFolder },
    { label: 'New file…', icon: 'file', onSelect: createFile },
    { label: 'Upload files…', icon: 'upload', disabled: !!uploadProgress, onSelect: () => fileInput.current?.click() },
    { label: 'Refresh', icon: 'refresh', onSelect: () => load(path) },
    'separator',
    { label: 'Up one level', icon: 'chevronUp', onSelect: () => go(tools.parent(path)) },
    { label: 'Copy current path', icon: 'copy', onSelect: () => copy(path, 'Path') },
  ]);

  const banner = admin ? (
    <Notice tone="warning">
      <span className="inline-flex items-center gap-2">
        <Icon name="unlock" className="h-4 w-4 shrink-0" />
        Admin Mode — files are read and written as <b>root</b>. Turn it off from the top bar when you're done.
      </span>
    </Notice>
  ) : (
    <Notice tone="info">
      <span className="inline-flex items-center gap-2">
        <Icon name="lock" className="h-4 w-4 shrink-0" />
        Limited access — acting as <b>{status.serviceUser}</b>.{' '}
        {status.admin.available ? 'Use Admin Mode in the top bar for files this account can’t reach.' : status.admin.reason}
      </span>
    </Notice>
  );

  if (editing) {
    return (
      <div className="flex h-[calc(100dvh-10rem)] min-h-[20rem] flex-col gap-3">
        {banner}
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <Button
            variant="ghost"
            onClick={async () => {
              if (dirty && !(await confirm({ title: 'Discard changes', message: 'Discard unsaved changes to this file?', confirmLabel: 'Discard', tone: 'danger' }))) return;
              setEditing(null);
            }}
          >
            ← Back
          </Button>
          <span className="min-w-0 truncate font-mono text-sm text-ink-300" title={editing}>{editing}</span>
          <Button className="ml-auto" variant="primary" onClick={save} disabled={!dirty || saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
        <ErrorText>{error}</ErrorText>
        <textarea
          className="console-view flex-1 resize-none rounded-lg border border-surface-700 bg-surface-900 p-4 text-[13px] text-ink-200 focus:outline-none focus:ring-2 focus:ring-accent-600/60"
          value={content}
          spellCheck={false}
          onChange={(e) => {
            setContent(e.target.value);
            setDirty(true);
          }}
        />
      </div>
    );
  }

  const visible = entries?.filter((e) => showHidden || !e.name.startsWith('.')) ?? null;
  const submitPath = (e: FormEvent) => {
    e.preventDefault();
    if (pathInput.trim()) go(pathInput.trim());
  };

  return (
    <div className="space-y-3">
      {banner}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" onClick={() => go(tools.parent(path))} title="Up one level" aria-label="Up one level">
          <Icon name="chevronUp" className="h-4 w-4" />
        </Button>
        <Button variant="ghost" onClick={() => go(status.home)} title={`Home (${status.home})`}>
          Home
        </Button>
        <form onSubmit={submitPath} className="min-w-[12rem] flex-1">
          <Input value={pathInput} onChange={(e) => setPathInput(e.target.value)} className="font-mono" aria-label="Path" spellCheck={false} />
        </form>
        <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => onUpload(e.target.files)} />
        <Button disabled={!!uploadProgress} onClick={() => fileInput.current?.click()}>Upload</Button>
        <Button onClick={createFolder}>New folder</Button>
        <Button onClick={createFile}>New file</Button>
      </div>
      <div className="flex flex-wrap items-center gap-x-1 gap-y-1 text-sm">
        {tools.crumbs(path).map((crumb, i, all) => (
          <span key={crumb.path} className="flex items-center gap-1 text-ink-400">
            <button className="hover:text-accent-500 hover:underline" onClick={() => go(crumb.path)}>{crumb.label}</button>
            {crumb.label !== '/' && i < all.length - 1 && tools.sep}
          </span>
        ))}
        <label className="ml-auto flex items-center gap-2 text-xs text-ink-400">
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> Show hidden files
        </label>
      </div>

      <UploadTracker progress={uploadProgress} />
      <ErrorText>{error}</ErrorText>

      <Card {...folderMenu} className="divide-y divide-surface-800">
        {visible === null ? (
          <p className="px-4 py-3 text-sm text-ink-500">Loading…</p>
        ) : visible.length === 0 ? (
          <p className="px-4 py-3 text-sm text-ink-500">{error ? 'This folder could not be opened.' : 'This folder is empty.'}</p>
        ) : (
          visible.map((entry) => (
            <Row key={entry.path} menu={entryMenu(entry)}>
              <button
                className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left text-sm"
                onClick={() => (entry.isDirectory ? go(entry.path) : openFile(entry))}
              >
                <span className="shrink-0">{entry.isDirectory ? '📁' : '📄'}</span>
                <span className="min-w-0">
                  <span className="block truncate text-ink-200">
                    {entry.name}
                    {entry.isSymlink && <span className="ml-1 text-xs text-ink-500">↪ link</span>}
                  </span>
                  <span className="block truncate text-xs text-ink-500 sm:hidden">
                    {entry.isDirectory ? '' : `${formatSize(entry.size)} · `}
                    {new Date(entry.modifiedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                  </span>
                </span>
              </button>
              {entry.permissions && (
                <span className="hidden w-48 shrink-0 truncate text-right font-mono text-xs text-ink-500 lg:block" title={`${entry.owner}:${entry.group} ${entry.permissions}`}>
                  {entry.permissions} {entry.owner}:{entry.group}
                </span>
              )}
              <span className="hidden w-20 shrink-0 text-right text-xs text-ink-500 sm:block">{entry.isDirectory ? '' : formatSize(entry.size)}</span>
              <span className="hidden w-36 shrink-0 text-right text-xs text-ink-500 md:block">{new Date(entry.modifiedAt).toLocaleString()}</span>
              <div className="flex shrink-0 gap-0.5 sm:gap-1">
                {!entry.isDirectory && (
                  <a className="rounded p-2 text-xs text-ink-400 hover:bg-surface-700 hover:text-ink-200 sm:px-2 sm:py-1" href={fileUrl(entry)} title="Download" aria-label={`Download ${entry.name}`}>
                    <Icon name="download" className="h-4 w-4" />
                  </a>
                )}
                <button className="rounded p-2 text-xs text-ink-400 hover:bg-surface-700 hover:text-ink-200 sm:px-2 sm:py-1" onClick={() => rename(entry)} title="Rename" aria-label={`Rename ${entry.name}`}>
                  <Icon name="edit" className="h-4 w-4" />
                </button>
                <button className="rounded p-2 text-xs text-red-400 hover:bg-red-500/10 sm:px-2 sm:py-1" onClick={() => remove(entry)} title="Delete" aria-label={`Delete ${entry.name}`}>
                  <Icon name="trash" className="h-4 w-4" />
                </button>
              </div>
            </Row>
          ))
        )}
      </Card>
    </div>
  );
}
