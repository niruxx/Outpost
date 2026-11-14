export interface AddonDependency {
    key: string;
    name: string;
    required: boolean;
    constraint: string;
    source: string;
}
export interface InstalledAddon {
    id: string;
    fileName: string;
    name: string;
    enabled: boolean;
    canToggle: boolean;
    sizeBytes: number;
    modifiedAt: string;
    relativePath: string | null;
    hash: string | null;
    metadata: {
        name: string | null;
        version: string | null;
        description: string;
        authors: string[];
        licenses: string[];
        links: string[];
        provides: string[];
        format: string;
        complete: boolean;
        warnings: string[];
        bundled: string[];
    };
    provenance: {
        source: string;
        project?: string;
        version?: string;
        versionId?: string;
        title?: string;
        explicit: boolean;
        at: number;
    } | null;
    installation: 'explicit' | 'dependency' | 'untracked';
    coverage: 'manifest' | 'catalog' | 'incomplete';
    provides: string[];
    dependencies: AddonDependency[];
    requiredBy: {
        id: string;
        name: string;
        enabled: boolean;
    }[];
    optionalBy: {
        id: string;
        name: string;
    }[];
}
export interface AddonInventory {
    serverId: string;
    revision: string;
    items: InstalledAddon[];
    warnings: string[];
    dependencyCleanup: boolean;
    interrupted?: {
        id: string;
        action: string;
        state: string;
        backup?: string;
    }[];
}
export interface AddonDetails {
    serverId: string;
    item: InstalledAddon;
    dependencies: (AddonDependency & {
        runtime: boolean;
        installed: {
            id: string;
            name: string;
            enabled: boolean;
            version: string | null;
        }[];
    })[];
    revision: string;
    warnings: string[];
    dependencyCleanup: boolean;
}
export type AddonAction = 'remove' | 'disable' | 'enable';
export interface AddonActionPlan {
    id: string;
    expires: number;
    action: AddonAction;
    root: {
        id: string;
        name: string;
    };
    remove: {
        id: string;
        name: string;
        fileName: string;
        installation: string;
    }[];
    keep: {
        id: string;
        name: string;
        reason: string;
    }[];
    blockers: string[];
    warnings: string[];
    requiresAcknowledgement: boolean;
    canApply: boolean;
}
export interface AddonActionResult {
    ok: boolean;
    action: AddonAction;
    removed: {
        id: string;
        name: string;
        fileName: string;
    }[];
    recycled: {
        id: string;
        path: string;
    }[];
    backup: string | null;
    focusId: string | null;
}
