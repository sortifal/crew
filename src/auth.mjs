import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT } from './config.mjs';
import { emit } from './store.mjs';

/** Locate the Claude Code binary: CLAUDE_BIN, the one bundled with the Agent SDK, or `claude` on PATH. */
export function claudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const scope = path.join(ROOT, 'node_modules', '@anthropic-ai');
  try {
    const want = `claude-agent-sdk-${process.platform}-${process.arch}`;
    const dirs = fs.readdirSync(scope).filter((d) => d.startsWith(want)).sort((a, b) => a.length - b.length);
    for (const d of dirs) for (const f of ['claude', 'claude.exe']) { const p = path.join(scope, d, f); if (fs.existsSync(p)) return p; }
  } catch { /* fall through */ }
  return 'claude';
}

const run = (args, timeoutMs = 15000) => new Promise((resolve) => {
  let out = '';
  let child;
  try { child = spawn(claudeBin(), args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return resolve({ code: 127, out: e.message }); }
  child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
  const to = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  child.on('error', (e) => { clearTimeout(to); resolve({ code: 127, out: e.message }); });
  child.on('close', (code) => { clearTimeout(to); resolve({ code: code ?? 1, out }); });
});

export async function authStatus() {
  if (process.env.ANTHROPIC_API_KEY) return { loggedIn: true, method: 'ANTHROPIC_API_KEY (environment)' };
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return { loggedIn: true, method: 'CLAUDE_CODE_OAUTH_TOKEN (environment)' };
  const r = await run(['auth', 'status']);
  try {
    const j = JSON.parse(r.out);
    return { loggedIn: !!j.loggedIn, method: j.authMethod && j.authMethod !== 'none' ? j.authMethod : '', email: j.email || j.account?.email || '', expiresAt: j.loginExpiresAt || null };
  } catch {
    return { loggedIn: false, method: '', error: r.code === 127 ? `Claude Code binary not found (${r.out.trim()})` : r.out.trim().slice(0, 300) };
  }
}

/* ── interactive login: `claude auth login` prints a URL, then waits for the code pasted on stdin ── */
let login = null; // { child, url, buf, timer }
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const phase = (p, extra = {}) => emit('auth', { phase: p, ...extra });
export const loginState = () => (login ? { phase: login.url ? 'url' : 'starting', url: login.url || '' } : { phase: 'idle' });

export function startLogin({ console: useConsole = false } = {}) {
  cancelLogin();
  const args = ['auth', 'login', ...(useConsole ? ['--console'] : [])];
  const child = spawn(claudeBin(), args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, BROWSER: 'true' } });
  const st = (login = { child, url: '', buf: '', timer: null });
  phase('starting');
  const onData = (d) => {
    st.buf = (st.buf + d.toString()).replace(ANSI, '').slice(-8000);
    if (!st.url) {
      const m = st.buf.match(/https:\/\/[^\s]*oauth\/authorize[^\s]*/);
      if (m) { st.url = m[0]; phase('url', { url: st.url }); }
    }
  };
  child.stdout.on('data', onData); child.stderr.on('data', onData);
  child.stdin.on('error', () => {});
  st.timer = setTimeout(() => { phase('failed', { message: 'Login timed out after 10 minutes.' }); cancelLogin(); }, 10 * 60000);
  child.on('error', (e) => { if (login === st) { login = null; clearTimeout(st.timer); phase('failed', { message: `Cannot start Claude Code: ${e.message}` }); } });
  child.on('close', async (code) => {
    clearTimeout(st.timer); clearTimeout(st.verifyTimer);
    if (login !== st) return; // cancelled or replaced
    login = null;
    const status = await authStatus();
    if (code === 0 && status.loggedIn) phase('done', { status });
    else {
      const last = st.buf.split('\n').map((l) => l.trim()).filter(Boolean).filter((l) => !/^Paste code here/.test(l)).slice(-2).join(' ');
      phase('failed', { message: last || `Login exited with code ${code}` });
    }
  });
  return loginState();
}

export function submitCode(code) {
  if (!login) throw new Error('no login in progress – start again');
  if (!login.url) throw new Error('the login link is not ready yet');
  const c = String(code || '').trim();
  if (!c) throw new Error('paste the code shown after you authorised in the browser');
  login.child.stdin.write(c + '\n');
  phase('verifying');
  const st = login;
  clearTimeout(st.verifyTimer);
  st.verifyTimer = setTimeout(() => { if (login === st) { phase('failed', { message: 'Verifying the code took too long. Check that this machine can reach claude.ai, then try again.' }); cancelLogin(); phase('failed', { message: 'Verifying the code took too long. Check that this machine can reach claude.ai, then try again.' }); } }, 60000);
}

export function cancelLogin() {
  if (!login) return;
  const st = login; login = null;
  clearTimeout(st.timer); clearTimeout(st.verifyTimer);
  st.child.kill('SIGTERM');
  phase('idle');
}

export async function logout() {
  cancelLogin();
  await run(['auth', 'logout']);
  return authStatus();
}
