// Unit checks for the Head's token-saving logic (no model calls).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-head-'));
const cfg = path.join(tmp, 'c.yaml');
fs.writeFileSync(cfg, `project: { name: T, repo: ${tmp}, baseBranch: main }\nhead: { model: opus, maxContextTokens: 20000 }\nworkers:\n  - { name: Mira, role: Backend }\ndataDir: ${path.join(tmp, 'data')}\n`);
process.env.CREW_CONFIG = cfg;
const { loadConfig, config } = await import('../src/config.mjs');
loadConfig();
const store = await import('../src/store.mjs');
const { __test: H } = await import('../src/head.mjs');
const ok = (m) => console.log('  ✔ ' + m);

const sys1 = H.buildSystem();
let p = H.preparePrompt('hello');
assert.match(p, /^\[board\]\n\(no open tasks\)/); assert.ok(p.endsWith('hello')); ok('first turn includes the board');
p = H.preparePrompt('again'); assert.equal(p, 'again'); ok('unchanged board is not repeated');
store.createTaskRecord({ title: 'Do X', brief: 'b', assignee: 'Mira' });
p = H.preparePrompt('next'); assert.match(p, /\[board\]\n#1 \[queued\] Do X → Mira/); ok('changed board is sent again');
assert.equal(H.buildSystem(), sys1); ok('system prompt is identical whatever the board says (keeps the prompt cache valid)');

store.pushFeed('head-chat', { role: 'user', text: 'build a thing' }, 'head_message');
store.pushFeed('head-chat', { role: 'head', text: 'on it' }, 'head_message');
H.setSession({ id: 'abc', costUsd: 1, context: 15000, lastBoard: H.getSession().lastBoard });
assert.ok(!/reset/.test(H.preparePrompt('small')));
assert.equal(H.getSession().id, 'abc'); ok('below the limit the session is kept');
H.setSession({ id: 'abc', costUsd: 1, context: 25000, lastBoard: H.getSession().lastBoard });
p = H.preparePrompt('big');
assert.match(p, /context was reset/); assert.match(p, /Owner: build a thing/); assert.match(p, /You: on it/); assert.match(p, /\[board\]/);
assert.equal(H.getSession().id, null); assert.equal(H.getSession().costUsd, 1);
assert.ok(store.getFeed('head-chat').some((m) => m.role === 'system' && /Context reset/.test(m.text))); ok('above the limit the session restarts with a handoff and tells the user');
config.head.maxContextTokens = 0;
H.setSession({ id: 'abc', costUsd: 0, context: 900000 }); H.preparePrompt('x'); assert.equal(H.getSession().id, 'abc'); ok('limit 0 disables the reset');
console.log('\nHEAD CHECKS PASSED');
process.exit(0);
