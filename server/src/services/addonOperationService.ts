import { HttpError } from '../utils/asyncHandler.js';
import { prep } from '../db/db.js';
const active = new Set<string>();
export function assertAddonIdle(id: string) {
    if (active.has(id))
        throw new HttpError(423, 'An add-on installation or removal is in progress');
    const pending = prep("SELECT id FROM addon_action_plans WHERE server_id=? AND json_extract(data,'$.state') IN ('applying','recovery-required') LIMIT 1").get(id) as {
        id: string;
    } | undefined;
    if (pending)
        throw new HttpError(423, `An interrupted add-on action needs recovery: ${pending.id}. Restore the original mod set from the recycle bin/backup and resolve it in Mods.`);
}
export async function withAddonOperation<T>(id: string, work: () => Promise<T>): Promise<T> {
    assertAddonIdle(id);
    active.add(id);
    try {
        return await work();
    }
    finally {
        active.delete(id);
    }
}
