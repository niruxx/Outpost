import { useEffect, useState } from 'react';
import { setVisibleInterval } from '../lib/perf.js';
import { useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Logo } from '../components/Logo.js';
import { LanguageSelect, t } from '../i18n/index.js';

interface PublicStatus {
  name: string;
  game: string;
  description: string;
  online: boolean;
  status: 'online' | 'starting' | 'offline' | 'maintenance';
  uptimeSeconds: number | null;
  address: string | null;
  port: number | null;
  version: string | null;
  players: { online: number; max: number | null; names: string[] | null } | null;
  checkedAt: string;
}

const STATUS_STYLE: Record<PublicStatus['status'], { label: string; dot: string; text: string }> = {
  online: { label: 'Online', dot: 'bg-success-400', text: 'text-success-400' },
  starting: { label: 'Starting', dot: 'bg-yellow-400', text: 'text-yellow-400' },
  offline: { label: 'Offline', dot: 'bg-ink-500', text: 'text-ink-300' },
  maintenance: { label: 'Maintenance', dot: 'bg-sky-400', text: 'text-sky-400' },
};

function formatUptime(s: number): string {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

/** /status/<slug> — what players see: is it up, how to join, who's on. No sign-in. */
export function PublicStatusPage() {
  const { slug } = useParams();
  const [data, setData] = useState<PublicStatus | null>(null);
  const [missing, setMissing] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch(`/api/public/status/${encodeURIComponent(slug ?? '')}`)
        .then(async (r) => {
          if (cancelled) return;
          if (r.status === 404) return setMissing(true);
          if (r.ok) {
            setData((await r.json()) as PublicStatus);
            setMissing(false);
          }
        })
        .catch(() => {});
    load();
    const timer = setVisibleInterval(load, 30_000);
    return () => {
      cancelled = true;
      timer();
    };
  }, [slug]);

  useEffect(() => {
    if (data) document.title = `${data.name} — ${t(STATUS_STYLE[data.status].label)}`;
  }, [data]);

  const address = data ? data.address ?? (data.port ? `${window.location.hostname}:${data.port}` : null) : null;
  const style = data ? STATUS_STYLE[data.status] : null;

  return (
    <div className="ui-app relative flex min-h-screen items-center justify-center overflow-hidden bg-surface-950 px-4 py-10">
      <div className="pointer-events-none absolute inset-0">
        <div className="grid-backdrop absolute inset-0" />
        <div className="absolute -top-24 left-1/3 h-72 w-72 rounded-full bg-accent-500/15 blur-[100px]" />
      </div>
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="ui-card relative z-10 w-full max-w-md rounded-4xl bg-surface-850 p-7">
        {missing ? (
          <div className="text-center">
            <Logo className="mx-auto mb-3 h-10 w-10 rounded-xl" />
            <p className="text-lg font-medium text-ink-50">{t('No status page here')}</p>
            <p className="mt-1 text-sm text-ink-400">{t('The link may have changed, or the page was turned off.')}</p>
          </div>
        ) : !data || !style ? (
          <p className="text-center text-sm text-ink-400">{t('Loading…')}</p>
        ) : (
          <>
            <div className="mb-5 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h1 className="truncate text-2xl font-normal text-ink-50">{data.name}</h1>
                <p className="text-sm text-ink-400">
                  {data.game}
                  {data.version ? ` · ${data.version}` : ''}
                </p>
              </div>
              <span className={`inline-flex shrink-0 items-center gap-2 rounded-full bg-surface-900 px-3 py-1 text-sm font-medium ${style.text}`}>
                <span className="relative flex h-2.5 w-2.5">
                  {data.status === 'online' && <span className={`absolute inline-flex h-full w-full animate-ping-slow rounded-full ${style.dot}`} />}
                  <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${style.dot}`} />
                </span>
                {t(style.label)}
              </span>
            </div>
            {data.description && <p className="mb-5 whitespace-pre-wrap text-sm text-ink-200">{data.description}</p>}
            <div className="space-y-3">
              {address && (
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard?.writeText(address).then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    });
                  }}
                  className="state-layer flex w-full items-center justify-between rounded-2xl bg-surface-900 px-4 py-3 text-left"
                >
                  <span>
                    <span className="block text-xs text-ink-400">{t('Address')}</span>
                    <span className="font-mono text-base text-ink-50">{address}</span>
                  </span>
                  <span className="text-xs font-medium text-accent-400">{copied ? t('Copied!') : t('Copy')}</span>
                </button>
              )}
              <div className="grid grid-cols-2 gap-3">
                {data.players && (
                  <div className="rounded-2xl bg-surface-900 px-4 py-3">
                    <span className="block text-xs text-ink-400">{t('Players')}</span>
                    <span className="text-lg text-ink-50">
                      {data.players.online}
                      {data.players.max ? <span className="text-ink-400"> / {data.players.max}</span> : null}
                    </span>
                  </div>
                )}
                {data.uptimeSeconds !== null && (
                  <div className="rounded-2xl bg-surface-900 px-4 py-3">
                    <span className="block text-xs text-ink-400">{t('Uptime')}</span>
                    <span className="text-lg text-ink-50">{formatUptime(data.uptimeSeconds)}</span>
                  </div>
                )}
              </div>
              {data.players?.names && data.players.names.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {data.players.names.map((n) => (
                    <span key={n} className="rounded-full bg-surface-900 px-2.5 py-1 text-xs text-ink-200">
                      {n}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="mt-6 flex items-center justify-between gap-3 text-[11px] text-ink-500">
              <span>
                {t('Updated {time}', { time: new Date(data.checkedAt).toLocaleTimeString() })} · {t('Powered by Outpost')}
              </span>
              <LanguageSelect className="!py-0.5 text-[11px]" />
            </div>
          </>
        )}
      </motion.div>
    </div>
  );
}
