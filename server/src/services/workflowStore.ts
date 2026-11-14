import { getSetting, setSetting } from './systemSettingsService.js';
import { HttpError } from '../utils/asyncHandler.js';
export function readWorkflow<T>(kind: string, serverId: string, fallback: T): T {
    const raw = getSetting(`workflow:${kind}:${serverId}`);
    return raw ? JSON.parse(raw) as T : fallback;
}
export function writeWorkflow(kind: string, serverId: string, value: unknown) {
    const json = JSON.stringify(value);
    if (json.length > 2 * 1024 * 1024)
        throw new HttpError(413, 'Workflow record is too large');
    setSetting(`workflow:${kind}:${serverId}`, json);
}
export function appendWorkflow<T>(kind: string, serverId: string, value: T, limit = 100) {
    const rows = [value, ...readWorkflow<T[]>(kind, serverId, [])].slice(0, limit);
    writeWorkflow(kind, serverId, rows);
    return rows;
}
export function boundedNumber(input: unknown, min: number, max: number, label: string) {
    if (typeof input !== 'number' || !Number.isFinite(input) || input < min || input > max)
        throw new HttpError(400, `${label}: enter ${min}–${max}`);
    return input;
}
