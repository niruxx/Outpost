import type { CSSProperties } from 'react';

/**
 * The theme's background wallpaper. One set of plain layers — each theme's CSS (index.css,
 * "Wallpapers") decides what they look like: aurora glows, clouds, bubbles, light streaks… Particles
 * get their position, size, speed and starting point in the cycle (--phase) from CSS variables so
 * every theme can reuse them and the screen is already populated at load. Static mode
 * (Appearance → Animated wallpaper off) pauses every animation.
 */
const PARTICLES: { x: string; y: string; s: string; d: string; phase: number }[] = [
  { x: '6%', y: '18%', s: '46px', d: '38s', phase: 0.12 },
  { x: '18%', y: '62%', s: '22px', d: '29s', phase: 0.58 },
  { x: '31%', y: '30%', s: '70px', d: '46s', phase: 0.33 },
  { x: '47%', y: '74%', s: '30px', d: '33s', phase: 0.81 },
  { x: '58%', y: '12%', s: '54px', d: '52s', phase: 0.47 },
  { x: '69%', y: '48%', s: '18px', d: '27s', phase: 0.93 },
  { x: '81%', y: '26%', s: '84px', d: '58s', phase: 0.24 },
  { x: '92%', y: '68%', s: '36px', d: '35s', phase: 0.69 },
];

export function Wallpaper() {
  return (
    <div className="ui-wallpaper" aria-hidden="true">
      <div className="wp-sky" />
      <div className="wp-glow wp-glow-1" />
      <div className="wp-glow wp-glow-2" />
      {PARTICLES.map((p, i) => (
        <span
          key={i}
          className={`wp-p wp-p${i + 1}`}
          style={{ '--x': p.x, '--y': p.y, '--s': p.s, '--d': p.d, '--phase': p.phase } as CSSProperties}
        />
      ))}
      <div className="wp-ground" />
    </div>
  );
}
