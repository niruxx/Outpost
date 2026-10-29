import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { Button, Card, ErrorText, Field, Select } from './ui.js';
import { useConfirm } from './ConfirmDialog.js';
import { useAuth } from '../state/AuthContext.js';
interface DefaultJava { supported: boolean; family: string; choices: string[]; current: string; error: string | null }
export function SystemJavaDefaultCard() {
  const [info, setInfo] = useState<DefaultJava | null>(null), [choice, setChoice] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const { user } = useAuth(); const confirm = useConfirm();
  async function load() { setError(''); try { const data = await api.get<DefaultJava>('/java/system-default'); setInfo(data); setChoice(data.choices.includes(data.current) ? data.current : data.choices[0] ?? ''); } catch (e) { setError(e instanceof Error ? e.message : 'Cannot read system Java'); } }
  useEffect(() => { void load(); }, []);
  async function save() {
    if (!await confirm({ title: 'Change the host’s default Java?', message: `Set ${choice} as the system Java default on this ${info?.family} host? Other applications using the system Java command will also use it on their next launch. Running instances and explicit JAVA_HOME/per-instance runtime choices are unaffected.` })) return;
    setBusy(true); setError('');
    try { setInfo(await api.put('/java/system-default', { choice })); await load(); } catch (e) { setError(e instanceof Error ? e.message : 'Could not change system Java'); } finally { setBusy(false); }
  }
  const command = info?.family === 'arch' ? 'archlinux-java set' : info?.family === 'fedora' ? 'alternatives --set java' : 'update-alternatives --set java';
  return <Card className="space-y-3 p-5"><h2 className="text-lg font-medium text-ink-100">Default Java environment</h2><p className="text-sm text-ink-400">Select the system runtime on Debian/Ubuntu, Fedora/RHEL or Arch Linux. Choices come from the distro’s registered Java environments. Outpost’s Minecraft version matching and explicit instance runtime selections continue to take priority.</p>{info && !info.supported ? <p className="text-xs text-ink-500">{info.error}</p> : info && <><p className="break-all text-xs text-ink-300">Detected distro family: {info.family} · Current system default: {info.current || 'None'}</p><Field label="Installed system Java"><Select disabled={busy || !info.choices.length || user?.role !== 'admin'} value={choice} onChange={e => setChoice(e.target.value)}>{!info.choices.length && <option value="">No registered environments found</option>}{info.choices.map(c => <option key={c} value={c}>{c}</option>)}</Select></Field><p className="break-all font-mono text-xs text-ink-500">{choice ? `${command} ${choice}` : command}</p><div className="flex gap-2"><Button variant="primary" disabled={busy || !choice || user?.role !== 'admin'} onClick={save}>Set system default</Button><Button disabled={busy} onClick={load}>Refresh defaults</Button></div><p className="text-xs text-ink-500">Changing the system selection needs root or the service account’s existing noninteractive sudo permission for this command. Outpost-managed Temurin downloads must first be registered with the distro to appear here.</p><ErrorText>{info.error}</ErrorText></>}<ErrorText>{error}</ErrorText></Card>;
}
