import { useEffect, useState } from 'react';
import { applyWallpaper, storedWallpaper } from './theme.js';

export const WALLPAPERS = [
  { id: 'aurora', label: 'Aurora', description: 'Slow ribbons of light and drifting color.' },
  { id: 'starfield', label: 'Starfield', description: 'A quiet field of softly twinkling stars.' },
  { id: 'bubbles', label: 'Bubbles', description: 'Translucent bubbles floating upwards.' },
  { id: 'fireflies', label: 'Fireflies', description: 'Warm points of light wandering across the screen.' },
  { id: 'rain', label: 'Rain', description: 'Fine, slanting trails of falling rain.' },
  { id: 'waves', label: 'Waves', description: 'Broad, gently rolling waves of color.' },
] as const;
export type WallpaperStyle = 'theme' | typeof WALLPAPERS[number]['id'];
export interface WallpaperPreferences {
  style: WallpaperStyle;
  animated: boolean;
  speed: 'slow' | 'normal' | 'fast';
  intensity: 'subtle' | 'balanced' | 'bold';
}
const KEY = 'outpost_wallpaper_preferences';
const defaults: WallpaperPreferences = { style: 'theme', animated: true, speed: 'normal', intensity: 'balanced' };
function parse(raw: string | null | undefined): WallpaperPreferences | null {
  try {
    const p = JSON.parse(raw ?? 'null');
    if (!p || !['theme', ...WALLPAPERS.map((w) => w.id)].includes(p.style) || typeof p.animated !== 'boolean' || !['slow', 'normal', 'fast'].includes(p.speed) || !['subtle', 'balanced', 'bold'].includes(p.intensity)) return null;
    return { style: p.style, animated: p.animated, speed: p.speed, intensity: p.intensity };
  } catch { return null; }
}
export function storedWallpaperPreferences(): WallpaperPreferences {
  try { return parse(localStorage.getItem(KEY)) ?? { ...defaults, animated: storedWallpaper() === 'animated' }; }
  catch { return { ...defaults }; }
}
let current: WallpaperPreferences | null = null;
const listeners = new Set<(p: WallpaperPreferences) => void>();
export function applyWallpaperPreferences(p: WallpaperPreferences) {
  current = p;
  const root = document.documentElement;
  root.dataset.wallpaperStyle = p.style;
  root.dataset.wallpaperSpeed = p.speed;
  root.dataset.wallpaperIntensity = p.intensity;
  applyWallpaper(p.animated ? 'animated' : 'static');
  for (const listener of listeners) listener(p);
}
export function cacheWallpaperPreferences(p: WallpaperPreferences, userId?: string) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
    if (userId) localStorage.setItem(`${KEY}:${userId}`, JSON.stringify(p));
  } catch { /* This visit still works when browser storage is blocked. */ }
  applyWallpaperPreferences(p);
}
export function applyAccountWallpaper(userId: string, raw: string | null | undefined) {
  let cached: WallpaperPreferences | null = null;
  try { cached = parse(localStorage.getItem(`${KEY}:${userId}`)); } catch { /* default */ }
  // Never inherit another account's custom style on a shared browser.
  cacheWallpaperPreferences(parse(raw) ?? cached ?? { ...defaults, animated: storedWallpaper() === 'animated' }, userId);
}
export function useWallpaperPreferences() {
  const [preferences, setPreferences] = useState(() => current ?? storedWallpaperPreferences());
  useEffect(() => { listeners.add(setPreferences); return () => { listeners.delete(setPreferences); }; }, []);
  return preferences;
}
