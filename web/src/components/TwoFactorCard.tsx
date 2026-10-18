import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api, ApiError } from '../api/client.js';
import type { TwoFactorStatus } from '../api/types.js';
import { Badge, Button, Card, CardTitle, ErrorText, Field, Input, Modal, Spinner } from './ui.js';
import { useToast } from './Toast.js';

/** Recovery codes are shown once — offer copy and download before the user closes them. */
function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const toast = useToast();
  const text = codes.join('\n');
  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-300">
        Save these somewhere safe. Each one signs you in once if you lose your phone. They won’t be shown again.
      </p>
      <div className="grid grid-cols-2 gap-2 rounded-2xl bg-surface-1000 p-4 font-mono text-sm text-ink-100">
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="ghost"
          onClick={() =>
            navigator.clipboard
              ?.writeText(text)
              .then(() => toast.success('Recovery codes copied'))
              .catch(() => toast.error('Clipboard unavailable'))
          }
        >
          Copy
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([`Outpost recovery codes\n\n${text}\n`], { type: 'text/plain' }));
            a.download = 'outpost-recovery-codes.txt';
            a.click();
            URL.revokeObjectURL(a.href);
          }}
        >
          Download
        </Button>
        <Button variant="primary" onClick={onDone}>
          I’ve saved them
        </Button>
      </div>
    </div>
  );
}

/** Step 1: scan the QR code; step 2: confirm with a code; step 3: recovery codes. */
function SetupModal({ open, onClose, onEnabled }: { open: boolean; onClose: () => void; onEnabled: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; uri: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);

  useEffect(() => {
    if (!open) return;
    setSetup(null);
    setCode('');
    setError('');
    setCodes(null);
    api
      .post<{ secret: string; uri: string }>('/auth/2fa/setup')
      .then(async (res) => setSetup({ ...res, qr: await QRCode.toDataURL(res.uri, { margin: 1, width: 200 }) }))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Couldn’t start setup'));
  }, [open]);

  async function confirm() {
    setBusy(true);
    setError('');
    try {
      const res = await api.post<{ recoveryCodes: string[] }>('/auth/2fa/enable', { code });
      setCodes(res.recoveryCodes);
      onEnabled();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t turn on two-factor sign-in');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={codes ? 'Recovery codes' : 'Turn on two-factor sign-in'}>
      {codes ? (
        <RecoveryCodes codes={codes} onDone={onClose} />
      ) : !setup ? (
        error ? <ErrorText>{error}</ErrorText> : <Spinner />
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-ink-300">
            Scan this with an authenticator app (Google Authenticator, Authy, 1Password, Bitwarden…), then enter the 6-digit code it shows.
          </p>
          <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
            <img src={setup.qr} alt="QR code for your authenticator app" className="h-44 w-44 rounded-xl bg-white p-1" />
            <div className="min-w-0 flex-1 space-y-2 text-xs text-ink-400">
              <p>Can’t scan it? Enter this key instead:</p>
              <code className="block break-all rounded-lg bg-surface-1000 px-3 py-2 font-mono text-sm text-ink-100">{setup.secret.match(/.{1,4}/g)?.join(' ')}</code>
            </div>
          </div>
          <Field label="Code from the app">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              className="font-mono tracking-widest"
              autoFocus
            />
          </Field>
          <ErrorText>{error}</ErrorText>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={busy || code.length !== 6} onClick={confirm}>
              {busy ? 'Checking…' : 'Turn on'}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Turning 2FA off and making new recovery codes both need the password and a current code. */
function ConfirmModal({
  mode,
  onClose,
  onDone,
}: {
  mode: 'disable' | 'regenerate' | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);

  useEffect(() => {
    setPassword('');
    setCode('');
    setError('');
    setCodes(null);
  }, [mode]);

  async function submit() {
    setBusy(true);
    setError('');
    try {
      if (mode === 'disable') {
        await api.post('/auth/2fa/disable', { password, code });
        toast.success('Two-factor sign-in is off');
        onDone();
        onClose();
      } else {
        const res = await api.post<{ recoveryCodes: string[] }>('/auth/2fa/recovery-codes', { password, code });
        setCodes(res.recoveryCodes);
        onDone();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={mode !== null} onClose={onClose} title={mode === 'disable' ? 'Turn off two-factor sign-in' : 'New recovery codes'}>
      {codes ? (
        <RecoveryCodes codes={codes} onDone={onClose} />
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-ink-300">
            {mode === 'disable'
              ? 'Your account will only need its password to sign in.'
              : 'Your old recovery codes stop working as soon as new ones are made.'}
          </p>
          <Field label="Password">
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
          </Field>
          <Field label="Authentication code (or a recovery code)">
            <Input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" className="font-mono" />
          </Field>
          <ErrorText>{error}</ErrorText>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant={mode === 'disable' ? 'danger' : 'primary'} disabled={busy || !password || !code} onClick={submit}>
              {mode === 'disable' ? 'Turn off' : 'Make new codes'}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** The signed-in user's own sign-in security. */
export function TwoFactorCard() {
  const [status, setStatus] = useState<TwoFactorStatus | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [confirmMode, setConfirmMode] = useState<'disable' | 'regenerate' | null>(null);

  const load = () =>
    api
      .get<TwoFactorStatus>('/auth/2fa')
      .then(setStatus)
      .catch(() => {});

  useEffect(() => {
    load();
  }, []);

  return (
    <Card className="p-5">
      <CardTitle action={status && <Badge tone={status.enabled ? 'green' : 'neutral'}>{status.enabled ? 'On' : 'Off'}</Badge>}>
        Two-factor sign-in
      </CardTitle>
      {!status ? (
        <Spinner />
      ) : status.enabled ? (
        <div className="space-y-3 text-sm text-ink-300">
          <p>
            Signing in to your account needs a code from your authenticator app as well as your password.{' '}
            {status.recoveryCodesLeft} recovery code{status.recoveryCodesLeft === 1 ? '' : 's'} left.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setConfirmMode('regenerate')}>New recovery codes</Button>
            <Button variant="danger" onClick={() => setConfirmMode('disable')}>
              Turn off
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3 text-sm text-ink-300">
          <p>Add a code from an authenticator app to your password, so a leaked password alone can’t get into your account.</p>
          <Button variant="primary" onClick={() => setSetupOpen(true)}>
            Turn on
          </Button>
        </div>
      )}
      <SetupModal open={setupOpen} onClose={() => setSetupOpen(false)} onEnabled={load} />
      <ConfirmModal mode={confirmMode} onClose={() => setConfirmMode(null)} onDone={load} />
    </Card>
  );
}
