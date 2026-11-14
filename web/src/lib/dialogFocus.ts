import { useEffect, useRef, type RefObject } from 'react';

/** Shared focus loop and return target for modal editors, confirmations and the palette. */
export function useDialogFocus(open: boolean, ref: RefObject<HTMLElement | null>, close: () => void) {
  const closeRef = useRef(close); closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])') ?? [])].filter(e => !!e.getClientRects().length && !e.closest('[hidden],[inert]'));
    const timer = window.setTimeout(() => (ref.current?.querySelector<HTMLElement>('[autofocus]') ?? focusable()[0] ?? ref.current)?.focus(), 0);
    const topmost = () => { const dialogs = [...document.querySelectorAll<HTMLElement>('[aria-modal="true"]')].filter(e => !!e.getClientRects().length); return dialogs.at(-1) === ref.current; };
    const key = (e: KeyboardEvent) => {
      if (!topmost()) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeRef.current(); }
      if (e.key === 'Tab') { const list = focusable(), first = list[0], last = list.at(-1); if (!first) { e.preventDefault(); ref.current?.focus(); } else if (e.shiftKey && (document.activeElement === first || !ref.current?.contains(document.activeElement))) { e.preventDefault(); last?.focus(); } else if (!e.shiftKey && (document.activeElement === last || !ref.current?.contains(document.activeElement))) { e.preventDefault(); first.focus(); } }
    };
    document.addEventListener('keydown', key, true);
    return () => { clearTimeout(timer); document.removeEventListener('keydown', key, true); if (previous?.isConnected) previous.focus(); };
  }, [open, ref]);
}
