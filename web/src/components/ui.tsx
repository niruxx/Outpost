import { AnimatePresence, motion } from 'framer-motion';
import { t, tc } from '../i18n/index.js';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';

const springy = { type: 'spring' as const, stiffness: 420, damping: 32 };

/** Inline notice block (MD3 tonal container). */
export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warning' | 'error'; children: ReactNode }) {
  const tones = {
    info: 'bg-tertiary-container text-tertiary-on-container',
    warning: 'bg-yellow-500/15 text-yellow-400',
    error: 'bg-error-container text-error-on-container',
  };
  return <div className={`rounded-2xl px-4 py-3 text-sm leading-relaxed ${tones[tone]}`}>{children}</div>;
}

/** MD3 buttons: filled (primary), tonal (default), error-tonal (danger), text (ghost), outlined. */
export function Button({
  variant = 'default',
  className = '',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'danger' | 'ghost' | 'outlined' }) {
  const base =
    'state-layer inline-flex items-center justify-center gap-2 rounded-full px-4 py-2 text-sm font-medium tracking-[0.01em] transition-[background-color,box-shadow,transform] duration-150 enabled:active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-[0.38] select-none';
  const variants: Record<string, string> = {
    default: 'bg-secondary-container text-secondary-on-container',
    primary: 'bg-accent-400 text-accent-on hover:shadow-flat',
    danger: 'bg-error-container text-error-on-container',
    ghost: 'bg-transparent text-accent-400',
    outlined: 'border border-surface-500 bg-transparent text-accent-400',
  };
  return (
    <button className={`ui-btn ui-btn-${variant} ${base} ${variants[variant]} ${className}`} {...props}>
      {tc(children)}
    </button>
  );
}

const FIELD_BASE =
  'ui-input w-full rounded-lg border border-surface-500 bg-transparent px-3 py-2 text-sm text-ink-100 outline-none transition-colors duration-150 hover:border-ink-300 focus:border-accent-400 focus:ring-1 focus:ring-accent-400 disabled:opacity-[0.38]';

/** MD3 outlined text field. */
export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${FIELD_BASE} placeholder-ink-500 ${props.className ?? ''}`} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${FIELD_BASE} bg-surface-900 ${props.className ?? ''}`} />;
}

/** MD3 filled card (surface-container); `glass={false}` gives the lower container tone. */
export function Card({
  children,
  className = '',
  hover = false,
  glass = true,
}: {
  children?: ReactNode;
  className?: string;
  hover?: boolean;
  glass?: boolean;
}) {
  return (
    <div
      className={`ui-card rounded-3xl ${glass ? 'bg-surface-850' : 'bg-surface-900'} ${
        hover ? 'transition-[background-color,transform,box-shadow] duration-200 ease-out hover:-translate-y-0.5 hover:bg-surface-800 hover:shadow-card' : ''
      } ${className}`}
    >
      {children}
    </div>
  );
}

/** Section heading used at the top of cards. */
export function CardTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <h2 className="ui-card-title text-base font-medium text-ink-100">{tc(children)}</h2>
      {action}
    </div>
  );
}

// `green` deliberately uses the `success` palette, not `accent` — status color (good/running)
// and brand/interactive color are different concepts and must stay visually distinct.
const BADGE_TONES: Record<string, string> = {
  neutral: 'bg-surface-700 text-ink-300',
  green: 'bg-success-500/15 text-success-400',
  red: 'bg-red-500/15 text-red-400',
  yellow: 'bg-yellow-500/15 text-yellow-400',
  blue: 'bg-sky-500/15 text-sky-400',
};

export function Badge({
  children,
  tone = 'neutral',
  pulse = false,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'green' | 'red' | 'yellow' | 'blue';
  pulse?: boolean;
}) {
  const dotColor: Record<string, string> = {
    neutral: 'bg-ink-400',
    green: 'bg-success-400',
    red: 'bg-red-400',
    yellow: 'bg-yellow-400',
    blue: 'bg-sky-400',
  };
  return (
    <span className={`ui-badge inline-flex items-center gap-1.5 rounded-lg px-2 py-0.5 text-xs font-medium transition-colors duration-300 ${BADGE_TONES[tone]}`}>
      {pulse && (
        <span className="relative flex h-1.5 w-1.5">
          <span className={`absolute inline-flex h-full w-full animate-ping-slow rounded-full ${dotColor[tone]}`} />
          <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${dotColor[tone]}`} />
        </span>
      )}
      {tc(children)}
    </span>
  );
}

export function Spinner({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg className={`animate-spin text-current ${className}`} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

export function Skeleton({ className = 'h-4 w-full' }: { className?: string }) {
  return <div className={`skeleton ${className}`} />;
}

const MODAL_SIZE: Record<string, string> = {
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
};

export function Modal({
  open,
  onClose,
  title,
  children,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  size?: 'md' | 'lg' | 'xl';
}) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          onClick={onClose}
        >
          <motion.div
            className={`ui-modal flex max-h-[85vh] w-full ${MODAL_SIZE[size]} flex-col rounded-4xl bg-surface-800 shadow-card`}
            initial={{ opacity: 0, scale: 0.95, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={springy}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="ui-modal-header flex shrink-0 items-center justify-between px-6 pb-2 pt-6">
              <h3 className="ui-modal-title text-xl font-normal text-ink-50">{t(title)}</h3>
              <button onClick={onClose} aria-label="Close" className="ui-modal-close state-layer rounded-full p-2 text-ink-300">
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="ui-modal-body overflow-y-auto px-6 pb-6 pt-2">{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-ink-300">{t(label)}</span>
      {children}
    </label>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  return (
    <AnimatePresence>
      {Boolean(children) && (
        <motion.p
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          className="overflow-hidden rounded-xl bg-error-container px-3 py-2 text-sm text-error-on-container"
        >
          {children}
        </motion.p>
      )}
    </AnimatePresence>
  );
}

export const fadeInUp = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -6 },
};

export const staggerContainer = {
  animate: { transition: { staggerChildren: 0.045 } },
};
