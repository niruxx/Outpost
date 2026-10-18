/**
 * UI themes. Each one is a `data-theme` value on <html>: index.css swaps the color tokens for it
 * and, for the retro themes, restyles the shared components (cards, buttons, fields, dialogs…)
 * through their `ui-*` class hooks. The choice is per browser.
 */
export type ThemeId = 'outpost' | 'xp' | 'minecraft';

export interface ThemeOption {
  id: ThemeId;
  label: string;
  description: string;
  /** Browser UI color (mobile address bar). */
  chrome: string;
  /** Swatches for the picker preview: page, panel, accent, text. */
  swatch: [string, string, string, string];
}

export const THEMES: ThemeOption[] = [
  {
    id: 'outpost',
    label: 'Outpost',
    description: 'The default dark Material look.',
    chrome: '#11140f',
    swatch: ['#11140f', '#1d211b', '#78dc77', '#e1e4da'],
  },
  {
    id: 'xp',
    label: 'Windows XP',
    description: 'Luna blue task panes, beige windows and glossy buttons.',
    chrome: '#0a5fe8',
    swatch: ['#ece9d8', '#ffffff', '#0054e3', '#000000'],
  },
  {
    id: 'minecraft',
    label: 'Minecraft',
    description: 'Square inventory panels, stone buttons and a pixel font.',
    chrome: '#593d29',
    swatch: ['#aaaaaa', '#c6c6c6', '#5d9c3a', '#3f3f3f'],
  },
];

const STORAGE_KEY = 'outpost_theme';

function isTheme(value: unknown): value is ThemeId {
  return THEMES.some((t) => t.id === value);
}

export function storedTheme(): ThemeId {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isTheme(v) ? v : 'outpost';
  } catch {
    return 'outpost';
  }
}

export function applyTheme(id: ThemeId) {
  document.documentElement.dataset.theme = id;
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute('content', THEMES.find((t) => t.id === id)?.chrome ?? THEMES[0].chrome);
}

export function saveTheme(id: ThemeId) {
  applyTheme(id);
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // private window or blocked storage — the theme still applies for this visit
  }
}
