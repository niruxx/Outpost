import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { Field, Select } from './ui.js';
export function SteamAccountSelect({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const [accounts, setAccounts] = useState<{ id: string; username: string }[]>([]);
  useEffect(() => { api.get<{ accounts: typeof accounts }>('/operations/steam').then(r => setAccounts(r.accounts)).catch(() => {}); }, []);
  return <Field label="Saved Steam account"><Select value={value.startsWith('account:') ? value : ''} disabled={disabled} onChange={e => onChange(e.target.value || 'anonymous')}><option value="">Anonymous / manual login below</option>{accounts.map(a => <option value={`account:${a.id}`} key={a.id}>{a.username}</option>)}</Select><p className="mt-1 text-xs text-ink-500">Manage your saved accounts and Steam Guard codes under Operations → My Steam accounts.</p></Field>;
}
