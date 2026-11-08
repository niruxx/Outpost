/**
 * UI themes. Each one is a `data-theme` value on <html>: index.css swaps the color tokens for it
 * and, for the retro themes, restyles the shared components (cards, buttons, fields, dialogs…)
 * through their `ui-*` class hooks. The choice is per browser; an admin can also give an account
 * a theme that is applied whenever it signs in.
 */
export type ThemeId = 'outpost' | 'classic' | 'xp' | 'minecraft' | 'vista' | 'aero';

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
    description: 'Clean light and dark modes in a familiar workspace layout — follows your system, or pick a mode.',
    chrome: '#131314',
    swatch: ['#131314', '#1e1f20', '#a8c7fa', '#e3e3e3'],
    preview: { sidebar: 'linear-gradient(90deg, #131314 50%, #f8fafd 50%)', page: 'linear-gradient(90deg, #1e1f20 50%, #ffffff 50%)', radius: 12 },
  },
  {
    id: 'classic',
    label: 'Outpost Classic',
    description: 'The original forest-green Outpost look.',
    chrome: '#0f1515',
    swatch: ['#151d1c', '#1c2523', '#b5e89b', '#e1e4da'],
    preview: { sidebar: '#0f1515', radius: 8 },
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

/** Outpost's color mode: follow the OS, or force dark or light. */
export type ColorMode = 'system' | 'dark' | 'light';
const MODE_KEY = 'outpost_color_mode';

export function storedColorMode(): ColorMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return v === 'dark' || v === 'light' ? v : 'system';
  } catch {
    return 'system';
  }
}

const systemLight = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: light)').matches;

let appliedTheme: ThemeId = 'outpost';
let systemListener = false;

/**
 * Sets <html data-theme> (and data-palette for the Outpost family). Classic shares Outpost's
 * shell styling, so it's data-theme="outpost" with the classic palette.
 */
export function applyTheme(id: ThemeId) {
  appliedTheme = id;
  const root = document.documentElement;
  root.dataset.theme = id === 'classic' ? 'outpost' : id;
  let chrome = THEMES.find((t) => t.id === id)?.chrome ?? THEMES[0].chrome;
  if (id === 'classic') root.dataset.palette = 'classic';
  else if (id === 'outpost') {
    const mode = storedColorMode();
    const light = mode === 'light' || (mode === 'system' && systemLight());
    root.dataset.palette = light ? 'light' : 'dark';
    if (light) chrome = '#f8fafd';
  } else delete root.dataset.palette;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', chrome);
  // Follow OS light/dark switches live while in system mode.
  if (!systemListener && typeof window !== 'undefined' && window.matchMedia) {
    systemListener = true;
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if (appliedTheme === 'outpost' && storedColorMode() === 'system') applyTheme('outpost');
    });
  }
}

export function saveColorMode(mode: ColorMode) {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // per-browser preference only
  }
  applyTheme(appliedTheme);
}

const WALLPAPER_KEY = 'outpost_wallpaper';
export type WallpaperMode = 'animated' | 'static';

export function storedWallpaper(): WallpaperMode {
  try {
    return localStorage.getItem(WALLPAPER_KEY) === 'static' ? 'static' : 'animated';
  } catch {
    return 'animated';
  }
}

export function applyWallpaper(mode: WallpaperMode) {
  document.documentElement.dataset.wallpaper = mode;
}

export function saveWallpaper(mode: WallpaperMode) {
  applyWallpaper(mode);
  try {
    localStorage.setItem(WALLPAPER_KEY, mode);
  } catch {
    // per-browser preference only
  }
}

const ASSIGNED_KEY = 'outpost_theme_assigned';

/**
 * Applies the theme an admin gave this account — once per assignment, so the user can still switch
 * afterwards and is only overridden again when the admin picks something new.
 */
export function applyAssignedTheme(assigned: string | null | undefined) {
  let last: string | null = null;
  try {
    last = localStorage.getItem(ASSIGNED_KEY);
  } catch {
    // storage unavailable — apply every time
  }
  if (!isThemeId(assigned)) {
    if (last) {
      try {
        localStorage.removeItem(ASSIGNED_KEY);
      } catch {
        // ignore
      }
    }
    return;
  }
  if (assigned === last) return;
  saveTheme(assigned);
  try {
    localStorage.setItem(ASSIGNED_KEY, assigned);
  } catch {
    // ignore
  }
}

export function saveTheme(id: ThemeId) {
  applyTheme(id);
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // private window or blocked storage — the theme still applies for this visit
  }
}
