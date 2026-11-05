import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { useConfirm } from '../components/ConfirmDialog.js';
import { Button, Spinner } from '../components/ui.js';
import { Icon } from '../components/icons.js';
import { t } from '../i18n/index.js';

/**
 * Unsaved-changes tracking. Forms call `useUnsavedChanges(dirty, label)`; while any form is dirty
 * the browser warns before closing/reloading the tab, and `<UnsavedChangesGuard />` asks before
 * in-app links navigate away. (BrowserRouter has no navigation blocker, so links are caught at
 * the document level — the browser's back button isn't intercepted.)
 */
const dirtyForms = new Map<symbol, string>();

export function hasUnsavedChanges(): boolean {
  return dirtyForms.size > 0;
}

/** Forget every dirty form — call right before navigating away after the user agreed to discard. */
export function discardUnsavedChanges(): void {
  dirtyForms.clear();
}

export function useUnsavedChanges(dirty: boolean, label: string): void {
  const key = useRef(Symbol(label)).current;
  useEffect(() => {
    if (dirty) dirtyForms.set(key, label);
    else dirtyForms.delete(key);
    return () => {
      dirtyForms.delete(key);
    };
  }, [dirty, key, label]);
}

/** Mounted once (in App): beforeunload warning plus a confirm before in-app links leave dirty forms. */
export function UnsavedChangesGuard() {
  const confirm = useConfirm();
  const navigate = useNavigate();

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!dirtyForms.size) return;
      e.preventDefault();
      e.returnValue = '';
    };

    const onClick = (e: MouseEvent) => {
      if (!dirtyForms.size || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      // Same page (e.g. only the hash or search changes within a page) — nothing is lost.
      if (url.pathname === window.location.pathname) return;
      // Capture phase on document runs before React's handlers, so the router never sees the click.
      e.preventDefault();
      e.stopPropagation();
      const forms = [...new Set(dirtyForms.values())];
      void confirm({
        title: t('Discard unsaved changes?'),
        message: `${t('You have unsaved changes in')} ${forms.join(', ')}. ${t('Leaving this page discards them.')}`,
        confirmLabel: t('Discard and leave'),
        tone: 'danger',
      }).then((ok) => {
        if (!ok) return;
        discardUnsavedChanges();
        navigate(`${url.pathname}${url.search}${url.hash}`);
      });
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [confirm, navigate]);

  return null;
}

/** Sticky "Unsaved changes · Discard · Save" bar pinned to the bottom of the scrolling page. */
export function UnsavedBar({
  dirty, saving, onSave, onDiscard, message = 'You have unsaved changes', canSave = true,
}: {
  dirty: boolean; saving: boolean; onSave: () => void; onDiscard: () => void; message?: string; canSave?: boolean;
}) {
  return (
    <AnimatePresence>
      {dirty && (
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 24 }}
          transition={{ type: 'spring', stiffness: 460, damping: 34 }}
          className="ui-unsaved-bar sticky bottom-4 z-30 mx-auto mt-6 flex w-full max-w-2xl flex-wrap items-center gap-3 rounded-[1.75rem] bg-surface-800 py-2.5 pl-5 pr-2.5 shadow-card ring-1 ring-surface-600"
          role="status"
        >
          <Icon name="warning" className="h-5 w-5 shrink-0 text-yellow-400" />
          <span className="min-w-0 flex-1 text-sm text-ink-100">{t(message)}</span>
          <Button variant="ghost" onClick={onDiscard} disabled={saving}>Discard</Button>
          {canSave && (
            <Button variant="primary" onClick={onSave} disabled={saving}>
              {saving ? <><Spinner /> {t('Saving…')}</> : t('Save changes')}
            </Button>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
