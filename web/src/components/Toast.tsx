import { AnimatePresence, motion } from 'framer-motion';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

type ToastKind = 'success' | 'error' | 'info';

interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastState {
  show: (message: string, kind?: ToastKind) => void;
  success: (message: string) => void;
  error: (message: string) => void;
}

const ToastContext = createContext<ToastState | null>(null);

// MD3 snackbar: inverse-surface container, a status-tinted icon, inverse-on-surface text.
const ICONS: Record<ToastKind, ReactNode> = {
  success: <span className="ui-toast-success text-[#2e7d32]">✓</span>,
  error: <span className="ui-toast-error text-[#ba1a1a]">✕</span>,
  info: <span className="ui-toast-info text-[#00639b]">ℹ</span>,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);

  const show = useCallback((message: string, kind: ToastKind = 'info') => {
    const id = ++counter.current;
    setToasts((prev) => [...prev.slice(-3), { id, kind, message }]);
  }, []);
  const dismiss = useCallback((id: number) => setToasts(prev => prev.filter(toast => toast.id !== id)), []);

  const value: ToastState = {
    show,
    success: (message) => show(message, 'success'),
    error: (message) => show(message, 'error'),
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed right-4 top-20 z-[100] flex max-h-[calc(100dvh-6rem)] w-[calc(100vw-2rem)] max-w-sm flex-col gap-2 overflow-y-auto" aria-label="Notifications">
        <AnimatePresence>
          {toasts.map(toast => <ToastNotice key={toast.id} toast={toast} onDismiss={dismiss} />)}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

function ToastNotice({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false);
  useEffect(() => {
    if (hovered || focused) return;
    const timer = window.setTimeout(() => onDismiss(toast.id), toast.kind === 'error' ? 8000 : 5000);
    return () => window.clearTimeout(timer);
  }, [toast.id, toast.kind, onDismiss, hovered, focused]);
  return <motion.div
    layout role={toast.kind === 'error' ? 'alert' : 'status'} aria-atomic="true"
    initial={{ opacity: 0, y: 16, scale: 0.94 }}
    animate={{ opacity: 1, y: 0, scale: 1 }}
    exit={{ opacity: 0, x: 40, scale: 0.94 }}
    transition={{ type: 'spring', stiffness: 420, damping: 32 }}
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false); }}
    className="ui-toast pointer-events-auto flex shrink-0 items-start gap-3 rounded-xl bg-inverse px-4 py-3 text-sm text-inverse-on shadow-card"
  >
    <span aria-hidden="true" className="mt-0.5 shrink-0">{ICONS[toast.kind]}</span>
    <span className="min-w-0 flex-1 leading-snug [overflow-wrap:anywhere]">{toast.message}</span>
    <button type="button" aria-label="Dismiss notification" onClick={() => onDismiss(toast.id)} className="-my-2 -mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-inverse-muted hover:bg-black/5 hover:text-inverse-on">✕</button>
  </motion.div>;
}

export function useToast(): ToastState {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
