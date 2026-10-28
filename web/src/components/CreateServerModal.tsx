import { UploadTracker } from './UploadTracker.js';
import type { UploadProgress } from '../api/client.js';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../api/client.js';
import { isProxyLoader, type LaunchConfig, type Loader, type Platform, type ServerRecord, type SteamGameOption, type VersionOption } from '../api/types.js';
import { useAuth } from '../state/AuthContext.js';
import { LaunchEditor, cleanLaunchConfig } from './LaunchEditor.js';
import { Button, ErrorText, Field, Input, Modal, Select, Spinner } from './ui.js';

const LOADERS_BY_PLATFORM: Record<Platform, { value: Loader; label: string }[]> = {
  java: [
    { value: 'vanilla', label: 'Vanilla' },
    { value: 'paper', label: 'Paper' },
    { value: 'purpur', label: 'Purpur' },
    { value: 'spigot', label: 'Spigot (built from source)' },
    { value: 'fabric', label: 'Fabric (mods)' },
    { value: 'quilt', label: 'Quilt (mods)' },
    { value: 'forge', label: 'Forge (mods)' },
    { value: 'neoforge', label: 'NeoForge (mods)' },
    { value: 'mohist', label: 'Mohist (Forge mods + Bukkit plugins)' },
    { value: 'spongeforge', label: 'SpongeForge (Forge + Sponge plugins)' },
    { value: 'velocity', label: 'Velocity (proxy)' },
    { value: 'waterfall', label: 'Waterfall (proxy)' },
    { value: 'bungeecord', label: 'BungeeCord (proxy)' },
    { value: 'modpack' as Loader, label: 'Modpack from Modrinth…' },
  ],
  bedrock: [{ value: 'bedrock', label: 'Bedrock Dedicated Server' }],
  steam: [{ value: 'steam', label: 'Steam Dedicated Server' }],
  custom: [{ value: 'custom', label: 'Custom' }],
  docker: [{ value: 'docker', label: 'Docker' }],
};

const CUSTOM_STEAM_GAME = '__custom__';

interface ModpackHit {
  projectId: string;
  slug: string;
  title: string;
  description: string;
  iconUrl: string | null;
  downloads: number;
}

/** Creates a game server (`mode="game"`) or a custom process (`mode="custom"`, admin-only). */
export function CreateServerModal({
  open,
  onClose,
  onCreated,
  mode = 'game',
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (s: ServerRecord) => void;
  mode?: 'game' | 'custom';
}) {
  const { user, creation } = useAuth();
  const isAdmin = user?.role === 'admin';
  const allowed = new Set(creation?.allowedPlatforms ?? []);
  const memoryCap = creation?.maxMemoryMb || 0;
  const [launch, setLaunch] = useState<LaunchConfig>({ executable: 'start.sh', stop: { kind: 'signal', signal: 'SIGTERM' } });
  const [name, setName] = useState('');
  const [platform, setPlatform] = useState<Platform>('java');
  const [loader, setLoader] = useState<Loader>('vanilla');
  const isModpack = (loader as string) === 'modpack';
  const [packFile, setPackFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [packQuery, setPackQuery] = useState('');
  const [packs, setPacks] = useState<ModpackHit[]>([]);
  const [pack, setPack] = useState<ModpackHit | null>(null);
  const [packLoading, setPackLoading] = useState(false);
  const [versions, setVersions] = useState<VersionOption[]>([]);
  const [version, setVersion] = useState('');
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [minMemoryMb, setMinMemoryMb] = useState(1024);
  const [maxMemoryMb, setMaxMemoryMb] = useState(2048);
  const [serverPort, setServerPort] = useState(25565);
  const [acceptEula, setAcceptEula] = useState(false);
  const [steamGames, setSteamGames] = useState<SteamGameOption[]>([]);
  const [steamGameChoice, setSteamGameChoice] = useState<string>(CUSTOM_STEAM_GAME);
  const [customAppId, setCustomAppId] = useState('');
  const [windowsBuild, setWindowsBuild] = useState(false);
  const [customExecutable, setCustomExecutable] = useState('');
  const [steamLogin, setSteamLogin] = useState('anonymous');
  const [steamExtraFlags, setSteamExtraFlags] = useState('');
  const [showSteamAdvanced, setShowSteamAdvanced] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open || platform === 'custom' || isModpack) return;
    setLoadingVersions(true);
    setVersion('');
    api
      .get<{ versions: VersionOption[] }>(`/servers/catalog/versions?loader=${loader}`)
      .then((res) => {
        setVersions(res.versions);
        const recommended = res.versions.find((v) => v.recommended);
        setVersion(recommended?.version ?? res.versions[0]?.version ?? '');
      })
      .catch(() => setVersions([]))
      .finally(() => setLoadingVersions(false));
  }, [loader, open, platform, isModpack]);

  // Modrinth modpack search
  useEffect(() => {
    if (!open || !isModpack) return;
    const handle = setTimeout(() => {
      setPackLoading(true);
      api
        .get<{ modpacks: ModpackHit[] }>(`/servers/catalog/modpacks?q=${encodeURIComponent(packQuery)}`)
        .then((r) => setPacks(r.modpacks))
        .catch(() => setPacks([]))
        .finally(() => setPackLoading(false));
    }, 300);
    return () => clearTimeout(handle);
  }, [open, isModpack, packQuery]);

  useEffect(() => {
    if (!open || platform !== 'steam') return;
    api
      .get<{ games: SteamGameOption[] }>('/servers/catalog/steam-games')
      .then((res) => {
        setSteamGames(res.games);
        if (res.games[0]) {
          setSteamGameChoice(res.games[0].id);
          setServerPort(res.games[0].defaultPort);
        }
      })
      .catch(() => setSteamGames([]));
  }, [platform, open]);

  useEffect(() => {
    if (!open) return;
    if (mode === 'custom') {
      setPlatform('custom');
      return;
    }
    if (platform === 'custom' || (creation && !creation.allowedPlatforms.includes(platform))) {
      const first = creation?.allowedPlatforms.find((p) => p === 'java' || p === 'bedrock' || p === 'steam') as Platform | undefined;
      if (first) setPlatform(first);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, creation, mode]);

  useEffect(() => {
    setServerPort(platform === 'bedrock' ? 19132 : platform === 'custom' ? 27015 : 25565);
    setLoader(LOADERS_BY_PLATFORM[platform][0].value);
  }, [platform]);

  const selectedSteamGame = steamGames.find((g) => g.id === steamGameChoice);

  function selectSteamGame(id: string) {
    setSteamGameChoice(id);
    const game = steamGames.find((g) => g.id === id);
    if (game) setServerPort(game.defaultPort);
  }

  async function submit() {
    setError('');
    if (!name.trim()) return setError('Instance name is required');
    if (platform === 'custom' && !launch.executable?.trim()) return setError('Enter the executable, script or command to launch');
    if (isModpack && !pack && !packFile) return setError('Pick a modpack');
    if (platform !== 'custom' && !isModpack && !version) return setError('Choose a version');
    if (platform === 'java' && !acceptEula) return setError("You must accept Mojang's EULA");
    if (memoryCap && maxMemoryMb > memoryCap) return setError(`Max memory is limited to ${memoryCap} MB per instance for your account`);
    if (platform === 'steam' && steamGameChoice === CUSTOM_STEAM_GAME) {
      if (!/^\d+$/.test(customAppId.trim())) return setError('Enter a numeric Steam App ID');
      if (!customExecutable.trim()) return setError('Enter the relative path to the server executable');
    }
    setSubmitting(true);
    try {
      const payload = {
        name: name.trim(),
        platform,
        loader,
        version: platform === 'custom' ? 'custom' : version,
        minMemoryMb,
        maxMemoryMb,
        serverPort,
        acceptEula,
        steamAppId: platform === 'steam' ? (selectedSteamGame ? selectedSteamGame.appId : customAppId.trim()) : undefined,
        steamPreset: platform === 'steam' && selectedSteamGame ? selectedSteamGame.id : undefined,
        customExecutable: platform === 'steam' && !selectedSteamGame ? customExecutable.trim() : undefined,
        steamLogin: platform === 'steam' ? steamLogin.trim() || 'anonymous' : undefined,
        steamExtraFlags: platform === 'steam' ? steamExtraFlags.trim() : undefined,
        launch: platform === 'custom' ? cleanLaunchConfig(launch) : undefined,
        modpack: isModpack && !packFile && pack ? { projectId: pack.projectId } : undefined,
        wine: platform === 'steam' && !selectedSteamGame && windowsBuild ? true : undefined,
      };
      let result: { server: ServerRecord };
      if (isModpack && packFile) {
        const form = new FormData();
        form.append('payload', JSON.stringify(payload));
        form.append('mrpack', packFile);
        result = await api.upload<{ server: ServerRecord }>('/servers', form, setUploadProgress);
      } else result = await api.post<{ server: ServerRecord }>('/servers', payload);
      const { server } = result;
      onCreated(server);
      onClose();
      setName('');
      setAcceptEula(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create instance');
    } finally {
      setSubmitting(false);
      setUploadProgress(null);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={mode === 'custom' ? 'New custom process' : 'New game server'} size={platform === 'custom' ? 'lg' : 'md'}>
      <div className="space-y-4">
        <Field label="Instance name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={mode === 'custom' ? 'My app' : 'My Survival Server'} autoFocus />
        </Field>

        <div className={`grid grid-cols-2 gap-3 ${mode === 'custom' ? 'hidden' : ''}`}>
          <Field label="Game">
            <Select value={platform} onChange={(e) => setPlatform(e.target.value as Platform)}>
              {allowed.has('java') && <option value="java">Minecraft: Java Edition</option>}
              {allowed.has('bedrock') && <option value="bedrock">Minecraft: Bedrock Edition</option>}
              {allowed.has('steam') && <option value="steam">Steam Dedicated Server</option>}
            </Select>
          </Field>
          {(platform === 'java' || platform === 'bedrock') && (
            <Field label="Server software">
              <Select
                value={loader}
                onChange={(e) => {
                  const next = e.target.value as Loader;
                  // Proxies conventionally listen on 25577 so the backends can keep 25565.
                  if (platform === 'java' && (isProxyLoader(next) !== isProxyLoader(loader))) setServerPort(isProxyLoader(next) ? 25577 : 25565);
                  setLoader(next);
                }}
              >
                {LOADERS_BY_PLATFORM[platform].map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {platform === 'steam' && (
            <Field label="Game">
              <Select value={steamGameChoice} onChange={(e) => selectSteamGame(e.target.value)}>
                {steamGames.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.label}
                  </option>
                ))}
                <option value={CUSTOM_STEAM_GAME}>Other (custom App ID)</option>
              </Select>
            </Field>
          )}
        </div>

        {platform === 'steam' && steamGameChoice === CUSTOM_STEAM_GAME && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Steam App ID">
              <Input value={customAppId} onChange={(e) => setCustomAppId(e.target.value)} placeholder="e.g. 380870" />
            </Field>
            <Field label="Server executable (relative path)">
              <Input
                value={customExecutable}
                onChange={(e) => setCustomExecutable(e.target.value)}
                placeholder="e.g. MyServer.exe"
              />
            </Field>
          </div>
        )}
        {platform === 'steam' && steamGameChoice === CUSTOM_STEAM_GAME && (
          <label className="flex items-start gap-2 text-sm text-ink-300">
            <input type="checkbox" className="mt-0.5" checked={windowsBuild} onChange={(e) => setWindowsBuild(e.target.checked)} />
            <span>
              Windows-only server — download the Windows build and run it with Wine
              <span className="block text-xs text-ink-400">For games without a Linux dedicated server. Needs Wine on the host (install.sh --wine).</span>
            </span>
          </label>
        )}

        {platform === 'steam' && selectedSteamGame?.notes && (
          <p className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-400">
            {selectedSteamGame.notes}
          </p>
        )}

        {platform === 'steam' && steamGameChoice === CUSTOM_STEAM_GAME && (
          <p className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-400">
            Custom App IDs are best-effort: Outpost doesn't know this game's launch behavior, so it will send
            SIGTERM to stop it (falling back to a forced stop after 60s) and mark it "running" as soon as the
            process starts. Config files are edited via the Files tab.
          </p>
        )}

        {platform === 'steam' && (
          <div>
            <button
              type="button"
              className="text-xs text-accent-500 hover:underline"
              onClick={() => setShowSteamAdvanced((v) => !v)}
            >
              {showSteamAdvanced ? '−' : '+'} Advanced SteamCMD options
            </button>
            {showSteamAdvanced && (
              <div className="mt-3 grid grid-cols-2 gap-3">
                <Field label="Steam login">
                  <Input
                    value={steamLogin}
                    onChange={(e) => setSteamLogin(e.target.value)}
                    placeholder="anonymous"
                  />
                </Field>
                <Field label="Extra steamcmd flags">
                  <Input
                    value={steamExtraFlags}
                    onChange={(e) => setSteamExtraFlags(e.target.value)}
                    placeholder="e.g. -beta staging"
                  />
                </Field>
                <p className="col-span-2 text-[11px] text-ink-600">
                  Login defaults to <span className="font-mono">anonymous</span>. Games that require an owned Steam
                  license need real credentials here (<span className="font-mono">username password</span>) —
                  interactive Steam Guard prompts aren't supported, so accounts that require one may hang or fail.
                  Extra flags are appended to the steamcmd command line (after <span className="font-mono">app_update</span>,
                  before <span className="font-mono">+quit</span>).
                </p>
              </div>
            )}
          </div>
        )}

        {platform === 'custom' && (
          <div className="space-y-3">
            <p className="rounded-2xl bg-tertiary-container px-3 py-2 text-xs text-tertiary-on-container">
              Runs any Linux server binary or shell script as the panel's user. After creating it, upload your server files in File
              Management (or point at an absolute path), then start it. Everything here can be changed later under Configuration → Launch.
            </p>
            <LaunchEditor value={launch} onChange={setLaunch} platform="custom" isAdmin={isAdmin} />
          </div>
        )}

        {(platform === 'java' || platform === 'bedrock') && !isModpack && (
          <Field label="Version">
            {loadingVersions ? (
              <div className="flex items-center gap-2 text-sm text-ink-400">
                <Spinner /> Loading versions…
              </div>
            ) : (
              <Select value={version} onChange={(e) => setVersion(e.target.value)}>
                {versions.map((v) => (
                  <option key={v.version} value={v.version}>
                    {v.version}
                    {v.recommended ? ' (recommended)' : ''}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}

        {isModpack && (
          <div className="space-y-2">
            <label className="block space-y-2 text-sm text-ink-300">
              <span>Upload a Modrinth modpack (.mrpack, up to 256 MB)</span>
              <input type="file" accept=".mrpack" disabled={submitting} onChange={e => { setPackFile(e.target.files?.[0] ?? null); setPack(null); }} />
            </label>
            {packFile && <p className="text-xs text-ink-400">{packFile.name} selected. Minecraft and the mod loader are detected from the archive.</p>}
            <UploadTracker progress={uploadProgress} />
            <Input value={packQuery} onChange={(e) => setPackQuery(e.target.value)} placeholder="Search Modrinth modpacks (Fabric, Quilt, Forge, NeoForge)…" />
            <div className="max-h-60 space-y-1 overflow-y-auto rounded-2xl bg-surface-900 p-1.5">
              {packLoading && packs.length === 0 ? (
                <Spinner />
              ) : (
                packs.map((p) => (
                  <button
                    key={p.projectId}
                    type="button"
                    onClick={() => { setPack(p); setPackFile(null); }}
                    className={`state-layer flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left ${pack?.projectId === p.projectId ? 'bg-secondary-container' : ''}`}
                  >
                    {p.iconUrl ? <img src={p.iconUrl} alt="" className="h-9 w-9 shrink-0 rounded-lg object-cover" loading="lazy" /> : <span className="h-9 w-9 shrink-0 rounded-lg bg-surface-700" />}
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-ink-100">{p.title}</span>
                      <span className="block truncate text-xs text-ink-400">{p.description}</span>
                    </span>
                    <span className="ml-auto shrink-0 text-[11px] text-ink-500">{p.downloads.toLocaleString()}↓</span>
                  </button>
                ))
              )}
            </div>
            <p className="text-xs text-ink-500">
              Outpost installs the newest release of the pack: its server-side mods and configs, then the loader version it was built for. Players install the same pack in their launcher.
            </p>
          </div>
        )}

        {(loader === 'forge' || loader === 'neoforge' || loader === 'spongeforge' || loader === 'quilt') && (
          <p className="rounded-lg border border-surface-600 px-3 py-2 text-xs text-ink-400">
            The {loader === 'quilt' ? 'Quilt' : 'Forge'} installer runs on this machine with the Java this Minecraft version needs (Configuration → Java runtimes). It downloads Minecraft and libraries, so the first install takes a few minutes.
          </p>
        )}

        {loader === 'spigot' && (
          <p className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-400">
            Spigot isn't pre-built — Outpost compiles it from source with BuildTools on this machine. That
            requires a full JDK (not just a JRE) and git, and can take several minutes. Watch the Console tab for
            live build output.
          </p>
        )}

        <div className={platform === 'steam' ? 'grid grid-cols-1 gap-3' : 'grid grid-cols-1 gap-3 sm:grid-cols-3'}>
          {platform !== 'steam' && (
            <>
              <Field label="Min memory (MB)">
                <Input type="number" value={minMemoryMb} min={512} step={256} onChange={(e) => setMinMemoryMb(Number(e.target.value))} />
              </Field>
              <Field label="Max memory (MB)">
                <Input type="number" value={maxMemoryMb} min={512} max={memoryCap || undefined} step={256} onChange={(e) => setMaxMemoryMb(Number(e.target.value))} />
              </Field>
            </>
          )}
          <Field label="Port">
            <Input type="number" value={serverPort} onChange={(e) => setServerPort(Number(e.target.value))} />
          </Field>
        </div>

        {platform === 'java' && (
          <label className="flex items-start gap-2 text-sm text-ink-300">
            <input type="checkbox" className="mt-0.5" checked={acceptEula} onChange={(e) => setAcceptEula(e.target.checked)} />
            <span>
              I have read and accept the{' '}
              <a
                className="text-accent-500 underline"
                href="https://aka.ms/MinecraftEULA"
                target="_blank"
                rel="noreferrer"
              >
                Minecraft End User License Agreement
              </a>
              .
            </span>
          </label>
        )}

        <ErrorText>{error}</ErrorText>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={submitting}>
            {submitting ? 'Creating…' : 'Create instance'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
