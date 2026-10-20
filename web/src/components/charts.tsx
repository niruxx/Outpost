import { useRef, useState } from 'react';

export interface ChartPoint {
  t: number;
  value: number;
}

/** A single-series magnitude-over-time sparkline: thin 2px line, rounded end, hover crosshair + tooltip. */
export function Sparkline({
  data,
  color,
  formatValue,
  emptyLabel,
  height = 48,
}: {
  data: ChartPoint[];
  color: string;
  formatValue: (v: number) => string;
  emptyLabel: string;
  height?: number;
}) {
  const width = 100; // viewBox units; scales responsively via SVG width=100%
  const pad = 3;
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const values = data.map((d) => d.value);
  if (values.length < 2) {
    return <div className="flex h-12 items-center text-xs text-ink-600">{emptyLabel}</div>;
  }

  const max = Math.max(1, ...values);
  const points = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (width - pad * 2);
    const y = height - pad - (v / max) * (height - pad * 2);
    return [x, y] as const;
  });
  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' ');
  const areaPath = `${linePath} L${points[points.length - 1][0].toFixed(2)},${height - pad} L${pad},${height - pad} Z`;
  const last = points[points.length - 1];
  const hover = hoverIdx !== null ? points[hoverIdx] : null;

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const relX = ((e.clientX - rect.left) / rect.width) * width;
    let nearest = 0;
    let bestDist = Infinity;
    points.forEach(([x], i) => {
      const d = Math.abs(x - relX);
      if (d < bestDist) {
        bestDist = d;
        nearest = i;
      }
    });
    setHoverIdx(nearest);
  }

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className={`${height === 48 ? 'h-12' : 'h-8'} w-full cursor-crosshair`}
        onMouseMove={onMove}
        onMouseLeave={() => setHoverIdx(null)}
      >
        <defs>
          <linearGradient id={`grad-${color.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.28" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={areaPath} fill={`url(#grad-${color.replace('#', '')})`} stroke="none" />
        <path d={linePath} fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        <circle cx={last[0]} cy={last[1]} r="1.8" fill={color} />
        {hover && (
          <line x1={hover[0]} x2={hover[0]} y1={pad} y2={height - pad} stroke="currentColor" strokeWidth="1" className="text-surface-600" vectorEffect="non-scaling-stroke" />
        )}
        {hover && <circle cx={hover[0]} cy={hover[1]} r="2.2" fill={color} stroke="black" strokeOpacity="0.4" />}
      </svg>
      {hoverIdx !== null && (
        <div className="pointer-events-none absolute -top-7 rounded-md bg-inverse px-2 py-1 text-[11px] font-medium text-inverse-on shadow-card" style={{ left: `${(hover![0] / width) * 100}%`, transform: 'translateX(-50%)' }}>
          {formatValue(values[hoverIdx])}
        </div>
      )}
    </div>
  );
}


/** Animated MD3-style circular progress gauge. */
export function Gauge({
  percent,
  color,
  size = 96,
  stroke = 9,
  children,
}: {
  percent: number | null;
  color: string;
  size?: number;
  stroke?: number;
  children?: React.ReactNode;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, percent ?? 0));
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgb(var(--surface-700))" strokeWidth={stroke} />
        {/* A CSS transition (not a spring) — it settles in 600 ms instead of animating most of the time. */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct / 100)}
          style={{ transition: 'stroke-dashoffset 600ms cubic-bezier(0.2, 0, 0, 1)' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">{children}</div>
    </div>
  );
}

/** Thin animated bar for compact per-instance metrics. */
export function MiniBar({ percent, color }: { percent: number | null; color: string }) {
  const pct = Math.max(0, Math.min(100, percent ?? 0));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-700">
      <div className="h-full rounded-full" style={{ backgroundColor: color, width: `${pct}%`, transition: 'width 500ms cubic-bezier(0.2, 0, 0, 1)' }} />
    </div>
  );
}
