import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api/client.js';
import type { AddonCatalog, PluginSearchResult, ResolvedPluginVersion, ServerRecord } from '../api/types.js';
import { PLUGIN_CAPABLE_LOADERS } from '../api/types.js';
import { useAuth } from '../state/AuthContext.js';
import { useToast } from './Toast.js';
import { Button, ErrorText, Input, Modal, Notice, Spinner } from './ui.js';

const LOADER_ICON: Record<string, string> = { paper: '📄', purpur: '🟣', spigot: '🥄', bedrock: '🪨', velocity: '⚡', waterfall: '🌊', bungeecord: '🔀' };

type Source = 'modrinth' | 'curseforge';

const NOUN: Record<AddonCatalog, string> = {
  plugin: 'plugins',
  datapack: 'data packs',
  bedrock: 'add-ons & packs',
  'mod:fabric': 'mods',
  'mod:quilt': 'mods',
  'mod:forge': 'mods',
  'mod:neoforge': 'mods',
  'proxy:velocity': 'Velocity plugins',
  'proxy:bungee': 'BungeeCord plugins',
};
const PLACEHOLDER: Record<AddonCatalog, string> = {
  plugin: 'Search plugins (EssentialsX, LuckPerms, WorldEdit…)',
  datapack: 'Search data packs (Terralith, Vanilla Tweaks…)',
  bedrock: 'Search add-ons and texture packs…',
  'mod:fabric': 'Search Fabric mods (Lithium, Fabric API, Chunky…)',
  'mod:quilt': 'Search Quilt & Fabric mods…',
  'mod:forge': 'Search Forge mods…',
  'mod:neoforge': 'Search NeoForge mods…',
  'proxy:velocity': 'Search Velocity plugins (LuckPerms, ViaVersion, LibreLogin…)',
  'proxy:bungee': 'Search BungeeCord plugins (LuckPerms, ViaVersion…)',
};

/** The mod ecosystem an instance's mods come from (Mohist and SpongeForge run Forge mods). */
function modEcosystem(s: ServerRecord): string | null {
  if (s.loader === 'mohist' || s.loader === 'spongeforge') return 'forge';
  return ['fabric', 'quilt', 'forge', 'neoforge'].includes(s.loader) ? s.loader : null;
}

/** Which instances a result can go to. */
function eligible(catalog: AddonCatalog, s: ServerRecord): boolean {
  if (catalog === 'bedrock') return s.platform === 'bedrock';
  if (catalog === 'datapack') return s.loader === 'vanilla';
  if (catalog.startsWith('mod:')) return modEcosystem(s) === catalog.slice(4);
  if (catalog === 'proxy:velocity') return s.loader === 'velocity';
  if (catalog === 'proxy:bungee') return s.loader === 'waterfall' || s.loader === 'bungeecord';
  return PLUGIN_CAPABLE_LOADERS.includes(s.loader);
}

export function PluginSearchModal({
  open,
  onClose,
  defaultServerId,
  catalog = 'plugin',
  onInstalled,
}: {
  open: boolean;
  onClose: () => void;
  defaultServerId?: string;
  catalog?: AddonCatalog;
  onInstalled?: () => void;
}) {
  const { user } = useAuth();
  const noun = NOUN[catalog];
  // Modrinth has no Bedrock packs, so Bedrock always searches CurseForge.
  const [source, setSource] = useState<Source>(catalog === 'bedrock' ? 'curseforge' : 'modrinth');
  const [cf, setCf] = useState<{ configured: boolean; classes: { id: number; name: string }[] } | null>(null);
  const [classId, setClassId] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PluginSearchResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [picking, setPicking] = useState<{ result: PluginSearchResult; source: Source } | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (!open) return;
    api
      .get<{ configured: boolean; classes: { id: number; name: string }[] }>(`/plugins/curseforge?catalog=${catalog}`)
      .then((res) => {
        setCf(res);
        setClassId((current) => current ?? res.classes[0]?.id ?? null);
      })
      .catch((err) => {
        setCf({ configured: true, classes: [] });
        if (source === 'curseforge') setError(err instanceof ApiError ? err.message : 'CurseForge is unavailable');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, catalog]);

  const cfReady = source !== 'curseforge' || (cf?.configured && (cf.classes.length > 0 || catalog !== 'bedrock'));

  useEffect(() => {
    if (!open || !cfReady || (source === 'curseforge' && !cf)) return;
    runSearch(query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, source, classId, cf]);

  function onQueryChange(next: string) {
    setQuery(next);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runSearch(next), 350);
  }

  async function runSearch(q: string) {
    if (source === 'curseforge' && !cf?.configured) return;
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ query: q, limit: '24', catalog });
      if (source === 'curseforge') {
        params.set('source', 'curseforge');
        if (classId) params.set('classId', String(classId));
      }
      const res = await api.get<{ results: PluginSearchResult[] }>(`/plugins/search?${params}`);
      setResults(res.results);
    } catch (err) {
      setResults(null);
      setError(err instanceof ApiError ? err.message : 'Search failed');
    } finally {
      setLoading(false);
    }
  }

  const sourceNote =
    source === 'curseforge'
      ? 'Results come from CurseForge.'
      : catalog === 'datapack'
        ? "Results come from Modrinth's data pack catalog."
        : catalog === 'proxy:velocity'
          ? "Results come from Modrinth's Velocity plugins."
          : catalog === 'proxy:bungee'
            ? "Results come from Modrinth's BungeeCord / Waterfall plugins."
            : "Results come from Modrinth's plugin catalog (Bukkit / Spigot / Paper / Purpur).";

  return (
    <>
      <Modal open={open && !picking} onClose={onClose} title={`Browse ${noun}`} size="xl">
        <div className="mb-4 space-y-3">
          {catalog !== 'bedrock' && !catalog.startsWith('proxy:') && (
            <div className="flex w-fit rounded-full border border-surface-500 p-0.5" role="radiogroup" aria-label="Catalog">
              {(['modrinth', 'curseforge'] as const).map((s) => (
                <button
                  key={s}
                  role="radio"
                  aria-checked={source === s}
                  onClick={() => {
                    setSource(s);
                    setResults(null);
                    setError('');
                  }}
                  className={`state-layer rounded-full px-3 py-1.5 text-xs font-medium ${source === s ? 'bg-secondary-container text-secondary-on-container' : 'text-ink-300'}`}
                >
                  {s === 'modrinth' ? 'Modrinth' : 'CurseForge'}
                </button>
              ))}
            </div>
          )}

          {source === 'curseforge' && cf && !cf.configured ? (
            <Notice tone="info">
              CurseForge search needs a free CurseForge API key.{' '}
              {user?.role === 'admin' ? (
                <>
                  Add one under{' '}
                  <Link to="/configuration" className="font-medium underline" onClick={onClose}>
                    Configuration → CurseForge
                  </Link>
                  .
                </>
              ) : (
                'Ask an admin to add one in Configuration.'
              )}{' '}
              {catalog === 'bedrock' && 'Until then, upload .mcpack / .mcaddon files directly.'}
            </Notice>
          ) : (
            <>
              <Input value={query} onChange={(e) => onQueryChange(e.target.value)} placeholder={PLACEHOLDER[catalog]} autoFocus />
              {source === 'curseforge' && cf && cf.classes.length > 1 && (
                <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Category">
                  {cf.classes.map((c) => (
                    <button
                      key={c.id}
                      role="tab"
                      aria-selected={classId === c.id}
                      onClick={() => setClassId(c.id)}
                      className={`state-layer rounded-lg border px-3 py-1.5 text-xs font-medium ${
                        classId === c.id ? 'border-transparent bg-secondary-container text-secondary-on-container' : 'border-surface-500 text-ink-300'
                      }`}
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
              )}
              <p className="text-[11px] text-ink-500">{sourceNote}</p>
            </>
          )}
        </div>

        <ErrorText>{error}</ErrorText>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-ink-500">
            <Spinner /> Searching…
          </div>
        ) : results && results.length === 0 ? (
          <p className="py-12 text-center text-sm text-ink-500">No {noun} found.</p>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {results?.map((r) => (
              <div key={r.id ?? r.slug} className="flex gap-3 rounded-2xl bg-surface-850 p-3 transition-colors hover:bg-surface-700">
                {r.iconUrl ? (
                  <img src={r.iconUrl} alt="" className="h-11 w-11 shrink-0 rounded-lg object-cover" />
                ) : (
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-surface-700 text-lg">🧩</div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-ink-100">{r.title}</p>
                  <p className="line-clamp-2 text-xs text-ink-500">{r.description}</p>
                  <div className="mt-1.5 flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-[11px] text-ink-500">
                      {r.downloads.toLocaleString()} downloads · {r.author}
                    </span>
                    {r.downloadable === false ? (
                      r.websiteUrl ? (
                        <a
                          href={r.websiteUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="shrink-0 text-xs font-medium text-accent-400 hover:underline"
                          title="The author only allows downloads from CurseForge — download it there, then upload it here"
                        >
                          Open on CurseForge
                        </a>
                      ) : null
                    ) : (
                      <Button className="!px-2.5 !py-1 text-xs" variant="primary" onClick={() => setPicking({ result: r, source })}>
                        Install
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Modal>

      {picking && (
        <InstallTargetModal
          plugin={picking.result}
          source={picking.source}
          catalog={catalog}
          defaultServerId={defaultServerId}
          onClose={() => setPicking(null)}
          onInstalled={() => {
            setPicking(null);
            onClose();
            onInstalled?.();
          }}
        />
      )}
    </>
  );
}

function InstallTargetModal({
  plugin,
  source,
  catalog,
  defaultServerId,
  onClose,
  onInstalled,
}: {
  plugin: PluginSearchResult;
  source: Source;
  catalog: AddonCatalog;
  defaultServerId?: string;
  onClose: () => void;
  onInstalled: () => void;
}) {
  const toast = useToast();
  const [servers, setServers] = useState<ServerRecord[] | null>(null);
  const [selected, setSelected] = useState<string | undefined>(defaultServerId);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get<{ servers: ServerRecord[] }>('/servers')
      .then((res) => {
        const list = res.servers.filter((s) => eligible(catalog, s));
        setServers(list);
        if (!selected) setSelected(list[0]?.id);
      })
      .catch(() => setServers([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function confirmInstall() {
    if (!selected) return;
    setInstalling(true);
    setError('');
    try {
      const body = source === 'curseforge' ? { source: 'curseforge', modId: plugin.id } : { slug: plugin.slug };
      const res = await api.post<{ resolved: ResolvedPluginVersion }>(`/servers/${selected}/plugins/install`, body);
      if (res.resolved.versionMismatchWarning) {
        toast.show(`Installed ${res.resolved.fileName} — no build listed for this exact Minecraft version, used the latest instead.`);
      } else {
        toast.success(`Installed ${plugin.title} (${res.resolved.versionNumber})`);
      }
      onInstalled();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Install failed');
    } finally {
      setInstalling(false);
    }
  }

  const none =
    catalog === 'bedrock' ? 'No Bedrock instances found.' : catalog === 'datapack' ? 'No Vanilla Java instances found.' : catalog.startsWith('mod:') ? 'No modded instances for these mods yet.' : 'No Paper, Purpur, or Spigot instances found. Create one first.';

  return (
    <Modal open onClose={onClose} title={`Install ${plugin.title}`}>
      <div className="space-y-4">
        <p className="text-sm text-ink-400">Which instance should this be installed to?</p>
        {servers === null ? (
          <div className="flex items-center gap-2 text-sm text-ink-500">
            <Spinner /> Loading servers…
          </div>
        ) : servers.length === 0 ? (
          <p className="text-sm text-ink-500">{none}</p>
        ) : (
          <div className="max-h-56 space-y-1.5 overflow-y-auto">
            {servers.map((s) => (
              <label
                key={s.id}
                className={`flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-sm transition-colors ${
                  selected === s.id ? 'border-accent-400 bg-accent-container/40' : 'border-surface-600 hover:border-surface-500'
                }`}
              >
                <input type="radio" name="target-server" checked={selected === s.id} onChange={() => setSelected(s.id)} />
                <span>{LOADER_ICON[s.loader] ?? '🧩'}</span>
                <span className="min-w-0 flex-1 truncate text-ink-200">{s.name}</span>
                <span className="shrink-0 text-xs text-ink-500">
                  {s.loader} {s.version}
                </span>
              </label>
            ))}
          </div>
        )}
        {catalog === 'bedrock' && <p className="text-xs text-ink-500">Behavior and resource packs are activated for the world automatically. Restart the server to apply.</p>}
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!selected || installing} onClick={confirmInstall}>
            {installing ? 'Installing…' : 'Install'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
