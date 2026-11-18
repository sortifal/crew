import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { ROOT, CONFIG_PATH, config, loadConfig, saveConfigText, saveConfigObject, normalize, workerByName, workerSettings, resolveKey } from './config.mjs';
import { bus, allTasks, getTask, getFeed, pushFeed, clearFeed, renameFeed, persistTasks, emit, dataPath } from './store.mjs';
import * as G from './git.mjs';
import * as T from './tasks.mjs';
import { sendToHead, stopHead, resetHead, headState } from './head.mjs';
import { dm, dmFeed } from './dm.mjs';
import { authStatus, startLogin, submitCode, cancelLogin, logout, loginState } from './auth.mjs';
import { getLessons, setLessons, scopes, validScope } from './lessons.mjs';

loadConfig();
let repoError = '';
try { await G.ensureRepo(); } catch (e) { repoError = e.message; console.warn('⚠ ', e.message, '\n  Fix it in Settings or crew.config.yaml.'); }

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(ROOT, 'public')));

const h = (fn) => async (req, res) => { try { res.json((await fn(req)) ?? { ok: true }); } catch (e) { res.status(400).json({ error: e.message }); } };
const maskKeys = (ws) => ws.map((w) => ({ ...w, apiKey: '', hasKey: !!w.apiKey })); // per-agent API keys never leave the server
const publicConfig = () => ({ project: config.project, head: config.head, workers: maskKeys(config.workers), scheduler: config.scheduler, qwen: { model: config.qwen.model, endpoint: config.qwen.endpoint } });
const fullConfig = () => ({ project: config.project, head: config.head, workers: maskKeys(config.workers), qwen: config.qwen, scheduler: config.scheduler, lessons: config.lessons });

app.get('/api/state', h(async () => ({
  config: publicConfig(), repoError, head: headState(), tasks: allTasks(),
  live: T.liveSnapshot(), feed: getFeed('feed'), headChat: getFeed('head-chat'), lessonScopes: scopes(),
})));

app.get('/api/events', (req, res) => {
  res.set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.flushHeaders();
  const send = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  bus.on('event', send);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { bus.off('event', send); clearInterval(ping); });
});

/* head */
app.post('/api/head', h(async (r) => { if (!r.body.text?.trim()) throw new Error('empty message'); if (repoError) throw new Error(repoError); if (!(await authStatus()).loggedIn) throw new Error('Not logged in to Claude – click “Log in to Claude” in the top bar.'); sendToHead(r.body.text.trim()); }));
app.post('/api/head/stop', h(async () => stopHead()));
app.post('/api/head/reset', h(async () => { resetHead(); clearFeed('head-chat'); bus.emit('event', { type: 'head_cleared' }); }));

/* tasks */
app.get('/api/tasks/:id', h(async (r) => {
  const t = getTask(r.params.id); if (!t) throw new Error('not found');
  return { ...(await T.taskView(t, { withDiff: true })), log: T.readLog(t, t.attempts.length) };
}));
app.post('/api/tasks', h(async (r) => T.createTask({ ...r.body, by: 'user' })));
app.post('/api/tasks/:id/approve', h(async (r) => T.approveTask(r.params.id, { by: 'user', force: !!r.body.force, note: r.body.note })));
app.post('/api/tasks/:id/reject', h(async (r) => T.rejectTask(r.params.id, { feedback: r.body.feedback, lesson: r.body.lesson, by: 'user' })));
app.post('/api/tasks/:id/answer', h(async (r) => T.answerTask(r.params.id, r.body.answer || '', 'user')));
app.post('/api/tasks/:id/cancel', h(async (r) => T.cancelTask(r.params.id, 'user')));
app.post('/api/tasks/:id/retry', h(async (r) => T.retryTask(r.params.id)));

/* team channel + DMs */
app.post('/api/feed', h(async (r) => {
  const text = String(r.body.text || '').trim(); if (!text) throw new Error('empty');
  pushFeed('feed', { from: 'You', kind: 'user', text });
  const m = text.match(/^@(\w[\w-]*)\s+([\s\S]+)/);
  if (m && workerByName(m[1])) {
    const w = workerByName(m[1]);
    dm(w.name, m[2]).then(() => { const last = getFeed(dmFeed(w.name), 1)[0]; if (last && last.role !== 'user') pushFeed('feed', { from: last.role === 'error' ? 'system' : w.name, kind: 'worker', text: last.text }); });
  } else if (/^@head\b/i.test(text)) sendToHead(text.replace(/^@head\s*/i, ''));
}));
app.get('/api/dm/:name', h(async (r) => { if (!workerByName(r.params.name)) throw new Error('unknown worker'); return getFeed(dmFeed(workerByName(r.params.name).name)); }));
app.post('/api/dm/:name', h(async (r) => { const t = String(r.body.text || '').trim(); if (!t) throw new Error('empty'); dm(r.params.name, t); }));

/* lessons */
app.get('/api/lessons/:scope', h(async (r) => { if (!validScope(r.params.scope)) throw new Error('unknown scope'); return { scope: r.params.scope, text: getLessons(r.params.scope) }; }));
app.put('/api/lessons/:scope', h(async (r) => { if (!validScope(r.params.scope)) throw new Error('unknown scope'); setLessons(r.params.scope, String(r.body.text ?? '')); }));

/* Claude (head) login */
app.get('/api/auth/status', h(async () => ({ ...(await authStatus()), login: loginState() })));
app.post('/api/auth/login', h(async (r) => startLogin({ console: !!r.body.console })));
app.post('/api/auth/code', h(async (r) => submitCode(r.body.code)));
app.post('/api/auth/cancel', h(async () => cancelLogin()));
app.post('/api/auth/logout', h(async () => logout()));

/* structured settings */
app.get('/api/config', h(async () => fullConfig()));
app.put('/api/config', h(async (r) => {
  const next = r.body.config; const renames = r.body.renames || {}; // { newName: oldName }
  if (!next) throw new Error('config missing');
  for (const w of next.workers || []) { // keys are masked in the UI: empty = keep the saved one, clearKey = remove it
    const prev = workerByName(renames[w.name] || w.name);
    if (w.clearKey) w.apiKey = ''; else if (!String(w.apiKey || '').trim()) w.apiKey = prev?.apiKey || '';
    delete w.clearKey; delete w.hasKey;
  }
  normalize(JSON.parse(JSON.stringify(next))); // validate fully before touching anything
  const newNames = new Set(next.workers.map((w) => w.name.toLowerCase()));
  const kept = new Set(Object.values(renames).map((n) => n.toLowerCase()));
  const active = ['queued', 'running', 'blocked', 'review', 'needs_attention'];
  for (const w of config.workers) {
    const gone = !newNames.has(w.name.toLowerCase()) && !kept.has(w.name.toLowerCase());
    const renamed = Object.values(renames).some((o) => o.toLowerCase() === w.name.toLowerCase());
    const busy = allTasks().filter((t) => t.assignee === w.name && active.includes(t.status));
    if (gone && busy.length) throw new Error(`Cannot remove ${w.name}: ${busy.length} unfinished task(s) (${busy.map((t) => '#' + t.id).join(', ')}). Finish or cancel them, or just disable the agent.`);
    if (renamed && busy.some((t) => t.status === 'running')) throw new Error(`Cannot rename ${w.name} while it is running a task.`);
  }
  // rename migration (tasks, lessons, DM history) – two-phase so name swaps work
  const pairs = Object.entries(renames).filter(([n, o]) => n !== o && workerByName(o));
  if (pairs.length) {
    const map = Object.fromEntries(pairs.map(([n, o]) => [o.toLowerCase(), n]));
    for (const t of allTasks()) { const n = map[t.assignee.toLowerCase()]; if (n) t.assignee = n; }
    persistTasks();
    const fsm = fs;
    pairs.forEach(([, o], i) => { renameFeed(`dm-${o.toLowerCase()}`, `dm-__tmp${i}`); const lf = dataPath('lessons', `${o.toLowerCase()}.md`); if (fsm.existsSync(lf)) fsm.renameSync(lf, dataPath('lessons', `__tmp${i}.md`)); });
    pairs.forEach(([n], i) => { renameFeed(`dm-__tmp${i}`, `dm-${n.toLowerCase()}`); const tf = dataPath('lessons', `__tmp${i}.md`); if (fsm.existsSync(tf)) fsm.renameSync(tf, dataPath('lessons', `${n.toLowerCase()}.md`)); });
  }
  saveConfigObject(next);
  repoError = ''; try { await G.ensureRepo(); } catch (e) { repoError = e.message; }
  for (const t of allTasks()) emit('task', { task: t });
  bus.emit('event', { type: 'config', config: publicConfig(), repoError });
  return { config: fullConfig(), repoError };
}));
app.post('/api/test-endpoint', h(async (r) => {
  const ep = String(r.body.endpoint || '').replace(/\/$/, ''); if (!/^https?:\/\//.test(ep)) throw new Error('endpoint must start with http:// or https://');
  const agent = r.body.agent ? workerByName(r.body.agent) : null;
  const key = resolveKey(r.body.apiKey) || (agent ? workerSettings(agent).apiKey : resolveKey(config.qwen.apiKey)) || 'local';
  const auth = { authorization: `Bearer ${key}` };
  const t0 = Date.now();
  try {
    const res = await fetch(`${ep}/models`, { headers: auth, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { ok: false, message: `HTTP ${res.status} from ${ep}/models` };
    const j = await res.json().catch(() => ({}));
    const models = (j.data || j.models || []).map((m) => m.id || m.name || m.model).filter(Boolean);
    const out = { ok: true, ms: Date.now() - t0, models };
    if (/(^|\.)openrouter\.ai$/i.test(new URL(ep).hostname)) { // /models is public, so validate the key separately
      if (key === 'local') return { ...out, ok: false, message: 'OpenRouter is reachable, but no API key is set for this agent.' };
      const k = await fetch(`${ep}/key`, { headers: auth, signal: AbortSignal.timeout(8000) }).catch(() => null);
      if (k && (k.status === 401 || k.status === 403)) return { ...out, ok: false, message: 'OpenRouter rejected this API key.' };
      const d = k?.ok ? (await k.json().catch(() => ({}))).data : null;
      if (d) out.keyInfo = { label: d.label || '', usage: d.usage ?? null, limit: d.limit ?? null };
    }
    return out;
  } catch (e) { return { ok: false, message: `Cannot reach ${ep}: ${e.cause?.code || e.message}. From Docker, use host.docker.internal instead of localhost.` }; }
}));

/* settings */
app.get('/api/config/raw', h(async () => ({ text: fs.readFileSync(CONFIG_PATH, 'utf8') })));
app.put('/api/config/raw', h(async (r) => {
  saveConfigText(String(r.body.text || ''));
  repoError = ''; try { await G.ensureRepo(); } catch (e) { repoError = e.message; }
  bus.emit('event', { type: 'config', config: publicConfig(), repoError });
  return { ok: true, repoError };
}));

T.startScheduler();
const port = Number(process.env.PORT || 4317);
const host = process.env.HOST || '127.0.0.1';
app.listen(port, host, () => console.log(`Crew running on http://${host}:${port}`));
