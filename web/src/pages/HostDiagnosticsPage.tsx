import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AdminNotice, HostLayout, fmtTime, formatBytes } from '../components/HostLayout.js';
import { Badge, Button, Card, CardTitle, Field, Input, Modal, Notice, Spinner } from '../components/ui.js';
import { Icon } from '../components/icons.js';
import { useToast } from '../components/Toast.js';
import { useConfirm } from '../components/ConfirmDialog.js';
import { api, ApiError, downloadUrl } from '../api/client.js';
import { hostApi, useHostAdmin } from '../state/hostTarget.js';

interface Job {
  state: 'running' | 'succeeded' | 'failed';
  output: string;
  error: string | null;
  label: string;
  startedAt: string;
}

interface Kdump {
  installed: boolean;
  flavor?: 'fedora' | 'debian';
  unit?: string;
  active?: boolean;
  enabled?: boolean;
  reservedBytes?: number;
  loaded?: boolean;
  cmdline?: string | null;
  path?: string;
  dumps?: Array<{ name: string; modifiedAt: string }>;
}

interface Overview {
  linux: boolean;
  sosInstalled: boolean;
  reports: Array<{ name: string; size: number; createdAt: string; sha256: string | null }>;
  kdump: Kdump;
  job: Job | null;
}

export function HostDiagnosticsPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const adminMode = useHostAdmin().active;
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [label, setLabel] = useState('');
  const [job, setJob] = useState<Job | null>(null);
  const [dumpPath, setDumpPath] = useState('');
  const [testing, setTesting] = useState(false);
  const [hostname, setHostname] = useState('');

  const load = useCallback(async () => {
    try {
      const d = await api.get<Overview>(hostApi('/diagnostics'));
      setData(d);
      setJob(d.job);
      setDumpPath(d.kdump.path ?? '');
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load diagnostics');
    }
  }, []);

  useEffect(() => {
    void load();
    api
      .get<{ hostname: string }>(hostApi('/admin-mode'))
      .then((r) => setHostname(r.hostname))
      .catch(() => undefined);
  }, [load]);

  useEffect(() => {
    if (job?.state !== 'running') return;
    const t = window.setInterval(async () => {
      try {
        const r = await api.get<{ job: Job | null }>(hostApi('/diagnostics/job'));
        setJob(r.job);
        if (r.job && r.job.state !== 'running') {
          if (r.job.state === 'succeeded') toast.success('Diagnostic report ready');
          else toast.error(r.job.error ?? 'The report failed');
          void load();
        }
      } catch {
        // keep polling
      }
    }, 2000);
    return () => window.clearInterval(t);
  }, [job?.state, load, toast]);

  async function startReport() {
    try {
      const r = await api.post<{ job: Job }>(hostApi('/diagnostics/sos'), { label });
      setJob(r.job);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Couldn’t start the report');
    }
  }

  async function kdump(path: string, body: unknown, done: string) {
    try {
      const r = await api.post<{ overview: Overview }>(hostApi(path), body);
      setData((d) => (d ? { ...r.overview, job: d.job } : d));
      toast.success(done);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'The change failed');
    }
  }

  const dis = !adminMode;
  const title = adminMode ? undefined : 'Turn on Admin Mode first';
  const k = data?.kdump;

  return (
    <HostLayout>
      {error ? (
        <Notice tone="error">{error}</Notice>
      ) : !data ? (
        <Spinner />
      ) : !data.linux ? (
        <Notice tone="info">Diagnostic reports and kdump are only available on Linux hosts.</Notice>
      ) : (
        <>
          <AdminNotice active={adminMode} what="collect reports or configure kdump" />
          <Card className="p-5">
            <CardTitle>Diagnostic reports</CardTitle>
            <p className="mb-4 text-sm text-ink-400">
              A <code>sos</code> report gathers logs, configuration and hardware details into one archive for your distribution’s support or for troubleshooting. It can take
              several minutes and may contain sensitive information — share it with care.
            </p>
            {!data.sosInstalled ? (
              <p className="text-sm text-ink-400">
                Install the <b>sos</b> package from{' '}
                <Link className="text-accent-400 hover:underline" to="/host/software">
                  Software
                </Link>{' '}
                to collect reports.
              </p>
            ) : (
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Label (optional, e.g. a case number)">
                  <Input value={label} onChange={(e) => setLabel(e.target.value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32))} />
                </Field>
                <Button variant="primary" disabled={dis || job?.state === 'running'} title={title} onClick={() => void startReport()}>
                  {job?.state === 'running' ? <Spinner /> : null} Run report
                </Button>
              </div>
            )}
            {job && job.state !== 'succeeded' && (
              <pre className="mt-4 max-h-64 overflow-auto whitespace-pre-wrap rounded-2xl bg-surface-1000 p-3 font-mono text-xs text-ink-300">{job.output || job.label}</pre>
            )}
            {data.reports.length > 0 && (
              <div className="mt-4 divide-y divide-surface-700 overflow-hidden rounded-2xl bg-surface-900">
                {data.reports.map((r) => (
                  <div key={r.name} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-sm text-ink-100">{r.name}</p>
                      <p className="text-xs text-ink-500">
                        {fmtTime(r.createdAt)} · {formatBytes(r.size)}
                        {r.sha256 ? ` · sha256 ${r.sha256.slice(0, 16)}…` : ''}
                      </p>
                    </div>
                    <a className="inline-flex items-center gap-1 text-sm text-accent-400 hover:underline" href={downloadUrl(hostApi(`/diagnostics/reports/${encodeURIComponent(r.name)}`))}>
                      <Icon name="download" className="h-4 w-4" /> Download
                    </a>
                    <Button
                      variant="ghost"
                      onClick={async () => {
                        if (!(await confirm({ title: 'Delete report', message: `Delete ${r.name}?`, confirmLabel: 'Delete', tone: 'danger' }))) return;
                        try {
                          await api.delete(hostApi(`/diagnostics/reports/${encodeURIComponent(r.name)}`));
                          void load();
                        } catch (err) {
                          toast.error(err instanceof ApiError ? err.message : 'Couldn’t delete the report');
                        }
                      }}
                    >
                      <Icon name="trash" className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card className="p-5">
            <CardTitle action={k?.installed && <Badge tone={k.loaded ? 'green' : k.active ? 'yellow' : 'neutral'}>{k.loaded ? 'Ready to capture' : k.active ? 'Not ready' : 'Off'}</Badge>}>
              Kernel crash dumps (kdump)
            </CardTitle>
            {!k?.installed ? (
              <p className="text-sm text-ink-400">
                kdump saves the kernel’s memory when the host crashes, so the cause can be found afterwards. Install <b>kexec-tools</b> (Fedora/RHEL) or <b>kdump-tools</b>{' '}
                (Debian/Ubuntu) from{' '}
                <Link className="text-accent-400 hover:underline" to="/host/software">
                  Software
                </Link>
                .
              </p>
            ) : (
              <div className="space-y-4">
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                  <dt className="text-ink-500">Service</dt>
                  <dd className="text-ink-100">
                    {k.unit} — {k.active ? 'running' : 'stopped'}, {k.enabled ? 'starts at boot' : 'doesn’t start at boot'}
                  </dd>
                  <dt className="text-ink-500">Reserved memory</dt>
                  <dd className="text-ink-100">{k.reservedBytes ? formatBytes(k.reservedBytes) : 'None'}{k.cmdline ? ` (${k.cmdline})` : ''}</dd>
                  <dt className="text-ink-500">Dumps saved to</dt>
                  <dd className="font-mono text-ink-100">{k.path}</dd>
                </dl>
                {!k.reservedBytes && (
                  <Notice tone="warning">
                    No memory is reserved for the crash kernel, so nothing can be captured.{' '}
                    {k.flavor === 'fedora' ? 'Reserve it below, then restart the host.' : 'kdump-tools adds crashkernel= to GRUB on install; run update-grub and restart the host.'}
                  </Notice>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button variant={k.enabled ? 'outlined' : 'primary'} disabled={dis} title={title} onClick={() => void kdump('/diagnostics/kdump/service', { enabled: !k.enabled }, k.enabled ? 'kdump off' : 'kdump on')}>
                    {k.enabled ? 'Turn off' : 'Turn on'}
                  </Button>
                  {k.flavor === 'fedora' && (
                    <Button variant="outlined" disabled={dis} title={title} onClick={() => void kdump('/diagnostics/kdump/reserve', {}, 'Memory reserved — restart the host to apply')}>
                      Reserve memory automatically
                    </Button>
                  )}
                  <Button variant="danger" disabled={dis || !k.loaded} title={k.loaded ? title : 'kdump isn’t ready'} onClick={() => setTesting(true)}>
                    Test by crashing the host
                  </Button>
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <Field label="Dump folder">
                    <Input className="font-mono" value={dumpPath} onChange={(e) => setDumpPath(e.target.value)} />
                  </Field>
                  <Button disabled={dis || !dumpPath || dumpPath === k.path} title={title} onClick={() => void kdump('/diagnostics/kdump/path', { path: dumpPath }, 'Dump folder saved')}>
                    Save
                  </Button>
                </div>
                {k.dumps && k.dumps.length > 0 && (
                  <div>
                    <p className="mb-2 text-sm font-medium text-ink-200">Captured crashes</p>
                    <ul className="space-y-1 text-sm">
                      {k.dumps.map((d) => (
                        <li key={d.name} className="font-mono text-xs text-ink-300">
                          {k.path}/{d.name} — {fmtTime(d.modifiedAt)}
                        </li>
                      ))}
                    </ul>
                    <p className="mt-1 text-xs text-ink-500">Open them from Host Files or analyse with the crash utility in the Host Console.</p>
                  </div>
                )}
              </div>
            )}
          </Card>
        </>
      )}

      {testing && (
        <CrashTestModal
          hostname={hostname}
          onClose={() => setTesting(false)}
          onConfirm={async (typed) => {
            try {
              await api.post(hostApi('/diagnostics/kdump/test'), { confirm: typed });
              setTesting(false);
              toast.success('The host is crashing now; it should reboot after saving a dump');
            } catch (err) {
              toast.error(err instanceof ApiError ? err.message : 'Couldn’t start the test');
            }
          }}
        />
      )}
    </HostLayout>
  );
}

function CrashTestModal({ hostname, onClose, onConfirm }: { hostname: string; onClose: () => void; onConfirm: (typed: string) => Promise<void> }) {
  const [typed, setTyped] = useState('');
  return (
    <Modal open onClose={onClose} title="Test kdump">
      <div className="space-y-4">
        <Notice tone="error">
          This <b>crashes the kernel on purpose</b>. Everything on {hostname || 'the host'} stops immediately without shutting down cleanly — instances, VMs, containers and this panel.
          Unsaved data is lost. If kdump works, a dump is saved and the host reboots.
        </Notice>
        <Field label={`Type the host name (${hostname}) to confirm`}>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={!hostname || typed !== hostname} onClick={() => void onConfirm(typed)}>
            Crash the host
          </Button>
        </div>
      </div>
    </Modal>
  );
}
