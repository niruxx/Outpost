import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '../api/client.js';
import type { LaunchConfig, Platform, RestartConfig, StopConfig, StopSignal, WineConfig, WineStatus } from '../api/types.js';
import { Field, Input, Select } from './ui.js';
import { Icon } from './icons.js';
import { EMPHASIZED } from './motion.js';

export const LAUNCH_VARIABLES = ['PORT', 'NAME', 'ID', 'DIR', 'MIN_MEMORY', 'MAX_MEMORY'] as const;

const DEFAULTS: Record<Platform, { executable: string; args: string; stop: string }> = {
  java: { executable: 'the installed server jar', args: 'nogui + extra server args', stop: 'console "stop"' },
  bedrock: { executable: 'bedrock_server', args: 'extra server args', stop: 'console "stop"' },
  steam: { executable: "the game's server binary", args: "the game's default launch args", stop: "the game's own stop method" },
  custom: { executable: '', args: 'none', stop: 'SIGTERM' },
  docker: { executable: 'the image', args: 'the image default', stop: 'SIGTERM to the container' },
};

function Collapse({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.25, ease: EMPHASIZED }}
          className="overflow-hidden"
        >
          <div className="pt-3">{children}</div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Which Java major a Java instance runs with — automatic (by Minecraft version) or one that's installed. */
function JavaVersionField({ value, onChange }: { value: number | undefined; onChange: (v: number | undefined) => void }) {
  const [majors, setMajors] = useState<number[]>([]);
  useEffect(() => {
    api
      .get<{ runtimes: { major: number }[] }>('/java')
      .then((r) => setMajors([...new Set(r.runtimes.map((x) => x.major))].sort((a, b) => b - a)))
      .catch(() => setMajors([]));
  }, []);
  const options = value && !majors.includes(value) ? [value, ...majors] : majors;
  return (
    <Field label="Java version">
      <Select value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : undefined)}>
        <option value="">Automatic — what this Minecraft version needs</option>
        {options.map((m) => (
          <option key={m} value={m}>
            Java {m}
            {majors.includes(m) ? '' : ' (not installed)'}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/** The Wine tab owns these settings; the launch editor only says what's set and keeps them as they are. */
function WineSummary({ value }: { value: WineConfig | undefined }) {
  const [status, setStatus] = useState<WineStatus | null>(null);
  useEffect(() => {
    api.get<WineStatus>('/servers/wine/status').then(setStatus).catch(() => setStatus(null));
  }, []);
  if (status && !status.supported) return null;
  const mode = value?.mode ?? 'auto';
  return (
    <p className="text-xs text-ink-500">
      Wine: <span className="text-ink-300">{mode === 'auto' ? 'automatic (for .exe / Windows-only games)' : mode}</span>
      {status && !status.available && <span className="text-yellow-400"> — not installed on this host</span>}. Windows version, DLL overrides, dependencies and more are in the instance’s Wine tab.
    </p>
  );
}

const lines = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean);

/**
 * Edits a LaunchConfig. Admin-only options (shell mode, absolute paths, a custom Java binary, stop
 * and restart scripts) are hidden for everyone else — the server enforces the same rule.
 */
export function LaunchEditor({
  value,
  onChange,
  platform,
  isAdmin,
  disabled = false,
}: {
  value: LaunchConfig;
  onChange: (next: LaunchConfig) => void;
  platform: Platform;
  isAdmin: boolean;
  disabled?: boolean;
}) {
  const set = (patch: Partial<LaunchConfig>) => onChange({ ...value, ...patch });
  const defaults = DEFAULTS[platform];
  const custom = platform === 'custom';
  const stop: StopConfig = value.stop ?? { kind: 'default' };
  const restart: RestartConfig = value.restart ?? { kind: 'default' };
  const env = value.env ?? [];

  return (
    <fieldset disabled={disabled} className="space-y-5">
      <div className="space-y-4">
        {custom && isAdmin && (
          <label className="flex items-start gap-3 rounded-2xl bg-surface-900 p-3 text-sm text-ink-200">
            <input type="checkbox" className="mt-1" checked={!!value.useShell} onChange={(e) => set({ useShell: e.target.checked })} />
            <span>
              <span className="font-medium">Run as a shell command</span>
              <span className="block text-xs text-ink-400">
                Runs the command below through <span className="font-mono">/bin/sh -c</span> — use for pipes, <span className="font-mono">&&</span>, or{' '}
                <span className="font-mono">$VARIABLES</span>. The whole process group is stopped together.
              </span>
            </span>
          </label>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={platform === 'java' ? 'Server jar' : value.useShell ? 'Command' : custom ? 'Executable or script' : 'Executable'}>
            <Input
              value={value.executable ?? ''}
              onChange={(e) => set({ executable: e.target.value })}
              placeholder={custom ? (value.useShell ? './start.sh --port {{PORT}} | tee server.log' : 'start.sh or bin/server') : `Default: ${defaults.executable}`}
              className="font-mono"
            />
          </Field>
          <Field label="Arguments">
            <Input
              value={value.args ?? ''}
              onChange={(e) => set({ args: e.target.value })}
              placeholder={`Default: ${defaults.args}`}
              className="font-mono"
            />
          </Field>
          {platform === 'java' && <JavaVersionField value={value.javaVersion} onChange={(javaVersion) => set({ javaVersion })} />}
          {platform === 'java' && isAdmin && (
            <Field label="Java binary">
              <Input value={value.javaPath ?? ''} onChange={(e) => set({ javaPath: e.target.value })} placeholder="Default: auto-detected java" className="font-mono" />
            </Field>
          )}
          <Field label="Working directory">
            <Input value={value.workingDir ?? ''} onChange={(e) => set({ workingDir: e.target.value })} placeholder="Default: the instance folder" className="font-mono" />
          </Field>
          {custom && (
            <Field label="Web interface on port (optional)">
              <div className="flex gap-2">
                <Select
                  value={value.webUi?.scheme ?? 'http'}
                  onChange={(e) => value.webUi && set({ webUi: { ...value.webUi, scheme: e.target.value as 'http' | 'https' } })}
                  className="!w-24"
                  disabled={!value.webUi}
                >
                  <option value="http">http</option>
                  <option value="https">https</option>
                </Select>
                <Input
                  type="number"
                  min={1}
                  max={65535}
                  value={value.webUi?.port ?? ''}
                  onChange={(e) => set({ webUi: e.target.value ? { port: Number(e.target.value), scheme: value.webUi?.scheme ?? 'http', path: value.webUi?.path ?? '/' } : undefined })}
                  placeholder="none — e.g. 3000"
                />
              </div>
            </Field>
          )}
          {custom && (
            <Field label="Clients connect over">
              <Select value={value.protocol ?? 'tcp'} onChange={(e) => set({ protocol: e.target.value as 'tcp' | 'udp' })}>
                <option value="tcp">TCP</option>
                <option value="udp">UDP</option>
              </Select>
            </Field>
          )}
        </div>
        <p className="text-xs text-ink-500">
          Paths are relative to the instance folder{isAdmin ? ' (absolute paths are allowed for admins)' : ''}. Quotes group words in arguments.
          {platform === 'java' && ' Memory flags and extra JVM args from General are always applied.'}
        </p>
      </div>

      {(platform === 'steam' || custom) && <WineSummary value={value.wine} />}

      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-medium text-ink-300">Environment variables</span>
          <button type="button" className="state-layer inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium text-accent-400" onClick={() => set({ env: [...env, { key: '', value: '' }] })}>
            <Icon name="plus" className="h-3.5 w-3.5" /> Add variable
          </button>
        </div>
        <AnimatePresence initial={false}>
          {env.map((e, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2, ease: EMPHASIZED }}
              className="overflow-hidden"
            >
              <div className="mb-2 flex items-center gap-2">
                <Input
                  value={e.key}
                  onChange={(ev) => set({ env: env.map((x, j) => (j === i ? { ...x, key: ev.target.value.replace(/[^A-Za-z0-9_]/g, '_') } : x)) })}
                  placeholder="NAME"
                  className="!w-40 font-mono"
                />
                <span className="text-ink-500">=</span>
                <Input
                  value={e.value}
                  onChange={(ev) => set({ env: env.map((x, j) => (j === i ? { ...x, value: ev.target.value } : x)) })}
                  placeholder="value (variables allowed)"
                  className="font-mono"
                />
                <button type="button" aria-label="Remove variable" className="state-layer rounded-full p-2 text-ink-400" onClick={() => set({ env: env.filter((_, j) => j !== i) })}>
                  <Icon name="close" className="h-4 w-4" />
                </button>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
        {env.length === 0 && <p className="text-xs text-ink-500">None. SERVER_PORT, SERVER_NAME, SERVER_DIR and friends are always set.</p>}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Field label="Stop the server by">
            <Select
              value={stop.kind}
              onChange={(e) => {
                const kind = e.target.value as StopConfig['kind'];
                set({
                  stop:
                    kind === 'stdin'
                      ? { kind, commands: ['stop'], delayMs: 0 }
                      : kind === 'signal'
                        ? { kind, signal: 'SIGTERM' }
                        : kind === 'script'
                          ? { kind, command: './stop.sh' }
                          : undefined,
                });
              }}
            >
              <option value="default">Default ({defaults.stop})</option>
              <option value="stdin">Typing console command(s)</option>
              <option value="signal">Sending a signal</option>
              {(isAdmin || stop.kind === 'script') && <option value="script">Running a stop script</option>}
            </Select>
          </Field>
          <Collapse open={stop.kind === 'stdin'}>
            {stop.kind === 'stdin' && (
              <div className="grid grid-cols-[minmax(0,1fr)_110px] gap-2">
                <textarea
                  value={stop.commands.join('\n')}
                  onChange={(e) => set({ stop: { ...stop, commands: e.target.value.split('\n') } })}
                  onBlur={(e) => set({ stop: { ...stop, commands: lines(e.target.value) } })}
                  rows={3}
                  placeholder={'save-all\nstop'}
                  className="w-full rounded-lg border border-surface-500 bg-transparent px-3 py-2 font-mono text-sm text-ink-100 outline-none focus:border-accent-400"
                />
                <Field label="Delay (ms)">
                  <Input type="number" min={0} value={stop.delayMs ?? 0} onChange={(e) => set({ stop: { ...stop, delayMs: Number(e.target.value) } })} />
                </Field>
              </div>
            )}
          </Collapse>
          <Collapse open={stop.kind === 'signal'}>
            {stop.kind === 'signal' && (
              <Select value={stop.signal} onChange={(e) => set({ stop: { kind: 'signal', signal: e.target.value as StopSignal } })}>
                {(['SIGTERM', 'SIGINT', 'SIGQUIT', 'SIGHUP'] as const).map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </Select>
            )}
          </Collapse>
          <Collapse open={stop.kind === 'script'}>
            {stop.kind === 'script' && (
              <Input value={stop.command} onChange={(e) => set({ stop: { kind: 'script', command: e.target.value } })} placeholder="./stop.sh {{PORT}}" className="font-mono" />
            )}
          </Collapse>
        </div>

        <div>
          <Field label="Restart the server by">
            <Select
              value={restart.kind}
              onChange={(e) => {
                const kind = e.target.value as RestartConfig['kind'];
                set({ restart: kind === 'stdin' ? { kind, commands: ['restart'] } : kind === 'script' ? { kind, command: './restart.sh' } : undefined });
              }}
            >
              <option value="default">Default (stop, then start)</option>
              <option value="stdin">Typing console command(s)</option>
              {(isAdmin || restart.kind === 'script') && <option value="script">Running a restart script</option>}
            </Select>
          </Field>
          <Collapse open={restart.kind === 'stdin'}>
            {restart.kind === 'stdin' && (
              <textarea
                value={restart.commands.join('\n')}
                onChange={(e) => set({ restart: { kind: 'stdin', commands: e.target.value.split('\n') } })}
                onBlur={(e) => set({ restart: { kind: 'stdin', commands: lines(e.target.value) } })}
                rows={3}
                placeholder="restart"
                className="w-full rounded-lg border border-surface-500 bg-transparent px-3 py-2 font-mono text-sm text-ink-100 outline-none focus:border-accent-400"
              />
            )}
          </Collapse>
          <Collapse open={restart.kind === 'script'}>
            {restart.kind === 'script' && (
              <Input value={restart.command} onChange={(e) => set({ restart: { kind: 'script', command: e.target.value } })} placeholder="./restart.sh" className="font-mono" />
            )}
          </Collapse>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Mark as running when output matches (regex)">
          <Input
            value={value.readyPattern ?? ''}
            onChange={(e) => set({ readyPattern: e.target.value })}
            placeholder={custom ? 'e.g. Server started|Listening on' : 'Default: built-in'}
            className="font-mono"
          />
        </Field>
        <Field label="Force-stop after (seconds)">
          <Input
            type="number"
            min={5}
            max={900}
            value={value.stopTimeoutSec ?? ''}
            onChange={(e) => set({ stopTimeoutSec: e.target.value ? Number(e.target.value) : undefined })}
            placeholder="60"
          />
        </Field>
      </div>

      <div className="rounded-2xl bg-surface-900 p-3">
        <p className="mb-2 text-xs font-medium text-ink-300">Variables you can use in the command, arguments, env values and scripts</p>
        <div className="flex flex-wrap gap-1.5">
          {LAUNCH_VARIABLES.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => navigator.clipboard?.writeText(`{{${v}}}`).catch(() => {})}
              title="Copy"
              className="state-layer rounded-lg border border-surface-600 px-2 py-0.5 font-mono text-xs text-ink-200"
            >
              {`{{${v}}}`}
            </button>
          ))}
        </div>
      </div>
    </fieldset>
  );
}

/** Drops empty fields so "unset" really means "use the platform default". */
export function cleanLaunchConfig(c: LaunchConfig): LaunchConfig {
  const out: LaunchConfig = {};
  for (const key of ['executable', 'javaPath', 'args', 'workingDir', 'readyPattern'] as const) {
    if (c[key]?.trim()) out[key] = c[key]!.trim();
  }
  if (c.useShell) out.useShell = true;
  if (c.javaVersion) out.javaVersion = c.javaVersion;
  if (c.protocol) out.protocol = c.protocol;
  const env = (c.env ?? []).filter((e) => e.key.trim());
  if (env.length) out.env = env;
  if (c.stop && c.stop.kind !== 'default') {
    out.stop = c.stop.kind === 'stdin' ? { ...c.stop, commands: c.stop.commands.map((x) => x.trim()).filter(Boolean) } : c.stop;
  }
  if (c.restart && c.restart.kind !== 'default') {
    out.restart = c.restart.kind === 'stdin' ? { ...c.restart, commands: c.restart.commands.map((x) => x.trim()).filter(Boolean) } : c.restart;
  }
  if (c.stopTimeoutSec) out.stopTimeoutSec = c.stopTimeoutSec;
  if (c.webUi?.port) out.webUi = c.webUi;
  if (c.wine) out.wine = c.wine; // edited in the Wine tab; passed through untouched
  return out;
}
