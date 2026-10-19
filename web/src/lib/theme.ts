/**
 * UI themes. Each one is a `data-theme` value on <html>: index.css swaps the color tokens for it
 * and, for the retro themes, restyles the shared components (cards, buttons, fields, dialogs…)
 * through their `ui-*` class hooks. The choice is per browser; an admin can also give an account
 * a theme that is applied whenever it signs in.
 */
export type ThemeId = 'outpost' | 'xp' | 'minecraft' | 'vista' | 'aero';

export interface ThemeOption {
  id: ThemeId;
  label: string;
  description: string;
  /** Browser UI color (mobile address bar). */
  chrome: string;
  /** Swatches for the picker preview: page, panel, accent, text. */
  swatch: [string, string, string, string];
  /** How the picker's mini window is drawn: sidebar and page backgrounds (any CSS), corner radius, panel border. */
  preview: { sidebar: string; page?: string; radius: number; border?: string };
}

export const THEMES: ThemeOption[] = [
  {
    id: 'outpost',
    label: 'Outpost',
    description: 'The default dark Material look.',
    chrome: '#11140f',
    swatch: ['#11140f', '#1d211b', '#78dc77', '#e1e4da'],
    preview: { sidebar: '#1d211b', radius: 8 },
  },
  {
    id: 'xp',
    label: 'Windows XP',
    description: 'Luna blue task panes, beige windows and glossy buttons.',
    chrome: '#0a5fe8',
    swatch: ['#ece9d8', '#ffffff', '#0054e3', '#000000'],
    preview: { sidebar: 'linear-gradient(#7ba2e7, #6375d6)', radius: 3 },
  },
  {
    id: 'minecraft',
    label: 'Minecraft',
    description: 'Square inventory panels, stone buttons and a pixel font.',
    chrome: '#593d29',
    swatch: ['#aaaaaa', '#c6c6c6', '#5d9c3a', '#3f3f3f'],
    preview: { sidebar: '#4a3524', radius: 0, border: '2px solid #000' },
  },
  {
    id: 'vista',
    label: 'Windows Vista / 7',
    description: 'Aero glass, a deep blue desktop and glossy Explorer buttons.',
    chrome: '#0c3266',
    swatch: ['#eaf1f9', '#ffffff', '#2a7bd4', '#1e395b'],
    preview: {
      sidebar: 'linear-gradient(180deg, rgba(60,110,170,.9), rgba(10,35,70,.95))',
      page: 'radial-gradient(ellipse at 70% 35%, #6fb4ee, transparent 70%), linear-gradient(160deg, #1d5594, #071f45)',
      radius: 4,
      border: '1px solid rgba(110,140,180,.6)',
    },
  },
  {
    id: 'aero',
    label: 'Frutiger Aero',
    description: 'Glossy sky, bubbles and grass — frosted glass everywhere.',
    chrome: '#3fb8f2',
    swatch: ['#8fdcff', 'rgba(255,255,255,.75)', '#79cf3a', '#07466f'],
    preview: {
      sidebar: 'linear-gradient(rgba(255,255,255,.75), rgba(255,255,255,.45))',
      page: 'radial-gradient(circle at 80% 30%, rgba(255,255,255,.9) 0 6%, transparent 7%), linear-gradient(180deg, #3fb8f2, #b9ecff 70%, #7fd14a 71%)',
      radius: 12,
      border: '1px solid rgba(255,255,255,.95)',
    },
  },
];

const STORAGE_KEY = 'outpost_theme';

export function isThemeId(value: unknown): value is ThemeId {
  return THEMES.some((t) => t.id === value);
}

export function storedTheme(): ThemeId {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isThemeId(v) ? v : 'outpost';
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
