import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from '../utils/paths.js';
import { envVar } from '../utils/env.js';
import { prep } from '../db/db.js';
import { HttpError } from '../utils/asyncHandler.js';
import { logAudit } from './userService.js';
import { checkOperation, storageFingerprint, validateStorageOperation, validateStorageSecrets, ADVANCED_ACTIONS, type StorageSecrets, type StorageInventory, type StorageOperation } from './storageHelper.js';

type HelperRequest = { action: 'inventory' | 'execute'; operation?: StorageOperation; fingerprint?: string; protectedPaths: string[]; secrets?: StorageSecrets };
export type StorageRunner = (request: HelperRequest) => Promise<unknown>;
interface Plan { userId: string; operation: StorageOperation; fingerprint: string; confirmation: string; expires: number }
export interface StorageJob { id: string; userId: string; action: string; device: string; state: 'running' | 'done' | 'failed'; message: string; createdAt: string }

async function rootOwned(file: string) {
  const resolved = await fs.realpath(file);
  let current = resolved;
  for (;;) {
    const stat = await fs.stat(current);
    if (stat.uid !== 0 || (stat.mode & 0o022)) throw new Error('Storage helper, Node executable and their parent directories must be root-owned and not group/world writable');
    if (current === path.dirname(current)) return resolved;
    current = path.dirname(current);
  }
}
export const runStorageHelper: StorageRunner = async (request) => {
  if (process.platform !== 'linux') throw new HttpError(503, 'Host disk management requires Linux. No disks on this platform will be modified.');
  const isRoot = process.getuid?.() === 0;
  const development = new URL(import.meta.url).pathname.endsWith('.ts');
  let helper = isRoot ? fileURLToPath(new URL(development ? './storageHelper.ts' : './storageHelper.js', import.meta.url)) : envVar('STORAGE_HELPER') ?? '/usr/local/libexec/outpost-storage-helper.mjs';
  let node = isRoot ? process.execPath : envVar('STORAGE_NODE') ?? '/usr/bin/node';
  if (!isRoot) {
    try { helper = await rootOwned(helper); node = await rootOwned(node); }
    catch (error) { throw new HttpError(503, `Install the root-owned Outpost storage helper and its scoped sudo rule first. ${error instanceof Error ? error.message : ''}`); }
  }
  return new Promise((resolve, reject) => {
    const child = execFile(isRoot ? node : '/usr/bin/sudo', isRoot ? development ? ['--import', import.meta.resolve('tsx'), helper] : [helper] : ['-n', '--', node, helper], {
      timeout: request.action === 'execute' ? 24 * 60 * 60_000 + 60_000 : 660_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' },
    }, (error, stdout, stderr) => {
      try {
        const response = JSON.parse(stdout);
        if (!response.ok) reject(new HttpError(400, response.error || 'Storage operation failed'));
        else resolve(response.result);
      } catch { reject(new HttpError(503, (stderr || error?.message || 'Storage helper returned invalid output').slice(0, 1500))); }
    });
    child.stdin?.end(JSON.stringify(request));
  });
};

export class StorageManager {
  private plans = new Map<string, Plan>();
  private jobs = new Map<string, StorageJob>();
  private busy = false;
  constructor(private run: StorageRunner = runStorageHelper) {}
  private protectedPaths() {
    const rows = prep('SELECT backup_directory FROM servers WHERE backup_directory IS NOT NULL').all() as { backup_directory: string }[];
    return [...new Set([DATA_DIR, process.cwd(), ...rows.map((r) => r.backup_directory)])];
  }
  async overview() {
    try {
      const state = await this.run({ action: 'inventory', protectedPaths: this.protectedPaths() }) as StorageInventory;
      return { available: true, error: null, ...state, busy: this.busy || !!state.operationRunning, jobs: [...this.jobs.values()].slice(-20).reverse() };
    }
    catch (error) { return { available: false, error: error instanceof Error ? error.message : 'Storage unavailable', devices: [], fstab: [], busy: this.busy, jobs: [...this.jobs.values()].slice(-20).reverse() }; }
  }
  async preview(userId: string, input: unknown) {
    if (this.busy) throw new HttpError(409, 'Another storage operation is still running');
    let operation;
    try { operation = validateStorageOperation(input); }
    catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'Invalid storage operation'); }
    const state = await this.run({ action: 'inventory', protectedPaths: this.protectedPaths() }) as StorageInventory;
    if (state.operationRunning) throw new HttpError(409, 'Another privileged storage operation is still running');
    let device;
    try { device = checkOperation(state, operation); }
    catch (error) { throw new HttpError(409, error instanceof Error ? error.message : 'Storage action is blocked'); }
    const destructive = ['format', 'wipe', 'partition', 'luksFormat', 'pvCreate', 'pvRemove', 'vgRemove', 'lvRemove', 'lvResize', 'partitionShrink', 'raidCreate', 'raidFail', 'raidRemove', 'pvShrink', 'luksRemoveSlot', 'layerShrink', 'secureErase'].includes(operation.action);
    const confirmation = operation.action === 'secureErase' ? `ERASE ${device.path} ${device.serial || device.wwn}` : destructive ? `ERASE ${device.path}` : device.path;
    for (const [key, plan] of this.plans) if (plan.expires < Date.now() || plan.userId === userId) this.plans.delete(key);
    if (this.plans.size >= 100) throw new HttpError(429, 'Too many pending storage previews');
    const ticket = crypto.randomBytes(32).toString('base64url');
    this.plans.set(ticket, { userId, operation, fingerprint: storageFingerprint(state, operation), confirmation, expires: Date.now() + 120_000 });
    return { ticket, device, affectedDevices: state.devices.flatMap(function flatten(node): typeof state.devices { return [node, ...node.children.flatMap(flatten)]; }).filter(d => (operation.devices ?? []).includes(d.path)).map(d => ({ path: d.path, size: d.size, model: d.model, serial: d.serial })), operation, confirmation, destructive, expiresInSeconds: 120, explanation: operation.action.startsWith('smart') ? 'Reads drive health or starts/stops a drive self-test. Tests run asynchronously; read health and self-test history later for results.' : operation.action.startsWith('raid') ? 'Manages Linux software RAID. Verify every member and keep independent backups. Synchronization may continue after the command returns. Boot configuration does not rebuild the initramfs.' : operation.action.startsWith('pvMove') ? 'Moves allocated extents between physical volumes in the same VG. Operations serialize behind the storage lock; interrupted migrations require inspection with native LVM tools.' : operation.action === 'secureErase' ? 'PERMANENT whole-disk data destruction. Verify the serial and capacity. Secure discard is attempted only with the kernel secure-discard API and never falls back to ordinary discard; software overwrite is an addressable-sector HDD clear, not a flash/remapped-sector physical purge.' : operation.action === 'layerShrink' ? 'Offline ext4 is shrunk and verified before dm-crypt and its outer partition/linear LV. The mapping is closed before reducing the outer layer, then reopened. Partial failures can leave a smaller filesystem or a closed mapping; inspect before retrying.' : operation.action === 'crypttabSet' && operation.keyMode === 'managed' ? 'Creates a root-only random boot-unlock key in a new LUKS slot. Anyone with the host root filesystem can use this key; protect host backups. Existing unrelated crypttab entries are preserved. The initramfs is not rebuilt.' : ADVANCED_ACTIONS.includes(operation.action) ? 'Changes encryption, LVM or device sizing. LUKS creation erases existing content; LV shrinking uses filesystem-aware resizing. Check the device, group and sizes. Keep a separate data backup. System and Outpost volumes remain protected.' : operation.action === 'wipe' ? 'Removes filesystem and partition-table signatures. Files become inaccessible; this is not a secure erase of the disk contents.' : operation.action === 'format' ? `Creates a new ${operation.filesystem} filesystem, destroying existing data on this device.` : operation.action === 'partition' ? 'Creates a GPT table and one Linux partition using the whole empty disk. Format the new partition afterwards.' : operation.action === 'automount' ? 'Changes this filesystem’s Outpost-managed UUID entry in /etc/fstab. Existing unrelated entries are preserved; changes apply at next mount/boot.' : operation.action === 'unmount' ? 'Unmounts the filesystem now. Its boot-mount setting is kept.' : 'Mounts the selected filesystem at the chosen empty folder.' };
  }
  plannedAction(userId: string, ticket: unknown): StorageOperation['action'] {
    const plan = typeof ticket === 'string' ? this.plans.get(ticket) : undefined;
    if (!plan || plan.userId !== userId || plan.expires <= Date.now()) throw new HttpError(403, 'Storage preview expired or is not yours. Review the action again.');
    return plan.operation.action;
  }
  plannedOperation(userId: string, ticket: unknown) {
    this.plannedAction(userId, ticket);
    return { ...this.plans.get(ticket as string)!.operation };
  }
  execute(userId: string, username: string, ticket: string, confirmation: unknown, secretInput?: unknown) {
    this.plannedAction(userId, ticket);
    const plan = this.plans.get(ticket)!;
    if (confirmation !== plan.confirmation) throw new HttpError(400, 'The confirmation text does not match the selected device');
    if (this.busy) throw new HttpError(409, 'Another storage operation is still running');
    let secrets: StorageSecrets;
    try { secrets = validateStorageSecrets(plan.operation, secretInput); } catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'Invalid passphrase'); }
    this.plans.delete(ticket); this.busy = true;
    for (const [key, job] of this.jobs) if (this.jobs.size >= 100 && job.state !== 'running') this.jobs.delete(key);
    const job: StorageJob = { id: crypto.randomUUID(), userId, action: plan.operation.action, device: plan.operation.device, state: 'running', message: 'Storage operation is running. Do not disconnect the disk.', createdAt: new Date().toISOString() };
    this.jobs.set(job.id, job);
    logAudit(userId, username, `storage.${job.action}.start`, job.device, JSON.stringify(plan.operation));
    void this.run({ action: 'execute', operation: plan.operation, fingerprint: plan.fingerprint, protectedPaths: this.protectedPaths(), secrets }).then((result) => {
      job.state = 'done'; job.message = (result as { message: string }).message;
      logAudit(userId, username, `storage.${job.action}.done`, job.device, job.message);
    }).catch((error) => {
      job.state = 'failed'; job.message = error instanceof Error ? error.message : 'Storage operation failed';
      logAudit(userId, username, `storage.${job.action}.failed`, job.device, job.message);
    }).finally(() => { this.busy = false; secrets.passphrase = undefined; secrets.newPassphrase = undefined; });
    return { ...job };
  }
}
export const storageManager = new StorageManager();
