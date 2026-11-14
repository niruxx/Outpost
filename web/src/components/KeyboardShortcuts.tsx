import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../state/AuthContext.js';
import { Input, Modal } from './ui.js';
import { useConfirm } from './ConfirmDialog.js';
import { hasUnsavedChanges, discardUnsavedChanges } from '../lib/unsaved.js';
export function openShortcuts() { window.dispatchEvent(new Event('outpost:shortcuts')); }
const SHORTCUTS = [
  ['Ctrl / ⌘ K', 'Open command palette'], ['?', 'Open keyboard shortcut reference'], ['/', 'Focus the current page search'],
  ['Alt Shift D', 'Open dashboard'], ['Alt Shift J', 'Open job center'], ['Ctrl / ⌘ S', 'Review and save the visible configuration editor'],
  ['Escape', 'Close the top dialog or leave instance selection'], ['Tab / Shift Tab', 'Move focus; keep focus inside an open dialog'],
  ['↑ / ↓, Enter', 'Choose and run a command palette result'],
];
export function KeyboardShortcuts() {
  const { user } = useAuth(), navigate = useNavigate();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false), [query, setQuery] = useState('');
  useEffect(() => {
    if (!user) return;
    const show = () => { setQuery(''); setOpen(true); };
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const editing = (e.target as HTMLElement)?.closest('input,textarea,select,[contenteditable="true"],.monaco-editor,.xterm');
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !e.altKey) {
        const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-save-shortcut]')].filter(b => !b.disabled && !!b.getClientRects().length && !b.closest('[hidden],[inert]'));
        if (buttons.length === 1 && !document.querySelector('[aria-modal="true"]')) { e.preventDefault(); buttons[0].click(); } return;
      }
      if (editing || document.querySelector('[aria-modal="true"]')) return;
      if (e.key === '?' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); show(); }
      if (e.key === '/' && !e.ctrlKey && !e.metaKey) { const search = [...document.querySelectorAll<HTMLInputElement>('input[type="search"],input[aria-label^="Search"]')].find(i => !!i.getClientRects().length); if (search) { e.preventDefault(); search.focus(); } }
      if (e.altKey && e.shiftKey && ['d', 'j'].includes(e.key.toLowerCase())) { e.preventDefault(); const target = e.key.toLowerCase() === 'd' ? '/dashboard' : '/jobs'; void (async () => { if (hasUnsavedChanges()) { if (!await confirm({ title: 'Discard unsaved changes?', message: 'Leaving this page discards them.', confirmLabel: 'Discard and leave', tone: 'danger' })) return; discardUnsavedChanges(); } navigate(target); })(); }
    };
    window.addEventListener('outpost:shortcuts', show); window.addEventListener('keydown', key);
    return () => { window.removeEventListener('outpost:shortcuts', show); window.removeEventListener('keydown', key); };
  }, [user?.id, navigate, confirm]);
  return <Modal open={open} onClose={() => setOpen(false)} title="Keyboard shortcuts"><div className="space-y-4"><Input aria-label="Search keyboard shortcuts" placeholder="Search shortcuts" value={query} onChange={e => setQuery(e.target.value)} />{SHORTCUTS.filter(s => s.join(' ').toLowerCase().includes(query.toLowerCase())).map(([keys, label]) => <div key={keys} className="flex flex-wrap justify-between gap-3 border-b border-surface-600 pb-3"><span>{label}</span><kbd className="rounded-lg bg-surface-900 px-2 py-1 text-sm">{keys}</kbd></div>)}<p className="text-xs text-ink-400">Single-key shortcuts pause while typing or using terminals. Dialogs return focus to their trigger when closed.</p></div></Modal>;
}
