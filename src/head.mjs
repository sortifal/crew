import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { config, workerByName } from './config.mjs';
import { allTasks, getTask, getFeed, pushFeed, emit, load, save } from './store.mjs';
import { record as recordUsage, addCost } from './usage.mjs';
import * as T from './tasks.mjs';
import { addLesson, validScope } from './lessons.mjs';
import { diffOf } from './git.mjs';

const CHAT = 'head-chat';
let busy = false;
let abort = null;
let queue = Promise.resolve();
let session = load('head-session.json', { id: null, costUsd: 0 });
export const headState = () => ({ busy, costUsd: session.costUsd, hasSession: !!session.id, context: session.id ? session.context || 0 : 0, maxContext: config.head.maxContextTokens });

const ok = (text) => ({ content: [{ type: 'text', text: typeof text === 'string' ? text : JSON.stringify(text, null, 2) }] });
const fail = (e) => ({ content: [{ type: 'text', text: `Error: ${e.message || e}` }], isError: true });
const wrap = (fn) => async (args) => { try { return ok(await fn(args)); } catch (e) { return fail(e); } };

const summary = (t) => ({ id: t.id, title: t.title, assignee: t.assignee, status: t.status, attempts: t.attempts.length, dependsOn: t.dependsOn, ...(t.question ? { question: t.question } : {}), ...(t.problem ? { problem: t.problem } : {}) });

function buildTools() {
  return [
    tool('create_task', 'Create a task and assign it to a developer. The brief must be self-contained (files, current vs desired behaviour, constraints). Include a verify command whenever one exists.',
      { title: z.string(), brief: z.string(), assignee: z.string().optional().describe('worker name; omit to pick the least busy'), acceptance: z.array(z.string()).optional(), verify: z.string().optional().describe('shell command run in the worktree, must exit 0 (tests/lint/build)'), depends_on: z.array(z.number()).optional().describe('task ids that must be merged first') },
      wrap(async (a) => summary(T.createTask({ title: a.title, brief: a.brief, assignee: a.assignee, acceptance: a.acceptance || [], verify: a.verify || '', dependsOn: a.depends_on || [], by: 'head' })))),
    tool('list_tasks', 'List tasks on the board, optionally filtered by status (queued, running, blocked, review, needs_attention, done, cancelled).',
      { status: z.string().optional() },
      wrap(async ({ status }) => allTasks().filter((t) => !status || t.status === status).map(summary)), { annotations: { readOnlyHint: true } }),
    tool('get_task', 'Detail of one task: brief, latest attempts, worker report, check output, and optionally the diff (capped at ~14k characters; the stat shows what was cut). Only ask for the diff when you are about to decide.',
      { id: z.number(), include_diff: z.boolean().optional(), include_log_tail: z.boolean().optional() },
      wrap(async ({ id, include_diff, include_log_tail }) => {
        const t = getTask(id); if (!t) throw new Error(`no task #${id}`);
        // Everything returned here stays in the conversation, so keep it lean: full detail for the latest attempt only
        const cut = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s);
        const lastN = t.attempts.length;
        const out = { ...summary(t), brief: t.brief, acceptance: t.acceptance, verify: t.verify, feedbackHistory: t.feedback.slice(-3).map((f) => ({ ...f, text: cut(f.text, 800) })), attempts: t.attempts.slice(-3).map((a) => ({ n: a.n, exit: a.exit, report: cut(a.report, a.n === lastN ? 3000 : 400), verify: a.verify && { code: a.verify.code, output: a.verify.output.slice(a.n === lastN ? -1500 : -300) } })) };
        if (t.feedback.length > 3 || lastN > 3) out.note = 'older feedback/attempts omitted';
        if (include_diff && t.branch) { const d = await diffOf(t, { maxChars: 14000 }); out.diffStat = d.stat; out.diff = d.patch + (d.truncated ? '\n…(truncated)' : ''); }
        if (include_log_tail) out.logTail = T.readLog(t, t.attempts.length, 2000);
        return out;
      }), { annotations: { readOnlyHint: true } }),
    tool('approve_task', 'Approve a task in "review": merges its branch into the base branch.',
      { id: z.number(), note: z.string().optional() },
      wrap(async ({ id, note }) => summary(await T.approveTask(id, { note, by: 'head' })))),
    tool('reject_task', 'Send a task back to its developer with concrete feedback. If the mistake is likely to repeat, also pass a short imperative lesson so the developer learns it.',
      { id: z.number(), feedback: z.string(), lesson: z.string().optional() },
      wrap(async ({ id, feedback, lesson }) => summary(await T.rejectTask(id, { feedback, lesson, by: 'head' })))),
    tool('answer_question', 'Answer the question of a blocked developer; the task is re-queued.',
      { id: z.number(), answer: z.string() },
      wrap(async ({ id, answer }) => summary(T.answerTask(id, answer, 'head')))),
    tool('cancel_task', 'Cancel a task and discard its work.', { id: z.number() },
      wrap(async ({ id }) => summary(await T.cancelTask(id, 'head')))),
    tool('add_lesson', 'Record a reusable lesson. scope = a developer name (personal habit) or "project" (convention/gotcha for everyone). One short, imperative, specific sentence. It is injected into every future brief.',
      { scope: z.string(), lesson: z.string() },
      wrap(async ({ scope, lesson }) => { if (!validScope(scope)) throw new Error(`unknown scope "${scope}"`); return addLesson(scope, lesson) ? 'saved' : 'already known'; })),
    tool('post_to_team', 'Say something in the team channel (visible to the user and developers). Use sparingly.',
      { text: z.string() },
      wrap(async ({ text }) => { pushFeed('feed', { from: 'Head', kind: 'head', text }); return 'posted'; })),
  ];
}

function buildSystem() {
  const workers = config.workers.map((w) => `- ${w.name} — ${w.role}${w.persona ? ` (${w.persona})` : ''}${w.enabled ? '' : ' [DISABLED – do not assign]'}`).join('\n');
  return `You are Head, the project lead of "${config.project.name}". You talk with the user (the owner) and run a small team of developers.

## Your team
${workers}
The developers run on a smaller local model. They are capable but literal, can drift or fake success, and need precise, self-contained instructions. You never write code yourself: you plan, delegate, review and coach. You may read the repository (Read/Glob/Grep) to understand it before planning.

## How you work
- Before creating tasks for a vague request, ask the user at most a few sharp questions. Otherwise act.
- Split work into small tasks, one concern each, that a developer can finish in one sitting. Use depends_on when order matters. Spread independent tasks across developers.
- Every brief must be self-contained: exact file paths, current vs desired behaviour, constraints, examples. Always give a verify command (tests/lint/build) when the project has one; developers run it and retry automatically before bothering you.
- Review with get_task(include_diff=true). Check the diff against the brief and acceptance criteria and the project's conventions. Approve only what you have actually looked at. Never approve a task in needs_attention without understanding why it failed. If it is not right, reject_task with specific, actionable feedback.
- Coaching: when a rejection or a stuck task shows a mistake that will likely repeat, record it with add_lesson (scope = the developer's name for personal habits, "project" for conventions and gotchas). Lessons are one short imperative sentence, concrete ("When adding an endpoint, also register it in routes.ts"). No trivia, no duplicates.
- Messages starting with [system] are automatic notifications about the board, not the user. Handle them (review, answer, re-plan), then briefly tell the user what you did.
- Talk to the user concisely and plainly. Say what is happening and what you need from them, if anything.
- Be economical: every message and tool result stays in your context. Each message starts with a [board] summary when the board changed, so do not call list_tasks to see it. Ask for diffs only when you are about to decide. After a [system] notification, act and then answer in one or two sentences. Never restate briefs, diffs or reports you already saw.

${config.project.context.trim() ? `## Project conventions (from the owner)\n${config.project.context.trim()}\n\n` : ''}${config.head.instructions.trim() ? `## Extra instructions from the owner\n${config.head.instructions.trim()}\n` : ''}`;
}

export function sendToHead(text, from = 'user') {
  pushFeed(CHAT, { role: from === 'user' ? 'user' : 'system', text }, 'head_message');
  queue = queue.then(() => runTurn(text)).catch(() => {});
}

export function stopHead() { abort?.abort(); }

export function resetHead() {
  stopHead();
  session = { id: null, costUsd: session.costUsd, context: 0 };
  save('head-session.json', session);
  emit('head_state', headState());
}

const fmtK = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
/** The board, kept out of the system prompt so that prompt (and the prompt cache behind it) stays identical between turns. */
function boardDigest() {
  const open = allTasks().filter((t) => !['done', 'cancelled'].includes(t.status));
  const done = allTasks().length - open.length;
  const lines = open.slice(0, 30).map((t) => `#${t.id} [${t.status}] ${t.title} → ${t.assignee}`);
  if (open.length > 30) lines.push(`…and ${open.length - 30} more (list_tasks)`);
  return `${lines.join('\n') || '(no open tasks)'}${done ? `\n(${done} finished or cancelled)` : ''}`;
}
const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);
const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);

/** Builds the prompt for this turn: board summary when it changed, plus a short handoff when the context was just reset. */
function preparePrompt(text) {
  let prefix = '';
  const limit = config.head.maxContextTokens;
  if (session.id && limit && (session.context || 0) > limit) {
    const recent = getFeed(CHAT, 12).filter((m) => m.role === 'user' || m.role === 'head').slice(-6).map((m) => `${m.role === 'user' ? 'Owner' : 'You'}: ${clip(m.text, 500)}`);
    const n = session.context;
    session = { ...session, id: null, lastBoard: null, context: 0 }; save('head-session.json', session);
    pushFeed(CHAT, { role: 'system', text: `Context reset to save tokens (it had grown to ${fmtK(n)}). The board and the last messages were carried over.` }, 'head_message');
    prefix += `[context was reset to save tokens; the conversation so far, newest last]\n${recent.join('\n') || '(nothing yet)'}\n\n`;
  }
  const board = boardDigest(), bh = hash(board);
  if (bh !== session.lastBoard) { prefix += `[board]\n${board}\n\n`; session.lastBoard = bh; save('head-session.json', session); }
  return prefix + text;
}

async function runTurn(text) {
  busy = true; emit('head_state', headState());
  abort = new AbortController();
  const server = createSdkMcpServer({ name: 'crew', version: '1.0.0', tools: buildTools() });
  const names = ['create_task', 'list_tasks', 'get_task', 'approve_task', 'reject_task', 'answer_question', 'cancel_task', 'add_lesson', 'post_to_team'];
  const base = {
    model: config.head.model, systemPrompt: buildSystem(), cwd: config.project.repo,
    tools: ['Read', 'Glob', 'Grep'], mcpServers: { crew: server },
    allowedTools: ['Read', 'Glob', 'Grep', ...names.map((n) => `mcp__crew__${n}`)],
    includePartialMessages: true, abortController: abort, maxTurns: 40, settingSources: ['project'],
    ...(config.head.effort ? { effort: config.head.effort } : {}),
  };
  text = preparePrompt(text);
  try {
    try { await consume(text, { ...base, ...(session.id ? { resume: session.id } : {}) }); }
    catch (e) {
      if (session.id && !abort.signal.aborted && /session|resume|conversation/i.test(String(e.message))) {
        session.id = null; await consume(text, base);
      } else throw e;
    }
  } catch (e) {
    if (!abort.signal.aborted) {
      const hint = /auth|api key|login/i.test(String(e.message)) ? ' — use “Log in” in the top bar (or set ANTHROPIC_API_KEY).' : '';
      pushFeed(CHAT, { role: 'error', text: `Head error: ${e.message}${hint}` }, 'head_message');
    }
  } finally {
    busy = false; abort = null; emit('head_state', headState());
  }
}

async function consume(prompt, options) {
  let cur = null; // the model request being streamed right now
  for await (const m of query({ prompt, options })) {
    if (m.session_id && m.session_id !== session.id) { session.id = m.session_id; save('head-session.json', session); }
    if (m.type === 'stream_event' && !m.parent_tool_use_id) {
      const ev = m.event;
      if (ev.type === 'message_start') { const u = ev.message?.usage || {}; cur = { t0: Date.now(), model: ev.message?.model || config.head.model, cached: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), output: 0 }; }
      else if (ev.type === 'message_delta' && cur && ev.usage?.output_tokens != null) cur.output = ev.usage.output_tokens;
      else if (ev.type === 'message_stop' && cur) {
        const ms = Date.now() - cur.t0;
        recordUsage({ who: 'Head', kind: 'head', ...cur, ms, tps: ms > 500 && cur.output ? +(cur.output / (ms / 1000)).toFixed(1) : 0 });
        session.context = cur.input; save('head-session.json', session); emit('head_state', headState()); cur = null;
      }
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') emit('head_delta', { text: ev.delta.text });
    } else if (m.type === 'assistant' && !m.parent_tool_use_id) {
      for (const b of m.message.content || []) {
        if (b.type === 'text' && b.text.trim()) pushFeed(CHAT, { role: 'head', text: b.text }, 'head_message');
        else if (b.type === 'tool_use') pushFeed(CHAT, { role: 'tool', text: `${b.name.replace(/^mcp__crew__/, '')} ${compact(b.input)}` }, 'head_message');
      }
    } else if (m.type === 'result') {
      if (typeof m.total_cost_usd === 'number') { session.costUsd = (session.costUsd || 0) + m.total_cost_usd; save('head-session.json', session); addCost('Head', m.total_cost_usd); }
      if (m.subtype && m.subtype !== 'success') pushFeed(CHAT, { role: 'error', text: `Head stopped: ${m.subtype}` }, 'head_message');
    }
  }
}
const compact = (o) => { const s = JSON.stringify(o); return s.length > 160 ? s.slice(0, 157) + '…' : s; };

/* ── automatic wake-ups ── */
const notes = new Map();
let timer = null;
T.hooks.attention = (t, reason) => {
  if (!config.head.autoReview) return;
  notes.set(t.id, reason);
  clearTimeout(timer);
  timer = setTimeout(() => {
    const lines = [...notes].filter(([id, r]) => getTask(id)?.status === r).map(([id, r]) => `- #${id} "${getTask(id).title}" (${getTask(id).assignee}): ${({ review: 'ready for review', blocked: 'blocked, has a question', needs_attention: 'failed after retries' })[r]}`);
    notes.clear();
    if (lines.length) sendToHead(`[system] The board needs you:\n${lines.join('\n')}`, 'system');
  }, Math.max(0, config.head.wakeDelaySeconds) * 1000);
};

export { workerByName };

export const __test = { preparePrompt, buildSystem, getSession: () => session, setSession: (s) => { session = s; } };
