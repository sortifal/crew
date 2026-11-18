import { load, save, emit, getTask, persistTasks } from './store.mjs';

/**
 * Token accounting. One record per model request, from three sources:
 *  - agents' CLI runs and chats (via the /llm-proxy route and dm.mjs): usage reported by the server, or an estimate
 *  - the Head (via the Agent SDK's stream events): exact, including prompt-cache reads/writes
 */
const KEEP = 300;
let recent = load('usage-recent.json', []);
let totals = load('usage-totals.json', {});
let seq = recent.at(-1)?.n || 0;
let timer = null;
const flush = () => { timer = null; save('usage-recent.json', recent); save('usage-totals.json', totals); };

/** r: {who, kind: 'task'|'chat'|'head', taskId?, attempt?, model, input, output, cached?, cacheWrite?, ms, estimated?, tps?} */
export function record(r) {
  const rec = { n: ++seq, ts: Date.now(), input: 0, output: 0, cached: 0, cacheWrite: 0, ...r };
  recent.push(rec); if (recent.length > KEEP) recent.splice(0, recent.length - KEEP);
  const tt = (totals[rec.who] ||= { requests: 0, input: 0, output: 0, cached: 0, cacheWrite: 0, cost: 0 });
  tt.requests++; tt.input += rec.input; tt.output += rec.output; tt.cached += rec.cached; tt.cacheWrite += rec.cacheWrite;
  if (rec.taskId) {
    const t = getTask(rec.taskId);
    if (t) { const u = (t.usage ||= { requests: 0, input: 0, output: 0 }); u.requests++; u.input += rec.input; u.output += rec.output; persistTasks(); }
  }
  if (!timer) timer = setTimeout(flush, 2000);
  emit('usage', { rec, totals: tt, who: rec.who });
  return rec;
}
export const addCost = (who, usd) => { const tt = (totals[who] ||= { requests: 0, input: 0, output: 0, cached: 0, cacheWrite: 0, cost: 0 }); tt.cost += usd; if (!timer) timer = setTimeout(flush, 2000); emit('usage', { rec: null, totals: tt, who }); };
export const usageSnapshot = () => ({ recent: recent.slice(-120), totals });
export const resetUsage = () => { recent = []; totals = {}; flush(); emit('usage', { reset: true }); };
