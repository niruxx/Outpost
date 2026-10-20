import { useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { useAuth } from '../state/AuthContext.js';
import { ApiError } from '../api/client.js';
import { Button, ErrorText, Field, Input } from '../components/ui.js';
import { Logo } from '../components/Logo.js';
import { Wallpaper } from '../components/Wallpaper.js';

const FEATURES = [
  { icon: '🖥️', title: 'Create & run servers', desc: 'Vanilla, Paper, Purpur & Bedrock — installed for you.' },
  { icon: '📡', title: 'Live console', desc: 'Real-time output and commands, streamed over WebSocket.' },
  { icon: '🗂️', title: 'Files & backups', desc: 'Browse, edit, and schedule automatic zip backups.' },
  { icon: '👥', title: 'Team access', desc: 'Invite staff with admin, moderator, or viewer roles.' },
];

function scorePassword(pw: string): { score: number; label: string; color: string } {
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  const levels = [
    { label: 'Too short', color: 'bg-red-500' },
    { label: 'Weak', color: 'bg-red-500' },
    { label: 'Fair', color: 'bg-yellow-500' },
    { label: 'Good', color: 'bg-sky-500' },
    { label: 'Strong', color: 'bg-success-500' },
    { label: 'Excellent', color: 'bg-success-400' },
  ];
  return { score, ...levels[Math.min(score, levels.length - 1)] };
}

function Backdrop() {
  return (
    <div className="pointer-events-none fixed inset-0 overflow-hidden">
      <div className="grid-backdrop absolute inset-0" />
      {/* Still glows: a moving 100px blur is re-rendered every frame. */}
      <div className="absolute -top-32 left-1/4 h-80 w-80 rounded-full bg-accent-500/20 blur-[100px]" />
      <div className="absolute bottom-[-6rem] right-1/4 h-80 w-80 rounded-full bg-sky-500/15 blur-[100px]" />
    </div>
  );
}

function StepDots({ step }: { step: number }) {
  return (
    <div className="mb-8 flex items-center justify-center gap-2">
      {[0, 1, 2].map((i) => (
        <motion.div
          key={i}
          className="h-1.5 rounded-full bg-accent-500"
          animate={{ width: i === step ? 28 : 8, opacity: i <= step ? 1 : 0.25 }}
          transition={{ type: 'spring', stiffness: 400, damping: 34 }}
        />
      ))}
    </div>
  );
}

export function SetupPage() {
  const { setup } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const strength = useMemo(() => scorePassword(password), [password]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    setSubmitting(true);
    try {
      await setup(username, password);
      setStep(2);
      setTimeout(() => navigate('/'), 1600);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Setup failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="relative isolate flex min-h-screen items-center justify-center px-4">
      <Wallpaper />
      <Backdrop />
      <div className="relative z-10 w-full max-w-md">
        <StepDots step={step} />
        <AnimatePresence mode="wait">
          {step === 0 && (
            <motion.div
              key="welcome"
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -24 }}
              transition={{ type: 'spring', stiffness: 300, damping: 30 }}
              className="ui-card rounded-4xl bg-surface-850 p-8"
            >
              <div className="mb-6 text-center">
                <Logo className="mx-auto mb-4 h-12 w-12 rounded-2xl" />
                <h1 className="text-2xl font-bold text-ink-50">
                  Welcome to <span className="text-accent-400">Outpost</span>
                </h1>
                <p className="mt-1.5 text-sm text-ink-400">Your self-hosted control panel for servers, apps and game servers.</p>
              </div>
              <div className="mb-6 grid grid-cols-2 gap-3">
                {FEATURES.map((f, i) => (
                  <motion.div
                    key={f.title}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.08 * i, duration: 0.35 }}
                    className="rounded-xl border border-surface-700/70 bg-surface-800/50 p-3"
                  >
                    <div className="mb-1 text-lg">{f.icon}</div>
                    <p className="text-xs font-semibold text-ink-200">{f.title}</p>
                    <p className="mt-0.5 text-[11px] leading-snug text-ink-500">{f.desc}</p>
                  </motion.div>
                ))}
              </div>
              <Button variant="primary" className="w-full py-2 text-[15px]" onClick={() => setStep(1)}>
                Get started →
              </Button>
            </motion.div>
          )}

          {step === 1 && (
            <motion.div
              key="account"
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -24 }}
              transition={{ type: 'spring', stiffness: 300, damping: 30 }}
              className="ui-card rounded-4xl bg-surface-850 p-8"
            >
              <div className="mb-6">
                <h1 className="text-xl font-bold text-ink-50">Create your admin account</h1>
                <p className="mt-1 text-sm text-ink-400">You'll use this to sign in and manage the panel.</p>
              </div>
              <form onSubmit={onSubmit} className="space-y-4">
                <Field label="Username">
                  <Input value={username} onChange={(e) => setUsername(e.target.value)} required minLength={3} autoFocus />
                </Field>
                <Field label="Password">
                  <Input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={8}
                  />
                </Field>
                {password.length > 0 && (
                  <div className="space-y-1">
                    <div className="h-1.5 overflow-hidden rounded-full bg-surface-700">
                      <motion.div
                        className={`h-full ${strength.color}`}
                        animate={{ width: `${(strength.score / 5) * 100}%` }}
                        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                      />
                    </div>
                    <p className="text-[11px] text-ink-500">{strength.label}</p>
                  </div>
                )}
                <Field label="Confirm password">
                  <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required minLength={8} />
                </Field>
                <ErrorText>{error}</ErrorText>
                <div className="flex gap-2 pt-1">
                  <Button type="button" variant="ghost" onClick={() => setStep(0)}>
                    ← Back
                  </Button>
                  <Button type="submit" variant="primary" className="flex-1" disabled={submitting}>
                    {submitting ? 'Creating account…' : 'Create admin account'}
                  </Button>
                </div>
              </form>
            </motion.div>
          )}

          {step === 2 && (
            <motion.div
              key="done"
              initial={{ opacity: 0, scale: 0.94 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ type: 'spring', stiffness: 260, damping: 22 }}
              className="rounded-4xl bg-surface-850 p-10 text-center"
            >
              <motion.div
                initial={{ scale: 0, rotate: -45 }}
                animate={{ scale: 1, rotate: 0 }}
                transition={{ type: 'spring', stiffness: 300, damping: 18, delay: 0.1 }}
                className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-success-500/15 text-2xl text-success-400 border border-success-500/30"
              >
                ✓
              </motion.div>
              <h1 className="text-xl font-bold text-ink-50">You're all set!</h1>
              <p className="mt-1.5 text-sm text-ink-400">Taking you to your dashboard…</p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
