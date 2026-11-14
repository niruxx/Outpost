import fs from 'node:fs';
import { inflateRawSync, crc32 } from 'node:zlib';
import TOML from '@iarna/toml';
import YAML from 'yaml';
export interface AddonDependency {
    key: string;
    name: string;
    required: boolean;
    constraint: string;
    source: string;
}
export interface AddonMetadata {
    name: string | null;
    version: string | null;
    description: string;
    authors: string[];
    licenses: string[];
    links: string[];
    provides: string[];
    dependencies: AddonDependency[];
    format: string;
    complete: boolean;
    warnings: string[];
    bundled: string[];
}
export const text = (v: unknown, max = 300) => typeof v === 'string' ? v.replace(/\x00/g, '').slice(0, max) : '';
const versionText = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? String(v) : text(v, 200);
const strings = (v: unknown) => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []).slice(0, 64).map(x => text(x, 200)).filter(Boolean);
const link = (v: unknown) => { try {
    const u = new URL(text(v, 2048));
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.href : null;
}
catch {
    return null;
} };
const unknown = (): AddonMetadata => ({ name: null, version: null, description: '', authors: [], licenses: [], links: [], provides: [], dependencies: [], format: 'unknown', complete: false, warnings: [], bundled: [] });
const key = (namespace: string, value: unknown) => { const id = text(value, 200); if (!id || !/^[\w.:-]+$/.test(id))
    throw Error('Invalid dependency identity'); return `${namespace}:${id.toLowerCase()}`; };
/** Reads only central-directory entries and bounded metadata, never an entire game JAR or its classes. */
class MetadataZip {
    private fd: number | null = null;
    private size: number;
    private entries = new Map<string, {
        offset: number;
        size: number;
        compressed: number;
        method: number;
        flags: number;
        crc: number;
    }>();
    constructor(private input: string | Buffer) {
        if (typeof input === 'string') {
            this.fd = fs.openSync(input, 'r');
            this.size = fs.fstatSync(this.fd).size;
        }
        else
            this.size = input.length;
        try {
            const tail = this.read(Math.max(0, this.size - 65557), Math.min(this.size, 65557));
            let at = tail.length - 22;
            while (at >= 0 && (tail.readUInt32LE(at) !== 0x06054b50 || at + 22 + tail.readUInt16LE(at + 20) !== tail.length))
                at--;
            if (at < 0 || tail.readUInt16LE(at + 4) || tail.readUInt16LE(at + 6))
                throw Error('Not a supported single-disk ZIP');
            const count = tail.readUInt16LE(at + 10), bytes = tail.readUInt32LE(at + 12), offset = tail.readUInt32LE(at + 16);
            if (count > 16384 || bytes > 8 * 1048576 || offset + bytes > this.size - 22)
                throw Error('ZIP directory exceeds metadata limits');
            const directory = this.read(offset, bytes);
            let pos = 0;
            for (let i = 0; i < count; i++) {
                if (pos + 46 > directory.length || directory.readUInt32LE(pos) !== 0x02014b50)
                    throw Error('Invalid ZIP directory');
                const n = directory.readUInt16LE(pos + 28), extra = directory.readUInt16LE(pos + 30), comment = directory.readUInt16LE(pos + 32), end = pos + 46 + n + extra + comment;
                if (end > directory.length)
                    throw Error('Truncated ZIP directory');
                const name = directory.subarray(pos + 46, pos + 46 + n).toString('utf8');
                if (this.entries.has(name))
                    throw Error('Duplicate ZIP entries');
                this.entries.set(name, { flags: directory.readUInt16LE(pos + 8), method: directory.readUInt16LE(pos + 10), crc: directory.readUInt32LE(pos + 16), compressed: directory.readUInt32LE(pos + 20), size: directory.readUInt32LE(pos + 24), offset: directory.readUInt32LE(pos + 42) });
                pos = end;
            }
        }
        catch (e) {
            this.close();
            throw e;
        }
    }
    private read(offset: number, length: number): Buffer {
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > this.size)
            throw Error('ZIP metadata is outside the file');
        if (Buffer.isBuffer(this.input))
            return this.input.subarray(offset, offset + length);
        const buffer = Buffer.alloc(length);
        let n = 0;
        while (n < length) {
            const got = fs.readSync(this.fd!, buffer, n, length - n, offset + n);
            if (!got)
                throw Error('Truncated ZIP');
            n += got;
        }
        return buffer;
    }
    get(name: string, maximum = 1048576): Buffer | null {
        const e = this.entries.get(name);
        if (!e)
            return null;
        if (e.size > maximum || e.compressed > maximum || (e.flags & 1) || ![0, 8].includes(e.method))
            throw Error('Encrypted or oversized add-on metadata');
        const header = this.read(e.offset, 30);
        if (header.readUInt32LE(0) !== 0x04034b50)
            throw Error('Invalid ZIP local header');
        const filename = this.read(e.offset + 30, header.readUInt16LE(26)).toString('utf8');
        if (filename !== name)
            throw Error('ZIP metadata path mismatch');
        const compressed = this.read(e.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28), e.compressed);
        const data = e.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: maximum });
        if (data.length !== e.size || crc32(data) !== e.crc)
            throw Error('Add-on metadata checksum mismatch');
        return data;
    }
    close() { if (this.fd !== null) {
        fs.closeSync(this.fd);
        this.fd = null;
    } }
}
function object(v: unknown): Record<string, any> { if (!v || typeof v !== 'object' || Array.isArray(v))
    throw Error('Invalid add-on manifest'); return v as Record<string, any>; }
function dep(m: AddonMetadata, id: unknown, required: boolean, constraint: unknown = '*', namespace = 'mod', source = m.format) {
    if (m.dependencies.length >= 512)
        throw Error('Too many dependency declarations');
    m.dependencies.push({ key: key(namespace, id), name: text(id), required, constraint: typeof constraint === 'string' ? text(constraint) : JSON.stringify(constraint).slice(0, 500), source });
}
function parseZip(input: string | Buffer, loader: string, budget: {
    bytes: number;
    nested: number;
}, depth = 0): AddonMetadata {
    const z = new MetadataZip(input), m = unknown();
    try {
        const json = (name: string) => { const data = z.get(name); return data ? object(JSON.parse(data.toString('utf8'))) : null; };
        const nested: string[] = [];
        const quilt = loader === 'quilt' ? json('quilt.mod.json') : null;
        const fabric = !quilt && ['fabric', 'quilt'].includes(loader) ? json('fabric.mod.json') : null;
        if (quilt || fabric) {
            m.format = quilt ? 'quilt.mod.json' : 'fabric.mod.json';
            const q = quilt ? object(quilt.quilt_loader) : fabric!, info = quilt ? object(q.metadata ?? {}) : q;
            m.name = text(info.name) || text(q.id);
            m.version = text(q.version);
            m.description = text(info.description, 4000);
            m.provides.push(key('mod', q.id));
            m.authors = quilt ? Object.keys(info.contributors ?? {}).slice(0, 64) : (Array.isArray(q.authors) ? q.authors : []).slice(0, 64).map((a: any) => text(typeof a === 'string' ? a : a?.name)).filter(Boolean);
            m.licenses = strings(info.license);
            m.links = [link(info.contact?.homepage), link(info.contact?.sources), link(info.contact?.issues)].filter((x): x is string => !!x);
            for (const p of Array.isArray(q.provides) ? q.provides : [])
                m.provides.push(key('mod', typeof p === 'string' ? p : p?.id));
            if (quilt)
                for (const d of Array.isArray(q.depends) ? q.depends : []) {
                    if (!d || Array.isArray(d) || d.unless) {
                        m.warnings.push('Conditional/alternative Quilt dependency needs manual review.');
                        continue;
                    }
                    dep(m, d.id, d.optional !== true, d.versions ?? '*');
                }
            else {
                for (const [id, range] of Object.entries(object(q.depends ?? {})))
                    dep(m, id, true, range);
                for (const [id, range] of Object.entries(object(q.recommends ?? {})))
                    dep(m, id, false, range);
                for (const [id, range] of Object.entries(object(q.suggests ?? {})))
                    dep(m, id, false, range);
            }
            for (const item of Array.isArray(q.jars) ? q.jars : [])
                nested.push(text(typeof item === 'string' ? item : item?.file, 500));
            m.complete = !m.warnings.length;
        }
        else if (['forge', 'neoforge', 'mohist', 'spongeforge'].includes(loader)) {
            const name = loader === 'neoforge' && z.get('META-INF/neoforge.mods.toml') ? 'META-INF/neoforge.mods.toml' : 'META-INF/mods.toml', data = z.get(name);
            if (data) {
                m.format = name;
                const t = TOML.parse(data.toString('utf8')) as any, mods = Array.isArray(t.mods) ? t.mods : [];
                if (!mods.length || mods.length > 128)
                    throw Error('No valid mod declarations');
                for (const mod of mods)
                    m.provides.push(key('mod', mod.modId));
                m.name = text(mods[0].displayName) || text(mods[0].modId);
                m.version = text(mods[0].version);
                m.description = text(mods[0].description, 4000);
                m.authors = strings(mods[0].authors);
                m.licenses = strings(t.license);
                m.links = [link(mods[0].displayURL), link(t.issueTrackerURL)].filter((x): x is string => !!x);
                for (const rows of Object.values(t.dependencies ?? {}))
                    for (const d of Array.isArray(rows) ? rows : [])
                        if (d.side !== 'CLIENT' && !['incompatible', 'discouraged'].includes(d.type))
                            dep(m, d.modId, d.type ? d.type === 'required' : d.mandatory !== false, d.versionRange ?? '*');
                m.complete = true;
            }
            else {
                const legacy = z.get('mcmod.info');
                if (legacy) {
                    const v = JSON.parse(legacy.toString('utf8')), mods = Array.isArray(v) ? v : v.modList;
                    if (!Array.isArray(mods) || !mods.length)
                        throw Error('Invalid legacy Forge manifest');
                    for (const mod of mods)
                        m.provides.push(key('mod', mod.modid));
                    m.format = 'mcmod.info';
                    m.name = text(mods[0].name);
                    m.version = text(mods[0].version);
                    m.description = text(mods[0].description, 4000);
                    m.authors = strings(mods[0].authorList);
                    m.warnings.push('Legacy Forge annotations may declare dependencies outside mcmod.info; cleanup is conservative.');
                }
            }
            const jarjar = json('META-INF/jarjar/metadata.json');
            if (jarjar)
                for (const j of Array.isArray(jarjar.jars) ? jarjar.jars : [])
                    nested.push(text(j.path, 500));
        }
        else {
            const names = loader === 'velocity' ? ['velocity-plugin.json'] : ['plugin.yml', 'paper-plugin.yml', 'bungee.yml'];
            for (const name of names) {
                const b = z.get(name);
                if (!b)
                    continue;
                const p = object(name.endsWith('.json') ? JSON.parse(b.toString('utf8')) : YAML.parse(b.toString('utf8'), { maxAliasCount: 20 }));
                m.format = name;
                m.name = text(p.name) || text(p.id);
                m.version = versionText(p.version);
                m.description = text(p.description, 4000);
                m.authors = strings(p.authors ?? p.author);
                m.links = [link(p.website ?? p.url)].filter((x): x is string => !!x);
                m.provides.push(key('plugin', p.id ?? p.name));
                for (const alias of Array.isArray(p.provides) ? p.provides : [])
                    m.provides.push(key('plugin', alias));
                if (name === 'velocity-plugin.json')
                    for (const d of Array.isArray(p.dependencies) ? p.dependencies : [])
                        dep(m, d.id, d.optional !== true, '*', 'plugin');
                else if (name === 'paper-plugin.yml')
                    for (const [id, d] of Object.entries(p.dependencies?.server ?? {}) as [
                        string,
                        any
                    ][])
                        dep(m, id, d?.required !== false, '*', 'plugin');
                else {
                    for (const id of strings(p.depend ?? p.depends))
                        dep(m, id, true, '*', 'plugin');
                    for (const id of strings(p.softdepend ?? p.softDepends))
                        dep(m, id, false, '*', 'plugin');
                }
                m.complete = true;
                break;
            }
        }
        for (const name of nested) {
            if (budget.bytes >= 32 * 1048576) {
                m.complete = false;
                m.warnings.push('Bundled archive inspection budget reached.');
                break;
            }
            if (!name || name.startsWith('/') || name.includes('..') || name.includes('\\') || depth >= 3 || ++budget.nested > 128) {
                m.complete = false;
                m.warnings.push('Nested mod metadata exceeds safe inspection limits.');
                continue;
            }
            try {
                const bytes = z.get(name, 8 * 1048576);
                if (!bytes || (budget.bytes += bytes.length) > 32 * 1048576)
                    throw Error('Nested archive limit reached');
                const inner = parseZip(bytes, loader, budget, depth + 1);
                m.provides.push(...inner.provides);
                m.dependencies.push(...inner.dependencies);
                m.bundled.push(inner.name ?? name);
                if (!inner.complete) {
                    m.complete = false;
                    m.warnings.push(`Bundled metadata needs review: ${name}`);
                }
            }
            catch {
                m.complete = false;
                m.warnings.push(`Could not inspect bundled metadata: ${name}`);
            }
        }
        if (m.version?.includes('${file.jarVersion}')) {
            const mf = z.get('META-INF/MANIFEST.MF')?.toString('utf8').replace(/\r?\n /g, '');
            m.version = mf?.match(/^Implementation-Version:\s*(.+)$/mi)?.[1].trim() ?? null;
        }
        if (m.provides.length > 512 || m.dependencies.length > 512) {
            m.complete = false;
            m.warnings.push('Module/dependency inspection limit reached.');
        }
        m.provides = [...new Set(m.provides)].slice(0, 512);
        m.dependencies = m.dependencies.filter(d => !m.provides.includes(d.key)).slice(0, 512);
        return m;
    }
    finally {
        z.close();
    }
}
export function inspectAddonMetadata(file: string, loader: string): AddonMetadata {
    try {
        return parseZip(file, loader, { bytes: 0, nested: 0 });
    }
    catch {
        const m = unknown();
        m.warnings.push('The embedded manifest could not be safely read. No dependency cleanup can be inferred from it.');
        return m;
    }
}
