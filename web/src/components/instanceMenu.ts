import type { NavigateFunction } from 'react-router-dom';
import type { ServerRecord } from '../api/types.js';
import { t } from '../i18n/index.js';
import { copyToClipboard, type MenuItems } from './ContextMenu.js';

export type PowerAction = 'start' | 'stop' | 'restart' | 'retry-install';

interface InstanceMenuOptions {
  server: ServerRecord;
  navigate: NavigateFunction;
  notify: { success: (m: string) => void; error: (m: string) => void };
  pinned?: boolean;
  togglePin?: (id: string) => void;
  /** Lifecycle entries appear only when given (and the instance isn't suspended). */
  power?: { busy: boolean; act: (id: string, action: PowerAction) => void };
  /** Extra entries placed just before the copy section. */
  extra?: MenuItems;
  /** Extra entries appended to the copy section. */
  copyExtra?: MenuItems;
}

/** The right-click menu shared by every place an instance is listed (cards, sidebar, Docker page). */
export function instanceMenu({ server, navigate, notify, pinned, togglePin, power, extra = [], copyExtra = [] }: InstanceMenuOptions): MenuItems {
  const base = `/instances/${server.id}`;
  const copy = (text: string, what: string) =>
    copyToClipboard(text).then((ok) => (ok ? notify.success(`${t(what)} ${t('copied')}`) : notify.error(t('Copy failed'))));
  const { status } = server;
  const canPower = power && !server.suspended;
  const lockedOut = !!server.suspended;

  return [
    { heading: server.name },
    { label: 'Open', icon: 'status', onSelect: () => navigate(base) },
    { label: 'Open in new tab', icon: 'external', onSelect: () => window.open(base, '_blank', 'noopener') },
    'separator',
    { label: 'Console', icon: 'console', disabled: lockedOut, onSelect: () => navigate(`${base}/console`) },
    { label: 'Files', icon: 'folder', disabled: lockedOut, onSelect: () => navigate(`${base}/files`) },
    { label: 'Backups', icon: 'backup', disabled: lockedOut, onSelect: () => navigate(`${base}/backups`) },
    { label: 'Configuration', icon: 'configuration', disabled: lockedOut, onSelect: () => navigate(`${base}/configuration`) },
    'separator',
    canPower && status === 'install_failed' && { label: 'Retry install', icon: 'restart', disabled: power.busy, onSelect: () => power.act(server.id, 'retry-install') },
    canPower && (status === 'stopped' || status === 'crashed') && { label: 'Start', icon: 'play', disabled: power.busy, onSelect: () => power.act(server.id, 'start') },
    canPower && status === 'running' && { label: 'Restart', icon: 'restart', disabled: power.busy, onSelect: () => power.act(server.id, 'restart') },
    canPower && status === 'running' && { label: 'Stop', icon: 'stop', danger: true, disabled: power.busy, onSelect: () => power.act(server.id, 'stop') },
    'separator',
    togglePin && { label: pinned ? 'Unpin' : 'Pin to top', icon: 'pin', onSelect: () => togglePin(server.id) },
    ...extra,
    'separator',
    { label: 'Copy name', icon: 'copy', onSelect: () => copy(server.name, 'Name') },
    { label: 'Copy link', icon: 'copy', onSelect: () => copy(`${window.location.origin}${base}`, 'Link') },
    { label: 'Copy instance ID', icon: 'copy', onSelect: () => copy(server.id, 'Instance ID') },
    ...copyExtra,
  ];
}
