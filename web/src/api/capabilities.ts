export interface CapabilityRun {
    id: string;
    at: string;
    hostOS: string;
    arch: string;
    node: string;
    kind: 'fixture' | 'contract' | 'browser' | 'live';
    suite: string;
    gameIds: string[];
    versions: Record<string, string[]>;
    scope: string;
}
export interface GameCapability {
    id: string;
    name: string;
    platform: string;
    settingsPath: string;
    versionPolicy: string;
    prerequisites: string[];
    notes: string[];
    hosts: {
        os: string;
        support: string;
        reason: string;
    }[];
    features: {
        id: string;
        label: string;
        support: string;
        reason: string;
        prerequisites: string[];
    }[];
}
export interface CapabilityMatrix {
    hostOS: string;
    hostName: string;
    arch: string;
    legend: string;
    catalogDigest: string;
    games: GameCapability[];
    evidence: {
        publishedAt: string | null;
        runs: CapabilityRun[];
    };
}
export interface InstanceCapabilities {
    game: GameCapability | null;
    host: {
        os: string;
        support: string;
        reason: string;
    };
    hostName: string;
    version: string;
    loader: string;
    validation: {
        runs: CapabilityRun[];
        exactVersion: CapabilityRun[];
        live: CapabilityRun[];
        note: string;
    };
    actions: (GameCapability['features'][number] & {
        available: boolean;
        blockers: string[];
    })[];
}
