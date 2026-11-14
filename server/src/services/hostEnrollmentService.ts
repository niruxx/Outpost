import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { StringDecoder } from 'node:string_decoder';
import { Client } from 'ssh2';
import { prep } from '../db/db.js';
import { DATA_DIR, SERVER_ROOT } from '../utils/paths.js';
import { HttpError } from '../utils/asyncHandler.js';
import { seal, unseal, sha256, constantEqual, trustedTransport, fetchBounded, requireFleetAdmin } from './fleetSecurity.js';
import { addNode, removeNode } from './nodeService.js';
import { beginJob, progressJob, finishJob } from './jobService.js';
const exec = promisify(execFile), base = path.join(DATA_DIR, 'fleet-enrollment');
interface Enrollment {
    id: string;
    owner: string;
    name: string;
    nodeUrl: string;
    panelUrl: string;
    port: number;
    nodeVersion: string;
    nodeHashes: Record<string, string>;
    state: string;
    expires: number;
    bundleHash: string;
    secret: string;
    ownerUsername: string;
    ownerPassword: string;
    nodeId?: string;
    error?: string;
    logs: string[];
}
const quote = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
function row(id: string) {
    const r = prep('SELECT data FROM fleet_enrollments WHERE id=?').get(id) as {
        data: string;
    } | undefined;
    if (!r)
        throw new HttpError(404, 'Enrollment not found');
    return JSON.parse(r.data) as Enrollment;
}
function save(e: Enrollment) { prep('UPDATE fleet_enrollments SET data=? WHERE id=?').run(JSON.stringify(e), e.id); }
export function enrollmentRows() {
    return (prep('SELECT data FROM fleet_enrollments ORDER BY created_at DESC LIMIT 100').all() as {
        data: string;
    }[]).map(r => { const e = JSON.parse(r.data) as Enrollment; return { ...e, secret: undefined, ownerPassword: undefined, rollback: `Stop/disable outpost-enroll-${e.id}.service. Files in /opt/outpost-enroll/${e.id} are retained; existing installations/services are never overwritten.` }; });
}
export async function createEnrollment(owner: string, input: Record<string, unknown>) {
    requireFleetAdmin(owner);
    const nodeUrl = trustedTransport(input.nodeUrl).origin, panelUrl = trustedTransport(input.panelUrl).origin, name = String(input.name ?? '').trim(), ownerUsername = String(input.ownerUsername ?? ''), password = String(input.ownerPassword ?? ''), port = Number(input.port ?? 8642);
    if (!name || name.length > 100 || !/^[a-z][a-z0-9_-]{2,31}$/i.test(ownerUsername) || password.length < 12 || password.length > 256 || password.includes('\0') || !Number.isInteger(port) || port < 1024 || port > 65535 || input.reverseProxyReady !== true)
        throw new HttpError(400, 'Provide a name, owner account/password (12+ characters), port and acknowledge the HTTPS reverse-proxy prerequisite');
    const index = JSON.parse((await fetchBounded('https://nodejs.org/dist/index.json')).toString('utf8')) as {
        version: string;
    }[];
    const requested = input.nodeVersion ? String(input.nodeVersion) : index.find(v => /^v22\.\d+\.\d+$/.test(v.version))?.version;
    if (!requested || !/^v22\.\d+\.\d+$/.test(requested))
        throw new HttpError(400, 'Choose a pinned Node 22 release');
    const sums = (await fetchBounded(`https://nodejs.org/dist/${requested}/SHASUMS256.txt`, {}, 131072)).toString('utf8'), nodeHashes: Record<string, string> = {};
    for (const arch of ['x64', 'arm64']) {
        const name = `node-${requested}-linux-${arch}.tar.xz`, line = sums.split('\n').find(l => l.trim().endsWith(' ' + name));
        if (!line || !/^[a-f0-9]{64}\s/.test(line))
            throw new HttpError(502, 'Official Node checksum is unavailable');
        nodeHashes[arch] = line.slice(0, 64);
    }
    const id = crypto.randomUUID(), secret = crypto.randomBytes(32).toString('base64url');
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    const artifact = path.join(base, `${id}.tar.gz`), root = path.resolve(SERVER_ROOT, '..');
    for (const p of ['server/dist/index.js', 'web/dist/index.html'])
        if (!fs.existsSync(path.join(root, p)))
            throw new HttpError(409, 'Build the panel before creating an enrollment bundle');
    await exec('tar', ['-czf', artifact, 'package.json', 'package-lock.json', 'server/package.json', 'server/dist', 'web/package.json', 'web/dist', 'scripts'], { cwd: root, windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 });
    const { hashFile } = await import('./verifiedBackupService.js');
    const e: Enrollment = { id, owner, name, nodeUrl, panelUrl, port, nodeVersion: requested, nodeHashes, state: 'review', expires: Date.now() + 3600000, bundleHash: await hashFile(artifact), secret: seal(secret), ownerUsername, ownerPassword: seal(password), logs: [] };
    prep('INSERT INTO fleet_enrollments(id,owner,secret_hash,data,created_at) VALUES (?,?,?,?,?)').run(id, owner, sha256(secret), JSON.stringify(e), Date.now());
    return { ...enrollmentRows().find(r => r.id === id)!, script: enrollmentScript(e, true) };
}
export function enrollmentScript(e: Enrollment, redacted = false) {
    const secret = redacted ? 'REDACTED' : unseal(e.secret), password = redacted ? 'REDACTED' : unseal(e.ownerPassword), prefix = `/opt/outpost-enroll/${e.id}`, unit = `outpost-enroll-${e.id}`, account = `outpost-${e.id.slice(0, 12)}`, config = Buffer.from(JSON.stringify({ id: e.id, secret, panelUrl: e.panelUrl, nodeUrl: e.nodeUrl, ownerUsername: e.ownerUsername, ownerPassword: password, port: e.port })).toString('base64');
    return `#!/usr/bin/env bash
set -euo pipefail
umask 077
test "$(id -u)" = 0 || { echo 'Root access is required (sudo -n bash -s is supported).'; exit 1; }
for cmd in curl tar sha256sum systemctl useradd; do command -v "$cmd" >/dev/null || { echo "Missing prerequisite: $cmd"; exit 1; }; done
prefix=${quote(prefix)}
test ! -e "$prefix" || { echo 'Enrollment directory already exists; inspect before retrying.'; exit 1; }
mkdir -p "$prefix/app" "$prefix/data"
printf '%s' ${quote(e.id)} > "$prefix/.outpost-enrollment"
case "$(uname -m)" in x86_64) arch=x64; nodehash=${quote(e.nodeHashes.x64)};; aarch64|arm64) arch=arm64; nodehash=${quote(e.nodeHashes.arm64)};; *) echo 'Only Linux x64/arm64 hosts are supported'; exit 1;; esac
echo 'Downloading pinned Node runtime'
curl --fail --silent --show-error --proto '=https' --tlsv1.2 ${quote(`https://nodejs.org/dist/${e.nodeVersion}/node-${e.nodeVersion}-linux-`)}"$arch.tar.xz" -o "$prefix/node.tar.xz"
printf '%s  %s\n' "$nodehash" "$prefix/node.tar.xz" | sha256sum -c -
mkdir "$prefix/node"; tar -xJf "$prefix/node.tar.xz" -C "$prefix/node" --strip-components=1
echo 'Downloading verified Outpost bundle'
curl --fail --silent --show-error --config - -o "$prefix/panel.tar.gz" <<'CURL'
url = "${e.panelUrl}/api/fleet-enrollment/${e.id}/bundle"
header = "Authorization: Bearer ${secret}"
CURL
printf '%s  %s\n' ${quote(e.bundleHash)} "$prefix/panel.tar.gz" | sha256sum -c -
tar -xzf "$prefix/panel.tar.gz" -C "$prefix/app"
export PATH="$prefix/node/bin:$PATH"
cd "$prefix/app"
echo 'Installing locked production dependencies'
npm ci --omit=dev --no-audit --no-fund
export OUTPOST_DATA_DIR="$prefix/data"
export OUTPOST_ENROLLMENT_CONFIG=${quote(config)}
node --input-type=module <<'NODE'
import fs from 'node:fs';
const c=JSON.parse(Buffer.from(process.env.OUTPOST_ENROLLMENT_CONFIG,'base64'));
const users=await import('./server/dist/services/userService.js');
if(users.listUsers().length)throw new Error('Existing accounts detected; refusing to overwrite');
users.createUser(c.ownerUsername,c.ownerPassword,'admin');
const {getLocalNodeKey}=await import('./server/dist/services/nodeService.js');
delete c.ownerPassword;
fs.writeFileSync(process.env.OUTPOST_DATA_DIR+'/enroll-once.json',JSON.stringify({...c,nodeKey:getLocalNodeKey()}),{mode:0o600});
NODE
unset OUTPOST_ENROLLMENT_CONFIG
useradd --system --no-create-home --home-dir "$prefix" --shell /usr/sbin/nologin ${quote(account)}
chown -R ${quote(account + ':' + account)} "$prefix"
cat > /etc/systemd/system/${unit}.service <<'UNIT'
[Unit]
Description=Outpost enrolled host ${e.id}
After=network-online.target
[Service]
User=${account}
Group=${account}
WorkingDirectory=${prefix}/app
Environment=OUTPOST_DATA_DIR=${prefix}/data
Environment=PORT=${e.port}
ExecStart=${prefix}/node/bin/node ${prefix}/app/server/dist/index.js
Restart=on-failure
UMask=0077
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now ${unit}.service
echo 'Verifying local readiness and enrolling with the controller'
node --input-type=module <<'NODE'
import fs from 'node:fs';
const file=process.env.OUTPOST_DATA_DIR+'/enroll-once.json',c=JSON.parse(fs.readFileSync(file));
let ready=false;for(let i=0;i<60;i++){try{const r=await fetch('http://127.0.0.1:'+c.port+'/api/node-link/info',{headers:{'x-outpost-node-key':c.nodeKey},signal:AbortSignal.timeout(2000)});if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,1000));}
if(!ready)throw new Error('New host did not become ready; inspect the enrollment unit');
const r=await fetch(c.panelUrl+'/api/fleet-enrollment/'+c.id+'/complete',{method:'POST',headers:{Authorization:'Bearer '+c.secret,'Content-Type':'application/json'},body:JSON.stringify({nodeKey:c.nodeKey}),signal:AbortSignal.timeout(20000)});
if(!r.ok)throw new Error('Controller enrollment failed: HTTP '+r.status);
fs.unlinkSync(file);console.log('Enrollment complete');
NODE
echo 'Rollback boundary: stop/disable ${unit}.service; leave ${prefix} intact for inspection. No existing Outpost service was changed.'
`;
}
export function enrollmentBundle(id: string, secret: string) {
    const e = row(id);
    requireFleetAdmin(e.owner);
    const r = prep('SELECT secret_hash FROM fleet_enrollments WHERE id=?').get(id) as {
        secret_hash: string;
    };
    if (e.expires < Date.now() || e.state === 'enrolled' || e.state === 'cancelled' || !constantEqual(sha256(secret), r.secret_hash))
        throw new HttpError(401, 'Enrollment token is invalid or expired');
    return path.join(base, `${id}.tar.gz`);
}
const completing = new Set<string>();
export async function completeEnrollment(id: string, secret: string, nodeKey: unknown) {
    const e = row(id);
    enrollmentBundle(id, secret);
    if (typeof nodeKey !== 'string' || !/^mcn_[\w-]{20,100}$/.test(nodeKey))
        throw new HttpError(400, 'New host node key required');
    if (completing.has(id))
        throw new HttpError(409, 'Enrollment verification is already running');
    completing.add(id);
    try {
        requireFleetAdmin(e.owner);
        const result = await addNode(e.name, e.nodeUrl, nodeKey);
        try {
            enrollmentBundle(id, secret);
            requireFleetAdmin(e.owner);
        }
        catch (error) {
            removeNode(result.node.id);
            throw error;
        }
        const latest = row(id);
        latest.nodeId = result.node.id;
        latest.state = 'enrolled';
        latest.logs.push('Verified remote node identity and enrolled host');
        latest.secret = '';
        latest.ownerPassword = '';
        save(latest);
        return { nodeId: result.node.id };
    }
    finally {
        completing.delete(id);
    }
}
const executing = new Set<string>();
export async function executeEnrollment(owner: string, id: string, input: Record<string, unknown>) {
    requireFleetAdmin(owner);
    const e = row(id);
    if (e.owner !== owner || e.state !== 'review' || e.expires < Date.now() || executing.has(id) || input.bundleHash !== e.bundleHash)
        throw new HttpError(409, 'Review/expiry/state changed; create a fresh enrollment after inspecting the remote host');
    const host = String(input.host ?? ''), username = String(input.username ?? 'root'), rawFingerprint = String(input.fingerprint ?? ''), fingerprint = /^SHA256:[A-Za-z0-9+/]{43}=?$/.test(rawFingerprint) ? Buffer.from(rawFingerprint.slice(7), 'base64').toString('hex') : rawFingerprint;
    if (!/^[a-z0-9.:-]{1,253}$/i.test(host) || !/^[\w-]{1,40}$/.test(username) || !/^[a-f0-9]{64}$/i.test(fingerprint) || typeof input.privateKey !== 'string' || input.privateKey.length > 32768)
        throw new HttpError(400, 'SSH host, username, pinned SHA-256 host-key fingerprint (hex) and private key required');
    const port = Number(input.port ?? 22);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new HttpError(400, 'Invalid SSH port');
    executing.add(id);
    e.state = 'installing';
    save(e);
    const job = beginJob('host-enrollment', null, 'Connecting with pinned SSH host key');
    void (async () => {
        const client = new Client();
        try {
            await new Promise<void>((resolve, reject) => { client.once('ready', resolve); client.once('error', reject); client.connect({ host, port, username, privateKey: input.privateKey as string, passphrase: typeof input.passphrase === 'string' ? input.passphrase : undefined, hostHash: 'sha256', hostVerifier: (hash: string) => constantEqual(String(hash).toLowerCase(), fingerprint.toLowerCase()), readyTimeout: 20000, keepaliveInterval: 15000 }); });
            requireFleetAdmin(owner);
            await new Promise<void>((resolve, reject) => {
                client.exec(username === 'root' ? 'bash -s' : 'sudo -n bash -s', (error, stream) => {
                    if (error)
                        return reject(error);
                    let bytes = 0;
                    const timer = setTimeout(() => { stream.close(); reject(new Error('Enrollment timed out; inspect the remote unit before retrying')); }, 30 * 60000);
                    const script = enrollmentScript(e);
                    const secrets = [unseal(e.secret), unseal(e.ownerPassword), script.match(/OUTPOST_ENROLLMENT_CONFIG='([^']+)'/)?.[1] ?? ''].filter(Boolean);
                    const write = (line: string) => { for (const secret of secrets)
                        line = line.split(secret).join('[redacted]'); bytes += line.length; if (bytes > 128 * 1024)
                        return; const latest = row(id); latest.logs.push(line.slice(0, 2000)); latest.logs = latest.logs.slice(-100); save(latest); progressJob(job, line.slice(0, 500), null); };
                    const buffered = () => { let pending = '', dropping = false; const decoder = new StringDecoder('utf8'); return { push: (chunk: Buffer) => { pending += decoder.write(chunk); let at; while ((at = pending.indexOf('\n')) >= 0) {
                            if (!dropping)
                                write(pending.slice(0, at));
                            pending = pending.slice(at + 1);
                            dropping = false;
                        } if (pending.length > 65536) {
                            pending = '';
                            dropping = true;
                        } }, flush: () => { pending += decoder.end(); if (!dropping && pending)
                            write(pending); } }; };
                    const stdout = buffered(), stderr = buffered();
                    stream.on('data', stdout.push);
                    stream.stderr.on('data', stderr.push);
                    stream.once('error', (error: Error) => { clearTimeout(timer); reject(error); });
                    stream.once('close', (code: number) => { clearTimeout(timer); stdout.flush(); stderr.flush(); code === 0 ? resolve() : reject(new Error('Remote installer failed; inspect retained files before retrying')); });
                    stream.end(script);
                });
            });
            if (row(id).state !== 'enrolled')
                throw new Error('Installer exited without a verified enrollment callback; inspect the remote host');
            finishJob(job);
        }
        catch (error) {
            const latest = row(id);
            if (latest.state !== 'enrolled') {
                latest.state = 'failed';
                latest.error = (error as Error).message;
                save(latest);
            }
            finishJob(job, error);
        }
        finally {
            client.end();
            executing.delete(id);
        }
    })();
    return { id, jobId: job, state: 'installing' };
}
export function cancelEnrollment(owner: string, id: string) {
    requireFleetAdmin(owner);
    const e = row(id);
    if (e.owner !== owner)
        throw new HttpError(403, 'Enrollment owner required');
    if (executing.has(id) || e.state === 'enrolled')
        throw new HttpError(409, 'Installer is running or already enrolled; inspect its remote unit and linked-host record before rollback');
    e.state = 'cancelled';
    e.secret = '';
    e.ownerPassword = '';
    save(e);
}
export function recoverEnrollmentJobs() { for (const item of enrollmentRows()) {
    if (item.state !== 'installing')
        continue;
    const e = row(item.id);
    e.state = 'interrupted';
    e.error = 'Controller restarted during installation. Inspect the remote unit before creating another enrollment.';
    save(e);
} }
