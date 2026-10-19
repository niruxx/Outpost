import type { ServerRecord } from '../api/types.js';

/**
 * Small emblems that identify which game an instance runs. These are original, simplified
 * illustrations (a grass block, a horned helmet, …) — not the games' trademarked logos.
 */
type DrawnKind = 'minecraft-java' | 'minecraft-bedrock' | 'palworld' | 'valheim' | 'zomboid' | 'terraria' | 'quake' | 'custom' | 'docker' | 'steam';

/** Games identified by a generic emblem: a crosshair for shooters, otherwise a short monogram. */
interface MarkedGame {
  label: string;
  mark: { type: 'crosshair'; color: string } | { type: 'monogram'; text: string; color: string };
  tile: string;
}

// Steam dedicated-server App IDs (what steamcmd installs) → how to badge them. Unknown IDs get a gamepad.
const MARKED_GAMES: Record<string, MarkedGame> = {
  '730': { label: 'Counter-Strike 2', mark: { type: 'crosshair', color: '#f2a03d' }, tile: 'from-[#3a2a12] to-[#1f170b]' },
  '740': { label: 'Counter-Strike: Global Offensive', mark: { type: 'crosshair', color: '#e8b04a' }, tile: 'from-[#3a2a12] to-[#1f170b]' },
  '232330': { label: 'Counter-Strike: Source', mark: { type: 'crosshair', color: '#d9c27a' }, tile: 'from-[#33301c] to-[#1c1a0f]' },
  '90': { label: 'Counter-Strike 1.6 / Condition Zero', mark: { type: 'crosshair', color: '#e0c890' }, tile: 'from-[#33301c] to-[#1c1a0f]' },
  '232250': { label: 'Team Fortress 2', mark: { type: 'monogram', text: 'TF2', color: '#e07a3d' }, tile: 'from-[#3d2212] to-[#22130a]' },
  '222860': { label: 'Left 4 Dead 2', mark: { type: 'monogram', text: 'L4D2', color: '#d94a3d' }, tile: 'from-[#3d1712] to-[#220d0a]' },
  '4020': { label: "Garry's Mod", mark: { type: 'monogram', text: 'GM', color: '#4aa3df' }, tile: 'from-[#12293d] to-[#0a1722]' },
  '258550': { label: 'Rust', mark: { type: 'monogram', text: 'RUST', color: '#ce4223' }, tile: 'from-[#3a1a12] to-[#210f0a]' },
  '376030': { label: 'ARK: Survival Evolved', mark: { type: 'monogram', text: 'ARK', color: '#7fc6d6' }, tile: 'from-[#14323a] to-[#0b1c21]' },
  '294420': { label: '7 Days to Die', mark: { type: 'monogram', text: '7D', color: '#c94c3c' }, tile: 'from-[#3a1712] to-[#210d0a]' },
  '1690800': { label: 'Satisfactory', mark: { type: 'monogram', text: 'SF', color: '#f5a623' }, tile: 'from-[#3a2a0f] to-[#211808]' },
  '2278520': { label: 'Enshrouded', mark: { type: 'monogram', text: 'EN', color: '#8fb6ff' }, tile: 'from-[#1a2440] to-[#0f1524]' },
  '1829350': { label: 'V Rising', mark: { type: 'monogram', text: 'VR', color: '#d8424a' }, tile: 'from-[#3a1216] to-[#210a0c]' },
  '1110390': { label: 'Unturned', mark: { type: 'monogram', text: 'UN', color: '#9bd06a' }, tile: 'from-[#22351a] to-[#131f0f]' },
  '343050': { label: "Don't Starve Together", mark: { type: 'monogram', text: 'DST', color: '#e8d9b0' }, tile: 'from-[#2e2a22] to-[#1a1813]' },
  '443030': { label: 'Conan Exiles', mark: { type: 'monogram', text: 'CE', color: '#d9a35a' }, tile: 'from-[#3a2a16] to-[#21180d]' },
  '403240': { label: 'Squad', mark: { type: 'monogram', text: 'SQ', color: '#b8c48a' }, tile: 'from-[#2c3320] to-[#191d12]' },
  '581330': { label: 'Insurgency: Sandstorm', mark: { type: 'crosshair', color: '#d6b47a' }, tile: 'from-[#3a2f1c] to-[#211b10]' },
  '232130': { label: 'Killing Floor 2', mark: { type: 'monogram', text: 'KF2', color: '#d94040' }, tile: 'from-[#3a1212] to-[#210a0a]' },
  '233780': { label: 'Arma 3', mark: { type: 'monogram', text: 'A3', color: '#c7c7a0' }, tile: 'from-[#2e2e22] to-[#1a1a13]' },
  '223350': { label: 'DayZ', mark: { type: 'monogram', text: 'DZ', color: '#d0d0d0' }, tile: 'from-[#2a2a2a] to-[#171717]' },
  '298740': { label: 'Space Engineers', mark: { type: 'monogram', text: 'SE', color: '#7fb2e5' }, tile: 'from-[#16263a] to-[#0d1621]' },
  '2465200': { label: 'Sons of the Forest', mark: { type: 'monogram', text: 'SotF', color: '#9bc48a' }, tile: 'from-[#1f3320] to-[#121d12]' },
  '629800': { label: 'Mordhau', mark: { type: 'monogram', text: 'MH', color: '#c9a86a' }, tile: 'from-[#33291a] to-[#1d170f]' },
};

const QUAKE_APP_IDS = new Set(['349090']); // Quake Live dedicated server

/** A drawn emblem kind, `steam:<appId>` for a marked Steam game, or `app:<icon>` for software. */
export type GameKind = DrawnKind | `steam:${string}` | `app:${string}`;

/** Emblems for general software (container apps). Simple original glyphs — not product logos. */
export const APP_ICONS: Record<string, { label: string; tile: string; color: string; path: string }> = {
  manager: { label: 'Container manager', tile: 'from-[#13365a] to-[#0b1f33]', color: '#8ec5ff', path: 'M6 9h8v6H6zM18 9h8v6h-8zM6 18h8v6H6zM18 18h8v6h-8z' },
  web: { label: 'Web server', tile: 'from-[#14402b] to-[#0b2418]', color: '#7fe0a8', path: 'M16 5a11 11 0 1 0 0 22 11 11 0 0 0 0-22zM5 16h22M16 5c3.5 3.5 3.5 18.5 0 22M16 5c-3.5 3.5-3.5 18.5 0 22' },
  database: { label: 'Database', tile: 'from-[#2b2350] to-[#17132d]', color: '#b8a7ff', path: 'M7 9c0-2 4-3.5 9-3.5s9 1.5 9 3.5-4 3.5-9 3.5S7 11 7 9zM7 9v14c0 2 4 3.5 9 3.5s9-1.5 9-3.5V9M7 16c0 2 4 3.5 9 3.5s9-1.5 9-3.5' },
  cache: { label: 'Cache', tile: 'from-[#4a1f1f] to-[#2a1111]', color: '#ff9e8f', path: 'M18 4L8 18h7l-1 10 10-14h-7z' },
  media: { label: 'Media server', tile: 'from-[#3e1d4a] to-[#22102a]', color: '#e3a3ff', path: 'M6 7h20v18H6zM13 11v10l8-5z' },
  monitor: { label: 'Monitoring', tile: 'from-[#173f3a] to-[#0c2420]', color: '#7ee0cf', path: 'M4 17h6l3-8 5 15 3-7h7' },
  vault: { label: 'Password manager', tile: 'from-[#3a3214] to-[#211c0b]', color: '#f2d16b', path: 'M16 4l9 4v7c0 6-4 10.5-9 13-5-2.5-9-7-9-13V8zM16 13a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM16 18v4' },
  cloud: { label: 'Cloud & files', tile: 'from-[#163a52] to-[#0c2130]', color: '#9fd6ff', path: 'M10 24a6 6 0 0 1-.5-12A8 8 0 0 1 25 13a5.5 5.5 0 0 1 0 11z' },
  app: { label: 'App', tile: 'from-[#2a2f36] to-[#16191d]', color: '#c2c9bb', path: 'M6 6h8v8H6zM18 6h8v8h-8zM6 18h8v8H6zM18 18h8v8h-8z' },
};

const DRAWN_APP: Record<string, DrawnKind> = {
  '2394010': 'palworld',
  '896660': 'valheim',
  '380870': 'zomboid',
  '105600': 'terraria',
};

const DRAWN_LABEL: Record<DrawnKind, string> = {
  'minecraft-java': 'Minecraft: Java Edition',
  'minecraft-bedrock': 'Minecraft: Bedrock Edition',
  palworld: 'Palworld',
  valheim: 'Valheim',
  zomboid: 'Project Zomboid',
  terraria: 'Terraria',
  quake: 'Quake Live',
  custom: 'Custom process',
  docker: 'Docker container',
  steam: 'Steam dedicated server',
};

/** Well-known community images → the game they run. */
const IMAGE_GAME: [RegExp, GameKind][] = [
  [/minecraft-bedrock/i, 'minecraft-bedrock'],
  [/minecraft/i, 'minecraft-java'],
  [/valheim/i, 'valheim'],
  [/palworld/i, 'palworld'],
  [/zomboid/i, 'zomboid'],
  [/terraria/i, 'terraria'],
  [/(^|\/)cs2|counter-?strike/i, 'steam:730'],
];

export function gameKindOf(server: Pick<ServerRecord, 'platform' | 'steam_app_id'> & { version?: string; docker_config?: string | null }): GameKind {
  if (server.platform === 'docker') {
    let icon: string | null = null;
    try {
      icon = server.docker_config ? (JSON.parse(server.docker_config).icon ?? null) : null;
    } catch {
      icon = null;
    }
    if (icon && APP_ICONS[icon]) return `app:${icon}`;
    if (icon && icon in DRAWN_LABEL) return icon as DrawnKind;
    return IMAGE_GAME.find(([re]) => re.test(server.version ?? ''))?.[1] ?? 'docker';
  }
  if (server.platform === 'java') return 'minecraft-java';
  if (server.platform === 'bedrock') return 'minecraft-bedrock';
  if (server.platform === 'custom') return 'custom';
  const appId = server.steam_app_id ?? '';
  if (DRAWN_APP[appId]) return DRAWN_APP[appId];
  if (QUAKE_APP_IDS.has(appId)) return 'quake';
  if (MARKED_GAMES[appId]) return `steam:${appId}`;
  return 'steam';
}

function appIcon(kind: GameKind) {
  return kind.startsWith('app:') ? APP_ICONS[kind.slice(4)] ?? APP_ICONS.app : null;
}

/** Whether an emblem kind is a game (vs. general software). */
export function isGameKind(kind: GameKind): boolean {
  return !kind.startsWith('app:') && kind !== 'docker' && kind !== 'custom';
}

function marked(kind: GameKind): MarkedGame | null {
  return kind.startsWith('steam:') ? MARKED_GAMES[kind.slice(6)] ?? null : null;
}

/** Human-readable game name for an emblem kind. */
export function gameLabel(kind: GameKind): string {
  return appIcon(kind)?.label ?? marked(kind)?.label ?? DRAWN_LABEL[kind as DrawnKind] ?? DRAWN_LABEL.steam;
}

/** Tile background per game — tonal, so the emblems read on the dark MD3 surfaces. */
const TILE: Record<DrawnKind, string> = {
  'minecraft-java': 'from-[#1f3d1a] to-[#14240f]',
  'minecraft-bedrock': 'from-[#33363a] to-[#1c1e21]',
  palworld: 'from-[#173a4a] to-[#0f2330]',
  valheim: 'from-[#3a2d1a] to-[#21190f]',
  zomboid: 'from-[#3d1717] to-[#220d0d]',
  terraria: 'from-[#1d3557] to-[#122036]',
  quake: 'from-[#3a1d12] to-[#1c0d08]',
  custom: 'from-[#20262b] to-[#0f1316]',
  docker: 'from-[#173450] to-[#0d1d2e]',
  steam: 'from-[#22303f] to-[#141c26]',
};

function tileOf(kind: GameKind): string {
  return appIcon(kind)?.tile ?? marked(kind)?.tile ?? TILE[kind as DrawnKind] ?? TILE.steam;
}

function Emblem({ kind }: { kind: GameKind }) {
  const app = appIcon(kind);
  if (app) {
    return <path d={app.path} fill="none" stroke={app.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />;
  }
  const m = marked(kind);
  if (m?.mark.type === 'crosshair') {
    const c = m.mark.color;
    return (
      <g fill="none" stroke={c} strokeWidth="2" strokeLinecap="round">
        <circle cx="16" cy="16" r="8" />
        <path d="M16 4v6M16 22v6M4 16h6M22 16h6" />
        <circle cx="16" cy="16" r="1.2" fill={c} stroke="none" />
      </g>
    );
  }
  if (m?.mark.type === 'monogram') {
    const len = m.mark.text.length;
    return (
      <text
        x="16"
        y="16"
        textAnchor="middle"
        dominantBaseline="central"
        fill={m.mark.color}
        fontFamily="Inter, system-ui, sans-serif"
        fontWeight="800"
        fontSize={len <= 2 ? 13 : len === 3 ? 10.5 : 8.5}
        letterSpacing="-0.3"
      >
        {m.mark.text}
      </text>
    );
  }
  switch (kind as DrawnKind) {
    case 'minecraft-java':
      // Isometric grass block
      return (
        <g>
          <path d="M16 5l10 5-10 5-10-5z" fill="#6fbf4a" />
          <path d="M16 6.4l7.6 3.6L16 13.6 8.4 10z" fill="#82d65a" />
          <path d="M6 10l10 5v12L6 22z" fill="#8a5a36" />
          <path d="M26 10l-10 5v12l10-5z" fill="#6e4528" />
          <path d="M6 10l10 5 10-5v2.4l-10 5-10-5z" fill="#5aa83b" />
          <path d="M9 17h2v2H9zM12 20h2v2h-2zM19 18h2v2h-2zM22 15h2v2h-2z" fill="#5b3a21" opacity="0.7" />
        </g>
      );
    case 'minecraft-bedrock':
      // Isometric stone block
      return (
        <g>
          <path d="M16 5l10 5-10 5-10-5z" fill="#9a9ea3" />
          <path d="M6 10l10 5v12L6 22z" fill="#7b7f84" />
          <path d="M26 10l-10 5v12l10-5z" fill="#5f6368" />
          <path d="M12 9h3v1.5h-3zM18 8h2v1.5h-2zM9 15h2v3H9zM12 20h2v2h-2zM19 17h3v2h-3zM21 21h2v2h-2z" fill="#4a4d51" opacity="0.8" />
        </g>
      );
    case 'palworld':
      // Capture sphere
      return (
        <g>
          <circle cx="16" cy="16" r="10" fill="#e8f1f5" />
          <path d="M6 16a10 10 0 0 1 20 0z" fill="#3ba3d0" />
          <rect x="6" y="15" width="20" height="2" fill="#163847" />
          <circle cx="16" cy="16" r="3.2" fill="#163847" />
          <circle cx="16" cy="16" r="1.8" fill="#e8f1f5" />
        </g>
      );
    case 'valheim':
      // Horned helmet
      return (
        <g>
          <path d="M7 9c-1 3 0 6 3 7l1-3c-2-.5-3-2-4-4z" fill="#e8dcc0" />
          <path d="M25 9c1 3 0 6-3 7l-1-3c2-.5 3-2 4-4z" fill="#e8dcc0" />
          <path d="M9 18a7 7 0 0 1 14 0v3H9z" fill="#b8874a" />
          <rect x="15" y="11" width="2" height="12" fill="#7a5527" />
          <rect x="8" y="20" width="16" height="3" rx="1" fill="#8f6431" />
          <rect x="15" y="22" width="2" height="4" fill="#7a5527" />
        </g>
      );
    case 'zomboid':
      // Raised hand + "Z"
      return (
        <g>
          <path d="M11 26v-9l-2-4a1.2 1.2 0 0 1 2-1l2 3V7a1.3 1.3 0 0 1 2.6 0v6V6a1.3 1.3 0 0 1 2.6 0v7-5a1.3 1.3 0 0 1 2.6 0v12c0 3-2 6-6 6z" fill="#8fae7e" />
          <path d="M18 18h5l-5 5h5" stroke="#c0392b" strokeWidth="2" fill="none" strokeLinejoin="round" />
        </g>
      );
    case 'terraria':
      // Pixel tree
      return (
        <g>
          <rect x="14" y="17" width="4" height="10" fill="#8a5a36" />
          <rect x="9" y="7" width="14" height="6" fill="#4caf50" />
          <rect x="7" y="11" width="18" height="6" fill="#43a047" />
          <rect x="11" y="5" width="10" height="3" fill="#66bb6a" />
          <rect x="10" y="26" width="12" height="2" fill="#6d4c41" />
        </g>
      );
    case 'quake':
      // Arena rune: ring + lightning bolt (an original mark, not the Quake logo)
      return (
        <g>
          <circle cx="16" cy="16" r="10" fill="none" stroke="#c46a2c" strokeWidth="2.2" />
          <path d="M17.5 7l-6 10h4.5l-1.5 8 6.5-11h-4.6z" fill="#e8893a" />
        </g>
      );
    case 'docker':
      // Stacked shipping containers (generic — not the Docker logo)
      return (
        <g>
          <rect x="6" y="16" width="20" height="9" rx="1.5" fill="#4f9ee8" />
          <rect x="9" y="8" width="14" height="8" rx="1.5" fill="#7cc0ff" />
          <path d="M10 18v5M14 18v5M18 18v5M22 18v5M12.5 10v4M16 10v4M19.5 10v4" stroke="#0d1d2e" strokeWidth="1.3" strokeLinecap="round" />
        </g>
      );
    case 'custom':
      // Terminal prompt
      return (
        <g>
          <rect x="5" y="7" width="22" height="18" rx="3" fill="#0b0f0c" stroke="#5f6b62" strokeWidth="1.4" />
          <path d="M9.5 13l3.5 3-3.5 3" fill="none" stroke="#78dc77" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M15 19.5h6.5" stroke="#78dc77" strokeWidth="2" strokeLinecap="round" />
        </g>
      );
    default:
      // Gamepad
      return (
        <g>
          <path d="M9 11h14a5 5 0 0 1 4.8 6.4l-1.3 4.4a2.5 2.5 0 0 1-4.3.9L19.5 20h-7l-2.7 2.7a2.5 2.5 0 0 1-4.3-.9l-1.3-4.4A5 5 0 0 1 9 11z" fill="#9fb3c8" />
          <path d="M10 14v4M8 16h4" stroke="#22303f" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="21" cy="15" r="1.2" fill="#22303f" />
          <circle cx="23.5" cy="17.5" r="1.2" fill="#22303f" />
        </g>
      );
  }
}

/** A rounded tile with the game's emblem — used in lists, the instance sidebar, and the top bar.
 *  `running` adds a small live dot so started instances stand out at a glance. */
export function GameTile({ kind, className = 'h-10 w-10', running = false }: { kind: GameKind; className?: string; running?: boolean }) {
  return (
    <div className={`relative flex shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br ${tileOf(kind)} ${className}`} title={gameLabel(kind)}>
      <svg viewBox="0 0 32 32" className="h-[70%] w-[70%]" aria-hidden="true">
        <Emblem kind={kind} />
      </svg>
      {running && (
        <span className="absolute -bottom-0.5 -right-0.5 flex h-3 w-3" aria-label="Running">
          <span className="absolute inline-flex h-full w-full animate-ping-slow rounded-full bg-success-400" />
          <span className="relative inline-flex h-3 w-3 rounded-full border-2 border-surface-850 bg-success-400" />
        </span>
      )}
    </div>
  );
}

/** Large, faded emblem for the instance top bar's background. */
export function GameWatermark({ kind, className = '' }: { kind: GameKind; className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={`pointer-events-none select-none ${className}`} aria-hidden="true">
      <Emblem kind={kind} />
    </svg>
  );
}

export type InstanceCategory = 'game' | 'app' | 'container' | 'custom';

/** What an instance is, for grouping: games, apps/services, plain containers, custom processes. */
export function instanceCategory(server: Pick<ServerRecord, 'platform' | 'docker_config'>): InstanceCategory {
  if (server.platform === 'custom') return 'custom';
  if (server.platform !== 'docker') return 'game';
  try {
    const c = server.docker_config ? JSON.parse(server.docker_config).category : null;
    return c === 'game' || c === 'app' ? c : 'container';
  } catch {
    return 'container';
  }
}
