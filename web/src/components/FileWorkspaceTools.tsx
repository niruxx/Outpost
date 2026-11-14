import { useState } from 'react';
import { api } from '../api/client.js';
import { Button, Input } from './ui.js';
import { useConfirm } from './ConfirmDialog.js';

type Match = { path: string; size: number; line?: number; preview?: string };
type Trash = { id: string; path: string; deletedAt: number; expires: number; directory: boolean };
export function FileWorkspaceTools({ serverId, canWrite, onOpen, onChanged }: { serverId: string; canWrite: boolean; onOpen: (entry: Match) => void; onChanged: () => void }) {
  const [tab, setTab] = useState(''); const [query, setQuery] = useState(''); const [name, setName] = useState(''); const [ext, setExt] = useState('');
  const [matches, setMatches] = useState<Match[]>([]); const [items, setItems] = useState<Trash[]>([]); const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false);
  const confirm = useConfirm(); const prefix = `/servers/${serverId}/files`;
  async function loadTrash() { try { setItems((await api.get<{ items: Trash[] }>(`${prefix}/recycle`)).items); setError(''); } catch (e) { setError((e as Error).message); } }
  async function search() {
    setBusy(true); setError('');
    try { const r = await api.get<{ matches: Match[]; truncated: boolean }>(`${prefix}/search?${new URLSearchParams({ q: query, name, extension: ext })}`); setMatches(r.matches); setNotice(r.truncated ? 'Search limit reached. Narrow the filename or type filter.' : `${r.matches.length} results. Content search skips binary files and files over 1 MiB.`); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function act(item: Trash, purge: boolean) {
    if (purge && !await confirm({ title: 'Delete permanently', message: `Permanently delete ${item.path}? This cannot be undone.`, confirmLabel: 'Delete permanently', tone: 'danger' })) return;
    setBusy(true); try { if (purge) await api.delete(`${prefix}/recycle/${item.id}`); else await api.post(`${prefix}/recycle/${item.id}/restore`); await loadTrash(); onChanged(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <section className="space-y-2">
    <div className="flex gap-2"><Button onClick={() => { setTab(tab === 'search' ? '' : 'search'); setError(''); }}>Search files</Button><Button onClick={() => { setTab(tab === 'trash' ? '' : 'trash'); void loadTrash(); }}>Recycle bin</Button></div>
    {tab === 'search' && <form className="space-y-2 rounded border border-surface-700 p-3" onSubmit={e => { e.preventDefault(); void search(); }}>
      <div className="flex flex-wrap gap-2"><Input aria-label="Search file contents" placeholder="Content contains" value={query} onChange={e => setQuery(e.target.value)} /><Input aria-label="Filename filter" placeholder="Filename contains" value={name} onChange={e => setName(e.target.value)} /><Input aria-label="File type filter" placeholder="Type, e.g. properties" value={ext} onChange={e => setExt(e.target.value)} /><Button type="submit" disabled={busy}>Search</Button></div>
      <p className="text-xs text-ink-400">{notice}</p>{matches.map(m => <button type="button" key={m.path} className="block w-full break-all rounded p-2 text-left text-sm hover:bg-surface-800" onClick={() => onOpen(m)}>{m.path}{m.line ? `:${m.line}` : ''}<span className="block text-xs text-ink-400">{m.preview}</span></button>)}
    </form>}
    {tab === 'trash' && <div className="space-y-2 rounded border border-surface-700 p-3"><p className="text-xs text-ink-400">Deleted items are retained for 30 days. Restore scans content when antivirus is enabled and refuses to overwrite existing files.</p><Button onClick={loadTrash}>Refresh</Button>{!items.length && <p>No recycled files.</p>}{items.map(item => <div key={item.id} className="flex flex-wrap items-center gap-2 text-sm"><span className="min-w-0 flex-1 break-all">{item.path}<small className="block">Expires {new Date(item.expires).toLocaleString()}</small></span>{canWrite && <><Button disabled={busy} onClick={() => act(item, false)}>Restore</Button><Button disabled={busy} onClick={() => act(item, true)}>Delete permanently</Button></>}</div>)}</div>}
    {error && <p role="alert" className="text-red-400">{error}</p>}
  </section>;
}
