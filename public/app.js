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

const S = { auth: null, authPhase: { phase: 'idle' }, config: null, tasks: new Map(), feeds: { team: [], head: [], dm: {} }, tab: 'head', unread: {}, selected: null, detail: null, live: '', headBusy: false, busySince: 0, act: new Map() };

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
  const run = mine.find((t) => t.status === 'running'); if (run) { const a = S.act.get(run.id); const last = a?.lines.length ? a.lines[a.lines.length - 1] : ''; return { cls: 'running', text: last ? `${last}` : `#${run.id} ${run.title}`, since: a?.startedAt }; }
  const bl = mine.find((t) => t.status === 'blocked'); if (bl) return { cls: 'blocked', text: `Blocked on #${bl.id}` };
  const q = mine.filter((t) => t.status === 'queued').length; if (q) return { cls: '', text: `${q} queued` };
  const rv = mine.find((t) => t.status === 'review'); if (rv) return { cls: 'review', text: `Awaiting review #${rv.id}` };
  return { cls: '', text: 'Idle' };
}

function renderRoster() {
  const el = $('#roster'); el.innerHTML = '';
  const people = [{ name: 'Head', tab: 'head', st: { cls: S.headBusy ? 'live' : '', text: S.headBusy ? 'Working…' : 'Opus · project lead' } }, ...S.config.workers.map((w) => ({ name: w.name, tab: 'dm:' + w.name, st: w.enabled === false ? { cls: '', text: 'Disabled' } : workerStatus(w.name), role: w.role, off: w.enabled === false }))];
  for (const p of people) {
    const d = document.createElement('div'); d.className = 'person' + (S.tab === p.tab ? ' sel' : '') + (p.off ? ' off' : '');
    d.innerHTML = `${avatar(p.name)}<div style="min-width:0;flex:1"><div class="nm">${esc(p.name)}</div><div class="sub">${esc(p.st.text)}</div>${p.st.since ? `<div class="sub el" data-since="${p.st.since}"></div>` : ''}</div><span class="dot ${p.st.cls}"></span>`;
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
  const tabs = [['head', 'Head'], ['team', 'Team'], ['live', 'Live'], ...S.config.workers.map((w) => ['dm:' + w.name, w.name])];
  for (const [id, label] of tabs) {
    const b = document.createElement('button'); b.className = S.tab === id ? 'on' : '';
    b.innerHTML = (id === 'live' && S.act.size ? '<span class="dot live" style="margin-right:6px"></span>' : '') + esc(label) + (S.unread[id] ? `<span class="count">${S.unread[id]}</span>` : '');
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

const fmtDur = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`; };
function renderLive() {
  const list = [...S.act.values()];
  if (!list.length) return `<div class="empty"><b>Nothing running</b>When an agent is working you'll see its output, files and timing here, live.</div>`;
  return list.map((a) => {
    const files = (a.files || []).slice(0, 10).map((f) => `<span class="chip"><span class="mono">${esc(f)}</span></span>`).join('') + ((a.files || []).length > 10 ? `<span class="chip">+${a.files.length - 10} more</span>` : '');
    return `<div class="livecard" data-task="${a.id}">
      <div class="lh">${avatar(a.worker, 24)}<div style="min-width:0;flex:1"><div class="nm">${esc(a.worker)}<span class="mono ref"> #${a.id}${a.attempt > 1 ? ' · try ' + a.attempt : ''}</span></div><div class="sub">${esc(a.title)}</div></div>
        <div class="ls"><span class="dot live"></span><span class="mono" data-since="${a.startedAt}"></span><span class="quiet mono" data-quiet="${a.lastOutputAt || 0}" data-start="${a.startedAt}"></span></div></div>
      ${files ? `<div class="chips" style="margin:8px 0 0">${files}</div>` : ''}
      <div class="code"><pre class="lp">${esc(a.lines.slice(-40).join('\n')) || '<span class="muted">waiting for output…</span>'}</pre></div>
    </div>`;
  }).join('');
}
function tickClocks() {
  const now = Date.now();
  document.querySelectorAll('[data-since]').forEach((el) => (el.textContent = fmtDur(now - +el.dataset.since)));
  document.querySelectorAll('[data-quiet]').forEach((el) => { const q = now - (+el.dataset.quiet || +el.dataset.start); el.textContent = q > 30000 ? `quiet ${fmtDur(q)}` : ''; el.classList.toggle('warn', q > 120000); });
}
setInterval(tickClocks, 1000);
let liveTimer = null;
const refreshLive = () => { if (liveTimer) return; liveTimer = setTimeout(() => { liveTimer = null; renderRoster(); renderTabs(); if (S.tab === 'live') { renderChat(); } tickClocks(); }, 250); };

function renderChat() {
  const el = $('#chat'); const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
  const body = S.tab === 'head' ? renderHeadChat() : S.tab === 'team' ? renderTeam() : S.tab === 'live' ? renderLive() : renderDm(S.tab.slice(3));
  el.innerHTML = `<div class="col">${body}</div>`;
  if (S.tab === 'live') el.querySelectorAll('.lp').forEach((p) => (p.scrollTop = p.scrollHeight));
  else if (atBottom) el.scrollTop = el.scrollHeight;
  $('#composer').hidden = S.tab === 'live';
  tickClocks();
  $('#input').placeholder = S.tab === 'head' ? 'Tell the Head what you want built…' : S.tab === 'team' ? 'Post to the team (@Name to ping)…' : `Message ${S.tab.slice(3)}…`;
}

document.addEventListener('click', (e) => { const c = e.target.closest?.('.livecard'); if (c && !e.target.closest('pre')) selectTask(+c.dataset.task); });
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

/* ───────── settings (structured) ───────── */
const SET = { draft: null, tab: 'team', sel: 0, dirty: false, open: false, models: [] };
const getP = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
const setP = (o, p, v) => { const ks = p.split('.'); const last = ks.pop(); const t = ks.reduce((a, k) => (a[k] ??= {}), o); t[last] = v; };
const fld = (label, inner, help = '') => `<div class="fr"><label>${label}</label>${inner}${help ? `<div class="help">${help}</div>` : ''}</div>`;
const inp = (path, { type = 'text', ph = '', as = '', list = '', cls = '' } = {}) => `<input class="field ${cls}" type="${type}" data-b="${path}" data-as="${as}" placeholder="${esc(ph)}" ${list ? `list="${list}"` : ''} autocomplete="off" spellcheck="false">`;
const area = (path, rows, ph = '', as = '') => `<textarea class="field" rows="${rows}" data-b="${path}" data-as="${as}" placeholder="${esc(ph)}" spellcheck="false"></textarea>`;
const sw = (path, label) => `<label class="sw"><input type="checkbox" data-b="${path}"><span class="knob"></span><span>${label}</span></label>`;
const W = () => SET.draft.workers[SET.sel];

function panelGeneral() {
  return `<h3>General</h3>
  <div class="grp"><h4>Project</h4>
    ${fld('Name', inp('project.name'))}
    ${fld('Repository path', inp('project.repo', { ph: '/workspace/project' }), 'A git repo with at least one commit, checked out on the base branch. In Docker this is the mounted <code>/workspace/project</code>.')}
    ${fld('Base branch', inp('project.baseBranch', { ph: 'main' }), 'Tasks branch from it and approved work is merged into it.')}
    ${fld('Conventions & context', area('project.context', 5, 'e.g. “TypeScript strict. Tests with vitest. Never edit generated files.”'), 'Included in the Head\'s prompt and in every developer brief.')}
  </div>
  <div class="grp"><h4>Head (Opus)</h4>
    ${fld('Model', inp('head.model', { list: 'headModels', ph: 'opus' }), 'An alias (<code>opus</code>, <code>sonnet</code>, <code>haiku</code>) or a full model id.<datalist id="headModels"><option>opus</option><option>sonnet</option><option>haiku</option></datalist>')}
    ${sw('head.autoReview', 'Wake the Head automatically when a task is ready for review, blocked or failed')}
    ${fld('Extra instructions', area('head.instructions', 5, 'e.g. “Be strict about tests. Prefer many small tasks. Answer me in French.”'), 'Added to the Head\'s system prompt.')}
  </div>`;
}

function panelTeam() {
  const ws = SET.draft.workers;
  const list = ws.map((w, i) => `<button class="ag ${i === SET.sel ? 'on' : ''}" data-ag="${i}">${avatar(w.name || '?', 22)}<span class="agn"><b>${esc(w.name || '(unnamed)')}</b><small>${esc(w.role)}${/openrouter\.ai/i.test(w.endpoint || '') ? ' · OpenRouter' : w.endpoint ? ' · remote' : ''}</small></span>${w.enabled === false ? '<span class="badge">off</span>' : ''}</button>`).join('');
  const w = W();
  const prov = !w ? 'default' : !w.endpoint ? 'default' : /(^|\.)openrouter\.ai(\/|$)/i.test(w.endpoint.replace(/^https?:\/\//, '')) ? 'openrouter' : 'custom';
  const form = !w ? '<div class="empty" style="margin:40px auto"><b>No agents</b>Add an agent to get started.</div>' : `
    <div class="row between" style="margin-bottom:6px"><h3 style="margin:0">${esc(w.name || 'New agent')}</h3>${sw(`workers.${SET.sel}.enabled`, 'Enabled')}</div>
    <div class="grid2">${fld('Name', inp(`workers.${SET.sel}.name`), 'Letters, digits, - and _. Renaming keeps its tasks, lessons and chats.')}${fld('Role', inp(`workers.${SET.sel}.role`, { ph: 'Backend developer' }))}</div>
    ${fld('Persona', area(`workers.${SET.sel}.persona`, 3, 'Calm, precise, a bit dry…'), 'Tone and character: shapes its messages, chats and briefs.')}
    ${fld('Standing instructions', area(`workers.${SET.sel}.instructions`, 4, 'e.g. “Prefer small commits. Always add a test for bug fixes.”'), 'Always included in this agent\'s task briefs.')}
    <div class="grp"><h4>Model <span class="muted" style="font-weight:400">— leave empty to use the defaults from “Local model”</span></h4>
      ${fld('Provider', `<select class="field" id="provSel"><option value="default"${prov === 'default' ? ' selected' : ''}>Default (local model)</option><option value="openrouter"${prov === 'openrouter' ? ' selected' : ''}>OpenRouter</option><option value="custom"${prov === 'custom' ? ' selected' : ''}>Other OpenAI-compatible API</option></select>`, prov === 'openrouter' ? 'Runs this agent on OpenRouter instead of your local model, so it does not use your GPU.' : '')}
      <div class="grid2">${fld('Model', inp(`workers.${SET.sel}.model`, { list: 'modelList', ph: prov === 'openrouter' ? 'qwen/qwen3-coder' : `default: ${SET.draft.qwen.model}` }), prov === 'openrouter' ? 'An OpenRouter model id. Test the connection to list them. Pick one that supports tool calling.' : '')}${fld('Endpoint', inp(`workers.${SET.sel}.endpoint`, { ph: `default: ${SET.draft.qwen.endpoint}` }))}</div>
      ${prov === 'default' ? '' : fld('API key', inp(`workers.${SET.sel}.apiKey`, { type: 'password', ph: w.hasKey ? 'saved — leave empty to keep it' : prov === 'openrouter' ? 'sk-or-v1-…  or  env:OPENROUTER_API_KEY' : 'empty = use the default key' }), `${w.hasKey ? '<a href="#" data-clearkey="1">Remove the saved key</a> · ' : ''}Stored in the config file on the server and never sent back to the browser. <code>env:NAME</code> reads it from an environment variable instead.`)}
      <div class="row"><button class="btn secondary sm" data-test="agent">Test connection</button><span class="help" id="test-agent"></span></div>
    </div>
    <div class="grp"><h4>Limits <span class="muted" style="font-weight:400">— empty = defaults</span></h4>
      <div class="grid2">${fld('Timeout (minutes)', inp(`workers.${SET.sel}.timeoutMinutes`, { type: 'number', as: 'num', ph: `default: ${SET.draft.qwen.timeoutMinutes}` }))}${fld('Auto-retries', inp(`workers.${SET.sel}.autoRetries`, { type: 'number', as: 'num', ph: `default: ${SET.draft.scheduler.autoRetries}` }), 'Retries on failing checks before the Head is called.')}</div>
    </div>
    <div class="actions"><button class="btn danger" data-rm="1">Remove agent</button></div>`;
  return `<div class="team"><div class="agents"><div class="agl">${list}</div><button class="btn secondary sm" data-add="1" style="margin:8px">${ic('plus')}Add agent</button></div><div class="agf">${form}</div></div>`;
}

function panelModel() {
  const env = Object.entries(SET.draft.qwen.env || {});
  return `<h3>Local model</h3><p class="muted" style="margin-top:0">Defaults for all agents. Each agent can override model and endpoint in the Team tab.</p>
  <div class="grid2">${fld('Endpoint (OpenAI-compatible)', inp('qwen.endpoint', { ph: 'http://localhost:8080/v1' }), 'In Docker use <code>host.docker.internal</code> instead of localhost.')}${fld('API key', inp('qwen.apiKey', { type: 'password', ph: 'local' }))}</div>
  <div class="row" style="margin-bottom:8px"><button class="btn secondary sm" data-test="global">Test connection</button><span class="help" id="test-global"></span></div>
  <div class="grid2">${fld('Default model', inp('qwen.model', { list: 'modelList', ph: 'qwen3-coder' }), 'Pick from the list after testing the connection.')}${fld('Timeout per run (minutes)', inp('qwen.timeoutMinutes', { type: 'number', as: 'num' }))}</div>
  <datalist id="modelList">${SET.models.map((m) => `<option>${esc(m)}</option>`).join('')}</datalist>
  <div class="grp"><h4>Agent CLI</h4>
    ${fld('Command', inp('qwen.command', { ph: 'qwen' }), 'Any CLI agent that takes a prompt works, e.g. <code>opencode</code>.')}
    ${fld('Arguments (one per line)', area('qwen.args', 3, '--yolo\n-p\n{prompt}', 'lines'), '<code>{prompt}</code> is replaced by a short pointer to the task brief.')}
    <div class="fr"><label>Environment variables</label><div class="envs">${env.map(([k, v], i) => `<div class="envrow"><input class="field" data-ek="${i}" value="${esc(k)}" placeholder="NAME"><input class="field" data-ev="${i}" value="${esc(v)}" placeholder="value"><button class="close" data-erm="${i}" title="Remove">${ic('x')}</button></div>`).join('')}</div><button class="btn secondary sm" data-eadd="1">${ic('plus')}Add variable</button><div class="help">Passed to the CLI. <code>OPENAI_BASE_URL</code>, <code>OPENAI_API_KEY</code> and <code>OPENAI_MODEL</code> are set by Crew from the endpoint, key and model settings (per agent where overridden).</div></div>
  </div>`;
}

function panelWorkflow() {
  return `<h3>Workflow</h3>
  <div class="grid2">${fld('Parallel runs · local model', inp('scheduler.maxParallel', { type: 'number', as: 'num' }), 'Agents using the default local model at the same time. One GPU usually serves one run best.')}${fld('Parallel runs · other endpoints', inp('scheduler.maxParallelRemote', { type: 'number', as: 'num' }), 'Agents on OpenRouter or another API; they do not compete for your GPU.')}</div>
  <div class="grid2">${fld('Auto-retries', inp('scheduler.autoRetries', { type: 'number', as: 'num' }), 'Default for agents: retries on failing checks before the Head is woken up.')}</div>
  <div class="grid2">${fld('Max attempts per task', inp('scheduler.maxAttempts', { type: 'number', as: 'num' }), 'Including rejections by the Head or you.')}${fld('Lessons injected (characters)', inp('lessons.maxChars', { type: 'number', as: 'num' }), 'Newest lessons are kept when the text is longer.')}</div>`;
}

function panelAdvanced() {
  return `<h3>Advanced — raw YAML</h3><p class="muted" style="margin-top:0">Saving here replaces the form settings (unsaved form changes are discarded).</p><textarea id="rawYaml" class="field" rows="22" spellcheck="false" style="font:12px/1.55 var(--mono)"></textarea><div class="actions"><button class="btn" id="saveYaml">Save YAML</button></div>`;
}

const TABS = [['general', 'General', panelGeneral], ['team', 'Team', panelTeam], ['model', 'Local model', panelModel], ['workflow', 'Workflow', panelWorkflow], ['advanced', 'Advanced', panelAdvanced]];

async function openSettings(tab = 'team') {
  const cfg = await api('GET', '/api/config');
  cfg.workers.forEach((w) => (w._orig = w.name));
  Object.assign(SET, { draft: cfg, tab, sel: 0, dirty: false, open: true, models: SET.models || [] });
  modal.classList.add('wide'); modal.showModal(); renderSettings();
}
function renderSettings(msg = '', cls = '') {
  const panel = TABS.find((t) => t[0] === SET.tab)[2]();
  $('#modalBody').innerHTML = `<div class="set"><nav class="set-nav"><div class="set-title">Settings</div>${TABS.map(([id, label]) => `<button class="${SET.tab === id ? 'on' : ''}" data-tab="${id}">${label}</button>`).join('')}</nav>
    <div class="set-main"><div class="set-body">${panel}</div><div class="set-foot"><span id="setMsg" class="${cls}">${esc(msg)}</span><div class="row"><button class="btn ghost" id="setDiscard">Close</button><button class="btn" id="setSave" ${SET.dirty ? '' : 'disabled'}>Save changes</button></div></div></div></div>`;
  hydrateIcons($('#modalBody'));
  wireSettings();
}
const markDirty = () => { SET.dirty = true; const b = $('#setSave'); if (b) b.disabled = false; const m = $('#setMsg'); if (m) { m.textContent = 'Unsaved changes'; m.className = ''; } };

function wireSettings() {
  const root = $('#modalBody');
  root.querySelectorAll('[data-b]').forEach((el) => {
    const path = el.dataset.b, as = el.dataset.as; const v = getP(SET.draft, path);
    if (el.type === 'checkbox') el.checked = path.endsWith('.enabled') ? v !== false : !!v;
    else if (as === 'lines') el.value = (v || []).join('\n');
    else el.value = v ?? '';
    el.addEventListener('input', () => {
      let val = el.type === 'checkbox' ? el.checked : el.value;
      if (as === 'num') val = el.value === '' ? null : Number(el.value);
      if (as === 'lines') val = el.value.split('\n').map((x) => x.trim()).filter(Boolean);
      setP(SET.draft, path, val); markDirty();
      if (/workers\.\d+\.(name|enabled|role)$/.test(path)) { const i = SET.sel; const it = root.querySelector(`[data-ag="${i}"]`); const w = SET.draft.workers[i]; if (it) { it.querySelector('b').textContent = w.name || '(unnamed)'; it.querySelector('small').textContent = w.role; it.querySelector('.avatar').outerHTML = avatar(w.name || '?', 22); let off = it.querySelector('.badge'); if (w.enabled === false && !off) it.insertAdjacentHTML('beforeend', '<span class="badge">off</span>'); if (w.enabled !== false && off) off.remove(); } const h3 = root.querySelector('.agf h3'); if (h3) h3.textContent = w.name || 'New agent'; }
    });
  });
  root.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { SET.tab = b.dataset.tab; renderSettings(); if (SET.tab === 'advanced') loadYaml(); }));
  root.querySelectorAll('[data-ag]').forEach((b) => (b.onclick = () => { SET.sel = +b.dataset.ag; renderSettings(); }));
  const add = root.querySelector('[data-add]'); if (add) add.onclick = () => {
    let n = SET.draft.workers.length + 1; const names = new Set(SET.draft.workers.map((w) => w.name.toLowerCase()));
    while (names.has('dev' + n)) n++;
    SET.draft.workers.push({ name: 'Dev' + n, role: 'Developer', persona: '', enabled: true, model: '', endpoint: '', apiKey: '', instructions: '', timeoutMinutes: null, autoRetries: null });
    SET.sel = SET.draft.workers.length - 1; markDirty(); renderSettings('Unsaved changes');
  };
  const rm = root.querySelector('[data-rm]'); if (rm) rm.onclick = () => {
    const w = W(); if (!confirm(`Remove ${w.name}? Its lessons are kept on disk; finished tasks keep its name.`)) return;
    SET.draft.workers.splice(SET.sel, 1); SET.sel = Math.max(0, SET.sel - 1); markDirty(); renderSettings('Unsaved changes');
  };
  const ps = root.querySelector('#provSel'); if (ps) ps.onchange = () => {
    const w = W();
    if (ps.value === 'default') { w.endpoint = ''; }
    else if (ps.value === 'openrouter') { w.endpoint = 'https://openrouter.ai/api/v1'; SET.models = []; }
    else if (/openrouter\.ai/i.test(w.endpoint || '')) w.endpoint = '';
    markDirty(); renderSettings('Unsaved changes');
  };
  const ck = root.querySelector('[data-clearkey]'); if (ck) ck.onclick = (e) => { e.preventDefault(); const w = W(); w.clearKey = true; w.hasKey = false; w.apiKey = ''; markDirty(); renderSettings('Unsaved changes'); };
  root.querySelectorAll('[data-test]').forEach((b) => (b.onclick = async () => {
    const isAgent = b.dataset.test === 'agent'; const out = $(isAgent ? '#test-agent' : '#test-global');
    const endpoint = (isAgent && W().endpoint) || SET.draft.qwen.endpoint; out.textContent = 'Testing…'; out.style.color = '';
    try {
      const r = await api('POST', '/api/test-endpoint', isAgent ? { endpoint, apiKey: W().apiKey, agent: W()._orig } : { endpoint, apiKey: SET.draft.qwen.apiKey });
      if (r.ok) { SET.models = r.models; out.textContent = `✔ reachable in ${r.ms} ms · ${r.models.length} model${r.models.length === 1 ? '' : 's'}${r.models.length ? ': ' + r.models.slice(0, 3).join(', ') + (r.models.length > 3 ? '…' : '') : ''}${r.keyInfo ? ` · key${r.keyInfo.label ? ' “' + r.keyInfo.label + '”' : ''} ok${typeof r.keyInfo.usage === 'number' ? ', $' + r.keyInfo.usage.toFixed(2) + ' used' : ''}${typeof r.keyInfo.limit === 'number' ? ' of $' + r.keyInfo.limit : ''}` : ''}`; out.style.color = 'var(--green)'; const dl = $('#modelList'); if (dl) dl.innerHTML = r.models.map((m) => `<option>${esc(m)}</option>`).join(''); }
      else { out.textContent = '✖ ' + r.message; out.style.color = 'var(--red)'; }
    } catch (e) { out.textContent = '✖ ' + e.message; out.style.color = 'var(--red)'; }
  }));
  // environment variable rows
  const envObj = () => SET.draft.qwen.env || (SET.draft.qwen.env = {});
  const rebuild = (rows) => { SET.draft.qwen.env = Object.fromEntries(rows.filter(([k]) => k.trim())); };
  root.querySelectorAll('[data-ek],[data-ev]').forEach((el) => el.addEventListener('change', () => {
    const rows = Object.entries(envObj()).map(([k, v]) => [k, v]);
    root.querySelectorAll('.envrow').forEach((r, i) => { rows[i] = [r.querySelector('[data-ek]').value, r.querySelector('[data-ev]').value]; });
    rebuild(rows); markDirty();
  }));
  root.querySelectorAll('[data-erm]').forEach((b) => (b.onclick = () => { const rows = Object.entries(envObj()); rows.splice(+b.dataset.erm, 1); rebuild(rows); markDirty(); renderSettings('Unsaved changes'); }));
  const ea = root.querySelector('[data-eadd]'); if (ea) ea.onclick = () => { const e = envObj(); let k = 'NEW_VAR'; while (k in e) k += '_'; e[k] = ''; markDirty(); renderSettings('Unsaved changes'); };

  $('#setSave').onclick = saveSettings;
  $('#setDiscard').onclick = closeSettings;
  const sy = $('#saveYaml'); if (sy) sy.onclick = async () => {
    try { const r = await api('PUT', '/api/config/raw', { text: $('#rawYaml').value }); const cfg = await api('GET', '/api/config'); cfg.workers.forEach((w) => (w._orig = w.name)); SET.draft = cfg; SET.dirty = false; renderSettings(r.repoError ? '⚠ Saved, but: ' + r.repoError : '✔ Saved', r.repoError ? 'warn' : 'ok'); SET.tab = 'advanced'; loadYaml(); }
    catch (e) { $('#setMsg').textContent = '✖ ' + e.message; $('#setMsg').className = 'bad'; }
  };
}
async function loadYaml() { const { text } = await api('GET', '/api/config/raw'); const t = $('#rawYaml'); if (t) t.value = text; }

async function saveSettings() {
  const draft = JSON.parse(JSON.stringify(SET.draft));
  const renames = {}; draft.workers.forEach((w) => { if (w._orig && w._orig !== w.name) renames[w.name] = w._orig; });
  draft.workers.forEach((w) => delete w._orig);
  const btn = $('#setSave'); btn.disabled = true;
  try {
    const r = await api('PUT', '/api/config', { config: draft, renames });
    r.config.workers.forEach((w) => (w._orig = w.name));
    const names = SET.draft.workers[SET.sel]?.name; SET.draft = r.config; SET.dirty = false;
    SET.sel = Math.max(0, SET.draft.workers.findIndex((w) => w.name === names));
    renderSettings(r.repoError ? '⚠ Saved, but: ' + r.repoError : '✔ Saved — applies immediately', r.repoError ? 'warn' : 'ok');
  } catch (e) { btn.disabled = false; const m = $('#setMsg'); m.textContent = '✖ ' + e.message; m.className = 'bad'; }
}
function closeSettings() { if (SET.dirty && !confirm('Discard unsaved changes?')) return; SET.dirty = false; modal.close(); }
modal.addEventListener('cancel', (e) => { if (SET.open && SET.dirty && !confirm('Discard unsaved changes?')) e.preventDefault(); });
modal.addEventListener('close', () => { SET.open = false; modal.classList.remove('wide'); });
$('#btnSettings').onclick = () => openSettings('team');

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
function liveAppend(e) {
  const a = S.act.get(e.id); if (!a) return;
  a.lastOutputAt = Date.now();
  const parts = ((a._p || '') + e.chunk).split('\n'); a._p = parts.pop();
  for (const l of parts) if (l.trim()) a.lines.push(l.slice(0, 400));
  if (a.lines.length > 200) a.lines.splice(0, a.lines.length - 200);
  refreshLive();
}
const bump = (tab) => { if (S.tab !== tab) S.unread[tab] = (S.unread[tab] || 0) + 1; };
function onEvent(e) {
  switch (e.type) {
    case 'task': S.tasks.set(e.task.id, e.task); renderRoster(); renderBoard(); if (S.selected === e.task.id) { clearTimeout(detailTimer); detailTimer = setTimeout(loadDetail, 400); } break;
    case 'live': if (e.entry) S.act.set(e.id, e.entry); else S.act.delete(e.id); refreshLive(); break;
    case 'task_files': { const a = S.act.get(e.id); if (a) { a.files = e.files; refreshLive(); } break; }
    case 'task_log': if (S.selected === e.id && S.detail && e.attempt === S.detail.attempts.length) { const L = $('#log'); if (L) { L.textContent += e.chunk; L.scrollTop = 1e9; } } liveAppend(e); break;
    case 'feed': if (e.feed === 'feed') { S.feeds.team.push(e.entry); bump('team'); renderTabs(); if (S.tab === 'team') renderChat(); } break;
    case 'head_message': S.feeds.head.push(e.entry); S.live = ''; if (e.entry.role === 'head' || e.entry.role === 'error') bump('head'); renderTabs(); if (S.tab === 'head') renderChat(); break;
    case 'head_delta': S.live += e.text; if (S.tab === 'head') renderChat(); break;
    case 'head_state': if (e.busy && !S.headBusy) S.busySince = Date.now(); S.headBusy = e.busy; S.cost = e.costUsd; if (!e.busy) S.live = ''; renderHeader(); renderRoster(); if (S.tab === 'head') renderChat(); hydrateIcons(); break;
    case 'head_cleared': S.feeds.head = []; renderChat(); break;
    case 'dm': { const n = e.feed.slice(3); const name = S.config.workers.find((w) => w.name.toLowerCase() === n)?.name || n; (S.feeds.dm[name] ||= []).push(e.entry); if (e.entry.role !== 'user') bump('dm:' + name); renderTabs(); if (S.tab === 'dm:' + name) renderChat(); break; }
    case 'auth': S.authPhase = e; if (e.phase === 'done') { S.auth = e.status ? { ...e.status } : S.auth; setTimeout(() => { if (S.authOpen && S.authPhase.phase === 'done') modal.close(); }, 1200); refreshAuth(); } if (S.authOpen) renderAuthModal(); break;
    case 'config': S.config = e.config; S.repoError = e.repoError; if (S.tab.startsWith('dm:') && !S.config.workers.some((w) => w.name === S.tab.slice(3))) S.tab = 'head'; for (const k of Object.keys(S.feeds.dm)) if (!S.config.workers.some((w) => w.name === k)) delete S.feeds.dm[k]; renderAll(); break;
  }
}

async function init() {
  hydrateIcons(); applyTheme(document.documentElement.classList.contains('dark') ? 'dark' : 'light');
  const st = await api('GET', '/api/state');
  S.config = st.config; S.repoError = st.repoError; S.headBusy = st.head.busy; S.cost = st.head.costUsd;
  if (S.headBusy) S.busySince = Date.now();
  st.tasks.forEach((t) => S.tasks.set(t.id, t));
  (st.live || []).forEach((a) => S.act.set(a.id, a));
  S.feeds.team = st.feed; S.feeds.head = st.headChat;
  renderAll(); $('#chat').scrollTop = 1e9;
  refreshAuth();
  const es = new EventSource('/api/events');
  es.onmessage = (m) => onEvent(JSON.parse(m.data));
  es.onerror = () => {};
}
init();
