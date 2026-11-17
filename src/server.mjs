import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { ROOT, CONFIG_PATH, config, loadConfig, saveConfigText, workerByName } from './config.mjs';
import { bus, allTasks, getTask, getFeed, pushFeed, clearFeed } from './store.mjs';
import * as G from './git.mjs';
import * as T from './tasks.mjs';
import { sendToHead, stopHead, resetHead, headState } from './head.mjs';
import { dm, dmFeed } from './dm.mjs';
import { getLessons, setLessons, scopes, validScope } from './lessons.mjs';

loadConfig();
let repoError = '';
try { await G.ensureRepo(); } catch (e) { repoError = e.message; console.warn('⚠ ', e.message, '\n  Fix it in Settings or crew.config.yaml.'); }

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(ROOT, 'public')));

const h = (fn) => async (req, res) => { try { res.json((await fn(req)) ?? { ok: true }); } catch (e) { res.status(400).json({ error: e.message }); } };
const publicConfig = () => ({ project: config.project, head: config.head, workers: config.workers, scheduler: config.scheduler, qwen: { model: config.qwen.model, endpoint: config.qwen.endpoint } });

app.get('/api/state', h(async () => ({
  config: publicConfig(), repoError, head: headState(), tasks: allTasks(),
  feed: getFeed('feed'), headChat: getFeed('head-chat'), lessonScopes: scopes(),
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
app.post('/api/head', h(async (r) => { if (!r.body.text?.trim()) throw new Error('empty message'); if (repoError) throw new Error(repoError); sendToHead(r.body.text.trim()); }));
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
