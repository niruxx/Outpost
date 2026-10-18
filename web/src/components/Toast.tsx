import { AnimatePresence, motion } from 'framer-motion';
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

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
    setToasts((prev) => [...prev, { id, kind, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4200);
  }, []);

  const value: ToastState = {
    show,
    success: (message) => show(message, 'success'),
    error: (message) => show(message, 'error'),
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-full max-w-sm flex-col gap-2">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, y: 16, scale: 0.94 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, x: 40, scale: 0.94 }}
              transition={{ type: 'spring', stiffness: 420, damping: 32 }}
              className="ui-toast pointer-events-auto flex items-start gap-3 rounded-xl bg-inverse px-4 py-3 text-sm text-inverse-on shadow-card"
            >
              <span className="mt-0.5">{ICONS[t.kind]}</span>
              <span className="flex-1 leading-snug">{t.message}</span>
              <button
                onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
                className="text-inverse-muted hover:text-inverse-on"
              >
                ✕
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastState {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
