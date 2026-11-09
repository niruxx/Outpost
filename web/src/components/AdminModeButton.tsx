import { useState, type FormEvent } from 'react';
import { ApiError } from '../api/client.js';
import { useAuth } from '../state/AuthContext.js';
import { disableAdminMode, enableAdminMode, useAdminMode } from '../state/adminMode.js';
import { Icon } from './icons.js';
import { Button, ErrorText, Field, Input, Modal, Notice } from './ui.js';
import { useToast } from './Toast.js';

/**
 * "Admin Mode" in the top bar, modelled on Cockpit's limited/administrative access switch:
 * off by default, turned on by re-entering the OS account password (sudo), and turned off
 * with one click. While it is on, host file operations run as root.
 */
export function AdminModeButton() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const status = useAdminMode(isAdmin);
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!isAdmin || !status) return null;
  const { admin } = status;
  const active = admin.active;

  const close = () => {
    setOpen(false);
    setPassword('');
    setError('');
  };

  async function turnOn(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await enableAdminMode(password);
      toast.success('Admin Mode on — host files are managed as root');
      close();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not turn on Admin Mode');
    } finally {
      setBusy(false);
      setPassword('');
    }
  }

  async function turnOff() {
    setBusy(true);
    try {
      await disableAdminMode();
      toast.success('Admin Mode off — back to limited access');
      close();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not turn off Admin Mode');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={active ? 'Administrative access is on' : 'Limited access — click to turn on Admin Mode'}
        aria-pressed={active}
        className={`state-layer flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium ${
          active ? 'bg-yellow-500/20 text-yellow-300 ring-1 ring-yellow-500/40' : 'text-ink-300 ring-1 ring-surface-600'
        }`}
      >
        <Icon name={active ? 'unlock' : 'lock'} className="h-4 w-4" />
        <span className="hidden sm:inline">{active ? 'Admin Mode' : 'Limited access'}</span>
      </button>

      <Modal open={open} onClose={close} title={active ? 'Administrative access' : 'Switch to administrative access'}>
        {admin.alwaysOn ? (
          <div className="space-y-4">
            <Notice tone="warning">
              Outpost is running as <b>{status.serviceUser}</b>, which already has administrative rights. Host file operations always run with full
              access, so Admin Mode can't be turned off here.
            </Notice>
            <div className="flex justify-end">
              <Button onClick={close}>Close</Button>
            </div>
          </div>
        ) : active ? (
          <div className="space-y-4">
            <p className="text-sm text-ink-300">
              You have administrative access in this browser session
              {admin.since ? ` since ${new Date(admin.since).toLocaleTimeString([], { timeStyle: 'short' })}` : ''}. Host file operations run as{' '}
              <b>root</b>. It switches back to limited access after {admin.idleMinutes} minutes without use.
            </p>
            <ErrorText>{error}</ErrorText>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={close}>Keep on</Button>
              <Button variant="primary" onClick={turnOff} disabled={busy}>
                {busy ? 'Switching…' : 'Limit access'}
              </Button>
            </div>
          </div>
        ) : !admin.available ? (
          <div className="space-y-4">
            <Notice tone="info">{admin.reason ?? 'Admin Mode is unavailable on this host.'}</Notice>
            <div className="flex justify-end">
              <Button onClick={close}>Close</Button>
            </div>
          </div>
        ) : (
          <form onSubmit={turnOn} className="space-y-4">
            <p className="text-sm text-ink-300">
              Admin Mode lets the Host File Manager read and change files anywhere on this host as <b>root</b>, through <code>sudo</code> as{' '}
              <b>{status.serviceUser}</b>. Changes can break the operating system — be careful. Every change is recorded in the audit log.
            </p>
            {admin.needsPassword ? (
              <Field label={`Password for ${status.serviceUser}`}>
                <Input type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </Field>
            ) : (
              <Notice tone="info">This account can use sudo without a password.</Notice>
            )}
            <p className="text-xs text-ink-500">This is the host operating-system password used by sudo, not your Outpost password. It is passed to sudo once and never stored.</p>
            <ErrorText>{error}</ErrorText>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={close}>Cancel</Button>
              <Button type="submit" variant="primary" disabled={busy || (admin.needsPassword && !password)}>
                {busy ? 'Authenticating…' : 'Authenticate'}
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}
