import { useState, type FormEvent } from 'react';
import { LanguageSelect, t } from '../i18n/index.js';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useAuth } from '../state/AuthContext.js';
import { ApiError } from '../api/client.js';
import { Badge, Button, ErrorText, Field, Input } from '../components/ui.js';
import { Logo } from '../components/Logo.js';
import { Wallpaper } from '../components/Wallpaper.js';

const APP_VERSION = '1.0.0';

export function LoginPage() {
  const { login, user, setupRequired } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Second step: the password was right and the account has two-factor sign-in on.
  const [needsCode, setNeedsCode] = useState(false);
  const [code, setCode] = useState('');

  if (setupRequired) return <Navigate to="/setup" replace />;
  if (user) return <Navigate to={(location.state as { from?: string })?.from ?? '/'} replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const result = await login(username, password, needsCode ? code : undefined);
      if (result === 'two-factor') {
        setNeedsCode(true);
        return;
      }
      navigate('/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Login failed');
      if (needsCode) setCode('');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="relative isolate flex min-h-screen items-center justify-center px-4">
      <Wallpaper />
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="grid-backdrop absolute inset-0" />
        <motion.div
          className="absolute -top-24 left-1/3 h-72 w-72 rounded-full bg-accent-500/15 blur-[100px]"
          animate={{ y: [0, 20, 0] }}
          transition={{ duration: 7, repeat: Infinity, ease: 'easeInOut' }}
        />
      </div>
      <motion.div
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: 'spring', stiffness: 280, damping: 26 }}
        className="ui-card relative z-10 w-full max-w-sm rounded-4xl bg-surface-850 p-8"
      >
        <div className="mb-6 text-center">
          <Logo className="mx-auto mb-3.5 h-11 w-11 rounded-xl" />
          <div className="flex items-center justify-center gap-2">
            <h1 className="text-xl font-bold text-ink-50">{t('Sign in to Outpost')}</h1>
            <Badge tone="neutral">v{APP_VERSION}</Badge>
          </div>
          <p className="mt-1 text-sm text-ink-400">{t('Manage your servers, apps and games.')}</p>
          <LanguageSelect className="mt-3 !py-1 text-xs" />
        </div>
        <form onSubmit={onSubmit} className="space-y-4">
          {needsCode ? (
            <>
              <p className="text-sm text-ink-300">
                Enter the 6-digit code from your authenticator app for <span className="font-medium text-ink-100">{username}</span>, or one of your
                recovery codes.
              </p>
              <Field label="Authentication code">
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  className="font-mono tracking-widest"
                  required
                  autoFocus
                />
              </Field>
            </>
          ) : (
            <>
              <Field label="Username">
                <Input value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
              </Field>
              <Field label="Password">
                <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </Field>
            </>
          )}
          <ErrorText>{error}</ErrorText>
          <Button type="submit" variant="primary" className="w-full py-2" disabled={submitting}>
            {t(submitting ? 'Signing in…' : needsCode ? 'Verify' : 'Sign in')}
          </Button>
          {needsCode && (
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              onClick={() => {
                setNeedsCode(false);
                setCode('');
                setPassword('');
                setError('');
              }}
            >
              Use a different account
            </Button>
          )}
        </form>
      </motion.div>
    </div>
  );
}
