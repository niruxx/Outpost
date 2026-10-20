import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { t } from '../i18n/index.js';
import { Button, Modal } from './ui.js';

export interface ConfirmOptions {
  title?: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 'danger' renders the confirm button as a destructive action (delete, restore, etc). */
  tone?: 'danger' | 'default';
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (value: boolean) => void;
}

const ConfirmContext = createContext<((options: ConfirmOptions) => Promise<boolean>) | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  // `request` is kept populated across close so the dialog's content doesn't flash empty
  // while its exit animation plays; `open` alone controls visibility.
  const [request, setRequest] = useState<PendingConfirm | null>(null);
  const [open, setOpen] = useState(false);

  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setRequest((prev) => {
        // A confirm requested while another is still open resolves the old one as cancelled.
        prev?.resolve(false);
        return { ...options, resolve };
      });
      setOpen(true);
    });
  }, []);

  function settle(value: boolean) {
    setOpen(false);
    request?.resolve(value);
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal open={open} onClose={() => settle(false)} title={request?.title ?? 'Are you sure?'}>
        <div className="space-y-4">
          <div className="text-sm leading-relaxed text-ink-300">{request?.message}</div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => settle(false)}>
              {request?.cancelLabel ?? t('Cancel')}
            </Button>
            <Button variant={request?.tone === 'danger' ? 'danger' : 'primary'} onClick={() => settle(true)}>
              {request?.confirmLabel ?? t('Confirm')}
            </Button>
          </div>
        </div>
      </Modal>
    </ConfirmContext.Provider>
  );
}

/** Promise-based replacement for `window.confirm`, styled to match the rest of the app. */
export function useConfirm(): (options: ConfirmOptions) => Promise<boolean> {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used within ConfirmProvider');
  return ctx;
}
