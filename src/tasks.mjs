import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config, workerByName, workerSettings } from './config.mjs';
import { allTasks, getTask, createTaskRecord, touch, pushFeed, emit, dataPath } from './store.mjs';
import * as G from './git.mjs';
import { lessonsFor, addLesson } from './lessons.mjs';

export const hooks = { attention: null }; // set by head.mjs: (task, reason) => void
const procs = new Map(); // taskId -> child
const starting = new Set();

const say = (worker, text, extra = {}) => pushFeed('feed', { from: worker, kind: 'worker', text, ...extra });
const tail = (s, n) => (s.length > n ? '…' + s.slice(-n) : s);

/* ───────────── task creation & views ───────────── */

export function createTask({ title, brief, assignee, acceptance = [], verify = '', dependsOn = [], by = 'head' }) {
  if (!title?.trim() || !brief?.trim()) throw new Error('title and brief are required');
  let w = assignee ? workerByName(assignee) : null;
  const active = config.workers.filter((x) => x.enabled);
  if (assignee && !w) throw new Error(`unknown worker "${assignee}". Workers: ${active.map((x) => x.name).join(', ')}`);
  if (w && !w.enabled) throw new Error(`worker "${w.name}" is disabled. Enabled workers: ${active.map((x) => x.name).join(', ') || '(none)'}`);
  if (!w) { // least-loaded enabled worker
    if (!active.length) throw new Error('all workers are disabled – enable one in Settings → Team');
    const load = (n) => allTasks().filter((t) => t.assignee === n && ['queued', 'running', 'blocked'].includes(t.status)).length;
    w = [...active].sort((a, b) => load(a.name) - load(b.name))[0];
  }
  for (const d of dependsOn) if (!getTask(d)) throw new Error(`dependency task #${d} does not exist`);
  const t = createTaskRecord({ title: title.trim(), brief: brief.trim(), assignee: w.name, acceptance, verify: verify.trim(), dependsOn, createdBy: by, autoRetried: 0 });
  pushFeed('feed', { from: by === 'user' ? 'You' : 'Head', kind: 'assign', taskId: t.id, text: `Assigned #${t.id} "${t.title}" to ${w.name}.` });
  setImmediate(tick);
  return t;
}

export async function taskView(t, { withDiff = false } = {}) {
  const v = { ...t };
  if (withDiff && t.branch) v.diff = await G.diffOf(t).catch((e) => ({ stat: '', patch: '', error: e.message }));
  return v;
}

export function readLog(t, attemptN, maxChars = 20000) {
  const f = dataPath('logs', `t${t.id}-a${attemptN}.log`);
  try { return tail(fs.readFileSync(f, 'utf8'), maxChars); } catch { return ''; }
}

/* ───────────── briefs ───────────── */

function buildBrief(t, worker) {
  const pending = t.feedback.filter((f) => !f.used && f.kind !== 'answer');
  const answers = t.feedback.filter((f) => f.kind === 'answer'); // decisions stay in every later brief
  const lessons = lessonsFor(worker.name);
  const last = t.attempts.at(-2); // previous attempt (current one already pushed)
  const parts = [
    `# Task #${t.id}: ${t.title}`,
    `You are **${worker.name}**, ${worker.role}.${worker.persona ? ' ' + worker.persona : ''}`,
    `You work in your own git worktree (the current directory). Only change files inside it.`,
    `## What to do\n${t.brief}`,
  ];
  if (config.project.context.trim()) parts.push(`## Project conventions\n${config.project.context.trim()}`);
  if (worker.instructions.trim()) parts.push(`## Standing instructions for you\n${worker.instructions.trim()}`);
  if (t.acceptance.length) parts.push('## Acceptance criteria\n' + t.acceptance.map((a) => `- ${a}`).join('\n'));
  if (t.verify) parts.push(`## How your work is checked\nAfter you finish, this command is run in your directory and must exit 0:\n\`\`\`\n${t.verify}\n\`\`\`\nRun it yourself before finishing and fix what fails.`);
  if (answers.length) parts.push('## Decisions already made (do not ask again)\n' + answers.map((f) => `- ${f.text}`).join('\n'));
  if (pending.length) {
    parts.push('## Feedback on your previous attempt — address ALL of it\n' + pending.map((f) => `- (${f.from}) ${f.text}`).join('\n'));
    if (last?.report) parts.push(`## What you reported last time\n${last.report}`);
  }
  if (lessons) parts.push(`## Lessons the team has learned (follow them)\n${lessons}`);
  parts.push(`## Rules
- Keep changes minimal and focused on this task. Do not refactor unrelated code.
- Do not run \`git commit\`, \`git push\`, or change branches; the system commits for you.
- When finished, write a short first-person report to \`.crew/REPORT.md\` (3–6 lines: what you did, files touched, anything you are unsure about).
- If you are blocked and need a decision, write ONE clear question to \`.crew/QUESTION.md\` and stop. Do not guess on important decisions.`);
  pending.forEach((f) => (f.used = true));
  answers.forEach((f) => (f.used = true));
  return parts.join('\n\n');
}

/* ───────────── running a worker ───────────── */

async function runAttempt(t) {
  const worker = workerByName(t.assignee);
  if (!worker) throw new Error(`worker "${t.assignee}" no longer exists in config`);
  t.status = 'running';
  const attempt = { n: t.attempts.length + 1, startedAt: Date.now() };
  t.attempts.push(attempt);
  touch(t);

  const wt = await G.ensureWorktree(t);
  if (attempt.n > 1) await G.updateFromBase(t);
  const crewDir = path.join(wt, '.crew');
  fs.mkdirSync(crewDir, { recursive: true });
  for (const f of ['REPORT.md', 'QUESTION.md']) fs.rmSync(path.join(crewDir, f), { force: true });
  fs.writeFileSync(path.join(crewDir, 'BRIEF.md'), buildBrief(t, worker));
  say(worker.name, attempt.n === 1 ? `Starting #${t.id} "${t.title}".` : `Back on #${t.id} (attempt ${attempt.n}) with the feedback.`, { taskId: t.id });

  const logPath = dataPath('logs', `t${t.id}-a${attempt.n}.log`);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const log = fs.createWriteStream(logPath);
  const prompt = 'Read the file .crew/BRIEF.md in the current directory and carry out the task described there. Follow its rules exactly.';
  const q = config.qwen;
  const eff = workerSettings(worker);
  const args = (q.args || []).map((a) => String(a).replace('{prompt}', prompt));
  const env = { ...process.env, ...Object.fromEntries(Object.entries(q.env || {}).map(([k, v]) => [k, String(v)])), CREW_TASK_ID: String(t.id), CREW_WORKER: worker.name };
  if (worker.model) env.OPENAI_MODEL = worker.model;        // per-agent overrides
  if (worker.endpoint) env.OPENAI_BASE_URL = worker.endpoint;

  const exit = await new Promise((resolve) => {
    let child;
    try { child = spawn(q.command, args, { cwd: wt, env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { log.write(`spawn failed: ${e.message}\n`); return resolve({ code: 127 }); }
    procs.set(t.id, child);
    let buf = '', timer = null;
    const flush = () => { timer = null; if (buf) { emit('task_log', { id: t.id, attempt: attempt.n, chunk: buf }); buf = ''; } };
    const onData = (d) => { log.write(d); buf += d.toString(); if (!timer) timer = setTimeout(flush, 300); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const killer = setTimeout(() => { attempt.timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000); }, eff.timeoutMinutes * 60000);
    child.on('error', (e) => { log.write(`\n[crew] process error: ${e.message}\n`); });
    child.on('close', (code, sig) => { clearTimeout(killer); flush(); resolve({ code: code ?? 1, sig }); });
  });
  procs.delete(t.id);
  log.end();
  attempt.exit = exit.code;
  attempt.endedAt = Date.now();
  if (t.status === 'cancelled') return;

  const read = (f) => { try { return fs.readFileSync(path.join(crewDir, f), 'utf8').trim(); } catch { return ''; } };
  attempt.report = read('REPORT.md');
  const question = read('QUESTION.md');

  if (question) {
    t.status = 'blocked';
    t.question = question;
    touch(t);
    say(worker.name, `Blocked on #${t.id}: ${question}`, { taskId: t.id });
    hooks.attention?.(t, 'blocked');
    return;
  }

  await G.commitAll(t, `crew: task #${t.id} ${t.title} (attempt ${attempt.n}, ${worker.name})`);
  const diff = await G.diffOf(t, { maxChars: 1 });
  const changed = diff.stat.trim().length > 0;

  if (t.verify) {
    attempt.verify = await runVerify(t.verify, wt);
  }
  const verifyOk = !t.verify || attempt.verify.code === 0;
  const ok = exit.code === 0 && verifyOk && changed;

  if (ok) {
    t.status = 'review';
    touch(t);
    say(worker.name, `Done with #${t.id}.${attempt.report ? '\n' + attempt.report : ''}${t.verify ? '\n✔ check passed' : ''}`, { taskId: t.id });
    hooks.attention?.(t, 'review');
    return;
  }

  const why = exit.code !== 0
    ? (attempt.timedOut ? `the worker timed out after ${eff.timeoutMinutes} min` : `the worker exited with code ${exit.code}`)
    : !changed ? 'no changes were made to the code'
    : `the check command failed (exit ${attempt.verify.code})`;
  const detail = attempt.verify && !verifyOk ? `\nOutput of \`${t.verify}\`:\n${tail(attempt.verify.output, 2500)}` : '';
  const canRetry = t.autoRetried < eff.autoRetries && t.attempts.length < config.scheduler.maxAttempts;
  if (canRetry) {
    t.autoRetried++;
    t.feedback.push({ from: 'checks', text: `Your last attempt was not accepted: ${why}.${detail}`, attempt: attempt.n });
    t.status = 'queued';
    touch(t);
    say(worker.name, `#${t.id} didn't pass (${why}). Trying again on my own.`, { taskId: t.id });
    setImmediate(tick);
  } else {
    t.status = 'needs_attention';
    t.problem = `${why}.${detail}`;
    touch(t);
    say(worker.name, `I'm stuck on #${t.id}: ${why}. Needs the head's attention.`, { taskId: t.id });
    hooks.attention?.(t, 'needs_attention');
  }
}

function runVerify(cmd, cwd) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', cmd], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const add = (d) => { out += d.toString(); if (out.length > 200000) out = out.slice(-100000); };
    child.stdout.on('data', add); child.stderr.on('data', add);
    const to = setTimeout(() => child.kill('SIGKILL'), 10 * 60000);
    child.on('close', (code) => { clearTimeout(to); resolve({ cmd, code: code ?? 1, output: tail(out, 20000) }); });
    child.on('error', (e) => { clearTimeout(to); resolve({ cmd, code: 127, output: e.message }); });
  });
}

/* ───────────── scheduler ───────────── */

export function tick() {
  const running = allTasks().filter((t) => t.status === 'running').length + starting.size;
  let slots = config.scheduler.maxParallel - running;
  if (slots <= 0) return;
  const busy = new Set(allTasks().filter((t) => t.status === 'running').map((t) => t.assignee));
  for (const t of allTasks().filter((x) => x.status === 'queued').sort((a, b) => a.id - b.id)) {
    if (slots <= 0) break;
    if (!workerByName(t.assignee)?.enabled) continue; // disabled or removed: task waits
    if (busy.has(t.assignee) || starting.has(t.id)) continue;
    if (!t.dependsOn.every((d) => getTask(d)?.status === 'done')) continue;
    slots--; busy.add(t.assignee); starting.add(t.id);
    runAttempt(t)
      .catch((e) => {
        t.status = 'needs_attention';
        t.problem = `internal error: ${e.message}`;
        touch(t);
        say(t.assignee, `Couldn't run #${t.id}: ${e.message}`, { taskId: t.id });
        hooks.attention?.(t, 'needs_attention');
      })
      .finally(() => { starting.delete(t.id); setImmediate(tick); });
  }
}
export function startScheduler() {
  // tasks left "running" by a crash go back to the queue
  for (const t of allTasks()) if (t.status === 'running') { t.status = 'queued'; touch(t); }
  setInterval(tick, 1500);
}

/* ───────────── decisions (head or user) ───────────── */

const need = (id) => { const t = getTask(id); if (!t) throw new Error(`no task #${id}`); return t; };

export async function approveTask(id, { note = '', by = 'head', force = false } = {}) {
  const t = need(id);
  if (t.status !== 'review' && !(force && t.status === 'needs_attention')) throw new Error(`task #${id} is "${t.status}", only tasks in "review" can be approved`);
  await G.mergeTask(t, `Merge task #${t.id}: ${t.title}`);
  t.status = 'done';
  t.approvedBy = by;
  t.approvalNote = note;
  touch(t);
  say(t.assignee, `#${t.id} merged into ${config.project.baseBranch}.${note ? ' ' + note : ''}`, { taskId: t.id });
  setImmediate(tick);
  return t;
}

export async function rejectTask(id, { feedback, lesson = '', by = 'head' }) {
  const t = need(id);
  if (!['review', 'needs_attention'].includes(t.status)) throw new Error(`task #${id} is "${t.status}", only "review" or "needs_attention" tasks can be rejected`);
  if (!feedback?.trim()) throw new Error('feedback is required');
  if (t.attempts.length >= config.scheduler.maxAttempts) throw new Error(`task #${id} used all ${config.scheduler.maxAttempts} attempts. Cancel it and create a new, better-specified task (or ask the user to raise scheduler.maxAttempts).`);
  t.feedback.push({ from: by, text: feedback.trim(), attempt: t.attempts.length });
  t.autoRetried = 0;
  t.problem = '';
  t.status = 'queued';
  if (lesson?.trim()) addLesson(t.assignee, lesson, t.id);
  touch(t);
  pushFeed('feed', { from: by === 'user' ? 'You' : 'Head', kind: 'review', taskId: t.id, text: `Sent #${t.id} back to ${t.assignee}: ${feedback.trim()}` });
  setImmediate(tick);
  return t;
}

export function answerTask(id, answer, by = 'head') {
  const t = need(id);
  if (t.status !== 'blocked') throw new Error(`task #${id} is "${t.status}", not blocked`);
  t.feedback.push({ from: by, kind: 'answer', text: `Answer to your question ("${t.question}"): ${answer.trim()}`, attempt: t.attempts.length });
  t.question = '';
  t.status = 'queued';
  touch(t);
  pushFeed('feed', { from: by === 'user' ? 'You' : 'Head', kind: 'answer', taskId: t.id, text: `@${t.assignee} on #${t.id}: ${answer.trim()}` });
  setImmediate(tick);
  return t;
}

export async function cancelTask(id, by = 'head') {
  const t = need(id);
  if (['done', 'cancelled'].includes(t.status)) throw new Error(`task #${id} is already ${t.status}`);
  t.status = 'cancelled';
  procs.get(t.id)?.kill('SIGTERM');
  touch(t);
  await G.cleanup(t).catch(() => {});
  pushFeed('feed', { from: by === 'user' ? 'You' : 'Head', kind: 'cancel', taskId: t.id, text: `Cancelled #${t.id}.` });
  return t;
}

export async function retryTask(id) {
  const t = need(id);
  if (!['needs_attention', 'cancelled'].includes(t.status)) throw new Error(`task #${id} is "${t.status}"`);
  if (t.status === 'cancelled') { t.branch = ''; t.worktree = ''; t.attempts = []; t.feedback = []; }
  t.autoRetried = 0; t.problem = ''; t.status = 'queued';
  touch(t);
  setImmediate(tick);
  return t;
}
