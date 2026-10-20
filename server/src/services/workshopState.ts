import type { ServerRecord } from '../types/index.js';

/**
 * An instance's Steam Workshop setup (servers.workshop, JSON). Kept free of other imports so the
 * game presets can read it when building launch arguments.
 */

export type WorkshopKind = 'map' | 'mod' | 'item';

export interface WorkshopItem {
  id: string;
  title: string;
  kind: WorkshopKind;
  /** Where it's installed / the name the game knows it by (BO3 map codename, mod folder). */
  folder: string | null;
  /** Project Zomboid: the mod ids inside this item (an item can carry several). */
  modIds: string[];
  sizeBytes: number;
  previewUrl: string | null;
  /** Steam's last-updated time (unix seconds) — newer than installedAt means an update is waiting. */
  updatedAt: number;
  installedAt: number | null;
  status: 'pending' | 'installed' | 'failed';
  error: string | null;
}

export interface WorkshopState {
  items: WorkshopItem[];
  /** Black Ops 3: the one mod loaded with fs_game (null = plain usermaps). */
  activeMod: string | null;
  /** Black Ops 3: the custom map to start on (its codename). */
  startMap: string | null;
  /** Steam account used to download items for games that need ownership ("user password"). Never sent to the browser. */
  login: string | null;
  /** Project Zomboid: what Outpost last wrote into the .ini, so removing an item only removes what Outpost added. */
  written: { items: string[]; mods: string[] } | null;
}

export const EMPTY_WORKSHOP: WorkshopState = { items: [], activeMod: null, startMap: null, login: null, written: null };

export function workshopStateOf(server: Pick<ServerRecord, 'workshop'>): WorkshopState {
  if (!server.workshop) return { ...EMPTY_WORKSHOP, items: [] };
  try {
    const raw = JSON.parse(server.workshop) as Partial<WorkshopState>;
    return {
      items: Array.isArray(raw.items) ? raw.items : [],
      activeMod: typeof raw.activeMod === 'string' ? raw.activeMod : null,
      startMap: typeof raw.startMap === 'string' ? raw.startMap : null,
      login: typeof raw.login === 'string' && raw.login ? raw.login : null,
      written:
        raw.written && Array.isArray(raw.written.items) && Array.isArray(raw.written.mods) ? { items: raw.written.items, mods: raw.written.mods } : null,
    };
  } catch {
    return { ...EMPTY_WORKSHOP, items: [] };
  }
}
