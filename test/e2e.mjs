import { spawn, execSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-test-'));
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo);
const sh = (c, cwd = repo) => execSync(c, { cwd, stdio: 'pipe' }).toString();
sh('git init -q -b main && git config user.email t@t && git config user.name t && echo hi > README.md && git add -A && git commit -qm init');

// fake OpenAI-compatible server for DMs
const llm = http.createServer((req, res) => { if (req.method === 'GET') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'fake-a' }, { id: 'fake-b' }] })); } let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { const j = JSON.parse(b); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: `<think>x</think>Sure. (sys has lesson: ${j.messages[0].content.includes('mock-lesson-marker')}) (model ${j.model}) (auth ${req.headers.authorization}) (provider ${JSON.stringify(j.provider)})` } }] })); }); });
await new Promise((r) => llm.listen(0, r));
const llmPort = llm.address().port;

const cfgPath = path.join(tmp, 'cfg.yaml');
fs.writeFileSync(cfgPath, `
project: { name: Test, repo: ${repo}, baseBranch: main }
head: { model: opus, autoReview: false }
workers:
  - { name: Mira, role: Backend, persona: dry }
  - { name: Theo, role: Frontend }
qwen:
  command: ${path.resolve('examples/mock-worker.sh')}
  args: ["{prompt}"]
  endpoint: http://127.0.0.1:${llmPort}/v1
  model: fake
scheduler: { maxParallel: 2, autoRetries: 1, maxAttempts: 4 }
dataDir: ${path.join(tmp, 'data')}
`);

const PORT = 4400 + Math.floor(Math.random() * 400);
const env = { ...process.env, CREW_CONFIG: cfgPath, PORT: String(PORT), CREW_SANDBOX: '1', CREW_TEST_KEY: 'from-env', CLAUDE_BIN: path.resolve('examples/fake-claude.sh'), FAKE_STATE: path.join(tmp, 'fake-login') };
delete env.ANTHROPIC_API_KEY; delete env.CLAUDE_CODE_OAUTH_TOKEN;
const srv = spawn('node', ['src/server.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let slog = ''; srv.stdout.on('data', (d) => (slog += d)); srv.stderr.on('data', (d) => (slog += d));
const base = `http://127.0.0.1:${PORT}`;
const api = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; };
const until = async (fn, label, ms = 20000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + label + '\n' + slog); await new Promise((r) => setTimeout(r, 200)); } };
const status = async (id) => (await api('GET', '/api/state')).tasks.find((t) => t.id === id).status;
const waitFor = (id, st) => until(async () => (await status(id)) === st, `task ${id} -> ${st}`);
let pass = 0; const ok = (n) => { pass++; console.log('  ✔', n); };

try {
  await until(async () => { try { await api('GET', '/api/state'); return true; } catch { return false; } }, 'server up');
  const st = await api('GET', '/api/state'); assert.equal(st.repoError, ''); ok('server starts, repo valid');

  // A: happy path
  const a = await api('POST', '/api/tasks', { title: 'Write a file', brief: 'write file', assignee: 'Mira', verify: 'test -f out_1.txt' });
  await waitFor(a.id, 'review'); ok('task runs in worktree and reaches review');
  const det = await api('GET', `/api/tasks/${a.id}`);
  assert.match(det.diff.patch, /hello from Mira/); assert.match(det.attempts[0].report, /I wrote/); assert.equal(det.attempts[0].verify.code, 0); ok('diff, report and check result captured');
  assert.ok(!det.diff.patch.includes('.crew')); ok('.crew scratch files not committed');
  assert.match(det.diff.patch, /NOSUBAGENTS/); assert.match(det.diff.patch, /SANDBOXNOTE/); ok('sandbox note (sudo/install allowed) is in the brief');
  await api('POST', `/api/tasks/${a.id}/approve`, {}); await waitFor(a.id, 'done');
  assert.ok(fs.existsSync(path.join(repo, 'out_1.txt'))); assert.match(sh('git log --oneline'), /Merge task #1/); ok('approve merges into main');
  assert.ok(!fs.existsSync(path.join(tmp, 'data/worktrees/t1'))); ok('worktree cleaned up after merge');

  // B: flaky -> auto retry -> review
  const b = await api('POST', '/api/tasks', { title: 'Flaky', brief: 'FLAKY thing', assignee: 'Theo', verify: 'grep -q good flaky.txt' });
  await waitFor(b.id, 'review'); const bd = await api('GET', `/api/tasks/${b.id}`);
  assert.equal(bd.attempts.length, 2); assert.equal(bd.autoRetried, 1); ok('failing check triggers one automatic retry, then passes');

  // C: question -> blocked -> answer
  const c = await api('POST', '/api/tasks', { title: 'Ask', brief: 'ASKME', assignee: 'Mira' });
  await waitFor(c.id, 'blocked'); assert.match((await api('GET', `/api/tasks/${c.id}`)).question, /tabs or spaces/); ok('worker question blocks the task');
  await api('POST', `/api/tasks/${c.id}/answer`, { answer: 'spaces' }); await waitFor(c.id, 'review'); ok('answer resumes the task');

  // D: reject with lesson -> lesson + feedback in next brief
  await api('POST', `/api/tasks/${c.id}/reject`, { feedback: 'Use better names', lesson: 'mock-lesson-marker: name files clearly' });
  await waitFor(c.id, 'review');
  const cd = await api('GET', `/api/tasks/${c.id}`); assert.match(cd.diff.patch, /SAW LESSON/); assert.match(cd.diff.patch, /FIXED/); assert.equal(cd.attempts.length, 3); ok('rejection feedback + lesson are injected into the next attempt');
  assert.match((await api('GET', '/api/lessons/Mira')).text, /mock-lesson-marker/); ok('lesson persisted per worker');

  // E: dependency ordering
  const d1 = await api('POST', '/api/tasks', { title: 'First', brief: 'x', assignee: 'Theo' });
  const d2 = await api('POST', '/api/tasks', { title: 'Second', brief: 'y', assignee: 'Mira', dependsOn: [d1.id] });
  await waitFor(d1.id, 'review'); await new Promise((r) => setTimeout(r, 2500)); assert.equal(await status(d2.id), 'queued'); ok('dependent task waits for its dependency to be merged');
  await api('POST', `/api/tasks/${d1.id}/approve`, {}); await waitFor(d2.id, 'review'); ok('dependent task starts once dependency is merged');

  // F: cancel
  const f = await api('POST', '/api/tasks', { title: 'To cancel', brief: 'ASKME', assignee: 'Theo' });
  await waitFor(f.id, 'blocked'); await api('POST', `/api/tasks/${f.id}/cancel`, {}); assert.equal(await status(f.id), 'cancelled'); ok('cancel works');

  // G: DM with persona + lessons
  await api('POST', '/api/dm/Mira', { text: 'hi' });
  const dm = await until(async () => { const x = await api('GET', '/api/dm/Mira'); return x.length >= 2 && x; }, 'dm reply');
  assert.match(dm[1].text, /has lesson: true/); assert.ok(!dm[1].text.includes('<think>')); ok('worker DM answers via local model, knows its lessons');

  // H: team channel routing
  await api('POST', '/api/feed', { text: '@Theo status?' });
  await until(async () => (await api('GET', '/api/state')).feed.some((m) => m.from === 'Theo' && m.kind === 'worker' && /Sure/.test(m.text)), 'team @mention');
  ok('@mention in team channel reaches the worker');

  // I: settings validation
  await assert.rejects(api('PUT', '/api/config/raw', { text: 'workers: []' }), /at least one agent/); ok('invalid config rejected, not saved');

  // K: structured settings – add an agent with per-agent overrides
  const cfg0 = await api('GET', '/api/config'); assert.equal(cfg0.workers.length, 2); assert.equal(cfg0.workers[0].enabled, true);
  const withZed = { ...cfg0, workers: [...cfg0.workers, { name: 'Zed', role: 'QA', persona: 'blunt', enabled: true, model: 'special-model', endpoint: '', instructions: 'Be nice', timeoutMinutes: null, autoRetries: null }] };
  await api('PUT', '/api/config', { config: withZed, renames: {} });
  assert.equal((await api('GET', '/api/state')).config.workers.length, 3); assert.match(fs.readFileSync(cfgPath, 'utf8'), /Zed/); ok('add agent via settings API, persisted to YAML');
  const z = await api('POST', '/api/tasks', { title: 'Zed task', brief: 'do it', assignee: 'Zed' }); await waitFor(z.id, 'review');
  const zd = await api('GET', `/api/tasks/${z.id}`); assert.match(zd.attempts[0].report, /model=special-model/); assert.match(zd.diff.patch, /STANDING/); ok('per-agent model override and standing instructions reach the worker');
  await api('POST', '/api/dm/Zed', { text: 'yo' }); const zdm = await until(async () => { const x = await api('GET', '/api/dm/Zed'); return x.length >= 2 && x; }, 'zed dm'); assert.match(zdm[1].text, /model special-model/); ok('per-agent model is used for chat too');

  // L: rename migrates tasks, lessons and chat history
  await api('PUT', '/api/lessons/Zed', { text: '- zed lesson' });
  const cfg1 = await api('GET', '/api/config'); cfg1.workers.find((w) => w.name === 'Zed').name = 'Zoe';
  await api('PUT', '/api/config', { config: cfg1, renames: { Zoe: 'Zed' } });
  assert.equal((await api('GET', '/api/state')).tasks.find((t) => t.id === z.id).assignee, 'Zoe');
  assert.match((await api('GET', '/api/lessons/Zoe')).text, /zed lesson/); assert.ok((await api('GET', '/api/dm/Zoe')).length >= 2); ok('rename migrates tasks, lessons and chat history');

  // M: remove – refused while unfinished work exists
  const cfg2 = await api('GET', '/api/config'); cfg2.workers = cfg2.workers.filter((w) => w.name !== 'Zoe');
  await assert.rejects(api('PUT', '/api/config', { config: cfg2, renames: {} }), /unfinished task/); ok('removing an agent with unfinished tasks is refused');
  await api('POST', `/api/tasks/${z.id}/approve`, {}); await api('PUT', '/api/config', { config: cfg2, renames: {} });
  assert.equal((await api('GET', '/api/state')).config.workers.length, 2); ok('agent can be removed once its work is done');

  // N: disable
  const cfg3 = await api('GET', '/api/config'); cfg3.workers.find((w) => w.name === 'Theo').enabled = false; await api('PUT', '/api/config', { config: cfg3, renames: {} });
  await assert.rejects(api('POST', '/api/tasks', { title: 'x', brief: 'y', assignee: 'Theo' }), /disabled/);
  const auto = await api('POST', '/api/tasks', { title: 'auto', brief: 'y' }); assert.equal(auto.assignee, 'Mira'); ok('disabled agents get no tasks; auto-assign skips them');
  await api('POST', `/api/tasks/${auto.id}/cancel`, {}); cfg3.workers.find((w) => w.name === 'Theo').enabled = true; await api('PUT', '/api/config', { config: cfg3, renames: {} });

  // O: validation
  const bad = (mut) => { const c = JSON.parse(JSON.stringify(cfg3)); mut(c); return api('PUT', '/api/config', { config: c, renames: {} }); };
  await assert.rejects(bad((c) => (c.scheduler.maxParallel = 0)), /max parallel/);
  await assert.rejects(bad((c) => (c.workers[1].name = c.workers[0].name)), /duplicate/);
  await assert.rejects(bad((c) => (c.workers[0].name = 'Head')), /reserved/);
  await assert.rejects(bad((c) => (c.workers[0].timeoutMinutes = -3)), /timeout/); ok('invalid settings are rejected with clear messages');

  // P: endpoint test
  const te = await api('POST', '/api/test-endpoint', { endpoint: `http://127.0.0.1:${llmPort}/v1` }); assert.equal(te.ok, true); assert.deepEqual(te.models, ['fake-a', 'fake-b']);
  assert.equal((await api('POST', '/api/test-endpoint', { endpoint: 'http://127.0.0.1:1/v1' })).ok, false); ok('endpoint test lists models / reports unreachable');

  // J: Claude login flow (fake binary)
  assert.equal((await api('GET', '/api/auth/status')).loggedIn, false);
  await assert.rejects(api('POST', '/api/head', { text: 'hello' }), /Not logged in/); ok('head refuses to run while logged out, with a clear message');
  await api('POST', '/api/auth/login', {});
  const lg = await until(async () => { const x = (await api('GET', '/api/auth/status')).login; return x.url && x; }, 'login url');
  assert.match(lg.url, /oauth\/authorize/); ok('login starts and the authorize URL is surfaced');
  await api('POST', '/api/auth/code', { code: 'wrong' });
  await until(async () => (await api('GET', '/api/auth/status')).login.phase === 'idle', 'bad code ends login'); assert.equal((await api('GET', '/api/auth/status')).loggedIn, false); ok('wrong code does not log in');
  await api('POST', '/api/auth/login', {});
  await until(async () => (await api('GET', '/api/auth/status')).login.url, 'login url 2');
  await api('POST', '/api/auth/code', { code: 'good-code' });
  await until(async () => (await api('GET', '/api/auth/status')).loggedIn, 'logged in'); ok('correct code completes the login');
  await api('POST', '/api/auth/logout', {}); assert.equal((await api('GET', '/api/auth/status')).loggedIn, false); ok('logout works');
  await assert.rejects(api('POST', '/api/auth/code', { code: 'x' }), /no login in progress/); ok('code without a login in progress is rejected');

  // L: live activity
  const sl = await api('POST', '/api/tasks', { title: 'Slow one', brief: 'SLOWLIVE please', assignee: 'Theo' });
  const act = await until(async () => (await api('GET', '/api/state')).live.find((x) => x.id === sl.id && x.lines.length && x.files.length), 'live entry with output and files', 15000);
  assert.equal(act.worker, 'Theo'); assert.ok(act.lines.some((l) => l === 'step one'), 'ANSI stripped'); assert.ok(act.files.some((f) => f.includes('early.txt'))); ok('running agent exposes live output and changed files');
  await waitFor(sl.id, 'review'); assert.equal((await api('GET', '/api/state')).live.length, 0); ok('live entry disappears when the agent finishes');

  // R: OpenRouter-style remote agent (different endpoint + own API key)
  const remoteEp = `http://localhost:${llmPort}/v1`; // differs from the default endpoint (127.0.0.1), so it counts as "remote"
  const cfgNow = async () => (await api('GET', '/api/config')).config ?? (await api('GET', '/api/config'));
  const put = async (mut) => { const c = await api('GET', '/api/config'); mut(c); return api('PUT', '/api/config', { config: c, renames: {} }); };
  await put((c) => { const th = c.workers.find((w) => w.name === 'Theo'); th.endpoint = remoteEp; th.apiKey = 'sk-or-test'; th.model = 'vendor/model-x'; c.scheduler.maxParallel = 1; c.scheduler.maxParallelRemote = 3; });
  const full = await api('GET', '/api/config'); const thFull = full.workers.find((w) => w.name === 'Theo');
  assert.equal(thFull.apiKey, ''); assert.equal(thFull.hasKey, true);
  assert.ok(!JSON.stringify(await api('GET', '/api/state')).includes('sk-or-test')); assert.ok(!JSON.stringify(full).includes('sk-or-test')); ok('per-agent API key is stored but never sent to the browser');
  await api('POST', '/api/dm/Theo', { text: 'hi remote' });
  const dmAuth = async (re) => until(async () => { const f = await api('GET', '/api/dm/Theo'); const l = f.at(-1); return l && l.role === 'Theo' && re.test(l.text) ? l.text : false; }, 'DM reply ' + re);
  await dmAuth(/Bearer sk-or-test/); ok('chats with a remote agent use its own endpoint, model and key');
  await put(() => {}); // the UI round-trips an empty key: it must keep the saved one
  await api('POST', '/api/dm/Theo', { text: 'again' }); await until(async () => (await api('GET', '/api/dm/Theo')).filter((m) => m.role === 'Theo').length >= 2, 'second reply');
  assert.match((await api('GET', '/api/dm/Theo')).at(-1).text, /Bearer sk-or-test/); ok('saving settings without retyping the key keeps it');
  const rt = await api('POST', '/api/tasks', { title: 'Remote job', brief: 'write file', assignee: 'Theo' });
  await waitFor(rt.id, 'review');
  const rd = await api('GET', `/api/tasks/${rt.id}`); assert.match(rd.attempts[0].report, new RegExp(`model=vendor/model-x endpoint=${remoteEp.replace(/[/.]/g, '\\$&')} key=sk-or-test`)); ok('Qwen CLI gets the agent\'s endpoint, model and key via OPENAI_* env');
  await put((c) => { c.workers.find((w) => w.name === 'Theo').apiKey = 'env:CREW_TEST_KEY'; });
  const rt2 = await api('POST', '/api/tasks', { title: 'Remote job 2', brief: 'write file', assignee: 'Theo' });
  await waitFor(rt2.id, 'review'); assert.match((await api('GET', `/api/tasks/${rt2.id}`)).attempts[0].report, /key=from-env/); ok('env:NAME keys are resolved from the server environment');
  // pinned OpenRouter providers go through the Crew proxy
  await put((c) => { const th = c.workers.find((w) => w.name === 'Theo'); th.endpoint = remoteEp; th.apiKey = 'sk-or-test'; th.model = 'vendor/model-x'; th.providers = 'relace, fireworks'; th.quantization = 'fp4'; });
  await api('POST', '/api/dm/Theo', { text: 'routed' });
  await until(async () => /"order":\["relace","fireworks"\]/.test(((await api('GET', '/api/dm/Theo')).at(-1) || {}).text || ''), 'dm carries provider routing'); ok('chats send the pinned provider routing');
  const pt = await api('POST', '/api/tasks', { title: 'Pinned job', brief: 'write file PROXYCALL', assignee: 'Theo' });
  await waitFor(pt.id, 'review');
  const prep = (await api('GET', `/api/tasks/${pt.id}`)).attempts[0].report; assert.match(prep, /endpoint=http:\/\/127\.0\.0\.1:\d+\/llm-proxy\/Theo/); assert.ok(!/key=sk-or-test/.test(prep)); assert.ok(prep.includes('auth Bearer sk-or-test') && prep.includes('relace') && prep.includes('fireworks') && prep.includes('fp4') && prep.includes('allow_fallbacks')); ok('CLI is pointed at the Crew proxy, which forwards with the real key and provider routing');
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/llm-proxy/Theo/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer nope' }, body: '{}' })).status, 401); ok('proxy rejects callers without the token');
  // one local + one remote agent run at the same time even though local parallelism is 1
  const sa = await api('POST', '/api/tasks', { title: 'Slow local', brief: 'SLOWLIVE', assignee: 'Mira' });
  const sb = await api('POST', '/api/tasks', { title: 'Slow remote', brief: 'SLOWLIVE', assignee: 'Theo' });
  await until(async () => { const l = (await api('GET', '/api/state')).live; return l.some((x) => x.id === sa.id) && l.some((x) => x.id === sb.id); }, 'local and remote run together', 15000); ok('remote agents run in parallel with the local one (separate limits)');
  await waitFor(sa.id, 'review'); await waitFor(sb.id, 'review');
  await put((c) => { const th = c.workers.find((w) => w.name === 'Theo'); th.clearKey = true; th.endpoint = ''; th.model = ''; });
  assert.equal((await api('GET', '/api/config')).workers.find((w) => w.name === 'Theo').hasKey, false); ok('saved key can be removed');

  console.log(`\nALL ${pass} CHECKS PASSED`);
} catch (e) { console.error('\nFAILED:', e.message); process.exitCode = 1; }
finally { srv.kill(); llm.close(); }
