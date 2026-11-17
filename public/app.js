const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const api = async (method, url, body) => {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};

/* ───────── icons (stroke, 24px grid) ───────── */
const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>', up: '<path d="M12 19V5M5 12l7-7 7 7"/>', square: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3L21 2M16 7l3 3M14 9l2 2"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 016.5 17H20V3H6.5A2.5 2.5 0 004 5.5v14z"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>', copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 012-2h9"/>',
  tool: '<path d="M14.7 6.3a4 4 0 005 5L21 13l-8 8a2.8 2.8 0 01-4-4l8-8z"/>', check: '<path d="M20 6L9 17l-5-5"/>',
};
const ic = (n) => `<i data-i="${n}"><svg viewBox="0 0 24 24">${ICONS[n] || ''}</svg></i>`;
const hydrateIcons = (root = document) => root.querySelectorAll('i[data-i]:empty').forEach((el) => (el.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[el.dataset.i] || ''}</svg>`));

/* ───────── theme ───────── */
function applyTheme(t) {
  document.documentElement.className = t; try { localStorage.setItem('crew-theme', t); } catch { /* private mode */ }
  const b = $('#btnTheme'); b.querySelector('i').dataset.i = t === 'dark' ? 'sun' : 'moon'; b.querySelector('i').innerHTML = `<svg viewBox="0 0 24 24">${ICONS[t === 'dark' ? 'sun' : 'moon']}</svg>`;
  $('#themeLabel').textContent = t === 'dark' ? 'Light mode' : 'Dark mode';
}
$('#btnTheme').onclick = () => applyTheme(document.documentElement.classList.contains('dark') ? 'light' : 'dark');

/* ───────── helpers ───────── */
const hue = (name) => [...name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
const avatar = (name, size = 22) => name === 'Head'
  ? `<div class="avatar" style="width:${size}px;height:${size}px;background:var(--accent-tint);color:var(--accent-ink)">H</div>`
  : `<div class="avatar" style="width:${size}px;height:${size}px;background:oklch(78% .11 ${hue(name)})">${esc(name[0].toUpperCase())}</div>`;
const nameColor = (n) => `oklch(72% .13 ${hue(n)})`;
function md(s) {
  let t = esc(s);
  t = t.replace(/```(?:\w+)?\n([\s\S]*?)```/g, (_, c) => `<pre>${c}</pre>`);
  return t.replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
}
const STATUS = { queued: 'Queued', running: 'Running', review: 'Review', blocked: 'Blocked', needs_attention: 'Needs attention', done: 'Done', cancelled: 'Cancelled' };
const badge = (st) => `<span class="badge ${st}">${STATUS[st] || st}</span>`;

const S = { auth: null, authPhase: { phase: 'idle' }, config: null, tasks: new Map(), feeds: { team: [], head: [], dm: {} }, tab: 'head', unread: {}, selected: null, detail: null, live: '', headBusy: false, busySince: 0 };

/* ───────── rendering ───────── */
function renderHeader() {
  $('#project').textContent = S.config?.project.name || '';
  const p = $('#headState');
  p.className = 'badge' + (S.headBusy ? ' accent' : '');
  p.innerHTML = S.headBusy ? '<span class="dot live"></span>Head is working' : 'Head idle';
  if (S.cost != null) p.title = `Opus spend (all sessions): $${S.cost.toFixed(2)}`;
  const lb = $('#btnLogin'), ok = !S.auth || S.auth.loggedIn;
  $('#loginLabel').textContent = S.auth ? (ok ? 'Claude · signed in' : 'Log in to Claude') : 'Claude';
  lb.classList.toggle('warn', !ok);
  lb.title = ok ? `Signed in: ${S.auth?.method || ''}${S.auth?.email ? ' · ' + S.auth.email : ''}` : 'The Head (Opus) needs a Claude login or API key';
  $('#stop').hidden = !(S.headBusy && S.tab === 'head');
  const b = $('#banner');
  b.hidden = !(S.repoError || (S.auth && !S.auth.loggedIn));
  b.textContent = S.repoError ? `Project repo problem: ${S.repoError} — open Settings to fix.` : 'Not signed in to Claude — click here to log in.';
  b.onclick = () => (S.repoError ? $('#btnSettings').click() : $('#btnLogin').click());
}

function workerStatus(name) {
  const mine = [...S.tasks.values()].filter((t) => t.assignee === name);
  const run = mine.find((t) => t.status === 'running'); if (run) return { cls: 'running', text: `#${run.id} ${run.title}` };
  const bl = mine.find((t) => t.status === 'blocked'); if (bl) return { cls: 'blocked', text: `Blocked on #${bl.id}` };
  const q = mine.filter((t) => t.status === 'queued').length; if (q) return { cls: '', text: `${q} queued` };
  const rv = mine.find((t) => t.status === 'review'); if (rv) return { cls: 'review', text: `Awaiting review #${rv.id}` };
  return { cls: '', text: 'Idle' };
}

function renderRoster() {
  const el = $('#roster'); el.innerHTML = '';
  const people = [{ name: 'Head', tab: 'head', st: { cls: S.headBusy ? 'live' : '', text: S.headBusy ? 'Working…' : 'Opus · project lead' } }, ...S.config.workers.map((w) => ({ name: w.name, tab: 'dm:' + w.name, st: workerStatus(w.name), role: w.role }))];
  for (const p of people) {
    const d = document.createElement('div'); d.className = 'person' + (S.tab === p.tab ? ' sel' : '');
    d.innerHTML = `${avatar(p.name)}<div style="min-width:0;flex:1"><div class="nm">${esc(p.name)}</div><div class="sub">${esc(p.st.text)}</div></div><span class="dot ${p.st.cls}"></span>`;
    d.title = p.role || 'Project head';
    d.onclick = () => openTab(p.tab);
    el.appendChild(d);
  }
}

function renderBoard() {
  const el = $('#board'); el.innerHTML = '';
  const order = ['needs_attention', 'blocked', 'review', 'running', 'queued', 'done', 'cancelled'];
  const list = [...S.tasks.values()].filter((t) => t.status !== 'cancelled').sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || b.id - a.id).slice(0, 80);
  if (!list.length) el.innerHTML = '<div class="muted" style="font-size:12px;padding:4px 8px">No tasks yet. Ask the Head to plan something.</div>';
  for (const t of list) {
    const d = document.createElement('div'); d.className = 'trow' + (S.selected === t.id ? ' sel' : '');
    d.innerHTML = `<span class="dot ${t.status}"></span><div style="flex:1"><div class="t">${esc(t.title)}</div><div class="meta"><span class="mono">#${t.id}</span>${esc(t.assignee)}${t.attempts.length > 1 ? ` · try ${t.attempts.length}` : ''}</div></div>${['review', 'blocked', 'needs_attention'].includes(t.status) ? badge(t.status) : ''}`;
    d.onclick = () => selectTask(t.id);
    el.appendChild(d);
  }
}

function renderTabs() {
  const el = $('#tabs'); el.innerHTML = '';
  const tabs = [['head', 'Head'], ['team', 'Team'], ...S.config.workers.map((w) => ['dm:' + w.name, w.name])];
  for (const [id, label] of tabs) {
    const b = document.createElement('button'); b.className = S.tab === id ? 'on' : '';
    b.innerHTML = esc(label) + (S.unread[id] ? `<span class="count">${S.unread[id]}</span>` : '');
    b.onclick = () => openTab(id); el.appendChild(b);
  }
}

const who = (name, ref) => `<div class="who">${avatar(name, 18)}<span style="color:${name === 'Head' ? 'var(--accent-ink)' : nameColor(name)}">${esc(name)}</span>${ref ? `<span class="ref">${ref}</span>` : ''}</div>`;
const bubble = (m) => `<div class="msg me"><div class="body">${md(m.text)}</div></div>`;

function renderHeadChat() {
  const out = [];
  let chips = [];
  const flush = () => { if (chips.length) { out.push(`<div class="chips">${chips.join('')}</div>`); chips = []; } };
  for (const m of S.feeds.head) {
    if (m.role === 'tool') { const [name, ...rest] = m.text.split(' '); chips.push(`<span class="chip">${ic('tool')}<b>${esc(name)}</b><span>${esc(rest.join(' '))}</span></span>`); continue; }
    flush();
    if (m.role === 'user') out.push(bubble(m));
    else if (m.role === 'head') out.push(`<div class="msg">${who('Head')}<div class="body">${md(m.text)}</div></div>`);
    else if (m.role === 'system') out.push(`<div class="note">${esc(m.text.replace(/^\[system\]\s*/, 'Board: '))}</div>`);
    else out.push(`<div class="note err">${esc(m.text)}</div>`);
  }
  flush();
  if (S.live) out.push(`<div class="msg">${who('Head')}<div class="body">${md(S.live)}</div></div>`);
  else if (S.headBusy) out.push(`<div class="think"><span class="pix"><s></s><s></s><s></s><s></s><s></s><s></s></span><span class="shimmer">Thinking</span><span id="elapsed">${elapsed()}</span></div>`);
  if (!out.length) return `<div class="empty"><b>Tell the Head what to build</b>It plans the work, assigns tasks to your developers, reviews their diffs and coaches them when they slip.</div>`;
  return out.join('');
}
const elapsed = () => (S.busySince ? ((Date.now() - S.busySince) / 1000).toFixed(1) + 's' : '');
setInterval(() => { const e = $('#elapsed'); if (e) e.textContent = elapsed(); }, 200);

function renderTeam() {
  const out = S.feeds.team.map((m) => {
    if (['assign', 'review', 'cancel', 'answer'].includes(m.kind)) return `<div class="note">${esc(m.from)} · ${esc(m.text)}</div>`;
    if (m.from === 'You') return bubble(m);
    return `<div class="msg">${who(m.from, m.taskId ? '#' + m.taskId : '')}<div class="body">${md(m.text)}</div></div>`;
  });
  return out.join('') || `<div class="empty"><b>Team channel</b>Workers report here. Type <code>@Mira do X</code> to talk to one directly, or <code>@head …</code> for the Head.</div>`;
}
function renderDm(n) {
  const out = (S.feeds.dm[n] || []).map((m) => m.role === 'user' ? bubble(m) : m.role === 'error' ? `<div class="note err">${esc(m.text)}</div>` : `<div class="msg">${who(m.role)}<div class="body">${md(m.text)}</div></div>`);
  return out.join('') || `<div class="empty"><b>${esc(n)}</b>Private chat. ${esc(n)} runs on your local model, remembers its lessons and knows its recent tasks.</div>`;
}

function renderChat() {
  const el = $('#chat'); const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
  const body = S.tab === 'head' ? renderHeadChat() : S.tab === 'team' ? renderTeam() : renderDm(S.tab.slice(3));
  el.innerHTML = `<div class="col">${body}</div>`;
  if (atBottom) el.scrollTop = el.scrollHeight;
  $('#input').placeholder = S.tab === 'head' ? 'Tell the Head what you want built…' : S.tab === 'team' ? 'Post to the team (@Name to ping)…' : `Message ${S.tab.slice(3)}…`;
}

function renderAll() { if (!S.config) return; renderHeader(); renderRoster(); renderBoard(); renderTabs(); renderChat(); hydrateIcons(); }

async function openTab(id) {
  S.tab = id; S.unread[id] = 0;
  if (id.startsWith('dm:')) { const n = id.slice(3); S.feeds.dm[n] = await api('GET', '/api/dm/' + n); }
  renderAll(); $('#chat').scrollTop = 1e9; $('#input').focus();
}

/* ───────── task detail ───────── */
async function selectTask(id) { S.selected = id; await loadDetail(); renderBoard(); }
async function loadDetail() {
  if (S.selected == null) return;
  try { S.detail = await api('GET', '/api/tasks/' + S.selected); } catch { S.detail = null; }
  renderDetail();
}
function diffTable(patch) {
  let h = '', oldN = 0, newN = 0, inHunk = false, rows = 0;
  for (const l of patch.split('\n')) {
    if (++rows > 3000) { h += '<tr class="dh"><td colspan="3">… truncated</td></tr>'; break; }
    if (l.startsWith('diff --git')) { inHunk = false; h += `<tr class="df"><td colspan="3">${esc(l.split(' b/')[1] || l)}</td></tr>`; continue; }
    if (l.startsWith('@@')) { inHunk = true; const m = l.match(/@@ -(\d+)(?:,\d+)? \+(\d+)/); if (m) { oldN = +m[1]; newN = +m[2]; } h += `<tr class="dh"><td colspan="3">${esc(l)}</td></tr>`; continue; }
    if (!inHunk || l === '' || l.startsWith('\\')) continue;
    if (l.startsWith('+')) h += `<tr class="add"><td class="ln"></td><td class="ln">${newN++}</td><td class="cd">+ ${esc(l.slice(1))}</td></tr>`;
    else if (l.startsWith('-')) h += `<tr class="del"><td class="ln">${oldN++}</td><td class="ln"></td><td class="cd">− ${esc(l.slice(1))}</td></tr>`;
    else h += `<tr><td class="ln">${oldN++}</td><td class="ln">${newN++}</td><td class="cd">  ${esc(l.slice(1))}</td></tr>`;
  }
  return `<table class="diff">${h}</table>`;
}
const codeBox = (label, text, cls = '') => `<div class="code ${cls}"><div class="ch"><span>${esc(label)}</span></div><pre>${esc(text)}</pre></div>`;

function renderDetail() {
  const el = $('#right'); const t = S.detail;
  if (!t) { el.hidden = true; return; }
  el.hidden = false;
  const last = t.attempts.at(-1);
  let h = `<div class="row between"><div class="dt-title">${esc(t.title)} <span class="mono muted" style="font-weight:400;font-size:12px">#${t.id}</span></div><button class="close" id="closeDetail">${ic('x')}</button></div>
  <div class="row" style="margin:8px 0;flex-wrap:wrap">${badge(t.status)}<span class="badge">${avatar(t.assignee, 14)}${esc(t.assignee)}</span><span class="badge">${t.attempts.length} attempt${t.attempts.length === 1 ? '' : 's'}</span>${t.dependsOn.length ? `<span class="badge">after ${t.dependsOn.map((d) => '#' + d).join(', ')}</span>` : ''}</div>`;

  if (t.status === 'blocked') h += `<div class="card"><div class="inner"><h4>${esc(t.assignee)} is asking</h4><p class="q">${esc(t.question)}</p><textarea class="field" id="answerText" rows="2" placeholder="Your answer…"></textarea><div class="actions"><button class="btn" id="doAnswer">Answer</button></div></div></div>`;
  if (['review', 'needs_attention'].includes(t.status)) h += `<div class="card"><div class="inner"><h4>${t.status === 'review' ? 'Ready for your decision' : 'Failed after retries — needs a decision'}</h4>
    <div class="actions" style="margin-top:0"><button class="btn good" id="doApprove">${t.status === 'review' ? 'Approve & merge' : 'Merge anyway'}</button></div>
    <textarea class="field" id="rejFb" rows="2" placeholder="Or send it back — what should change? (goes to ${esc(t.assignee)})"></textarea>
    <input class="field" id="rejLesson" placeholder="Lesson to remember (optional)">
    <div class="actions"><button class="btn secondary" id="doReject">Send back</button></div></div></div>`;
  if (t.problem) h += `<div class="sec"><h4>Problem</h4>${codeBox('why it failed', t.problem, 'red')}</div>`;
  h += `<div class="sec"><h4>Brief</h4>${codeBox('brief.md', t.brief)}</div>`;
  if (t.acceptance.length) h += `<div class="sec"><h4>Acceptance</h4>${codeBox('criteria', t.acceptance.map((a) => '• ' + a).join('\n'))}</div>`;
  if (t.verify) h += `<div class="sec"><h4>Check command</h4>${codeBox('shell', t.verify)}</div>`;
  if (last?.report) h += `<div class="sec"><h4>${esc(t.assignee)}'s report</h4>${codeBox('REPORT.md', last.report)}</div>`;
  if (last?.verify) h += `<div class="sec"><h4>Check output · exit ${last.verify.code}</h4>${codeBox(t.verify, last.verify.output || '(no output)', last.verify.code ? 'red' : '')}</div>`;
  if (t.feedback.length) h += `<div class="sec"><h4>Feedback so far</h4>${codeBox('feedback', t.feedback.map((f) => `(${f.from}) ${f.text}`).join('\n\n'))}</div>`;
  if (t.diff?.stat) h += `<div class="sec"><h4>Changes</h4><pre class="stat">${esc(t.diff.stat)}</pre><div class="code diffwrap">${diffTable(t.diff.patch)}${t.diff.truncated ? '<div class="muted" style="padding:6px 10px">… diff truncated</div>' : ''}</div></div>`;
  h += `<div class="sec"><h4>Worker log · live</h4><div class="code"><pre id="log" style="max-height:220px">${esc(t.log)}</pre></div></div>`;
  h += `<div class="actions">`;
  if (['needs_attention', 'cancelled'].includes(t.status)) h += `<button class="btn ghost" id="doRetry">Retry from scratch</button>`;
  if (!['done', 'cancelled'].includes(t.status)) h += `<button class="btn danger" id="doCancel">Cancel task</button>`;
  h += `</div>`;
  el.innerHTML = h;
  const L = $('#log'); if (L) L.scrollTop = 1e9;
  const act = (sel, fn) => { const b = $(sel); if (b) b.onclick = async () => { b.disabled = true; try { await fn(); } catch (e) { alert(e.message); } await loadDetail(); }; };
  $('#closeDetail').onclick = () => { S.selected = null; S.detail = null; $('#right').hidden = true; renderBoard(); };
  act('#doApprove', () => api('POST', `/api/tasks/${t.id}/approve`, { force: t.status === 'needs_attention' }));
  act('#doReject', () => api('POST', `/api/tasks/${t.id}/reject`, { feedback: $('#rejFb').value, lesson: $('#rejLesson').value }));
  act('#doAnswer', () => api('POST', `/api/tasks/${t.id}/answer`, { answer: $('#answerText').value }));
  act('#doRetry', () => api('POST', `/api/tasks/${t.id}/retry`));
  act('#doCancel', () => confirm('Cancel and discard this task’s work?') && api('POST', `/api/tasks/${t.id}/cancel`));
}

/* ───────── modals ───────── */
const modal = $('#modal');
function openModal(html) { $('#modalBody').innerHTML = `<button class="close" id="mClose">${ic('x')}</button>` + html; $('#mClose').onclick = () => modal.close(); modal.showModal(); }

$('#btnSettings').onclick = async () => {
  const { text } = await api('GET', '/api/config/raw');
  openModal(`<h3>Settings</h3><p>crew.config.yaml — workers, models, Qwen endpoint, scheduler. Applies immediately on save.</p><textarea id="cfg" class="field mono" rows="24" spellcheck="false" style="font:12px/1.55 var(--mono)"></textarea><div class="actions"><button class="btn" id="saveCfg">Save</button><span id="cfgMsg" class="muted"></span></div>`);
  $('#cfg').value = text;
  $('#saveCfg').onclick = async () => { try { const r = await api('PUT', '/api/config/raw', { text: $('#cfg').value }); $('#cfgMsg').textContent = r.repoError ? '⚠ saved, but: ' + r.repoError : '✔ saved'; } catch (e) { $('#cfgMsg').textContent = '✖ ' + e.message; } };
};

$('#btnLessons').onclick = async () => {
  const scopes = ['project', ...S.config.workers.map((w) => w.name)];
  openModal(`<h3>Lessons</h3><p>What the team has learned. Injected into every future brief. Edit freely — delete what's wrong.</p><select id="lsScope" class="field">${scopes.map((s) => `<option>${esc(s)}</option>`).join('')}</select><textarea id="lsText" class="field" rows="14" spellcheck="false" style="font:12.5px/1.6 var(--mono)"></textarea><div class="actions"><button class="btn" id="lsSave">Save</button><span id="lsMsg" class="muted"></span></div>`);
  const load = async () => { $('#lsText').value = (await api('GET', '/api/lessons/' + $('#lsScope').value)).text; };
  $('#lsScope').onchange = load; await load();
  $('#lsSave').onclick = async () => { await api('PUT', '/api/lessons/' + $('#lsScope').value, { text: $('#lsText').value }); $('#lsMsg').textContent = '✔ saved'; };
};

$('#btnNew').onclick = () => {
  openModal(`<h3>New task</h3><p>Usually it's better to describe the goal to the Head and let it write the briefs.</p><input class="field" id="ntTitle" placeholder="Title"><textarea class="field" id="ntBrief" rows="6" placeholder="What should be done? Be specific."></textarea><input class="field" id="ntVerify" placeholder="Check command (optional), e.g. npm test"><select class="field" id="ntWho"><option value="">Any worker (least busy)</option>${S.config.workers.map((w) => `<option>${esc(w.name)}</option>`).join('')}</select><div class="actions"><button class="btn" id="ntGo">Create</button><span id="ntMsg" class="muted"></span></div>`);
  $('#ntGo').onclick = async () => { try { await api('POST', '/api/tasks', { title: $('#ntTitle').value, brief: $('#ntBrief').value, verify: $('#ntVerify').value, assignee: $('#ntWho').value || undefined }); modal.close(); } catch (e) { $('#ntMsg').textContent = '✖ ' + e.message; } };
};

/* ───────── Claude login ───────── */
async function refreshAuth() { try { S.auth = await api('GET', '/api/auth/status'); } catch { /* ignore */ } renderHeader(); if (S.authOpen) renderAuthModal(); }
function renderAuthModal() {
  const p = S.authPhase, a = S.auth || {};
  let h = '<h3>Claude login</h3>';
  if (p.phase === 'starting') h += '<p>Preparing the login link…</p><div class="actions"><button class="btn ghost" id="auCancel">Cancel</button></div>';
  else if (p.phase === 'url' || p.phase === 'verifying') {
    const v = p.phase === 'verifying';
    h += `<p><b>1.</b> Open this link, sign in and authorise:</p><div class="code"><pre><a href="${esc(p.url)}" target="_blank" rel="noopener" style="color:var(--accent-ink)">Open Claude sign-in ↗</a>\n<span class="muted" style="word-break:break-all">${esc(p.url)}</span></pre></div><div class="actions"><button class="btn ghost sm" id="auCopy">${ic('copy')}Copy link</button></div>
    <p><b>2.</b> Claude then shows a code. Paste it here:</p><input class="field" id="auCode" placeholder="Paste the code" autocomplete="off" ${v ? 'disabled' : ''}><div class="actions"><button class="btn" id="auSubmit" ${v ? 'disabled' : ''}>${v ? 'Verifying…' : 'Submit code'}</button><button class="btn ghost" id="auCancel">Cancel</button></div>`;
  } else {
    if (p.phase === 'done') h += '<p style="color:var(--green)">✔ Logged in.</p>';
    if (p.phase === 'failed') h += `<p style="color:var(--red)">✖ ${esc(p.message || 'Login failed')}</p>`;
    h += a.loggedIn ? `<p>Signed in: <b style="color:var(--ink)">${esc(a.method || 'yes')}</b>${a.email ? ' · ' + esc(a.email) : ''}</p>` : '<p>Not signed in. The Head cannot work until you log in (or set <code>ANTHROPIC_API_KEY</code>).</p>';
    if (a.error) h += `<div class="code red"><pre>${esc(a.error)}</pre></div>`;
    h += `<label style="display:block;font-size:13px;margin:6px 0"><input type="radio" name="auKind" value="sub" checked> Claude subscription (Pro/Max)</label><label style="display:block;font-size:13px;margin:6px 0"><input type="radio" name="auKind" value="console"> Anthropic Console (API billing)</label><div class="actions"><button class="btn" id="auStart">${a.loggedIn ? 'Sign in again' : 'Log in'}</button>${a.loggedIn && !/environment/.test(a.method) ? '<button class="btn ghost" id="auLogout">Log out</button>' : ''}</div><p style="font-size:12px;color:var(--ink-3)">The login is stored in the container's home volume and survives restarts.</p>`;
  }
  $('#modalBody').innerHTML = `<button class="close" id="mClose">${ic('x')}</button>` + h;
  $('#mClose').onclick = () => modal.close();
  const on = (sel, fn) => { const b = $(sel); if (b) b.onclick = async () => { try { await fn(); } catch (e) { alert(e.message); } }; };
  on('#auStart', () => api('POST', '/api/auth/login', { console: document.querySelector('input[name=auKind]:checked')?.value === 'console' }));
  on('#auCancel', () => api('POST', '/api/auth/cancel'));
  on('#auLogout', async () => { S.auth = await api('POST', '/api/auth/logout'); S.authPhase = { phase: 'idle' }; renderHeader(); renderAuthModal(); });
  on('#auCopy', () => navigator.clipboard.writeText(p.url));
  on('#auSubmit', () => api('POST', '/api/auth/code', { code: $('#auCode').value }));
  const ci = $('#auCode'); if (ci && !ci.disabled) { ci.focus(); ci.onkeydown = (e) => { if (e.key === 'Enter') $('#auSubmit').click(); }; }
}
$('#btnLogin').onclick = async () => { S.authOpen = true; modal.showModal(); await refreshAuth(); renderAuthModal(); };
modal.addEventListener('close', () => { S.authOpen = false; });

/* ───────── input ───────── */
const input = $('#input');
const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 200) + 'px'; };
input.addEventListener('input', grow);
$('#composer').onsubmit = async (e) => {
  e.preventDefault();
  const text = input.value.trim(); if (!text) return;
  input.value = ''; grow();
  try {
    if (S.tab === 'head') await api('POST', '/api/head', { text });
    else if (S.tab === 'team') await api('POST', '/api/feed', { text });
    else await api('POST', '/api/dm/' + S.tab.slice(3), { text });
  } catch (err) { alert(err.message); input.value = text; grow(); }
};
input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit(); } };
$('#stop').onclick = () => api('POST', '/api/head/stop');

/* ───────── live events ───────── */
let detailTimer = null;
const bump = (tab) => { if (S.tab !== tab) S.unread[tab] = (S.unread[tab] || 0) + 1; };
function onEvent(e) {
  switch (e.type) {
    case 'task': S.tasks.set(e.task.id, e.task); renderRoster(); renderBoard(); if (S.selected === e.task.id) { clearTimeout(detailTimer); detailTimer = setTimeout(loadDetail, 400); } break;
    case 'task_log': if (S.selected === e.id && S.detail && e.attempt === S.detail.attempts.length) { const L = $('#log'); if (L) { L.textContent += e.chunk; L.scrollTop = 1e9; } } break;
    case 'feed': if (e.feed === 'feed') { S.feeds.team.push(e.entry); bump('team'); renderTabs(); if (S.tab === 'team') renderChat(); } break;
    case 'head_message': S.feeds.head.push(e.entry); S.live = ''; if (e.entry.role === 'head' || e.entry.role === 'error') bump('head'); renderTabs(); if (S.tab === 'head') renderChat(); break;
    case 'head_delta': S.live += e.text; if (S.tab === 'head') renderChat(); break;
    case 'head_state': if (e.busy && !S.headBusy) S.busySince = Date.now(); S.headBusy = e.busy; S.cost = e.costUsd; if (!e.busy) S.live = ''; renderHeader(); renderRoster(); if (S.tab === 'head') renderChat(); hydrateIcons(); break;
    case 'head_cleared': S.feeds.head = []; renderChat(); break;
    case 'dm': { const n = e.feed.slice(3); const name = S.config.workers.find((w) => w.name.toLowerCase() === n)?.name || n; (S.feeds.dm[name] ||= []).push(e.entry); if (e.entry.role !== 'user') bump('dm:' + name); renderTabs(); if (S.tab === 'dm:' + name) renderChat(); break; }
    case 'auth': S.authPhase = e; if (e.phase === 'done') { S.auth = e.status ? { ...e.status } : S.auth; setTimeout(() => { if (S.authOpen && S.authPhase.phase === 'done') modal.close(); }, 1200); refreshAuth(); } if (S.authOpen) renderAuthModal(); break;
    case 'config': S.config = e.config; S.repoError = e.repoError; renderAll(); break;
  }
}

async function init() {
  hydrateIcons(); applyTheme(document.documentElement.classList.contains('dark') ? 'dark' : 'light');
  const st = await api('GET', '/api/state');
  S.config = st.config; S.repoError = st.repoError; S.headBusy = st.head.busy; S.cost = st.head.costUsd;
  if (S.headBusy) S.busySince = Date.now();
  st.tasks.forEach((t) => S.tasks.set(t.id, t));
  S.feeds.team = st.feed; S.feeds.head = st.headChat;
  renderAll(); $('#chat').scrollTop = 1e9;
  refreshAuth();
  const es = new EventSource('/api/events');
  es.onmessage = (m) => onEvent(JSON.parse(m.data));
  es.onerror = () => {};
}
init();
