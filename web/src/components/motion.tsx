import { useEffect, useState, type ReactNode } from 'react';
import { effectsReduced } from '../lib/perf.js';
import { animate, motion, useMotionValue, useReducedMotion } from 'framer-motion';

/** A number that eases to each new value instead of jumping. */
export function AnimatedNumber({ value, format = (v) => String(Math.round(v)) }: { value: number | null; format?: (v: number) => string }) {
  const mv = useMotionValue(value ?? 0);
  const reduce = useReducedMotion();
  const [display, setDisplay] = useState(value ?? 0);

  useEffect(() => mv.on('change', setDisplay), [mv]);
  useEffect(() => {
    if (value === null) return;
    if (reduce || effectsReduced()) {
      mv.set(value);
      return;
    }
    const controls = animate(mv, value, { duration: 0.4, ease: [0.2, 0, 0, 1] });
    return () => controls.stop();
  }, [value, mv, reduce]);

  return <>{value === null ? '—' : format(display)}</>;
}

/** MD3 "emphasized" easing — used for page and container transitions. */
export const EMPHASIZED = [0.2, 0, 0, 1] as const;

/** Fades + rises its children in; stagger children with `delay`. */
export function Reveal({ children, delay = 0, className = '' }: { children: ReactNode; delay?: number; className?: string }) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: EMPHASIZED, delay }}
    >
      {children}
    </motion.div>
  );
}
