import { useEffect, useRef, useState } from 'react';
import { api, getToken } from '../api/client.js';
import { Button, Input } from './ui.js';

type Transfer = { id: string; path: string; size: number; offset: number; state: string; result?: string; fingerprint: string };
type Row = { key: string; path: string; file?: File; transfer?: Transfer; percent: number; state: string; error?: string; controller?: AbortController };
const CHUNK = 1024 * 1024;
const sha = async (value: ArrayBuffer) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', value)), b => b.toString(16).padStart(2, '0')).join('');
const wait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) return reject(new Error('Paused'));
  const abort = () => { clearTimeout(timer); reject(new Error('Paused')); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
  signal.addEventListener('abort', abort, { once: true });
});

export function FileUploadQueue({ serverId, basePath, onChanged }: { serverId: string; basePath: string; onChanged: () => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const rowsRef = useRef(rows); rowsRef.current = rows;
  const [collision, setCollision] = useState('skip');
  const [concurrency, setConcurrency] = useState(2);
  const [rate, setRate] = useState(0);
  const controls = useRef({ rate, collision }); controls.current = { rate, collision };
  const [error, setError] = useState('');
  const active = useRef(new Set<string>());
  const nextSlot = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const prefix = `/servers/${serverId}/files/transfers`;
  const update = (key: string, patch: Partial<Row>) => setRows(old => old.map(row => row.key === key ? { ...row, ...patch } : row));
  useEffect(() => {
    let live = true;
    api.get<{ items: Transfer[] }>(prefix).then(({ items }) => { if (live) setRows(items.filter(t => !['done', 'skipped'].includes(t.state)).map(t => ({ key: t.id, path: t.path, transfer: t, percent: t.size ? t.offset / t.size * 100 : 0, state: t.state === 'publishing' ? 'Review interrupted publication' : 'Reselect file to resume' }))); }).catch(e => live && setError(e.message));
    return () => { live = false; rowsRef.current.forEach(r => r.controller?.abort()); };
  }, [prefix]);

  function enqueue(files: { file: File; relative: string }[]) {
    setRows(old => {
      const result = [...old];
      for (const { file, relative } of files) {
        const path = [basePath, relative].filter(Boolean).join('/');
        const existing = result.find(r => r.path === path && r.transfer?.size === file.size && !r.file && r.transfer.state !== 'publishing');
        if (existing) { existing.file = file; existing.state = 'Queued'; }
        else result.push({ key: crypto.randomUUID(), path, file, percent: 0, state: 'Queued' });
      }
      return result;
    });
  }
  async function drop(event: React.DragEvent) {
    event.preventDefault();
    // DirectoryEntry is supported by Chromium and Firefox for dropped folders.
    type Entry = { isFile: boolean; isDirectory: boolean; name: string; file: (ok: (file: File) => void, fail: (e: unknown) => void) => void; createReader: () => { readEntries: (ok: (entries: Entry[]) => void, fail: (e: unknown) => void) => void } };
    const files: { file: File; relative: string }[] = [];
    async function walk(entry: Entry, parent: string) {
      if (files.length > 10000) throw new Error('Upload at most 10,000 files per selection');
      const relative = parent + entry.name;
      if (entry.isFile) files.push({ file: await new Promise<File>((ok, fail) => entry.file(ok, fail)), relative });
      else if (entry.isDirectory) {
        const reader = entry.createReader();
        for (;;) { const entries = await new Promise<Entry[]>((ok, fail) => reader.readEntries(ok, fail)); if (!entries.length) break; for (const child of entries) await walk(child, relative + '/'); }
      }
    }
    const items = Array.from(event.dataTransfer.items);
    const fallback = Array.from(event.dataTransfer.files);
    // Capture entries before the drop event's protected data store closes.
    const entries = items.map(item => (item as DataTransferItem & { webkitGetAsEntry?: () => Entry | null }).webkitGetAsEntry?.());
    try { if (entries.some(Boolean)) { for (const entry of entries) if (entry) await walk(entry as unknown as Entry, ''); enqueue(files); } else enqueue(fallback.map(file => ({ file, relative: file.name }))); } catch (e) { setError((e as Error).message); }
  }
  async function run(row: Row) {
    const controller = new AbortController(); const signal = controller.signal;
    update(row.key, { state: 'Hashing', controller, error: undefined });
    try {
      if (!crypto.subtle) throw new Error('Resumable uploads require HTTPS or localhost for checksum verification.');
      const file = row.file!; const hashes: string[] = [];
      for (let offset = 0; offset < file.size; offset += CHUNK) { signal.throwIfAborted(); hashes.push(await sha(await file.slice(offset, offset + CHUNK).arrayBuffer())); }
      signal.throwIfAborted();
      if (row.transfer && row.transfer.fingerprint !== await sha(new TextEncoder().encode(JSON.stringify(hashes)).buffer)) throw new Error('Selected file differs from the saved transfer. Select the original file or cancel this transfer.');
      let t = row.transfer ? await api.get<Transfer>(`${prefix}/${row.transfer.id}`) : await api.post<Transfer>(prefix, { path: row.path, size: file.size, hashes, collision: controls.current.collision });
      if (row.transfer && row.transfer.id !== t.id) throw new Error('Selected file differs from the saved transfer. Cancel the old transfer first.');
      update(row.key, { transfer: t, state: 'Uploading' });
      while (t.offset < t.size) {
        signal.throwIfAborted();
        const chunk = file.slice(t.offset, t.offset + CHUNK, 'application/octet-stream');
        const rate = controls.current.rate;
        if (rate > 0) { const now = Date.now(); const start = Math.max(now, nextSlot.current); nextSlot.current = start + chunk.size / (rate * 1024) * 1000; await wait(nextSlot.current - now, signal); }
        let response: Response | undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            response = await fetch(`/api${prefix}/${t.id}/chunk`, { method: 'PUT', headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/octet-stream', 'Upload-Offset': String(t.offset) }, body: chunk, signal });
            if (!response.ok && response.status !== 409) throw new Error((await response.json()).error ?? 'Upload failed');
            break;
          } catch (e) { if (signal.aborted || attempt === 2) throw e; await wait(500 * 2 ** attempt, signal); }
        }
        const previousOffset = t.offset;
        t = await api.get<Transfer>(`${prefix}/${t.id}`);
        if (t.offset === previousOffset) throw new Error('Chunk was rejected. Resume to retry, or cancel if the selected file differs.');
        update(row.key, { transfer: t, percent: t.size ? t.offset / t.size * 100 : 100 });
        if (response?.status === 409 && t.offset < t.size && t.offset % CHUNK !== 0) throw new Error('Invalid saved offset. Cancel and retry.');
      }
      signal.throwIfAborted(); update(row.key, { state: 'Scanning and publishing', percent: 100 });
      t = await api.post<Transfer>(`${prefix}/${t.id}/complete`);
      update(row.key, { transfer: t, state: t.state === 'done' ? 'Complete' : 'Skipped', file: undefined, percent: 100 }); onChanged();
    } catch (e) { update(row.key, { state: signal.aborted ? 'Paused' : 'Failed', error: signal.aborted ? undefined : (e as Error).message }); }
    finally { active.current.delete(row.key); update(row.key, { controller: undefined }); }
  }
  useEffect(() => {
    for (const row of rows) { if (active.current.size >= concurrency) break; if (row.state === 'Queued' && row.file && !active.current.has(row.key)) { active.current.add(row.key); void run(row); } }
  }, [rows, concurrency]);
  async function cancel(row: Row) {
    row.controller?.abort();
    if (active.current.has(row.key)) { update(row.key, { state: 'Paused' }); return; }
    try { if (row.transfer) await api.delete(`${prefix}/${row.transfer.id}`); setRows(old => old.filter(r => r.key !== row.key)); } catch (e) { setError((e as Error).message); }
  }
  return <section className="space-y-2 rounded-lg border border-surface-700 p-3" onDragOver={e => e.preventDefault()} onDrop={drop} aria-label="Upload queue">
    <div className="flex flex-wrap items-center gap-2">
      <input ref={input} type="file" multiple hidden data-upload-instance={serverId} onChange={e => { enqueue(Array.from(e.target.files ?? []).map(file => ({ file, relative: file.name }))); e.target.value = ''; }} />
      <input ref={folder} type="file" multiple hidden {...{ webkitdirectory: '' }} onChange={e => { enqueue(Array.from(e.target.files ?? []).map(file => ({ file, relative: file.webkitRelativePath || file.name }))); e.target.value = ''; }} />
      <Button onClick={() => input.current?.click()}>Upload files</Button><Button onClick={() => folder.current?.click()}>Upload folder</Button>
      <label className="text-xs">Collision <select value={collision} onChange={e => setCollision(e.target.value)}><option value="skip">Skip existing</option><option value="rename">Rename incoming</option><option value="replace">Replace (recycle existing)</option></select></label>
      <label className="text-xs">Concurrent <select value={concurrency} onChange={e => setConcurrency(+e.target.value)}>{[1, 2, 3, 4].map(n => <option key={n}>{n}</option>)}</select></label>
      <label className="text-xs">Bandwidth target KiB/s (0 unlimited)<Input type="number" min={0} max={1000000} value={rate} onChange={e => setRate(Math.max(0, +e.target.value))} /></label>
    </div>
    <p className="text-xs text-ink-400">Drop files or folders here. Transfers expire after 48 hours. Reselect the same files after reopening to resume. Bandwidth is paced in 1 MiB chunks; bursts are possible. Empty folders are not uploaded.</p>
    {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
    <div aria-live="polite">{rows.map(row => <div key={row.key} className="my-2 rounded border border-surface-700 p-2 text-sm">
      <p className="break-all">{row.path}{row.transfer?.result && row.transfer.result !== row.path ? ` → ${row.transfer.result}` : ''}</p>
      <div className="flex flex-wrap items-center gap-2"><progress max={100} value={row.percent} aria-label={`Upload ${row.path}`} /><span>{Math.floor(row.percent)}% · {row.state}</span>
        {row.controller && row.state !== 'Scanning and publishing' && <Button onClick={() => row.controller?.abort()}>Pause</Button>}
        {!row.controller && row.file && ['Paused', 'Failed'].includes(row.state) && <Button onClick={() => update(row.key, { state: 'Queued' })}>Resume / retry</Button>}
        {!row.controller && <Button onClick={() => cancel(row)}>{['Complete', 'Skipped'].includes(row.state) ? 'Clear' : 'Cancel'}</Button>}
      </div>{row.error && <p role="alert" className="text-red-400">{row.error}</p>}
    </div>)}</div>
  </section>;
}
