import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useServerDetail } from './ServerContext.js';
import { Button, Card, Input, ErrorText } from '../../components/ui.js';
import { useConfirm } from '../../components/ConfirmDialog.js';
type Port = {
    role: string;
    offset: number;
    protocol: string;
};
type Profile = {
    id: string;
    name: string;
    versions: {
        version: number;
        at: number;
        files: Record<string, string>;
        parent?: {
            id: string;
            version: number;
        };
    }[];
};
type Match = {
    id: string;
    teamA: string;
    teamB: string;
    rosterA: string[];
    rosterB: string[];
    maps: string[];
    vetoes: {
        map: string;
        team: string;
    }[];
    state: string;
    scoreA?: number;
    scoreB?: number;
};
type Data = {
    ports: {
        role: string;
        port: number;
        protocol: string;
    }[];
    suggestedPorts: Port[];
    profiles: Profile[];
    managed: {
        file: string;
        version: string;
        project: string;
    }[];
    modPlan: {
        id: string;
        current: {
            file: string;
            version: string;
        }[];
        files: {
            file: string;
            version: string;
            project: string;
        }[];
        warnings: string[];
        state: string;
    } | null;
    staging: {
        id: string;
        clone: string;
        state: string;
        backup?: string;
    }[];
    imports: {
        at: number;
        path: string;
        edition: string;
        version: unknown;
        findings: {
            severity: string;
            message: string;
        }[];
    }[];
    matches: Match[];
    bans: {
        id: string;
        name: string;
        expires: number;
        state: string;
    }[];
    profiler: {
        urls: string[];
        lines: string[];
        suggestions: string[];
    } | null;
    sleep: {
        config: {
            enabled: boolean;
            port: number;
            idleSeconds: number;
        };
        state: string;
        error: string | null;
        listening: boolean;
    };
    fastdl: {
        supported: boolean;
        publication: {
            url: string;
            assets: {
                path: string;
            }[];
            enabled: boolean;
        } | null;
    };
    sharedBans?: {
        name: string;
        reason: string;
    }[];
};
const textarea = 'w-full min-h-28 rounded border border-surface-700 bg-surface-900 p-2 font-mono text-sm text-ink-200';
const list = (text: string) => text.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
function Section({ title, children }: {
    title: string;
    children: React.ReactNode;
}) { return <Card className="p-4"><details><summary className="cursor-pointer text-lg font-semibold">{title}</summary><div className="mt-3 space-y-3">{children}</div></details></Card>; }
export function GameWorkflowsTab() {
    const { serverId, server, can, isAdmin } = useServerDetail();
    const prefix = `/servers/${serverId}/game-workflows`, confirm = useConfirm();
    const [data, setData] = useState<Data | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [report, setReport] = useState<unknown>(null);
    const [roles, setRoles] = useState<Port[]>([]), [base, setBase] = useState(server?.server_port ?? 25565), [sleep, setSleep] = useState({ enabled: false, port: (server?.server_port ?? 25565) + 1, idleSeconds: 600 });
    const [projectRefs, setProjectRefs] = useState(''), [world, setWorld] = useState('world'), [requirements, setRequirements] = useState(''), [stagingPort, setStagingPort] = useState((server?.server_port ?? 25565) + 100), [promotion, setPromotion] = useState<Record<string, string>>({});
    const [profileId, setProfileId] = useState(''), [profileName, setProfileName] = useState(''), [parentId, setParentId] = useState(''), [filePath, setFilePath] = useState('server.properties'), [content, setContent] = useState(''), [profileFiles, setProfileFiles] = useState<Record<string, string>>({}), [version, setVersion] = useState(1), [selected, setSelected] = useState<string[]>([]), [targets, setTargets] = useState<string[]>([serverId]), [inventory, setInventory] = useState<{
        id: string;
        name: string;
    }[]>([]), [previews, setPreviews] = useState<Record<string, {
        revision: string;
        changes: {
            path: string;
            before: string | null;
            after: string;
        }[];
    }>>({});
    const [playerQuery, setPlayerQuery] = useState(''), [players, setPlayers] = useState<{
        name: string;
        identities?: string[];
        joins?: number;
        lastSeen?: number;
        online?: boolean;
        notes: {
            note: string;
            at: number;
        }[];
    }[]>([]), [playerName, setPlayerName] = useState(''), [note, setNote] = useState(''), [banMinutes, setBanMinutes] = useState(60), [banReason, setBanReason] = useState('Panel moderation');
    const [shared, setShared] = useState(''), [teamA, setTeamA] = useState('Team A'), [teamB, setTeamB] = useState('Team B'), [rosterA, setRosterA] = useState(''), [rosterB, setRosterB] = useState(''), [mapPool, setMapPool] = useState(''), [scores, setScores] = useState<Record<string, {
        a: number;
        b: number;
    }>>({});
    const [profileSeconds, setProfileSeconds] = useState(60), [profileConsent, setProfileConsent] = useState(false), [assets, setAssets] = useState(''), [assetUrl, setAssetUrl] = useState(`${location.origin}/fastdl/${serverId}`), [compress, setCompress] = useState(false);
    const [discord, setDiscord] = useState<{
        enabled: boolean;
        applicationId: string;
        publicKey: string;
        guildId: string;
        mappings: unknown[];
        tokenConfigured?: boolean;
    } | null>(null), [mapping, setMapping] = useState('[]');
    async function load(initial = false) { try {
        const d = await api.get<Data>(prefix);
        setData(d);
        if (initial) {
            setRoles(d.suggestedPorts);
            setSleep(d.sleep.config);
            setShared(JSON.stringify(d.sharedBans ?? [], null, 2));
        }
    }
    catch (e) {
        setError((e as Error).message);
    } }
    useEffect(() => { void load(true); api.get<{
        servers: {
            id: string;
            name: string;
        }[];
    }>('/servers').then(r => setInventory(r.servers)).catch(() => { }); if (isAdmin)
        api.get<NonNullable<typeof discord>>('/integrations/discord').then(d => { setDiscord(d); setMapping(JSON.stringify(d.mappings, null, 2)); }).catch(() => { }); const t = setInterval(() => load(), 15000); return () => clearInterval(t); }, [prefix, isAdmin]);
    async function action<T = unknown>(path: string, body?: unknown, method = 'post'): Promise<T | undefined> { setBusy(true); setError(''); try {
        const r = method === 'put' ? await api.put<T>(prefix + path, body) : await api.post<T>(prefix + path, body);
        setReport(r);
        await load();
        return r;
    }
    catch (e) {
        setError((e as Error).message);
    }
    finally {
        setBusy(false);
    } }
    async function searchPlayers() { try {
        setPlayers((await api.get<{
            players: typeof players;
        }>(`${prefix}/players?q=${encodeURIComponent(playerQuery)}`)).players);
    }
    catch (e) {
        setError((e as Error).message);
    } }
    const current = data?.profiles.find(p => p.id === profileId);
    function inheritedFiles(p: Profile | undefined, v: number, seen = new Set<string>()): Record<string, string> { if (!p || seen.has(p.id))
        return {}; seen.add(p.id); const entry = p.versions.find(x => x.version === v); if (!entry)
        return {}; return { ...(entry.parent ? inheritedFiles(data?.profiles.find(x => x.id === entry.parent?.id), entry.parent.version, seen) : {}), ...entry.files }; }
    const availableFiles = inheritedFiles(current, version);
    if (!data || !server)
        return <><ErrorText>{error}</ErrorText><p>Loading game workflows…</p></>;
    return <div className="space-y-4"><h2 className="text-xl font-semibold">Game and player workflows</h2><ErrorText>{error}</ErrorText>
    {isAdmin && <Section title="Port bundle"><p className="text-sm text-ink-400">Reserve game, query, RCON, voice and companion ports together. Stop the instance first. These reservations include offsets; native auxiliary listeners may still need configuration.</p><label>Main game port<Input type="number" min={1024} max={65535} value={base} onChange={e => setBase(+e.target.value)}/></label>
      {roles.map((r, i) => <div key={i} className="grid gap-2 sm:grid-cols-4"><Input aria-label={`Port role ${i + 1}`} value={r.role} onChange={e => setRoles(roles.map((x, j) => j === i ? { ...x, role: e.target.value } : x))}/><Input aria-label={`Port offset ${i + 1}`} type="number" min={0} value={r.offset} onChange={e => setRoles(roles.map((x, j) => j === i ? { ...x, offset: +e.target.value } : x))}/><select aria-label={`Port protocol ${i + 1}`} value={r.protocol} onChange={e => setRoles(roles.map((x, j) => j === i ? { ...x, protocol: e.target.value } : x))}>{['tcp', 'udp', 'both'].map(p => <option key={p}>{p}</option>)}</select><Button onClick={() => setRoles(roles.filter((_, j) => i !== j))}>Remove</Button></div>)}<Button onClick={() => setRoles([...roles, { role: 'voice', offset: 2, protocol: 'udp' }])}>Add port role</Button> <Button disabled={busy} onClick={() => action('/ports', { base, roles }, 'put')}>Allocate bundle</Button><ul>{data.ports.map(p => <li key={p.role}>{p.role}: {p.port}/{p.protocol}</li>)}</ul>
    </Section>}
    {server.platform === 'java' && !['velocity', 'bungeecord', 'waterfall'].includes(server.loader) && <Section title="Minecraft sleep and wake"><p className="text-sm text-ink-400">Players connect to the public proxy port. Status pings show sleeping/waking progress; joining wakes the game and asks the player to reconnect. Automatic sleep requires no observed players or proxy connections. Restrict direct access to the backend game port.</p><p>State: {data.sleep.state} · Proxy {data.sleep.listening ? 'listening' : 'offline'} {data.sleep.error}</p>{isAdmin && <><label className="flex gap-2"><input type="checkbox" checked={sleep.enabled} onChange={e => setSleep({ ...sleep, enabled: e.target.checked })}/>Enable public sleep proxy</label><label>Public proxy port<Input type="number" value={sleep.port} onChange={e => setSleep({ ...sleep, port: +e.target.value })}/></label><label>Idle seconds before sleep<Input type="number" min={60} value={sleep.idleSeconds} onChange={e => setSleep({ ...sleep, idleSeconds: +e.target.value })}/></label><Button disabled={busy} onClick={() => action('/sleep', sleep, 'put')}>Save sleep settings</Button></>}<Button disabled={busy || !can('power')} onClick={() => action('/sleep/wake')}>Wake server</Button></Section>}
    {can('plugins') && <Section title="Managed mod and plugin update plan"><p className="text-sm text-ink-400">Plan selected Modrinth Java mods/Bukkit plugins and required dependencies against the instance game version. Only tracked managed files are replaced; unmanaged collisions block the update. Stop the server before applying.</p><label>Modrinth project IDs or slugs (one per line)<textarea className={textarea} value={projectRefs} onChange={e => setProjectRefs(e.target.value)}/></label><Button disabled={busy} onClick={() => action('/mods/plan', { projects: list(projectRefs) })}>Build update plan</Button>
      {data.modPlan && <><p>Plan: {data.modPlan.state}</p><ul>{data.modPlan.files.map(f => <li key={f.file}>{f.project}: {data.modPlan?.current.find(c => c.file === f.file)?.version ?? 'new/untracked'} → {f.version} ({f.file})</li>)}</ul>{data.modPlan.warnings.map(w => <p className="text-amber-400" key={w}>{w}</p>)}<Button disabled={busy || data.modPlan.warnings.length > 0 || data.modPlan.state !== 'review'} onClick={async () => { if (await confirm({ title: 'Apply managed mod update', message: 'Back up the stopped instance and install this reviewed managed set?', confirmLabel: 'Back up and apply' }))
            await action('/mods/apply', { plan: data.modPlan!.id }); }}>Back up and apply plan</Button></>}
      <Button disabled={busy} onClick={async () => { if (await confirm({ title: 'Restore previous mod set', message: 'Restore the previous add-on directory? Changes made since the managed update will block rollback.', confirmLabel: 'Restore previous set' }))
            await action('/mods/rollback'); }}>Restore previous managed set</Button>
      <ul>{data.managed.map(m => <li key={m.file}>{m.project}: {m.version}</li>)}</ul>
    </Section>}
    {isAdmin && <Section title="Staging and reviewed promotion"><p className="text-sm text-ink-400">Clone a stopped managed instance, test its game/modpack update through the clone's existing controls, stop both instances, then review and promote. Production changes invalidate the review. Check auxiliary ports, external databases and integration credentials before starting a clone.</p><label>Unused staging game port<Input type="number" min={1024} max={65535} value={stagingPort} onChange={e => setStagingPort(+e.target.value)}/></label><Button disabled={busy} onClick={() => action('/staging', { port: stagingPort })}>Create staging clone</Button>{data.staging.map(s => <div key={s.id} className="space-y-2 rounded border border-surface-700 p-2"><p><Link className="text-accent-400 underline" to={`/instances/${s.clone}/status`}>Open staging instance</Link> · {s.state}</p>{s.backup && <p>Recovery snapshot: {s.backup}</p>}<Button disabled={busy || s.state !== 'testing'} onClick={async () => { const r = await action<{
        revision: string;
    }>(`/staging/${s.id}/review`); if (r)
        setPromotion({ ...promotion, [s.id]: r.revision }); }}>Review promotion</Button> <Button disabled={busy || !promotion[s.id]} onClick={async () => { if (await confirm({ title: 'Promote staging files', message: 'Replace production files with the reviewed staging files and retain a full recovery backup?', confirmLabel: 'Back up and promote', tone: 'danger' }))
        await action(`/staging/${s.id}/promote`, { revision: promotion[s.id] }); }}>Promote reviewed clone</Button></div>)}<Button disabled={busy} onClick={async () => { if (await confirm({ title: 'Roll back promotion', message: 'Restore the pre-promotion directory? Any production changes after promotion block this shortcut; use the recorded backup after reviewing newer world data.', confirmLabel: 'Roll back', tone: 'danger' }))
        await action('/staging/rollback', { confirm: true }); }}>Roll back latest promotion</Button></Section>}
    <Section title="World import compatibility"><p className="text-sm text-ink-400">Upload a world into a separate folder first. Inspect edition/version and common companion files without changing the live world. Mod/DLC requirements you supply are checked against installed mod filenames and still need a staging test.</p><label>Uploaded world directory or save file<Input value={world} onChange={e => setWorld(e.target.value)}/></label><label>Required mod/DLC labels (comma separated)<Input value={requirements} onChange={e => setRequirements(e.target.value)}/></label><Button disabled={busy} onClick={() => action('/world/check', { path: world, requirements: list(requirements) })}>Check world import</Button>{data.imports.slice(0, 5).map((r, i) => <div key={i} className="text-sm"><p>{r.path}: {r.edition} · {String(r.version ?? 'unknown version')}</p>{r.findings.map((f, j) => <p className={f.severity === 'error' ? 'text-red-400' : 'text-amber-400'} key={j}>{f.message}</p>)}</div>)}</Section>
    <Section title="Versioned configuration profiles"><p className="text-sm text-ink-400">Private reusable profiles inherit from a pinned parent version. Select files and target instances, review the before/after changes, then apply while stopped. Every application creates a recovery snapshot.</p>
      <label>Profile<select className="block max-w-full" value={profileId} onChange={e => { setProfileId(e.target.value); const p = data.profiles.find(p => p.id === e.target.value); setProfileName(p?.name ?? ''); setVersion(p?.versions[0]?.version ?? 1); setSelected([]); setPreviews({}); }}><option value="">New profile</option>{data.profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><Input aria-label="Profile name" placeholder="Profile name" value={profileName} onChange={e => setProfileName(e.target.value)}/>
      <label>Inherit latest version from<select className="block max-w-full" value={parentId} onChange={e => setParentId(e.target.value)}><option value="">No parent</option>{data.profiles.filter(p => p.id !== profileId).map(p => <option value={p.id} key={p.id}>{p.name} v{p.versions[0].version}</option>)}</select></label>
      <Input aria-label="Profile file path" placeholder="Configuration file path" value={filePath} onChange={e => setFilePath(e.target.value)}/><textarea aria-label="Profile file content" className={textarea} value={content} onChange={e => setContent(e.target.value)}/><Button disabled={!filePath} onClick={() => setProfileFiles({ ...profileFiles, [filePath]: content })}>Add file to draft profile</Button><p>Draft files: {Object.keys(profileFiles).join(', ') || 'none'}</p><Button disabled={busy || !can('files.write')} onClick={() => action('/profiles', { id: profileId || undefined, name: profileName, files: profileFiles, parent: parentId ? { id: parentId, version: data.profiles.find(p => p.id === parentId)!.versions[0].version } : undefined })}>Save new version</Button>
      {current && <><label>Review version<select className="block" value={version} onChange={e => { setVersion(+e.target.value); setSelected([]); setPreviews({}); }}>{current.versions.map(v => <option key={v.version} value={v.version}>v{v.version} · {new Date(v.at).toLocaleString()}</option>)}</select></label><fieldset><legend>Files to apply</legend>{Object.keys(availableFiles).map(p => <label className="block break-all" key={p}><input type="checkbox" checked={selected.includes(p)} onChange={e => { setSelected(e.target.checked ? [...selected, p] : selected.filter(x => x !== p)); setPreviews({}); }}/> {p}</label>)}</fieldset><fieldset><legend>Target instances</legend>{inventory.map(s => <label className="block" key={s.id}><input type="checkbox" checked={targets.includes(s.id)} onChange={e => { setTargets(e.target.checked ? [...targets, s.id] : targets.filter(x => x !== s.id)); setPreviews({}); }}/> {s.name}</label>)}</fieldset><Button disabled={busy || !selected.length || !targets.length} onClick={async () => { setBusy(true); setError(''); try {
            const reviews: typeof previews = {};
            for (const id of targets)
                reviews[id] = await api.post(`/servers/${id}/game-workflows/profiles/preview`, { profile: profileId, version, selected });
            setPreviews(reviews);
        }
        catch (e) {
            setError((e as Error).message);
        }
        finally {
            setBusy(false);
        } }}>Preview selected targets</Button>
        {Object.entries(previews).map(([id, p]) => <details key={id}><summary>{inventory.find(s => s.id === id)?.name}: {p.changes.length} file changes · restart required</summary>{p.changes.map(c => <div key={c.path}><h4>{c.path}</h4><div className="grid gap-2 md:grid-cols-2"><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all bg-surface-900 p-2 text-xs">Before:{'\n'}{c.before ?? '(missing)'}</pre><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all bg-surface-900 p-2 text-xs">After:{'\n'}{c.after}</pre></div></div>)}</details>)}
        <Button disabled={busy || Object.keys(previews).length !== targets.length || !targets.length || !can('files.write')} onClick={async () => { if (!await confirm({ title: 'Apply reviewed configuration', message: `Apply selected files to ${targets.length} stopped instances, with a backup before each?`, confirmLabel: 'Back up and apply' }))
            return; setBusy(true); const result = []; try {
            for (const id of targets) {
                try {
                    await api.post(`/servers/${id}/game-workflows/profiles/apply`, { profile: profileId, version, selected, revision: previews[id].revision });
                    result.push({ id, ok: true });
                }
                catch (e) {
                    result.push({ id, ok: false, error: (e as Error).message });
                }
            }
            setReport(result);
            setPreviews({});
            await load();
        }
        finally {
            setBusy(false);
        } }}>Apply reviewed targets</Button></>}
    </Section>
    {can('players') && <Section title="Player history and moderation"><div className="flex flex-wrap gap-2"><Input aria-label="Search player identity" placeholder="Search player name" value={playerQuery} onChange={e => setPlayerQuery(e.target.value)}/><Button onClick={searchPlayers}>Search players</Button></div><p className="text-xs text-ink-400">History records observed joins/leaves. Names are labels, not verified account ownership. Timed/shared bans currently use Minecraft Java usernames; expiration waits for the game to be running.</p>{players.map(p => <details key={p.name}><summary onClick={() => setPlayerName(p.name)}>{p.name} · {p.online ? 'online' : 'offline'} · {p.joins ?? 0} joins</summary>{p.identities?.map(id => <p className="font-mono text-xs" key={id}>{id}</p>)}{p.notes.map((n, i) => <p key={i}>{new Date(n.at).toLocaleString()}: {n.note}</p>)}</details>)}<Input aria-label="Moderation player name" placeholder="Player username" value={playerName} onChange={e => setPlayerName(e.target.value)}/><textarea aria-label="Moderation note" className={textarea} placeholder="Private moderation note" value={note} onChange={e => setNote(e.target.value)}/><Button disabled={busy} onClick={() => action('/players/note', { name: playerName, note })}>Save moderation note</Button>{server.platform === 'java' && <><label>Ban minutes<Input type="number" min={1} value={banMinutes} onChange={e => setBanMinutes(+e.target.value)}/></label><Input aria-label="Ban reason" value={banReason} onChange={e => setBanReason(e.target.value)}/><Button disabled={busy} onClick={async () => { if (await confirm({ title: 'Apply timed player ban', message: `Ban ${playerName} for ${banMinutes} minutes?`, confirmLabel: 'Apply ban', tone: 'danger' }))
        await action('/players/ban', { name: playerName, reason: banReason, minutes: banMinutes }); }}>Apply timed ban</Button>{data.bans.map(b => <p key={b.id}>{b.name}: {b.state} · expires {new Date(b.expires).toLocaleString()}</p>)}</>}{isAdmin && <details><summary>Administrator shared Java ban list</summary><textarea aria-label="Shared ban list" className={textarea} value={shared} onChange={e => setShared(e.target.value)}/><p className="text-xs">List entries use a player name and reason: [{'{"name":"Player","reason":"Moderation"}'}]. Applying sends bans only to this instance.</p><Button disabled={busy} onClick={() => { try {
        void action('/shared-bans', { bans: JSON.parse(shared) }, 'put');
    }
    catch (e) {
        setError((e as Error).message);
    } }}>Save shared list</Button> <Button disabled={busy} onClick={async () => { if (await confirm({ title: 'Apply shared ban list', message: 'Apply the administrator shared list to this running Java instance?', confirmLabel: 'Apply bans', tone: 'danger' }))
        await action('/shared-bans/apply'); }}>Apply list to this instance</Button></details>}</Section>}
    {['cs2', 'tf2'].includes(server.steam_preset ?? '') && can('players') && <Section title="Tournament rosters, vetoes and results"><div className="grid gap-3 sm:grid-cols-2"><label>Team A<Input value={teamA} onChange={e => setTeamA(e.target.value)}/></label><label>Team B<Input value={teamB} onChange={e => setTeamB(e.target.value)}/></label><label>Team A roster<textarea className={textarea} value={rosterA} onChange={e => setRosterA(e.target.value)}/></label><label>Team B roster<textarea className={textarea} value={rosterB} onChange={e => setRosterB(e.target.value)}/></label></div><label>Map pool (one name per line)<textarea className={textarea} value={mapPool} onChange={e => setMapPool(e.target.value)}/></label><Button disabled={busy} onClick={() => action('/matches', { teamA, teamB, rosterA: list(rosterA), rosterB: list(rosterB), maps: list(mapPool) })}>Create match and veto</Button>{data.matches.map(m => <div key={m.id} className="space-y-2 rounded border border-surface-700 p-2"><h3>{m.teamA} vs {m.teamB} · {m.state}</h3><p>{m.rosterA.join(', ')} / {m.rosterB.join(', ')}</p>{m.vetoes.map(v => <p key={v.map}>{v.team} vetoed {v.map}</p>)}<div className="flex flex-wrap gap-2">{m.maps.filter(map => !m.vetoes.some(v => v.map === map)).map(map => <Button key={map} disabled={busy || m.state !== 'veto' || m.maps.length - m.vetoes.length <= 1} onClick={() => action(`/matches/${m.id}/veto`, { map })}>Veto {map}</Button>)}</div><Button disabled={busy || !can('files.write')} onClick={() => action(`/matches/${m.id}/action`, { action: 'prepare' })}>Write tournament preset (stopped)</Button><p className="text-xs text-ink-400">Use existing match/demo controls to run the match. TF2: execute outpost_tournament after starting. Rosters are planning records; team enforcement requires a compatible game plugin.</p><div className="flex flex-wrap gap-2"><Input aria-label={`${m.teamA} score`} type="number" min={0} value={scores[m.id]?.a ?? m.scoreA ?? 0} onChange={e => setScores({ ...scores, [m.id]: { a: +e.target.value, b: scores[m.id]?.b ?? 0 } })}/><Input aria-label={`${m.teamB} score`} type="number" min={0} value={scores[m.id]?.b ?? m.scoreB ?? 0} onChange={e => setScores({ ...scores, [m.id]: { a: scores[m.id]?.a ?? 0, b: +e.target.value } })}/><Button disabled={busy} onClick={() => action(`/matches/${m.id}/action`, { action: 'result', scoreA: scores[m.id]?.a ?? 0, scoreB: scores[m.id]?.b ?? 0 })}>Record result</Button></div></div>)}</Section>}
    {server.platform === 'java' && can('console') && <Section title="Minecraft performance diagnostics"><p className="text-sm text-ink-400">Install a compatible spark plugin/mod first. Capture a profile during lag, inspect the viewer hotspots, and compare CPU/memory with your health alerts.</p><label className="flex gap-2"><input type="checkbox" checked={profileConsent} onChange={e => setProfileConsent(e.target.checked)}/>I understand spark profiling can upload data to its external viewer.</label><label>Capture duration seconds<Input type="number" min={10} max={600} value={profileSeconds} onChange={e => setProfileSeconds(+e.target.value)}/></label><div className="flex flex-wrap gap-2">{['start', 'stop', 'cancel', 'health', 'ticks'].map(actionName => <Button key={actionName} disabled={busy || !profileConsent} onClick={() => action('/profiler', { action: actionName, seconds: profileSeconds, consent: profileConsent })}>{actionName === 'start' ? 'Start profile' : actionName === 'stop' ? 'Stop and view' : actionName === 'cancel' ? 'Cancel capture' : actionName === 'health' ? 'Health report' : 'Tick sample'}</Button>)}</div>{data.profiler?.urls.map(u => <a className="block break-all text-accent-400 underline" target="_blank" rel="noreferrer" href={u} key={u}>Open spark report: {u}</a>)}<pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">{data.profiler?.lines.join('\n')}</pre>{data.profiler?.suggestions.map(s => <p key={s} className="text-sm">{s}</p>)}</Section>}
    {isAdmin && data.fastdl.supported && <Section title="Source FastDL asset publishing"><p className="text-sm text-ink-400">Publish only selected public maps, materials, models, sounds and particles. Configuration, plugins and executable files are excluded. Compression requires bzip2 installed on the host.</p><label>Asset paths relative to the game folder<textarea className={textarea} placeholder="maps/custom_map.bsp" value={assets} onChange={e => setAssets(e.target.value)}/></label><label>Public FastDL base URL<Input value={assetUrl} onChange={e => setAssetUrl(e.target.value)}/></label><label className="flex gap-2"><input type="checkbox" checked={compress} onChange={e => setCompress(e.target.checked)}/>Publish bzip2 copies too</label><Button disabled={busy} onClick={() => action('/fastdl', { paths: list(assets), url: assetUrl, compress })}>Publish selected assets</Button> <Button disabled={busy} onClick={() => action('/fastdl/verify')}>Verify public downloads</Button>{data.fastdl.publication && <><p>{data.fastdl.publication.assets.length} assets · {data.fastdl.publication.enabled ? 'enabled' : 'disabled'}</p><pre className="whitespace-pre-wrap break-all text-xs">sv_downloadurl "{data.fastdl.publication.url}"{'\n'}sv_allowdownload 1</pre><p className="text-xs">Add these settings to the game's server configuration and restart/change map.</p><Button disabled={busy} onClick={async () => { try {
        await api.delete(prefix + '/fastdl');
        await load();
    }
    catch (e) {
        setError((e as Error).message);
    } }}>Disable public asset hosting</Button></>}</Section>}
    {isAdmin && discord && <Section title="Optional Discord commands"><p className="text-sm text-ink-400">An authenticated Discord application can expose approved status/player/power commands. Map each Discord identity to an Outpost account, allowed instance IDs and actions. Outpost permissions are checked on every interaction; arbitrary console commands are unavailable.</p><label className="flex gap-2"><input type="checkbox" checked={discord.enabled} onChange={e => setDiscord({ ...discord, enabled: e.target.checked })}/>Enable signed Discord interactions</label>{(['applicationId', 'publicKey', 'guildId'] as const).map(k => <label className="block" key={k}>{k}<Input value={discord[k]} onChange={e => setDiscord({ ...discord, [k]: e.target.value })}/></label>)}<label>Account mappings<textarea aria-label="Discord account mappings" className={textarea} value={mapping} onChange={e => setMapping(e.target.value)}/></label><p className="text-xs">Each mapping: discordId, userId, instances (ID list), actions (status, players, start, stop, restart). Endpoint: {location.origin}/api/integrations/discord/interactions. Set OUTPOST_DISCORD_BOT_TOKEN on the host to register commands; no token is needed to verify incoming signatures.</p><Button disabled={busy} onClick={async () => { setBusy(true); try {
        await api.put('/integrations/discord', { ...discord, mappings: JSON.parse(mapping) });
        setReport({ ok: true });
    }
    catch (e) {
        setError((e as Error).message);
    }
    finally {
        setBusy(false);
    } }}>Save Discord configuration</Button> <Button disabled={busy || !discord.tokenConfigured} onClick={async () => { setBusy(true); try {
        setReport(await api.post('/integrations/discord/register'));
    }
    catch (e) {
        setError((e as Error).message);
    }
    finally {
        setBusy(false);
    } }}>Register guild slash command</Button></Section>}
    {report != null && <Card className="space-y-2 p-4"><h3 className="font-semibold">Workflow result</h3><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(report, null, 2)}</pre><Button onClick={() => setReport(null)}>Dismiss result</Button></Card>}
  </div>;
}
