import { memo, useId, type ReactNode } from 'react';
import { kindAccent, kindAppId, kindTileColors, type GameKind } from './GameArt.js';
import type { BannerArtwork } from '../api/types.js';
import { BannerImage } from './BannerImage.js';

/**
 * Wide illustrated banners per game/app family — original, procedurally drawn scenes (voxel
 * terrain, a radar grid, mountain ridges, container stacks…), not any game's key art or logo.
 * Shapes are seeded from the kind, so an instance always gets the same picture.
 */
type Scene = 'blocks' | 'pixel' | 'tactical' | 'arena' | 'wilds' | 'sandbox' | 'containers' | 'data' | 'network' | 'terminal' | 'steam';

const TACTICAL = new Set(['730', '740', '232330', '90', '581330', '403240', '233780']);
const ARENA = new Set(['545990', '2200', '232370', '232290', '232250', '222860', '232130', '629800', '349090']);
const WILDS = new Set(['258550', '376030', '294420', '2278520', '1829350', '1110390', '343050', '443030', '223350', '2465200', '896660', '2394010', '380870']);
const SANDBOX = new Set(['4020', '298740', '1690800']);

const GROUNDED = new Set<Scene>(['blocks', 'pixel', 'wilds', 'containers']);

export function sceneOf(kind: GameKind): Scene {
  if (kind === 'minecraft-java' || kind === 'minecraft-bedrock') return 'blocks';
  if (kind === 'terraria') return 'pixel';
  if (kind === 'quake') return 'arena';
  if (kind === 'docker' || kind === 'app:manager') return 'containers';
  if (kind === 'custom' || kind === 'app:template' || kind === 'app:app') return 'terminal';
  if (kind === 'app:database' || kind === 'app:cache' || kind === 'app:vault') return 'data';
  if (kind.startsWith('app:')) return 'network';
  const appId = kindAppId(kind);
  if (appId && TACTICAL.has(appId)) return 'tactical';
  if (appId && ARENA.has(appId)) return 'arena';
  if (appId && WILDS.has(appId)) return 'wilds';
  if (appId && SANDBOX.has(appId)) return 'sandbox';
  return 'steam';
}

/** Small deterministic PRNG (mulberry32) seeded from a string. */
function seeded(seed: string) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 3432918353), (h = (h << 13) | (h >>> 19));
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Scopes an SVG id to one banner, since several can share a page. */
type Ids = (name: string) => string;
interface SceneProps {
  rand: () => number;
  accent: string;
  bg: [string, string];
  u: Ids;
}

const W = 1200;
const H = 300;

/** Mix a hex color toward white (amount > 0) or black (amount < 0). */
function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) =>
    Math.round(amount >= 0 ? c + (255 - c) * amount : c * (1 + amount)),
  );
  return `#${ch.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

function Blocks({ rand, variant, u }: { rand: () => number; variant: 'java' | 'bedrock' | 'pixel'; u: Ids }) {
  // Kept low: a wide header shows only the bottom ~half of the 300-unit picture.
  const cell = variant === 'pixel' ? 20 : 30;
  const palette = {
    java: { skyTop: '#3d7cc0', skyBottom: '#a9d4f2', grass: '#62a83c', grassSide: '#4c8a2c', dirt: '#7b5434', stone: '#6f7378', sun: '#fff3b0' },
    bedrock: { skyTop: '#3a2f63', skyBottom: '#e0906c', grass: '#5e9a46', grassSide: '#467735', dirt: '#6b4a32', stone: '#5d6168', sun: '#ffd27a' },
    pixel: { skyTop: '#0e1a3a', skyBottom: '#2d4f8e', grass: '#4caf50', grassSide: '#388e3c', dirt: '#7a4f2e', stone: '#565a66', sun: '#f4f1d0' },
  }[variant];
  const cols = Math.ceil(W / cell) + 1;
  let h = 2 + Math.floor(rand() * 2);
  const blocks: ReactNode[] = [];
  for (let c = 0; c < cols; c++) {
    if (rand() < 0.38) h = Math.max(1, Math.min(variant === 'pixel' ? 5 : 4, h + (rand() < 0.5 ? -1 : 1)));
    for (let r = 0; r < h; r++) {
      const y = H - (r + 1) * cell;
      const top = r === h - 1;
      const fill = top ? palette.grass : r >= h - 3 ? palette.dirt : palette.stone;
      blocks.push(<rect key={`${c}-${r}`} x={c * cell} y={y} width={cell} height={cell} fill={fill} />);
      if (top) blocks.push(<rect key={`${c}-${r}-s`} x={c * cell} y={y + cell * 0.72} width={cell} height={cell * 0.28} fill={palette.grassSide} />);
      // Speckles give the blocks texture.
      if (!top && rand() < 0.5) blocks.push(<rect key={`${c}-${r}-d`} x={c * cell + cell * rand() * 0.7} y={y + cell * rand() * 0.7} width={cell / 5} height={cell / 5} fill="#000" opacity={0.14} />);
    }
  }
  const clouds = Array.from({ length: 4 }, (_, i) => {
    const x = rand() * W;
    const y = 120 + rand() * 40;
    const w = cell * (3 + Math.floor(rand() * 4));
    return <rect key={i} x={x} y={y} width={w} height={cell * 0.75} fill="#fff" opacity={variant === 'pixel' ? 0.08 : 0.7} />;
  });
  const stars = variant === 'pixel' ? Array.from({ length: 50 }, (_, i) => <rect key={i} x={rand() * W} y={rand() * 220} width={3} height={3} fill="#fff" opacity={0.3 + rand() * 0.6} />) : null;
  return (
    <>
      <defs>
        <linearGradient id={u('sky')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={palette.skyTop} />
          <stop offset="1" stopColor={palette.skyBottom} />
        </linearGradient>
      </defs>
      <rect width={W} height={H} fill={`url(#${u('sky')})`} />
      {stars}
      <rect x={W * 0.68} y={140} width={cell * 1.6} height={cell * 1.6} fill={palette.sun} opacity={0.9} />
      {clouds}
      <g shapeRendering="crispEdges">{blocks}</g>
    </>
  );
}

function Tactical({ rand, accent, bg, u }: SceneProps) {
  const cx = W * 0.7;
  const cy = H * 0.5;
  const blips = Array.from({ length: 7 }, (_, i) => {
    const a = rand() * Math.PI * 2;
    const r = 40 + rand() * 200;
    return <circle key={i} cx={cx + Math.cos(a) * r} cy={cy + Math.sin(a) * r} r={3 + rand() * 3} fill={accent} opacity={0.5 + rand() * 0.5} />;
  });
  return (
    <>
      <defs>
        <linearGradient id={u('bg')} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={shade(bg[0], 0.05)} />
          <stop offset="1" stopColor={shade(bg[1], -0.3)} />
        </linearGradient>
        <radialGradient id={u('sweep')} cx="0" cy="0.5" r="1">
          <stop offset="0" stopColor={accent} stopOpacity="0.35" />
          <stop offset="1" stopColor={accent} stopOpacity="0" />
        </radialGradient>
        <pattern id={u('grid')} width="40" height="40" patternUnits="userSpaceOnUse">
          <path d="M40 0H0V40" fill="none" stroke={accent} strokeOpacity="0.1" />
        </pattern>
      </defs>
      <rect width={W} height={H} fill={`url(#${u('bg')})`} />
      <rect width={W} height={H} fill={`url(#${u('grid')})`} />
      {[60, 120, 180, 240, 300].map((r) => <circle key={r} cx={cx} cy={cy} r={r} fill="none" stroke={accent} strokeOpacity={0.22 - r / 2000} strokeWidth="1.5" />)}
      <path d={`M${cx} ${cy} L${cx + 300} ${cy - 120} A320 320 0 0 1 ${cx + 300} ${cy + 60} Z`} fill={`url(#${u('sweep')})`} />
      <path d={`M${cx - 320} ${cy}H${cx + 320}M${cx} ${cy - 320}V${cy + 320}`} stroke={accent} strokeOpacity="0.25" />
      <g stroke={accent} strokeWidth="3" strokeLinecap="round" opacity="0.9">
        <path d={`M${cx - 26} ${cy}h-18M${cx + 26} ${cy}h18M${cx} ${cy - 26}v-18M${cx} ${cy + 26}v18`} />
      </g>
      {blips}
      <g opacity="0.16" fill={accent}>
        {Array.from({ length: 9 }, (_, i) => <path key={i} d={`M${i * 34 - 40} ${H}l60 -60h20l-60 60z`} />)}
      </g>
    </>
  );
}

function Arena({ rand, accent, bg, u }: SceneProps) {
  const shards = Array.from({ length: 14 }, (_, i) => {
    const x = W * 0.35 + rand() * W * 0.7;
    const y = rand() * H;
    const s = 30 + rand() * 120;
    const pts = [0, 1, 2].map((k) => {
      const a = rand() * Math.PI * 2 + k * 2.1;
      return `${(x + Math.cos(a) * s).toFixed(0)},${(y + Math.sin(a) * s).toFixed(0)}`;
    });
    return <polygon key={i} points={pts.join(' ')} fill={accent} opacity={0.05 + rand() * 0.16} />;
  });
  return (
    <>
      <defs>
        <linearGradient id={u('bg')} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={shade(bg[1], -0.35)} />
          <stop offset="1" stopColor={shade(bg[0], 0.08)} />
        </linearGradient>
        <radialGradient id={u('glow')} cx="0.78" cy="0.45" r="0.45">
          <stop offset="0" stopColor={accent} stopOpacity="0.45" />
          <stop offset="1" stopColor={accent} stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width={W} height={H} fill={`url(#${u('bg')})`} />
      <rect width={W} height={H} fill={`url(#${u('glow')})`} />
      {shards}
      {Array.from({ length: 5 }, (_, i) => (
        <path key={i} d={`M${W * 0.4 + i * 90} ${H + 20} L${W * 0.62 + i * 120} -20`} stroke={accent} strokeOpacity={0.25 + i * 0.08} strokeWidth={1.5 + (i % 2)} />
      ))}
    </>
  );
}

function Wilds({ rand, accent, bg, u }: SceneProps) {
  const ridge = (base: number, amp: number, step: number) => {
    let d = `M0 ${H}`;
    for (let x = 0; x <= W + step; x += step) d += ` L${x} ${(base - rand() * amp).toFixed(0)}`;
    return `${d} L${W} ${H} Z`;
  };
  const trees = Array.from({ length: 28 }, (_, i) => {
    const x = (i / 28) * W + rand() * 30;
    const h = 26 + rand() * 34;
    return <path key={i} d={`M${x} ${H - h - 8} l${h * 0.28} ${h} h${-h * 0.56} z`} fill={shade(bg[1], -0.55)} />;
  });
  return (
    <>
      <defs>
        <linearGradient id={u('bg')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={shade(bg[1], -0.2)} />
          <stop offset="1" stopColor={shade(bg[0], 0.18)} />
        </linearGradient>
      </defs>
      <rect width={W} height={H} fill={`url(#${u('bg')})`} />
      <circle cx={W * 0.68} cy={H * 0.6} r={30} fill={accent} opacity={0.75} />
      <circle cx={W * 0.68} cy={H * 0.6} r={70} fill={accent} opacity={0.1} />
      <path d={ridge(H * 0.8, 50, 60)} fill={shade(bg[0], -0.05)} opacity={0.8} />
      <path d={ridge(H * 0.9, 28, 45)} fill={shade(bg[1], -0.25)} opacity={0.95} />
      {trees}
    </>
  );
}

function Sandbox({ rand, accent, bg, u }: SceneProps) {
  const cubes = Array.from({ length: 4 }, (_, i) => {
    const x = W * 0.5 + i * 150 + rand() * 40;
    const y = 70 + rand() * 120;
    const s = 36 + rand() * 40;
    const dx = s * 0.87;
    const d = `M${x} ${y} l${dx} ${-s / 2} l${dx} ${s / 2} l${-dx} ${s / 2} z M${x} ${y} v${s} l${dx} ${s / 2} v${-s} M${x + 2 * dx} ${y} v${s} l${-dx} ${s / 2}`;
    return <path key={i} d={d} fill="none" stroke={accent} strokeOpacity={0.55} strokeWidth="1.6" strokeLinejoin="round" />;
  });
  return (
    <>
      <defs>
        <linearGradient id={u('bg')} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={shade(bg[0], 0.05)} />
          <stop offset="1" stopColor={shade(bg[1], -0.3)} />
        </linearGradient>
        <pattern id={u('minor')} width="20" height="20" patternUnits="userSpaceOnUse">
          <path d="M20 0H0V20" fill="none" stroke={accent} strokeOpacity="0.08" />
        </pattern>
        <pattern id={u('major')} width="100" height="100" patternUnits="userSpaceOnUse">
          <path d="M100 0H0V100" fill="none" stroke={accent} strokeOpacity="0.2" />
        </pattern>
      </defs>
      <rect width={W} height={H} fill={`url(#${u('bg')})`} />
      <rect width={W} height={H} fill={`url(#${u('minor')})`} />
      <rect width={W} height={H} fill={`url(#${u('major')})`} />
      {cubes}
    </>
  );
}

function Containers({ rand, accent, bg, u }: SceneProps) {
  const boxes: ReactNode[] = [];
  const colors = [accent, shade(accent, -0.25), shade(accent, 0.25), shade(accent, -0.45)];
  for (let col = 0; col < 8; col++) {
    const stack = 1 + Math.floor(rand() * 2);
    for (let r = 0; r < stack; r++) {
      const x = W * 0.4 + col * 76;
      const y = H - 52 - (r + 1) * 38;
      const fill = colors[Math.floor(rand() * colors.length)];
      boxes.push(
        <g key={`${col}-${r}`} opacity={0.85}>
          <rect x={x} y={y} width={72} height={34} rx={3} fill={fill} opacity={0.55} />
          {Array.from({ length: 5 }, (_, k) => <path key={k} d={`M${x + 10 + k * 13} ${y + 5}v24`} stroke="#000" strokeOpacity={0.18} strokeWidth={2} />)}
        </g>,
      );
    }
  }
  const wave = (y: number, amp: number) => {
    let d = `M0 ${y}`;
    for (let x = 0; x <= W; x += 60) d += ` Q${x + 30} ${y - amp} ${x + 60} ${y}`;
    return `${d} V${H} H0 Z`;
  };
  return (
    <>
      <defs>
        <linearGradient id={u('bg')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={shade(bg[0], 0.12)} />
          <stop offset="1" stopColor={shade(bg[1], -0.2)} />
        </linearGradient>
      </defs>
      <rect width={W} height={H} fill={`url(#${u('bg')})`} />
      {boxes}
      <path d={wave(H - 44, 8)} fill={accent} opacity={0.18} />
      <path d={wave(H - 26, 12)} fill={accent} opacity={0.28} />
    </>
  );
}

function DataScene({ rand, accent, bg, u }: SceneProps) {
  const dots: ReactNode[] = [];
  for (let x = 20; x < W; x += 28) {
    for (let y = 20; y < H; y += 28) {
      const fade = Math.max(0, (x - W * 0.25) / (W * 0.75));
      if (rand() < 0.75) dots.push(<circle key={`${x}-${y}`} cx={x} cy={y} r={2.2} fill={accent} opacity={fade * (0.15 + rand() * 0.55)} />);
    }
  }
  return (
    <>
      <defs>
        <linearGradient id={u('bg')} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={shade(bg[1], -0.2)} />
          <stop offset="1" stopColor={shade(bg[0], 0.1)} />
        </linearGradient>
      </defs>
      <rect width={W} height={H} fill={`url(#${u('bg')})`} />
      {dots}
      {[0, 1, 2].map((i) => {
        const x = W * 0.6 + i * 90;
        const y = 80 + (i % 2) * 30;
        return (
          <g key={i} fill="none" stroke={accent} strokeOpacity={0.6} strokeWidth="2">
            <ellipse cx={x} cy={y} rx={34} ry={10} />
            <path d={`M${x - 34} ${y}v90a34 10 0 0 0 68 0v-90`} />
            <path d={`M${x - 34} ${y + 45}a34 10 0 0 0 68 0`} />
          </g>
        );
      })}
    </>
  );
}

function Network({ rand, accent, bg, u }: SceneProps) {
  const cx = W * 0.7;
  const cy = H * 0.62;
  const r = 170;
  let pulse = `M0 ${H * 0.5}`;
  for (let x = 0; x < W * 0.6; x += 40) pulse += ` L${x + 20} ${H * 0.5 + (rand() < 0.25 ? (rand() - 0.5) * 120 : 0)} L${x + 40} ${H * 0.5}`;
  return (
    <>
      <defs>
        <linearGradient id={u('bg')} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={shade(bg[1], -0.2)} />
          <stop offset="1" stopColor={shade(bg[0], 0.12)} />
        </linearGradient>
      </defs>
      <rect width={W} height={H} fill={`url(#${u('bg')})`} />
      <g fill="none" stroke={accent} strokeOpacity="0.4" strokeWidth="1.5">
        <circle cx={cx} cy={cy} r={r} />
        {[0.35, 0.7].map((k) => <ellipse key={k} cx={cx} cy={cy} rx={r * k} ry={r} />)}
        {[-0.5, 0, 0.5].map((k) => <ellipse key={k} cx={cx} cy={cy + k * r} rx={r * Math.sqrt(1 - k * k)} ry={r * 0.12} />)}
      </g>
      <path d={pulse} fill="none" stroke={accent} strokeOpacity="0.55" strokeWidth="2" strokeLinejoin="round" />
    </>
  );
}

function Terminal({ rand, accent, bg, u }: SceneProps) {
  const lines = Array.from({ length: 9 }, (_, i) => {
    const indent = Math.floor(rand() * 3) * 28;
    return (
      <g key={i}>
        <rect x={W * 0.5 + indent} y={34 + i * 28} width={60 + rand() * 260} height={10} rx={5} fill={accent} opacity={0.12 + rand() * 0.3} />
        {rand() < 0.4 && <rect x={W * 0.5 + indent + 340} y={34 + i * 28} width={40 + rand() * 80} height={10} rx={5} fill={accent} opacity={0.2} />}
      </g>
    );
  });
  return (
    <>
      <rect width={W} height={H} fill={shade(bg[1], -0.3)} />
      {lines}
      <text x={W * 0.5 - 50} y={46} fill={accent} opacity={0.6} fontFamily="JetBrains Mono, monospace" fontSize="22">{'>_'}</text>
    </>
  );
}

function SteamScene({ accent, bg, u }: Omit<SceneProps, 'rand'>) {
  return (
    <>
      <defs>
        <linearGradient id={u('bg')} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={shade(bg[1], -0.3)} />
          <stop offset="1" stopColor={shade(bg[0], 0.1)} />
        </linearGradient>
        <pattern id={u('hex')} width="56" height="97" patternUnits="userSpaceOnUse" patternTransform="scale(0.8)">
          <path d="M28 0l28 16v32L28 64 0 48V16zM28 64v33" fill="none" stroke={accent} strokeOpacity="0.32" strokeWidth="1.5" />
        </pattern>
        <linearGradient id={u('fade')} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0.3" stopColor="#fff" stopOpacity="0" />
          <stop offset="1" stopColor="#fff" stopOpacity="1" />
        </linearGradient>
        <mask id={u('fadeMask')}>
          <rect width={W} height={H} fill={`url(#${u('fade')})`} />
        </mask>
      </defs>
      <rect width={W} height={H} fill={`url(#${u('bg')})`} />
      <circle cx={W * 0.82} cy={H * 0.5} r={220} fill={accent} opacity={0.12} />
      <rect width={W} height={H} fill={`url(#${u('hex')})`} mask={`url(#${u('fadeMask')})`} />
    </>
  );
}

/**
 * The banner fills its (relatively positioned) parent. `fade` blends the bottom into the card
 * so content can sit on the card below the art.
 */
export const GameBanner = memo(function GameBanner({ kind, seed, className = '', fade = true, serverId, artwork, previewUrl, positionX = 50, positionY = 50 }: { kind: GameKind; seed?: string; className?: string; fade?: boolean; serverId?: string; artwork?: BannerArtwork | null; previewUrl?: string | null; positionX?: number; positionY?: number }) {
  const scene = sceneOf(kind);
  const accent = kindAccent(kind);
  const bg = kindTileColors(kind);
  const rand = seeded(`${kind}:${seed ?? ''}`);
  // Gradient/pattern ids must be unique per banner on the page.
  const uid = useId().replace(/:/g, '');
  const u: Ids = (name) => `${uid}-${name}`;
  const body = (() => {
    switch (scene) {
      case 'blocks': return <Blocks rand={rand} u={u} variant={kind === 'minecraft-bedrock' ? 'bedrock' : 'java'} />;
      case 'pixel': return <Blocks rand={rand} u={u} variant="pixel" />;
      case 'tactical': return <Tactical rand={rand} accent={accent} bg={bg} u={u} />;
      case 'arena': return <Arena rand={rand} accent={accent} bg={bg} u={u} />;
      case 'wilds': return <Wilds rand={rand} accent={accent} bg={bg} u={u} />;
      case 'sandbox': return <Sandbox rand={rand} accent={accent} bg={bg} u={u} />;
      case 'containers': return <Containers rand={rand} accent={accent} bg={bg} u={u} />;
      case 'data': return <DataScene rand={rand} accent={accent} bg={bg} u={u} />;
      case 'network': return <Network rand={rand} accent={accent} bg={bg} u={u} />;
      case 'terminal': return <Terminal rand={rand} accent={accent} bg={bg} u={u} />;
      default: return <SteamScene accent={accent} bg={bg} u={u} />;
    }
  })();
  return (
    <div className={`ui-game-banner pointer-events-none absolute inset-0 overflow-hidden ${className}`} aria-hidden="true" data-scene={scene}>
      {/* Ground scenes keep their bottom edge when a wide header crops the picture. */}
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio={GROUNDED.has(scene) ? 'xMidYMax slice' : 'xMidYMid slice'} className="h-full w-full">
        {body}
      </svg>
      {previewUrl ? <img src={previewUrl} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover" style={{ objectPosition: `${positionX}% ${positionY}%` }} /> : serverId && artwork ? <BannerImage serverId={serverId} artwork={artwork} /> : null}
      {fade && <div className="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-surface-850 via-surface-850/40 to-transparent" />}
    </div>
  );
});
