import crypto from 'node:crypto';
import { db, prep } from '../db/db.js';
import { HttpError } from '../utils/asyncHandler.js';
import { trustedTransport, fetchBounded, sha256, plainId, requireFleetAdmin } from './fleetSecurity.js';
import { validateTemplate, saveTemplate, getTemplate } from './templateService.js';
import { extensionReview, installExtension, extensionRows } from './extensionService.js';
interface CatalogRelease {
    version: string;
    url: string;
    sha256: string;
    summary: string;
}
interface CatalogEntry {
    id: string;
    name: string;
    kind: 'template' | 'extension';
    releases: CatalogRelease[];
}
interface CatalogManifest {
    schemaVersion: 1;
    publisher: string;
    generatedAt: string;
    entries: CatalogEntry[];
}
interface Source {
    id: string;
    name: string;
    url: string;
    public_key: string;
    manifest: string | null;
    synced_at: number | null;
    enabled: number;
}
export function catalogSources() { return (prep('SELECT * FROM community_sources ORDER BY name').all() as unknown as Source[]).map(s => ({ ...s, publicKey: s.public_key, manifest: s.manifest ? JSON.parse(s.manifest) as CatalogManifest : null, fingerprint: sha256(Buffer.from(s.public_key, 'hex')) })); }
export function addCatalogSource(input: Record<string, unknown>) {
    const name = String(input.name ?? '').trim(), url = trustedTransport(input.url).toString(), publicKey = String(input.publicKey ?? '');
    if (!name || name.length > 100 || !/^[a-f0-9]{64}$/i.test(publicKey))
        throw new HttpError(400, 'Source name and Ed25519 raw public key are required');
    const id = crypto.randomUUID();
    prep('INSERT INTO community_sources(id,name,url,public_key) VALUES (?,?,?,?)').run(id, name, url, publicKey.toLowerCase());
    return { id, fingerprint: sha256(Buffer.from(publicKey, 'hex')) };
}
export function toggleCatalogSource(id: string, enabled: boolean) {
    if (!prep('UPDATE community_sources SET enabled=? WHERE id=?').run(enabled ? 1 : 0, id).changes)
        throw new HttpError(404, 'Catalog source not found');
}
function source(id: string) {
    const s = prep('SELECT * FROM community_sources WHERE id=?').get(id) as unknown as Source | undefined;
    if (!s || !s.enabled)
        throw new HttpError(404, 'Catalog source is disabled or missing');
    return s;
}
export async function syncCatalog(id: string) {
    const s = source(id), envelope = JSON.parse((await fetchBounded(s.url)).toString('utf8')) as {
        manifest: string;
        signature: string;
    };
    if (typeof envelope.manifest !== 'string' || typeof envelope.signature !== 'string')
        throw new HttpError(400, 'Catalog must contain exact manifest text and its signature');
    const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(s.public_key, 'hex')]), type: 'spki', format: 'der' });
    if (!crypto.verify(null, Buffer.from(envelope.manifest), key, Buffer.from(envelope.signature, 'base64')))
        throw new HttpError(422, 'Catalog signature verification failed');
    const m = JSON.parse(envelope.manifest) as CatalogManifest;
    if (m.schemaVersion !== 1 || typeof m.publisher !== 'string' || !m.publisher || m.publisher.length > 200 || !Number.isFinite(Date.parse(m.generatedAt)) || !Array.isArray(m.entries) || m.entries.length > 200)
        throw new HttpError(400, 'Invalid catalog manifest');
    const old = s.manifest ? JSON.parse(s.manifest) as CatalogManifest : null;
    if (old && Date.parse(m.generatedAt) < Date.parse(old.generatedAt))
        throw new HttpError(409, 'Catalog rollback detected; review/re-add the source explicitly');
    for (const entry of m.entries) {
        plainId(entry.id, 'package ID');
        if (!['template', 'extension'].includes(entry.kind) || typeof entry.name !== 'string' || entry.name.length > 100 || !Array.isArray(entry.releases) || !entry.releases.length || entry.releases.length > 50)
            throw new HttpError(400, 'Invalid catalog entry');
        for (const release of entry.releases) {
            if (!/^\d+\.\d+\.\d+$/.test(release.version) || !/^[a-f0-9]{64}$/.test(release.sha256) || typeof release.summary !== 'string' || release.summary.length > 2000)
                throw new HttpError(400, 'Invalid pinned release');
            trustedTransport(release.url);
        }
        if (new Set(entry.releases.map(r => r.version)).size !== entry.releases.length)
            throw new HttpError(400, 'Duplicate package release');
    }
    if (new Set(m.entries.map(e => e.id)).size !== m.entries.length)
        throw new HttpError(400, 'Duplicate package IDs');
    source(id);
    db.exec('BEGIN IMMEDIATE');
    try {
        for (const entry of m.entries)
            for (const release of entry.releases) {
                const prior = prep('SELECT digest,kind FROM community_pins WHERE source_id=? AND package_id=? AND version=?').get(id, entry.id, release.version) as {
                    digest: string;
                    kind: string;
                } | undefined;
                if (prior && (prior.digest !== release.sha256 || prior.kind !== entry.kind))
                    throw new HttpError(409, 'Publisher changed an already pinned version digest or kind');
                prep('INSERT OR IGNORE INTO community_pins(source_id,package_id,version,digest,kind) VALUES (?,?,?,?,?)').run(id, entry.id, release.version, release.sha256, entry.kind);
            }
        prep('UPDATE community_sources SET manifest=?,synced_at=? WHERE id=?').run(JSON.stringify(m), Date.now(), id);
        db.exec('COMMIT');
    }
    catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
    return m;
}
export async function reviewCatalogRelease(sourceId: string, packageId: string, version: string) {
    const s = source(sourceId), m = s.manifest ? JSON.parse(s.manifest) as CatalogManifest : null, entry = m?.entries.find(e => e.id === packageId), release = entry?.releases.find(r => r.version === version);
    if (!entry || !release)
        throw new HttpError(404, 'Sync and select an exact catalog version');
    const bytes = await fetchBounded(release.url, {}, 2 * 1024 * 1024);
    if (sha256(bytes) !== release.sha256)
        throw new HttpError(422, 'Package download digest mismatch');
    const raw = JSON.parse(bytes.toString('utf8'));
    const installed = prep('SELECT * FROM community_installations WHERE package_id=? AND source_id=?').get(packageId, sourceId);
    const review = entry.kind === 'extension' ? extensionReview(raw) : { template: validateTemplate(raw), permissions: ['Administrator template import'], digest: sha256(JSON.stringify(validateTemplate(raw))) };
    if (entry.kind === 'extension' && ('manifest' in review) && review.manifest.version !== version)
        throw new HttpError(409, 'Extension version differs from catalog pin');
    return { sourceId, packageId, version, kind: entry.kind, publisher: m!.publisher, sourceFingerprint: sha256(Buffer.from(s.public_key, 'hex')), url: release.url, digest: release.sha256, summary: release.summary, installed: installed ?? null, review };
}
export async function installCatalogRelease(owner: string, input: Record<string, unknown>) {
    requireFleetAdmin(owner);
    const review = await reviewCatalogRelease(String(input.sourceId), String(input.packageId), String(input.version));
    requireFleetAdmin(owner);
    source(review.sourceId);
    if (input.digest !== review.digest || input.sourceFingerprint !== review.sourceFingerprint)
        throw new HttpError(409, 'Review/source digest changed');
    const provenance = { sourceId: review.sourceId, publisher: review.publisher, sourceFingerprint: review.sourceFingerprint, url: review.url, digest: review.digest, version: review.version, installedAt: Date.now(), installedBy: owner };
    let targetId: string;
    if (review.kind === 'extension' && 'manifest' in review.review) {
        targetId = installExtension(review.review.manifest, review.review.digest, provenance).id;
    }
    else if ('template' in review.review) {
        targetId = saveTemplate(review.review.template, owner);
    }
    else
        throw new HttpError(400, 'Package kind mismatch');
    prep('INSERT INTO community_installations(package_id,source_id,kind,version,digest,target_id,at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(package_id,source_id) DO UPDATE SET version=excluded.version,digest=excluded.digest,target_id=excluded.target_id,at=excluded.at').run(review.packageId, review.sourceId, review.kind, review.version, review.digest, targetId, Date.now());
    return { targetId, provenance, enabled: false };
}
export function catalogInstallations() { return prep('SELECT * FROM community_installations ORDER BY at DESC').all(); }
