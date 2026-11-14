import crypto from 'node:crypto';
import { GAME_PROFILES } from './gameControlProfiles.js';
import { STEAM_GAME_PRESETS, findPresetFor } from './steamGames.js';
import { isProxyLoader, type ServerRecord } from '../types/index.js';
import published from '../compatibility/game-capability-evidence.json' with { type: 'json' };
export type FeatureId = 'settings' | 'maps' | 'mapUpload' | 'liveMap' | 'workshop' | 'gamerules' | 'worldHealth' | 'sleep' | 'profiler' | 'fastdl';
type Support = 'supported' | 'conditional' | 'unavailable';
export interface GameFeature {
    id: FeatureId;
    label: string;
    support: Support;
    reason: string;
    prerequisites: string[];
    permissions: string[];
    stopped?: boolean;
    running?: boolean;
    admin?: boolean;
}
export interface GameCapability {
    id: string;
    name: string;
    platform: string;
    appId?: string;
    settingsPath: string;
    hosts: {
        os: string;
        support: Support;
        reason: string;
    }[];
    prerequisites: string[];
    notes: string[];
    features: GameFeature[];
    versionPolicy: string;
}
export interface CapabilityRun {
    id: string;
    at: string;
    hostOS: string;
    arch: string;
    node: string;
    sourceDigest: string;
    kind: 'fixture' | 'contract' | 'browser' | 'live';
    suite: string;
    gameIds: string[];
    versions: Record<string, string[]>;
    scope: string;
    status: 'passed';
}
export interface CapabilityEvidence {
    schemaVersion: number;
    publishedAt: string | null;
    runs: CapabilityRun[];
}
const evidence = published as CapabilityEvidence;
const hostNames: Record<string, string> = { linux: 'Linux', win32: 'Windows', darwin: 'macOS' };
export const capabilityHostName = (os: string) => hostNames[os] ?? os;
const feature = (id: FeatureId, label: string, support: Support, reason: string, permissions: string[], extra: Partial<GameFeature> = {}): GameFeature => ({ id, label, support, reason, permissions, prerequisites: [], ...extra });
export function gameCapabilityCatalog(): GameCapability[] {
    const steam = STEAM_GAME_PRESETS.map(preset => {
        const profile = GAME_PROFILES.find(p => p.id === preset.id), dedicated = ['cs2', 'tf2', 'gmod'].includes(preset.id);
        const map = profile?.map, mapSelection = !!map || dedicated || preset.id === 'satisfactory';
        const upload = !!map?.upload || preset.id === 'tf2' || preset.id === 'gmod' || preset.id === 'satisfactory';
        const live = !!map?.live || dedicated;
        const fastdl = ['tf2', 'css', 'csgo', 'gmod', 'hl2dm', 'dods', 'l4d2'].includes(preset.id);
        const settingsPath = dedicated ? preset.id : 'game-settings';
        return {
            id: preset.id, name: preset.label, platform: 'steam', appId: preset.appId, settingsPath,
            hosts: ['linux', 'win32', 'darwin'].map(os => ({ os, support: (os === 'darwin' || (preset.hosts && !preset.hosts.includes(os as NodeJS.Platform))) ? 'unavailable' as const : preset.windowsOnly && os === 'linux' ? 'conditional' as const : 'supported' as const,
                reason: os === 'darwin' ? 'This preset installs Linux/Windows server binaries; native macOS installation is not implemented.' : preset.hosts && !preset.hosts.includes(os as NodeJS.Platform) ? `This preset declares ${preset.hosts.map(capabilityHostName).join(', ')} hosts only.` : preset.windowsOnly && os === 'linux' ? 'Windows-only server: Wine and a prepared prefix are required; headless setups may require Xvfb.' : 'A native launch adapter is implemented. Live game/version validation is separate.' })),
            prerequisites: [preset.install ? 'This preset uses its direct installer; install the game data/content it requires.' : 'Install the server through SteamCMD and supply an owned Steam account when the game or Workshop item requires it.', 'Verify that CPU architecture and native runtime libraries match the installed binaries, and open every game/query/RCON/companion port required by this game.', ...(preset.windowsOnly ? ['On Linux, install Wine and prepare the instance prefix before starting.'] : [])],
            notes: [...(preset.notes ? [preset.notes] : []), ...(profile?.notes ?? []), ...(map?.note ? [map.note] : []), ...(!mapSelection ? ['This game has a fixed world or uses native generation/save settings; interchangeable map packages are not exposed.'] : [])],
            versionPolicy: 'Steam latest/beta channels are not immutable build IDs. Fixture latest labels do not certify an installed Steam build.',
            features: [
                feature('settings', 'Game settings', profile || dedicated ? 'supported' : 'unavailable', profile || dedicated ? `Managed controls are available in ${dedicated ? preset.label : 'Game settings'}. Restart to apply startup settings.` : 'No native settings adapter is registered. Use File Management and Configuration → Launch.', ['settings'], { stopped: true }),
                feature('maps', 'Map / world selection', mapSelection ? 'conditional' : 'unavailable', mapSelection ? map?.note ?? (preset.id === 'satisfactory' ? 'Satisfactory has a fixed map; manage sessions and saves through its authenticated HTTPS API.' : 'Select installed/Workshop maps in the dedicated game controls.') : 'No interchangeable-map selector is implemented; use this game’s native world/generation settings.', ['settings'], { prerequisites: ['Install the selected map, required mods and DLC on the server and clients.'] }),
                feature('mapUpload', 'Map / world upload', upload ? 'conditional' : 'unavailable', upload ? map?.upload ? `Upload format: ${map.upload}. Existing saves/content are protected; review the game-specific import notes.` : preset.id === 'satisfactory' ? 'SAV uploads use the running server’s authenticated HTTPS API.' : 'Use the dedicated game page/add-on upload controls.' : preset.id === 'rust' ? 'Rust custom maps use a public HTTPS map URL rather than direct map-package upload.' : preset.workshop ? 'Map mods use the Workshop workflow; direct map-package upload is not implemented.' : 'No validated map-package importer is implemented for this game.', ['settings', 'files.write'], { stopped: preset.id !== 'satisfactory', running: preset.id === 'satisfactory', prerequisites: preset.id === 'satisfactory' ? ['Claim the server and connect its API token in Game settings.'] : ['Select the documented file format and keep a recovery backup.'] }),
                feature('liveMap', 'Live map change', live ? 'conditional' : 'unavailable', live ? 'Send a map-change command to the running game; this interrupts connected players.' : 'Use a restart or the native session/save API for this game.', ['console'], { running: true }),
                feature('workshop', 'Steam Workshop', preset.workshop ? 'conditional' : 'unavailable', preset.workshop ? `Managed ${preset.workshop.mode} Workshop installation is implemented.` : preset.id === 'cs2' || preset.id === 'tf2' ? 'Use Workshop map IDs in the dedicated game page; this preset has no managed Workshop package installer.' : preset.id === 'quakelive' ? 'Edit the native Workshop list in Game settings; the managed Workshop installer is unavailable.' : 'No managed Workshop installer is registered for this preset.', ['plugins'], { stopped: true, prerequisites: preset.workshop?.needsLogin ? ['Supply a Steam account that owns the required content.'] : [] }),
                feature('gamerules', 'Minecraft gamerule presets', 'unavailable', 'Gamerules apply to Minecraft game servers, not Steam games.', ['settings']),
                feature('worldHealth', 'World corruption checks / repair', preset.id === 'terraria' ? 'conditional' : 'unavailable', preset.id === 'terraria' ? 'Checks Terraria file envelopes. Repairs require a stopped game and a safe paired backup when tModLoader companions exist.' : 'No game-aware corruption checker/repair handler is implemented for this format.', ['files.read'], { prerequisites: preset.id === 'terraria' ? ['Use a matching WLD/TWLD backup; semantic world/mod compatibility is not certified.'] : [] }),
                feature('sleep', 'Sleep / wake proxy', 'unavailable', 'The wake proxy supports modern standalone Minecraft Java handshakes only.', ['settings']),
                feature('profiler', 'spark profiling', 'unavailable', 'The spark integration is for compatible Minecraft Java servers.', ['console']),
                feature('fastdl', 'FastDL asset publishing', fastdl ? 'conditional' : 'unavailable', fastdl ? 'Publish approved Source 1 assets, then configure the displayed download URL in the game.' : 'This FastDL workflow supports selected Source 1 games; CS2 and other engines are excluded.', ['settings'], { admin: true, prerequisites: fastdl ? ['Configure a client-reachable public URL. Optional BZ2 compression requires bzip2.'] : [] }),
            ],
        } satisfies GameCapability;
    });
    const minecraft = (id: string, name: string, platform: string, proxy = false): GameCapability => {
        const java = platform === 'java', world = !proxy;
        return { id, name, platform, settingsPath: proxy ? 'network' : 'configuration',
            hosts: ['linux', 'win32', 'darwin'].map(os => ({ os, support: (!java && os === 'darwin') ? 'unavailable' : 'supported', reason: java ? 'A compatible Java runtime is required. Loader, plugin and native-mod compatibility must be checked for this version.' : os === 'darwin' ? 'The Bedrock installer/launcher has Linux and Windows binaries, not a native macOS server.' : 'Install the matching native Bedrock server and its runtime libraries.' })),
            prerequisites: java ? ['Install the Java version required by this server/loader.', ...(proxy ? ['Configure backend forwarding and compatible proxy/back-end authentication settings.'] : ['Accept the Minecraft EULA and install matching loader/mod/plugin versions.'])] : ['Verify CPU architecture matches the Bedrock binary, install its native runtime dependencies and reserve game and IPv6 ports.'],
            notes: proxy ? ['Velocity, Waterfall and BungeeCord proxies have no local game world.'] : ['A Minecraft version label alone does not certify every loader, mod set or native dependency.'],
            versionPolicy: 'Exact fixture version/loader labels are shown as evidence. Other versions/loaders remain unverified; no broad version range is inferred.',
            features: [
                feature('settings', 'Game settings', 'supported', proxy ? 'Use Network and Configuration for proxy/backend settings.' : 'Edit server.properties and instance settings in Configuration.', ['settings'], { stopped: true }),
                feature('maps', 'Map / world selection', world ? 'conditional' : 'unavailable', world ? 'Use the configured level/world name and the Minecraft map controls. Back up before replacing a world.' : 'A proxy has no local game world.', ['settings']),
                feature('mapUpload', 'Map / world upload', 'unavailable', proxy ? 'A proxy has no world to import.' : 'Use File Management and Game workflows world-import preflight; a universal map-package importer is not provided by this page.', ['files.write']),
                feature('liveMap', 'Live map change', 'unavailable', 'Standalone Minecraft has no general changelevel workflow; world changes need a restart or game-specific plugin.', ['console']),
                feature('workshop', 'Steam Workshop', 'unavailable', 'Minecraft does not use Steam Workshop.', ['plugins']),
                feature('gamerules', 'Minecraft gamerule presets', world ? 'conditional' : 'unavailable', world ? 'Configure automatic presets or apply commands to a running game. Java naming depends on the version; Bedrock uses its edition-specific names.' : 'Configure gamerules on the backend game server, not the proxy.', ['settings'], { prerequisites: world ? ['Check command acceptance in Console for the installed edition/version.'] : [] }),
                feature('worldHealth', 'World corruption checks / repair', java && world ? 'conditional' : 'unavailable', java && world ? 'Checks region/NBT storage; safe repairs require a stopped instance and recovery backup.' : 'Bedrock LevelDB repair and proxy-world checks are not implemented.', ['files.read']),
                feature('sleep', 'Sleep / wake proxy', java && world ? 'conditional' : 'unavailable', java && world ? 'Modern Java handshakes only. Joining wakes the server and may require reconnecting.' : 'Bedrock and proxy-forwarding networks are unsupported by this wake proxy.', ['settings'], { admin: true, prerequisites: java && world ? ['Use a distinct public proxy port and reachable loopback game listener; restrict direct backend access. Legacy protocols are unverified.'] : [] }),
                feature('profiler', 'spark profiling', java && world ? 'conditional' : 'unavailable', java && world ? 'Run bounded spark commands and inspect captured reports; installing a compatible spark plugin/mod is required.' : 'This spark workflow targets standalone Java game servers.', ['console'], { running: true, prerequisites: java && world ? ['Install compatible spark and acknowledge its external report upload.'] : [] }),
                feature('fastdl', 'FastDL asset publishing', 'unavailable', 'This FastDL workflow is for Source 1 assets.', ['settings']),
            ] };
    };
    return [minecraft('minecraft-java', 'Minecraft Java', 'java'), minecraft('minecraft-proxy', 'Minecraft Java proxies', 'java', true), minecraft('minecraft-bedrock', 'Minecraft Bedrock', 'bedrock'), ...steam];
}
export function capabilityGameId(server: Pick<ServerRecord, 'platform' | 'loader' | 'steam_preset' | 'steam_app_id'>) {
    if (server.platform === 'java')
        return isProxyLoader(server.loader) ? 'minecraft-proxy' : 'minecraft-java';
    if (server.platform === 'bedrock')
        return 'minecraft-bedrock';
    return server.platform === 'steam' ? findPresetFor(server)?.id ?? null : null;
}
export function capabilityMatrix(data: CapabilityEvidence = evidence) {
    const games = gameCapabilityCatalog();
    return { schemaVersion: 1, hostOS: process.platform, hostName: capabilityHostName(process.platform), arch: process.arch, evidence: data, games,
        legend: 'Implemented controls, fixture checks, browser checks and live game validation are separate. No test result is inferred for another OS, version or loader.',
        catalogDigest: crypto.createHash('sha256').update(JSON.stringify(games)).digest('hex') };
}
export function instanceCapabilities(server: ServerRecord, permissions: string[], admin: boolean, hostOS: string = process.platform) {
    const id = capabilityGameId(server), game = gameCapabilityCatalog().find(g => g.id === id) ?? null;
    const host = game?.hosts.find(h => h.os === hostOS) ?? { os: hostOS, support: 'unavailable' as const, reason: game ? 'This host OS has no registered native launch adapter.' : 'No built-in game capability profile is registered; use Files and Configuration → Launch.' };
    const runs = evidence.runs.filter(r => r.gameIds.includes(id ?? '') && r.hostOS === hostOS);
    return { game, host, hostName: capabilityHostName(hostOS), arch: process.arch, version: server.version, loader: server.loader,
        validation: { runs, exactVersion: runs.filter(r => r.versions[id ?? '']?.includes(`${server.loader}@${server.version}`)), live: runs.filter(r => r.kind === 'live' && r.versions[id ?? '']?.includes(`${server.loader}@${server.version}`)), note: 'A fixture latest label is not a tested Steam build. Unlisted versions/loaders and host OS combinations remain unverified.' },
        actions: (game?.features ?? []).map(f => {
            const blockers: string[] = [];
            if (f.support === 'unavailable')
                blockers.push(f.reason);
            if (host.support === 'unavailable')
                blockers.push(host.reason);
            if (!admin) {
                if (f.admin)
                    blockers.push('Administrator access is required.');
                for (const p of f.permissions)
                    if (!permissions.includes(p))
                        blockers.push(`Requires ${p} permission.`);
            }
            if (server.suspended)
                blockers.push('This instance is suspended.');
            if (f.stopped && !['stopped', 'crashed', 'install_failed'].includes(server.status))
                blockers.push('Stop the instance and finish background jobs first.');
            if (f.running && server.status !== 'running')
                blockers.push('The game must be running.');
            return { ...f, available: !blockers.length, blockers };
        }) };
}
