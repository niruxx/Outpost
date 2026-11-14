import { writeWorkflow } from './workflowStore.js';
const pending = new Map<string, number>();
/** Parse only explicit spark MSPT samples, never infer tick time from CPU utilization. */
export function observeProfilerLine(id: string, line: string) {
    const text = line.replace(/\x1b\[[0-9;]*m/g, '').replace(/§[0-9a-fk-or]/gi, '');
    if (/tick durations.*min.*med.*max/i.test(text)) {
        pending.set(id, Date.now());
        return;
    }
    const direct = text.match(/\bMSPT\s*[:=]\s*(\d+(?:\.\d+)?)/i);
    const durations = Date.now() - (pending.get(id) ?? 0) < 5000 ? text.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/) : null;
    const value = direct ? Number(direct[1]) : durations ? Number(durations[2]) : null;
    if (value !== null && value >= 0 && value <= 60000) {
        writeWorkflow('tick-sample', id, { at: Date.now(), mspt: value, source: 'spark console' });
        pending.delete(id);
    }
}
