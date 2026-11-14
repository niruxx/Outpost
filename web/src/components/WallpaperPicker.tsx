import { useState } from 'react';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../state/AuthContext.js';
import { WALLPAPERS, cacheWallpaperPreferences, useWallpaperPreferences, type WallpaperPreferences } from '../lib/wallpaper.js';
import { useEffectsMode } from '../lib/perf.js';
import { ErrorText, Field, Select } from './ui.js';
import { WallpaperScene } from './Wallpaper.js';

export function WallpaperPicker() {
  const { user } = useAuth();
  const preferences = useWallpaperPreferences(), effects = useEffectsMode();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function choose(patch: Partial<WallpaperPreferences>) {
    if (!user || busy) return;
    setBusy(true); setError('');
    try {
      const { wallpaper } = await api.put<{ wallpaper: WallpaperPreferences }>('/auth/appearance', { wallpaper: { ...preferences, ...patch } });
      cacheWallpaperPreferences(wallpaper, user.id);
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Could not save your background preferences'); }
    finally { setBusy(false); }
  }
  return <section className="mt-6 space-y-3" aria-labelledby="wallpaper-heading">
    <div><h3 id="wallpaper-heading" className="text-base font-medium text-ink-100">Background animation</h3><p className="mt-1 text-xs text-ink-400">Choose independently of your theme. Saved to your account and restored when you sign in on another browser.</p></div>
    <fieldset disabled={busy} className="space-y-3">
      <legend className="sr-only">Background animation preferences</legend>
      <label className="flex items-center gap-2 text-sm text-ink-200"><input type="radio" name="wallpaper-style" value="theme" checked={preferences.style === 'theme'} onChange={() => void choose({ style: 'theme' })} />Use theme background</label>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {WALLPAPERS.map((wallpaper) => <label key={wallpaper.id} className={`wallpaper-option cursor-pointer rounded-2xl border p-2 transition-colors focus-within:ring-2 focus-within:ring-accent-400 ${preferences.style === wallpaper.id ? 'border-accent-400 bg-secondary-container text-secondary-on-container' : 'border-surface-700 bg-surface-900 text-ink-200'}`}>
          <div className="wallpaper-preview relative h-24 overflow-hidden rounded-xl bg-surface-950"><WallpaperScene style={wallpaper.id} preview /></div>
          <span className="mt-2 flex items-center gap-2 px-1 text-sm font-medium"><input type="radio" name="wallpaper-style" value={wallpaper.id} checked={preferences.style === wallpaper.id} onChange={() => void choose({ style: wallpaper.id })} />{wallpaper.label}</span>
          <span className="mt-1 block px-1 pb-1 text-xs opacity-80">{wallpaper.description}</span>
        </label>)}
      </div>
      <div className="grid gap-3 rounded-2xl bg-surface-900 p-3 sm:grid-cols-2">
        <Field label="Animation speed"><Select aria-label="Animation speed" disabled={preferences.style === 'theme'} value={preferences.speed} onChange={(e) => void choose({ speed: e.target.value as WallpaperPreferences['speed'] })}><option value="slow">Slow</option><option value="normal">Normal</option><option value="fast">Fast</option></Select></Field>
        <Field label="Background intensity"><Select aria-label="Background intensity" disabled={preferences.style === 'theme'} value={preferences.intensity} onChange={(e) => void choose({ intensity: e.target.value as WallpaperPreferences['intensity'] })}><option value="subtle">Subtle</option><option value="balanced">Balanced</option><option value="bold">Bold</option></Select></Field>
        <p className="text-xs text-ink-400 sm:col-span-2">Speed and intensity apply to the six custom styles. Theme background keeps the theme’s original artwork.</p>
      </div>
      <label className="flex items-start gap-3 rounded-2xl bg-surface-900 p-3 text-sm text-ink-200"><input type="checkbox" className="mt-1" checked={preferences.animated} onChange={(e) => void choose({ animated: e.target.checked })} /><span><span className="font-medium">Animate background</span><span className="block text-xs text-ink-400">Turn off to keep a still background. Reduced effects and your device’s reduced-motion setting take priority.</span></span></label>
    </fieldset>
    {effects === 'reduced' && <p className="text-xs text-ink-400" role="status">Reduced effects is on. Your chosen background stays still until reduced effects is turned off.</p>}
    <p className="min-h-4 text-xs text-ink-400" role="status" aria-live="polite">{busy ? 'Saving background…' : ''}</p><ErrorText>{error}</ErrorText>
  </section>;
}
