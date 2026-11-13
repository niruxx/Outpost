import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AdminNotice, HostLayout, fmtTime } from '../components/HostLayout.js';
import { Badge, Button, Card, CardTitle, ErrorText, Field, Input, Modal, Notice, Select, Spinner } from '../components/ui.js';
import { useToast } from '../components/Toast.js';
import { useConfirm } from '../components/ConfirmDialog.js';
import { api, ApiError, type UploadProgress } from '../api/client.js';
import { UploadTracker } from '../components/UploadTracker.js';
import { hostApi, useHostAdmin, useHostTarget } from '../state/hostTarget.js';

interface CertInfo {
  subject: string;
  issuer: string;
  names: string[];
  validFrom: string;
  validTo: string;
  daysLeft: number;
  selfSigned: boolean;
  fingerprint: string;
}

interface Tls {
  enabled: boolean;
  listening: boolean;
  port: number;
  redirect: boolean;
  source: 'custom' | 'self-signed' | 'acme' | null;
  domain: string | null;
  cert: CertInfo | null;
  error: string | null;
  lastError: string | null;
}

interface Job {
  state: 'running' | 'succeeded' | 'failed';
  output: string;
  error: string | null;
  label: string;
}

interface Overview {
  linux: boolean;
  selinux: { present: boolean; mode: string | null; configured: string | null; policy: string | null };
  apparmor: { present: boolean; enabled: boolean };
  crypto: { supported: boolean; current: string | null; available: string[] };
  tls: Tls;
}

interface Denial {
  time: string | null;
  kind: 'selinux' | 'apparmor';
  comm: string | null;
  permission: string | null;
  target: string | null;
  source: string | null;
  targetContext: string | null;
  targetClass: string | null;
  profile: string | null;
  raw: string;
}

export function HostSecurityPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const adminMode = useHostAdmin().active;
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [persistent, setPersistent] = useState(true);
  const [policy, setPolicy] = useState('');

  const load = useCallback(async () => {
    try {
      const d = await api.get<Overview>(hostApi('/security'));
      setData(d);
      setPolicy(d.crypto.current ?? '');
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load security settings');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function post(path: string, body: unknown, done: string) {
    try {
      const r = await api.post<Overview | Record<string, unknown>>(hostApi(path), body);
      if (r && 'selinux' in r) setData(r as Overview);
      else await load();
      toast.success(done);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'The change failed');
    }
  }

  async function selinuxMode(mode: 'enforcing' | 'permissive') {
    if (mode === 'permissive') {
      const ok = await confirm({ title: 'Switch SELinux to permissive?', message: 'Denials are only logged, not enforced, so confined services lose their protection.', confirmLabel: 'Switch', tone: 'danger' });
      if (!ok) return;
    }
    await post('/security/selinux/mode', { mode, persistent }, `SELinux ${mode}`);
  }

  const dis = !adminMode;
  const title = adminMode ? undefined : 'Turn on Admin Mode first';

  return (
    <HostLayout>
      {error ? (
        <Notice tone="error">{error}</Notice>
      ) : !data ? (
        <Spinner />
      ) : (
        <>
          {data.linux && <AdminNotice active={adminMode} what="change security settings or view denials" />}

          <TlsCard tls={data.tls} adminMode={adminMode} linux={data.linux} onChanged={load} />

          {data.selinux.present && (
            <Card className="p-5">
              <CardTitle action={<Badge tone={data.selinux.mode === 'enforcing' ? 'green' : data.selinux.mode === 'permissive' ? 'yellow' : 'red'}>{data.selinux.mode ?? 'disabled'}</Badge>}>SELinux</CardTitle>
              <p className="mb-3 text-sm text-ink-400">
                Policy {data.selinux.policy ?? '—'} · configured at boot: <b>{data.selinux.configured ?? '—'}</b>
              </p>
              {data.selinux.mode === 'disabled' || !data.selinux.mode ? (
                <p className="text-sm text-ink-400">SELinux is disabled. Enabling it needs a relabel and reboot; do it from the Host Console.</p>
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  <Button disabled={dis || data.selinux.mode === 'enforcing'} title={title} onClick={() => void selinuxMode('enforcing')}>
                    Enforcing
                  </Button>
                  <Button variant="outlined" disabled={dis || data.selinux.mode === 'permissive'} title={title} onClick={() => void selinuxMode('permissive')}>
                    Permissive
                  </Button>
                  <label className="flex items-center gap-2 text-sm text-ink-300">
                    <input type="checkbox" checked={persistent} onChange={(e) => setPersistent(e.target.checked)} /> Keep after reboot
                  </label>
                </div>
              )}
              {adminMode && data.selinux.mode && data.selinux.mode !== 'disabled' && <SelinuxDenials />}
            </Card>
          )}

          {data.apparmor.present && (
            <Card className="p-5">
              <CardTitle action={<Badge tone={data.apparmor.enabled ? 'green' : 'neutral'}>{data.apparmor.enabled ? 'Enabled' : 'Disabled'}</Badge>}>AppArmor</CardTitle>
              {!adminMode ? <p className="text-sm text-ink-400">Turn on Admin Mode to see profiles and denials.</p> : <AppArmorPanel />}
            </Card>
          )}

          {data.linux && !data.selinux.present && !data.apparmor.present && <Notice tone="info">Neither SELinux nor AppArmor is active on this host.</Notice>}

          {data.crypto.supported && (
            <Card className="p-5">
              <CardTitle action={<Badge tone="blue">{data.crypto.current}</Badge>}>System crypto policy</CardTitle>
              <p className="mb-3 text-sm text-ink-400">
                Sets which TLS/SSH protocols, ciphers and key sizes every library on the host accepts. LEGACY allows old clients; FUTURE refuses anything weaker than today’s
                recommendations. Services pick up a change when they restart.
              </p>
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Policy (optionally with :SUBPOLICY modules)">
                  <Input list="crypto-policies" value={policy} onChange={(e) => setPolicy(e.target.value.toUpperCase())} />
                </Field>
                <datalist id="crypto-policies">
                  {data.crypto.available.map((p) => (
                    <option key={p} value={p} />
                  ))}
                </datalist>
                <Button disabled={dis || !policy || policy === data.crypto.current} title={title} onClick={() => void post('/security/crypto-policy', { policy }, `Crypto policy ${policy}`)}>
                  Apply
                </Button>
              </div>
            </Card>
          )}
        </>
      )}
    </HostLayout>
  );
}

function DenialList({ denials, explain }: { denials: Denial[]; explain?: (d: Denial) => void }) {
  if (!denials.length) return <p className="text-sm text-ink-500">No denials recorded.</p>;
  return (
    <div className="max-h-[50vh] divide-y divide-surface-700 overflow-auto rounded-2xl bg-surface-900">
      {denials.map((d, i) => (
        <div key={i} className="flex flex-wrap items-start gap-3 px-4 py-3">
          <div className="min-w-0 flex-1 text-sm">
            <p className="text-ink-100">
              <span className="font-mono">{d.comm ?? '?'}</span> was denied <b>{d.permission ?? '?'}</b>
              {d.target ? (
                <>
                  {' '}
                  on <span className="font-mono">{d.target}</span>
                </>
              ) : null}
              {d.targetClass ? <span className="text-ink-500"> ({d.targetClass})</span> : null}
            </p>
            <p className="break-all font-mono text-xs text-ink-500">
              {d.kind === 'selinux' ? `${d.source} → ${d.targetContext}` : `profile ${d.profile}`} · {fmtTime(d.time)}
            </p>
          </div>
          {explain && (
            <Button variant="ghost" onClick={() => explain(d)}>
              Explain
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

function SelinuxDenials() {
  const [since, setSince] = useState('today');
  const [denials, setDenials] = useState<Denial[] | null>(null);
  const [error, setError] = useState('');
  const [explained, setExplained] = useState<{ d: Denial; explanation: string; allowRule: string } | null>(null);

  useEffect(() => {
    setDenials(null);
    api
      .get<{ denials: Denial[] }>(hostApi(`/security/selinux/denials?since=${since}`))
      .then((r) => setDenials(r.denials))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Couldn’t read denials'));
  }, [since]);

  async function explain(d: Denial) {
    try {
      const r = await api.post<{ explanation: string; allowRule: string }>(hostApi('/security/selinux/explain'), { raw: d.raw });
      setExplained({ d, ...r });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t explain the denial');
    }
  }

  return (
    <div className="mt-5 space-y-3">
      <div className="flex items-center gap-3">
        <p className="flex-1 text-sm font-medium text-ink-200">Access denials</p>
        <Select className="w-auto" value={since} onChange={(e) => setSince(e.target.value)} aria-label="Since">
          <option value="recent">Last 10 minutes</option>
          <option value="today">Today</option>
          <option value="week-ago">Last 7 days</option>
        </Select>
      </div>
      <ErrorText>{error}</ErrorText>
      {!denials ? <Spinner /> : <DenialList denials={denials} explain={(d) => void explain(d)} />}
      {explained && (
        <Modal open onClose={() => setExplained(null)} title="Why was this denied?" size="lg">
          <div className="space-y-4">
            <pre className="whitespace-pre-wrap rounded-2xl bg-surface-1000 p-4 font-mono text-xs text-ink-200">{explained.explanation || 'No explanation available.'}</pre>
            {explained.allowRule && (
              <>
                <p className="text-sm text-ink-300">
                  A local policy module that would allow it (review before using — fixing a file label with <code>restorecon</code> or flipping a boolean is usually better):
                </p>
                <pre className="whitespace-pre-wrap rounded-2xl bg-surface-1000 p-4 font-mono text-xs text-ink-200">{explained.allowRule}</pre>
              </>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

function AppArmorPanel() {
  const toast = useToast();
  const [data, setData] = useState<{ profiles: Array<{ name: string; mode: string }>; denials: Denial[] } | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');

  const load = useCallback(() => {
    api
      .get<{ profiles: Array<{ name: string; mode: string }>; denials: Denial[] }>(hostApi('/security/apparmor'))
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Couldn’t read AppArmor status'));
  }, []);
  useEffect(load, [load]);

  async function setMode(profile: string, mode: 'enforce' | 'complain') {
    try {
      await api.post(hostApi('/security/apparmor/mode'), { profile, mode });
      toast.success(`${profile}: ${mode}`);
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Couldn’t change the profile');
    }
  }

  if (error) return <ErrorText>{error}</ErrorText>;
  if (!data) return <Spinner />;
  const profiles = data.profiles.filter((p) => !filter || p.name.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Input className="max-w-xs" placeholder="Filter profiles…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="text-xs text-ink-500">
          {data.profiles.filter((p) => p.mode === 'enforce').length} enforcing · {data.profiles.filter((p) => p.mode === 'complain').length} complain
        </span>
      </div>
      <div className="max-h-[40vh] divide-y divide-surface-700 overflow-auto rounded-2xl bg-surface-900">
        {profiles.map((p) => (
          <div key={p.name} className="flex items-center gap-3 px-4 py-2">
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-200">{p.name}</span>
            <Badge tone={p.mode === 'enforce' ? 'green' : p.mode === 'complain' ? 'yellow' : 'neutral'}>{p.mode}</Badge>
            {(p.mode === 'enforce' || p.mode === 'complain') && (
              <Button variant="ghost" onClick={() => void setMode(p.name, p.mode === 'enforce' ? 'complain' : 'enforce')}>
                {p.mode === 'enforce' ? 'Complain' : 'Enforce'}
              </Button>
            )}
          </div>
        ))}
      </div>
      <p className="text-sm font-medium text-ink-200">Denials (last 7 days)</p>
      <DenialList denials={data.denials} />
    </div>
  );
}

function TlsCard({ tls, adminMode, linux, onChanged }: { tls: Tls; adminMode: boolean; linux: boolean; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const target = useHostTarget();
  const [port, setPort] = useState(String(tls.port));
  const [upload, setUpload] = useState(false);
  const [acme, setAcme] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const jobRef = useRef(job);
  jobRef.current = job;

  useEffect(() => {
    api
      .get<Tls & { job: Job | null }>(hostApi('/security/tls'))
      .then((r) => setJob(r.job))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (job?.state !== 'running') return;
    const t = window.setInterval(async () => {
      try {
        const r = await api.get<Tls & { job: Job | null }>(hostApi('/security/tls'));
        setJob(r.job);
        if (r.job?.state === 'succeeded') {
          toast.success('Certificate issued');
          void onChanged();
        } else if (r.job?.state === 'failed') toast.error(r.job.error ?? 'Certificate request failed');
      } catch {
        // keep polling
      }
    }, 1500);
    return () => window.clearInterval(t);
  }, [job?.state, onChanged, toast]);

  async function post(path: string, body: unknown, done: string, onProgress?: (progress: UploadProgress) => void) {
    try {
      if (onProgress) await api.uploadJson(hostApi(path), body, onProgress);
      else await api.post(hostApi(path), body);
      toast.success(done);
      await onChanged();
      return true;
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'The change failed');
      return false;
    }
  }

  const httpsUrl = `https://${window.location.hostname}:${tls.port}`;
  return (
    <Card className="p-5">
      <CardTitle action={<Badge tone={tls.listening ? 'green' : tls.enabled ? 'red' : 'neutral'}>{tls.listening ? `HTTPS on ${tls.port}` : tls.enabled ? 'Not listening' : 'HTTP only'}</Badge>}>
        Panel HTTPS{target.name ? ` (${target.name})` : ''}
      </CardTitle>
      {tls.lastError && tls.enabled && <Notice tone="error">HTTPS couldn’t start: {tls.lastError}</Notice>}
      {tls.cert ? (
        <div className="mb-4 space-y-1 text-sm">
          <p className="text-ink-100">
            {tls.cert.names.join(', ') || tls.cert.subject}{' '}
            <Badge tone={tls.cert.daysLeft < 14 ? 'red' : tls.cert.daysLeft < 30 ? 'yellow' : 'green'}>{tls.cert.daysLeft} days left</Badge>{' '}
            {tls.cert.selfSigned && <Badge tone="yellow">Self-signed</Badge>}
            {tls.source === 'acme' && <Badge tone="blue">Let’s Encrypt · renews automatically</Badge>}
          </p>
          <p className="text-xs text-ink-500">
            Issued by {tls.cert.issuer} · valid until {fmtTime(tls.cert.validTo)}
          </p>
        </div>
      ) : (
        <p className="mb-4 text-sm text-ink-400">No certificate yet. The panel is only served over plain HTTP, so passwords cross the network unencrypted unless a reverse proxy adds HTTPS.</p>
      )}
      <div className="flex flex-wrap gap-2">
        {linux && (
          <Button onClick={() => setAcme(true)} disabled={!adminMode || job?.state === 'running'} title={adminMode ? undefined : 'Turn on Admin Mode first'}>
            Get a Let’s Encrypt certificate
          </Button>
        )}
        <Button variant="outlined" onClick={() => setUpload(true)}>
          Upload certificate
        </Button>
        <Button variant="ghost" onClick={() => void post('/security/tls/self-signed', { names: [window.location.hostname] }, 'Self-signed certificate created')}>
          Create self-signed
        </Button>
      </div>
      {tls.cert && (
        <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-surface-700 pt-4">
          <Field label="HTTPS port">
            <Input type="number" className="w-28" value={port} onChange={(e) => setPort(e.target.value)} />
          </Field>
          <Button variant={tls.enabled ? 'outlined' : 'primary'} onClick={() => void post('/security/tls/options', { enabled: !tls.enabled, port: Number(port) }, tls.enabled ? 'HTTPS off' : 'HTTPS on')}>
            {tls.enabled ? 'Turn HTTPS off' : 'Turn HTTPS on'}
          </Button>
          {tls.enabled && Number(port) !== tls.port && <Button onClick={() => void post('/security/tls/options', { port: Number(port) }, `HTTPS moved to ${port}`)}>Change port</Button>}
          {tls.listening && (
            <label className="flex items-center gap-2 text-sm text-ink-300">
              <input type="checkbox" checked={tls.redirect} onChange={(e) => void post('/security/tls/options', { redirect: e.target.checked }, e.target.checked ? 'Browsers are sent to HTTPS' : 'Redirect off')} /> Send browsers on HTTP to HTTPS
            </label>
          )}
          {tls.listening && !target.nodeId && window.location.protocol === 'http:' && (
            <a className="text-sm text-accent-400 hover:underline" href={httpsUrl}>
              Open {httpsUrl}
            </a>
          )}
        </div>
      )}
      {job && (job.state === 'running' || job.state === 'failed') && (
        <pre className="mt-4 max-h-60 overflow-auto whitespace-pre-wrap rounded-2xl bg-surface-1000 p-3 font-mono text-xs text-ink-300">{job.output || job.label}</pre>
      )}

      {upload && <UploadCertModal onClose={() => setUpload(false)} onSave={async (cert, key, onProgress) => (await post('/security/tls/custom', { cert, key }, 'Certificate saved', onProgress)) && setUpload(false)} />}
      {acme && (
        <AcmeModal
          onClose={() => setAcme(false)}
          onStart={async (domain, email, staging) => {
            try {
              const r = await api.post<{ job: Job }>(hostApi('/security/tls/acme'), { domain, email, staging });
              setJob(r.job);
              setAcme(false);
            } catch (err) {
              toast.error(err instanceof ApiError ? err.message : 'Couldn’t start certbot');
            }
          }}
        />
      )}
    </Card>
  );
}

function UploadCertModal({ onClose, onSave }: { onClose: () => void; onSave: (cert: string, key: string, onProgress: (progress: UploadProgress) => void) => Promise<unknown> }) {
  const [cert, setCert] = useState('');
  const [key, setKey] = useState('');
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => { if (!busy) onClose(); };
  async function save() {
    if (busy) return;
    setBusy(true);
    try { await onSave(cert, key, setProgress); }
    finally { setBusy(false); setProgress(null); }
  }
  const area = 'ui-input h-36 w-full rounded-lg border border-surface-500 bg-transparent px-3 py-2 font-mono text-xs text-ink-100';
  return (
    <Modal open onClose={close} title="Upload certificate" size="lg">
      <div className="space-y-4">
        <Field label="Certificate chain (PEM, server certificate first)">
          <textarea className={area} value={cert} onChange={(e) => setCert(e.target.value)} placeholder="-----BEGIN CERTIFICATE-----" spellCheck={false} />
        </Field>
        <Field label="Private key (PEM, unencrypted)">
          <textarea className={area} value={key} onChange={(e) => setKey(e.target.value)} placeholder="-----BEGIN PRIVATE KEY-----" spellCheck={false} />
        </Field>
        <UploadTracker progress={progress} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !cert || !key} onClick={() => void save()}>
            {busy ? 'Uploading…' : 'Save'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function AcmeModal({ onClose, onStart }: { onClose: () => void; onStart: (domain: string, email: string, staging: boolean) => Promise<void> }) {
  const [domain, setDomain] = useState(/^[\d.:[\]]+$|^localhost$/.test(window.location.hostname) ? '' : window.location.hostname);
  const [email, setEmail] = useState('');
  const [staging, setStaging] = useState(false);
  return (
    <Modal open onClose={onClose} title="Let’s Encrypt certificate">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void onStart(domain, email, staging);
        }}
      >
        <Notice tone="info">
          certbot proves you control the domain over HTTP: the domain must point at this host and <b>port 80</b> must be reachable from the internet and free while it runs. Install certbot from{' '}
          <Link className="underline" to="/host/software">
            Software
          </Link>{' '}
          first. Renewals happen automatically through certbot’s timer.
        </Notice>
        <Field label="Domain">
          <Input value={domain} onChange={(e) => setDomain(e.target.value.trim())} placeholder="panel.example.com" required />
        </Field>
        <Field label="Email for expiry notices">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value.trim())} required />
        </Field>
        <label className="flex items-center gap-2 text-sm text-ink-300">
          <input type="checkbox" checked={staging} onChange={(e) => setStaging(e.target.checked)} /> Test against the staging server (untrusted certificate, no rate limits)
        </label>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!domain || !email}>
            Request certificate
          </Button>
        </div>
      </form>
    </Modal>
  );
}
