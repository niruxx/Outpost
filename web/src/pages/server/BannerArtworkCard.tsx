import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type UploadProgress } from '../../api/client.js';
import type { BannerArtwork } from '../../api/types.js';
import { Button, Card, CardTitle, ErrorText, Field, Notice } from '../../components/ui.js';
import { GameBanner } from '../../components/GameBanner.js';
import { gameKindOf } from '../../components/GameArt.js';
import { UploadTracker } from '../../components/UploadTracker.js';
import { useServerDetail } from './ServerContext.js';
import { useToast } from '../../components/Toast.js';
import { useConfirm } from '../../components/ConfirmDialog.js';
import { useUnsavedChanges } from '../../lib/unsaved.js';

export function BannerArtworkCard() {
  const { serverId, server, can, refresh } = useServerDetail();
  const toast = useToast(), confirm = useConfirm(), input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null), [preview, setPreview] = useState<string | null>(null);
  const [positionX, setX] = useState(50), [positionY, setY] = useState(50);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const artwork = server?.banner;
  const dirty = !!file || (!!artwork && (positionX !== artwork.positionX || positionY !== artwork.positionY));
  useUnsavedChanges(dirty, 'Banner artwork');
  useEffect(() => { setX(artwork?.positionX ?? 50); setY(artwork?.positionY ?? 50); }, [serverId, artwork?.version, artwork?.positionX, artwork?.positionY]);
  useEffect(() => {
    setPreview(null); if (!file) return;
    const url = URL.createObjectURL(file), image = new Image(); let cancelled = false;
    image.onload = () => {
      if (cancelled) return;
      if (image.naturalWidth < 32 || image.naturalHeight < 16 || image.naturalWidth > 8192 || image.naturalHeight > 8192 || image.naturalWidth * image.naturalHeight > 16_000_000) { setError('Choose an image at least 32×16 pixels, no larger than 8192×8192 or 16 megapixels'); setFile(null); return; }
      setPreview(url);
    };
    image.onerror = () => { if (!cancelled) { setError('This image could not be decoded. Choose a PNG, JPEG or WebP file.'); setFile(null); } };
    image.src = url;
    return () => { cancelled = true; image.onload = null; image.onerror = null; URL.revokeObjectURL(url); };
  }, [file]);
  if (!server) return null;
  const disabled = busy || !can('settings');
  function choose(next: File | undefined) {
    setError(''); if (!next) return;
    if (next.size > 8 * 1048576) { setError('Choose a banner image under 8 MB'); return; }
    if (next.type && !['image/png', 'image/jpeg', 'image/webp'].includes(next.type)) { setError('Choose PNG, JPEG or WebP artwork'); return; }
    setFile(next); setX(50); setY(50);
  }
  async function save() {
    setBusy(true); setError('');
    const x = positionX, y = positionY;
    try {
      let next = artwork;
      if (file) { const form = new FormData(); form.append('file', file); next = (await api.upload<{ banner: BannerArtwork }>(`/servers/${serverId}/banner`, form, setProgress)).banner; }
      if (next && (x !== next.positionX || y !== next.positionY)) await api.patch(`/servers/${serverId}/banner`, { version: next.version, positionX: x, positionY: y });
      setFile(null); await refresh(); toast.success('Instance banner saved');
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Could not save banner artwork'); }
    finally { setBusy(false); setProgress(null); }
  }
  const renderPreview = (fade: boolean) => <GameBanner kind={gameKindOf(server!)} seed={serverId} serverId={serverId} artwork={artwork ? { ...artwork, positionX, positionY } : null} previewUrl={preview} positionX={positionX} positionY={positionY} fade={fade} />;
  return <Card className="p-5">
    <CardTitle>Custom instance banner</CardTitle>
    <p className="mb-4 text-sm text-ink-400">Upload your own artwork for this instance, including games and apps without built-in artwork. It appears in the instance header and banner cards for everyone with access.</p>
    <div className="relative h-36 overflow-hidden rounded-2xl bg-surface-950" aria-label="Instance header banner preview">{renderPreview(true)}</div>
    <p className="mb-3 mt-1 text-xs text-ink-400">Header preview</p>
    <div className="relative h-24 w-full max-w-sm overflow-hidden rounded-2xl bg-surface-950" aria-label="Instance card banner preview">{renderPreview(false)}</div>
    <p className="mb-4 mt-1 text-xs text-ink-400">Card preview — cropping depends on screen width.</p>
    <UploadTracker progress={progress} /><ErrorText>{error}</ErrorText>
    {!can('settings') && <Notice tone="info">Editing instance artwork requires configuration permission.</Notice>}
    <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" aria-label="Choose custom banner artwork" className="hidden" disabled={disabled} onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ''; }} />
    <div className="mt-4 flex flex-wrap gap-2">
      <Button disabled={disabled} onClick={() => input.current?.click()}>Choose image</Button>
      <Button variant="primary" disabled={disabled || !dirty || (!!file && !preview)} onClick={() => void save()}>{busy ? 'Saving…' : file ? 'Upload banner' : 'Save position'}</Button>
      {dirty && <Button variant="ghost" disabled={busy} onClick={() => { setFile(null); setX(artwork?.positionX ?? 50); setY(artwork?.positionY ?? 50); setError(''); }}>Discard changes</Button>}
      {artwork && <Button variant="ghost" disabled={disabled} onClick={async () => {
        if (!await confirm({ title: 'Restore default banner', message: 'Remove this instance’s custom artwork and use its default banner?', confirmLabel: 'Restore default' })) return;
        setBusy(true); setError('');
        try { await api.delete(`/servers/${serverId}/banner`, { version: artwork.version }); setFile(null); await refresh(); toast.success('Default banner restored'); }
        catch (err) { setError(err instanceof ApiError ? err.message : 'Could not restore the default banner'); }
        finally { setBusy(false); }
      }}>Restore default</Button>}
    </div>
    {(artwork || preview) && <fieldset disabled={disabled} className="mt-4 grid gap-4 sm:grid-cols-2"><legend className="sr-only">Banner crop position</legend>
      <Field label={`Horizontal focus: ${positionX}%`}><input aria-label="Horizontal banner focus" type="range" min={0} max={100} value={positionX} onChange={(e) => setX(Number(e.target.value))} className="w-full accent-accent-400" /></Field>
      <Field label={`Vertical focus: ${positionY}%`}><input aria-label="Vertical banner focus" type="range" min={0} max={100} value={positionY} onChange={(e) => setY(Number(e.target.value))} className="w-full accent-accent-400" /></Field>
    </fieldset>}
    <p className="mt-3 text-xs text-ink-400">PNG, JPEG or still WebP, up to 8 MB and 16 megapixels. A wide image around 1200×300 works best. Artwork is stored with this instance’s files; missing images fall back to the default banner.</p>
    {file && <p className="mt-1 break-all text-xs text-ink-400">Selected: {file.name}</p>}
  </Card>;
}
