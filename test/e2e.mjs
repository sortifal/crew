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
const llm = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { const j = JSON.parse(b); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: `<think>x</think>Sure. (sys has lesson: ${j.messages[0].content.includes('mock-lesson-marker')})` } }] })); }); });
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
const env = { ...process.env, CREW_CONFIG: cfgPath, PORT: String(PORT), CLAUDE_BIN: path.resolve('examples/fake-claude.sh'), FAKE_STATE: path.join(tmp, 'fake-login') };
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
  await assert.rejects(api('PUT', '/api/config/raw', { text: 'workers: []' }), /at least one worker/); ok('invalid config rejected, not saved');

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

  console.log(`\nALL ${pass} CHECKS PASSED`);
} catch (e) { console.error('\nFAILED:', e.message); process.exitCode = 1; }
finally { srv.kill(); llm.close(); }
