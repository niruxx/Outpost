import { prep } from '../db/db.js';
import { HttpError } from '../utils/asyncHandler.js';

export const WALLPAPER_STYLES = ['theme', 'aurora', 'starfield', 'bubbles', 'fireflies', 'rain', 'waves'] as const;
export interface WallpaperPreferences {
  style: typeof WALLPAPER_STYLES[number];
  animated: boolean;
  speed: 'slow' | 'normal' | 'fast';
  intensity: 'subtle' | 'balanced' | 'bold';
}
export function validateWallpaper(input: unknown): WallpaperPreferences {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Wallpaper preferences are required');
  const p = input as Record<string, unknown>;
  if (!WALLPAPER_STYLES.includes(p.style as WallpaperPreferences['style']) || typeof p.animated !== 'boolean' || !['slow', 'normal', 'fast'].includes(String(p.speed)) || !['subtle', 'balanced', 'bold'].includes(String(p.intensity))) throw new HttpError(400, 'Invalid wallpaper style, motion, speed or intensity');
  return { style: p.style as WallpaperPreferences['style'], animated: p.animated, speed: p.speed as WallpaperPreferences['speed'], intensity: p.intensity as WallpaperPreferences['intensity'] };
}
export function saveUserWallpaper(userId: string, input: unknown) {
  const preferences = validateWallpaper(input);
  prep('UPDATE users SET wallpaper_preferences = ? WHERE id = ?').run(JSON.stringify(preferences), userId);
  return preferences;
}
