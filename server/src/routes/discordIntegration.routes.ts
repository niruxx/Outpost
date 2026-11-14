import express, { Router } from 'express';
import crypto from 'node:crypto';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { getUserById, logAudit } from '../services/userService.js';
import { authorizeWorkflowActor } from '../services/reliabilityService.js';
import { readWorkflow, writeWorkflow } from '../services/workflowStore.js';
import { getServer } from '../services/serverService.js';
import { getOnlinePlayers } from '../services/playerService.js';
import { isRunning, startServer, stopServer, restartServer } from '../services/processManager.js';
import { beginJob, finishJob } from '../services/jobService.js';
import { HttpError, asyncHandler } from '../utils/asyncHandler.js';
import { envVar } from '../utils/env.js';
interface Config {
    enabled: boolean;
    applicationId: string;
    publicKey: string;
    guildId: string;
    mappings: {
        discordId: string;
        userId: string;
        instances: string[];
        actions: string[];
    }[];
}
const config = () => readWorkflow<Config>('discord', 'global', { enabled: false, applicationId: '', publicKey: '', guildId: '', mappings: [] });
const cooldown = new Map<string, number>();
export const discordAdminRouter = Router();
discordAdminRouter.use(requireAuth, (req, _res, next) => { const user = getUserById(req.auth!.sub); if (!user || user.disabled)
    return next(new HttpError(403, 'Current administrator account required')); req.auth!.role = user.role; next(); }, requireRole('admin'));
discordAdminRouter.get('/', (_req, res) => res.json({ ...config(), tokenConfigured: !!envVar('DISCORD_BOT_TOKEN'), endpoint: '/api/integrations/discord/interactions' }));
discordAdminRouter.put('/', (req, res, next) => { try {
    const input = req.body as Config;
    if (!input || typeof input.enabled !== 'boolean' || !/^[0-9]{10,30}$/.test(input.applicationId) || !/^[a-f0-9]{64}$/i.test(input.publicKey) || !/^[0-9]{10,30}$/.test(input.guildId) || !Array.isArray(input.mappings) || input.mappings.length > 1000 || !input.mappings.every(m => /^[0-9]{10,30}$/.test(m.discordId) && getUserById(m.userId) && Array.isArray(m.instances) && m.instances.length <= 100 && m.instances.every(id => !!getServer(id)) && Array.isArray(m.actions) && m.actions.every(a => ['status', 'players', 'start', 'stop', 'restart'].includes(a))))
        throw new HttpError(400, 'Provide application/guild IDs, an Ed25519 public key and explicit account/instance/action mappings');
    writeWorkflow('discord', 'global', input);
    logAudit(req.auth!.sub, req.auth!.username, 'discord.configure');
    res.json({ ok: true });
}
catch (e) {
    next(e);
} });
discordAdminRouter.post('/register', asyncHandler(async (req, res) => {
    const c = config(), token = envVar('DISCORD_BOT_TOKEN');
    if (!c.enabled || !token)
        throw new HttpError(400, 'Enable the integration and configure OUTPOST_DISCORD_BOT_TOKEN on the host');
    const response = await fetch(`https://discord.com/api/v10/applications/${c.applicationId}/guilds/${c.guildId}/commands`, { method: 'POST', headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'outpost', description: 'Approved Outpost server actions', default_member_permissions: '0', options: ['status', 'players', 'start', 'stop', 'restart'].map(name => ({ type: 1, name, description: `Outpost ${name}`, options: [{ type: 3, name: 'instance', description: 'Outpost instance ID', required: true }] })) }), signal: AbortSignal.timeout(15000) });
    if (!response.ok)
        throw new HttpError(502, `Discord command registration failed: HTTP ${response.status}`);
    logAudit(req.auth!.sub, req.auth!.username, 'discord.register');
    res.json({ ok: true });
}));
export const discordInteractionRouter = Router();
// Mount before the application JSON parser: verification requires the exact request bytes.
discordInteractionRouter.post('/interactions', express.raw({ type: 'application/json', limit: '64kb' }), (req, res) => {
    const c = config(), signature = String(req.headers['x-signature-ed25519'] ?? ''), timestamp = String(req.headers['x-signature-timestamp'] ?? '');
    try {
        if (!c.enabled || !Buffer.isBuffer(req.body) || !/^[a-f0-9]{128}$/i.test(signature) || !/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300)
            throw new Error('Invalid signature');
        const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(c.publicKey, 'hex')]), format: 'der', type: 'spki' });
        if (!crypto.verify(null, Buffer.concat([Buffer.from(timestamp), req.body]), key, Buffer.from(signature, 'hex')))
            throw new Error('Invalid signature');
        const body = JSON.parse(req.body.toString('utf8'));
        if (body.application_id !== c.applicationId)
            throw new Error('Wrong application');
        if (body.type === 1) {
            res.json({ type: 1 });
            return;
        }
        const respond = (content: string) => res.json({ type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } });
        if (body.type !== 2 || body.guild_id !== c.guildId || body.data?.name !== 'outpost')
            return void respond('Command is unavailable in this context.');
        const discordId = body.member?.user?.id, sub = body.data.options?.[0], action = sub?.name, id = sub?.options?.find((o: {
            name: string;
        }) => o.name === 'instance')?.value;
        const mapping = c.mappings.find(m => m.discordId === discordId && m.instances.includes(id) && m.actions.includes(action));
        if (!mapping)
            return void respond('This Discord account has no approved mapping for that action/instance.');
        authorizeWorkflowActor(mapping.userId, [id], [['start', 'stop', 'restart'].includes(action) ? 'power' : action === 'players' ? 'players' : 'files.read']);
        const seen = readWorkflow<string[]>('discord-seen', 'global', []);
        if (typeof body.id !== 'string' || seen.includes(body.id))
            return void respond('Interaction already handled.');
        writeWorkflow('discord-seen', 'global', [body.id, ...seen].slice(0, 2000));
        if (action === 'status')
            return void respond(`${getServer(id)!.name}: ${getServer(id)!.status}${isRunning(id) ? ' (process active)' : ''}`);
        if (action === 'players')
            return void respond(`${getOnlinePlayers(id).length} players: ${getOnlinePlayers(id).join(', ').slice(0, 1500) || 'none observed'}`);
        if (!['start', 'stop', 'restart'].includes(action))
            return void respond('Action unavailable.');
        const keyId = `${mapping.userId}:${id}`;
        if (Date.now() - (cooldown.get(keyId) ?? 0) < 30000)
            return void respond('An action was recently requested. Wait 30 seconds before another request.');
        cooldown.set(keyId, Date.now());
        const job = beginJob(`discord-${action}`, id), user = getUserById(mapping.userId)!;
        logAudit(user.id, user.username, `discord.${action}`, id);
        respond(`Approved ${action} request queued. Check Outpost job history for the result.`);
        void (async () => { try {
            authorizeWorkflowActor(user.id, [id], ['power']);
            if (action === 'start')
                await startServer(id);
            else if (action === 'stop')
                stopServer(id);
            else
                await restartServer(id);
            finishJob(job);
        }
        catch (e) {
            finishJob(job, e);
        } })();
    }
    catch {
        res.status(401).json({ error: 'Invalid Discord signature or account access' });
    }
});
