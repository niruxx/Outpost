import { useEffect, useState } from 'react';

/**
 * Keeping the panel light on laptops.
 *
 *  - setVisibleInterval: like setInterval, but skips ticks while the tab is hidden and runs once
 *    straight away when it becomes visible again — a background tab costs nothing.
 *  - "Reduce effects": no wallpaper animation, glass blur, pulsing dots or chart animation.
 *    On by choice (Configuration → Appearance) or when the OS asks for reduced motion.
 */

export function setVisibleInterval(fn: () => void, ms: number): () => void {
  const tick = () => {
    if (typeof document === 'undefined' || !document.hidden) fn();
  };
  const timer = setInterval(tick, ms);
  const onVisible = () => {
    if (!document.hidden) fn();
  };
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
  };
}

const EFFECTS_KEY = 'outpost_effects';
export type EffectsMode = 'full' | 'reduced';

const osPrefersReduced = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function storedEffects(): EffectsMode {
  try {
    const v = localStorage.getItem(EFFECTS_KEY);
    if (v === 'full' || v === 'reduced') return v;
  } catch {
    // storage blocked
  }
  return osPrefersReduced() ? 'reduced' : 'full';
}

const listeners = new Set<(m: EffectsMode) => void>();

export function applyEffects(mode: EffectsMode) {
  document.documentElement.dataset.effects = mode;
  for (const l of listeners) l(mode);
}

export function saveEffects(mode: EffectsMode) {
  try {
    localStorage.setItem(EFFECTS_KEY, mode);
  } catch {
    // this visit only
  }
  applyEffects(mode);
}

export function effectsReduced(): boolean {
  return document.documentElement.dataset.effects === 'reduced';
}

/** Re-renders when the setting changes. */
export function useEffectsMode(): EffectsMode {
  const [mode, setMode] = useState<EffectsMode>(() => (effectsReduced() ? 'reduced' : 'full'));
  useEffect(() => {
    listeners.add(setMode);
    return () => {
      listeners.delete(setMode);
    };
  }, []);
  return mode;
}
