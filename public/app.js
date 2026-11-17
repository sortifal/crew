const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const api = async (method, url, body) => {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};
const COLORS = ['#7c9cff', '#4cc38a', '#e5b04c', '#c792ea', '#ef8f6b', '#56c8d8'];
const colorOf = (name) => COLORS[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
const avatar = (name) => `<div class="avatar" style="background:${name === 'Head' ? '#fff' : colorOf(name)}">${esc(name[0].toUpperCase())}</div>`;

function md(s) {
  let t = esc(s);
  t = t.replace(/```(?:\w+)?\n([\s\S]*?)```/g, (_, c) => `<pre>${c}</pre>`);
  t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  return t;
}

const S = { auth: null, authPhase: { phase: 'idle' }, config: null, tasks: new Map(), feeds: { team: [], head: [], dm: {} }, tab: 'head', unread: {}, selected: null, detail: null, live: '', headBusy: false };

/* ───────── rendering ───────── */
function renderHeader() {
  $('#project').textContent = S.config?.project.name || '';
  const p = $('#headState');
  p.textContent = S.headBusy ? 'Head is thinking…' : 'Head idle';
  p.className = 'pill' + (S.headBusy ? ' busy' : '');
  if (S.cost != null) p.title = `Opus spend this session store: $${S.cost.toFixed(2)}`;
  const lb = $('#btnLogin');
  if (S.auth) { lb.textContent = S.auth.loggedIn ? '🔑 Claude ✔' : '🔑 Log in to Claude'; lb.style.color = S.auth.loggedIn ? '' : 'var(--warn)'; lb.style.borderColor = S.auth.loggedIn ? '' : 'var(--warn)'; lb.title = S.auth.loggedIn ? `Signed in: ${S.auth.method}${S.auth.email ? ' · ' + S.auth.email : ''}` : 'The Head (Opus) needs a Claude login or API key'; }
  $('#stop').hidden = !(S.headBusy && S.tab === 'head');
  const b = $('#banner');
  b.hidden = !S.repoError; b.textContent = S.repoError ? `Project repo problem: ${S.repoError} — open Settings to fix.` : '';
}

function workerStatus(name) {
  const mine = [...S.tasks.values()].filter((t) => t.assignee === name);
  const run = mine.find((t) => t.status === 'running'); if (run) return { cls: 'running', text: `working on #${run.id} ${run.title}` };
  const bl = mine.find((t) => t.status === 'blocked'); if (bl) return { cls: 'blocked', text: `blocked on #${bl.id}` };
  const q = mine.filter((t) => t.status === 'queued').length; if (q) return { cls: '', text: `${q} queued` };
  const rv = mine.find((t) => t.status === 'review'); if (rv) return { cls: '', text: `waiting for review #${rv.id}` };
  return { cls: '', text: 'idle' };
}

function renderRoster() {
  const el = $('#roster'); el.innerHTML = '';
  const people = [{ name: 'Head', role: 'Project lead (Opus)', tab: 'head', sub: S.headBusy ? 'thinking…' : 'ready' }, ...S.config.workers.map((w) => ({ name: w.name, role: w.role, tab: 'dm:' + w.name, sub: workerStatus(w.name), worker: true }))];
  for (const p of people) {
    const d = document.createElement('div'); d.className = 'person' + (S.tab === p.tab ? ' sel' : '');
    const st = typeof p.sub === 'string' ? { cls: S.headBusy ? 'running' : '', text: p.sub } : p.sub;
    d.innerHTML = `${avatar(p.name)}<div style="min-width:0;flex:1"><div><b>${esc(p.name)}</b> <span class="muted">${esc(p.role)}</span></div><div class="sub">${esc(st.text)}</div></div><span class="dot ${st.cls}"></span>`;
    d.onclick = () => openTab(p.tab);
    el.appendChild(d);
  }
}

function renderBoard() {
  const el = $('#board'); el.innerHTML = '';
  const order = ['needs_attention', 'blocked', 'review', 'running', 'queued', 'done', 'cancelled'];
  const list = [...S.tasks.values()].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || b.id - a.id);
  if (!list.length) el.innerHTML = '<div class="muted">No tasks yet. Ask the Head to plan something.</div>';
  for (const t of list.filter((t) => t.status !== 'cancelled').slice(0, 60)) {
    const d = document.createElement('div'); d.className = 'card' + (S.selected === t.id ? ' sel' : '');
    d.innerHTML = `<div class="t">#${t.id} ${esc(t.title)}</div><div class="m"><span class="st ${t.status}">${t.status.replace('_', ' ')}</span> ${esc(t.assignee)}${t.attempts.length > 1 ? ` · attempt ${t.attempts.length}` : ''}</div>`;
    d.onclick = () => selectTask(t.id);
    el.appendChild(d);
  }
}

function renderTabs() {
  const el = $('#tabs'); el.innerHTML = '';
  const tabs = [['head', '🧭 Head'], ['team', '💬 Team'], ...S.config.workers.map((w) => ['dm:' + w.name, '@' + w.name])];
  for (const [id, label] of tabs) {
    const b = document.createElement('button'); b.className = S.tab === id ? 'on' : '';
    b.innerHTML = esc(label) + (S.unread[id] ? `<span class="badge">${S.unread[id]}</span>` : '');
    b.onclick = () => openTab(id); el.appendChild(b);
  }
}

function msgHtml(m, kind) {
  if (kind === 'head') {
    if (m.role === 'user') return `<div class="msg me">${md(m.text)}</div>`;
    if (m.role === 'head') return `<div class="msg"><div class="who">Head</div>${md(m.text)}</div>`;
    if (m.role === 'tool') return `<div class="msg tool">⚙ ${esc(m.text)}</div>`;
    return `<div class="msg ${m.role}">${esc(m.text)}</div>`;
  }
  if (kind === 'team') {
    if (['assign', 'review', 'cancel', 'answer'].includes(m.kind)) return `<div class="msg event">${esc(m.from)}: ${esc(m.text)}</div>`;
    if (m.from === 'You') return `<div class="msg me">${md(m.text)}</div>`;
    return `<div class="msg"><div class="who" style="color:${colorOf(m.from)}">${esc(m.from)}${m.taskId ? ` · #${m.taskId}` : ''}</div>${md(m.text)}</div>`;
  }
  if (m.role === 'user') return `<div class="msg me">${md(m.text)}</div>`;
  if (m.role === 'error') return `<div class="msg error">${esc(m.text)}</div>`;
  return `<div class="msg"><div class="who" style="color:${colorOf(m.role)}">${esc(m.role)}</div>${md(m.text)}</div>`;
}

function renderChat() {
  const el = $('#chat'); const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  let html = '';
  if (S.tab === 'head') { html = S.feeds.head.map((m) => msgHtml(m, 'head')).join(''); if (S.live) html += `<div class="msg"><div class="who">Head</div>${md(S.live)}</div>`; if (!S.feeds.head.length && !S.live) html = '<div class="msg system">Tell the Head what you want built. It will plan, assign tasks to the team, review their work and coach them.</div>'; }
  else if (S.tab === 'team') html = S.feeds.team.map((m) => msgHtml(m, 'team')).join('') || '<div class="msg system">Team channel. Workers report here. Type <code>@Name message</code> to talk to one directly, <code>@head …</code> to the Head.</div>';
  else { const n = S.tab.slice(3); html = (S.feeds.dm[n] || []).map((m) => msgHtml(m, 'dm')).join('') || `<div class="msg system">Private chat with ${esc(n)}. They run on your local model and remember their lessons.</div>`; }
  el.innerHTML = html;
  if (atBottom) el.scrollTop = el.scrollHeight;
  $('#input').placeholder = S.tab === 'head' ? 'Talk to the Head…' : S.tab === 'team' ? 'Post to the team channel (@Name to ping)…' : `Message ${S.tab.slice(3)}…`;
}

function renderAll() { if (!S.config) return; renderHeader(); renderRoster(); renderBoard(); renderTabs(); renderChat(); }

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
function diffHtml(p) {
  return esc(p).split('\n').map((l) => l.startsWith('diff --git') ? `<span class="file">${l}</span>` : l.startsWith('@@') ? `<span class="hunk">${l}</span>` : l.startsWith('+') && !l.startsWith('+++') ? `<span class="add">${l}</span>` : l.startsWith('-') && !l.startsWith('---') ? `<span class="del">${l}</span>` : l).join('\n');
}
function renderDetail() {
  const el = $('#right'); const t = S.detail;
  if (!t) { el.hidden = true; return; }
  el.hidden = false;
  const last = t.attempts.at(-1);
  let h = `<div class="row"><h2 style="margin:0">#${t.id} ${esc(t.title)}</h2><button class="ghost" id="closeDetail">✕</button></div>
  <div style="margin:6px 0"><span class="st ${t.status}">${t.status.replace('_', ' ')}</span> <b style="color:${colorOf(t.assignee)}">${esc(t.assignee)}</b> <span class="muted">· ${t.attempts.length} attempt(s)${t.dependsOn.length ? ' · after ' + t.dependsOn.map((d) => '#' + d).join(', ') : ''}</span></div>`;
  if (t.status === 'blocked') h += `<div class="sect"><h4>${esc(t.assignee)} asks</h4><div class="box">${esc(t.question)}</div><textarea class="full" id="answerText" rows="2" placeholder="Your answer…"></textarea><div class="actions"><button id="doAnswer">Answer</button></div></div>`;
  if (t.problem) h += `<div class="sect"><h4>Problem</h4><div class="box">${esc(t.problem)}</div></div>`;
  h += `<div class="sect"><h4>Brief</h4><div class="box">${esc(t.brief)}</div></div>`;
  if (t.acceptance.length) h += `<div class="sect"><h4>Acceptance</h4><div class="box">${t.acceptance.map((a) => '• ' + esc(a)).join('\n')}</div></div>`;
  if (t.verify) h += `<div class="sect"><h4>Check command</h4><div class="box">${esc(t.verify)}</div></div>`;
  if (last?.report) h += `<div class="sect"><h4>${esc(t.assignee)}'s report</h4><div class="box">${esc(last.report)}</div></div>`;
  if (last?.verify) h += `<div class="sect"><h4>Check output (exit ${last.verify.code})</h4><div class="box">${esc(last.verify.output)}</div></div>`;
  if (t.feedback.length) h += `<div class="sect"><h4>Feedback so far</h4><div class="box">${t.feedback.map((f) => `(${esc(f.from)}) ${esc(f.text)}`).join('\n\n')}</div></div>`;
  if (t.diff?.stat) h += `<div class="sect"><h4>Changes</h4><div class="box">${esc(t.diff.stat)}</div><div class="box diff" style="margin-top:6px;max-height:420px">${diffHtml(t.diff.patch)}${t.diff.truncated ? '\n…truncated' : ''}</div></div>`;
  h += `<div class="sect"><h4>Worker log (live)</h4><div class="box" id="log" style="max-height:240px">${esc(t.log)}</div></div>`;
  h += `<div class="sect actions">`;
  if (['review', 'needs_attention'].includes(t.status)) {
    h += `<button class="good" id="doApprove">${t.status === 'review' ? 'Approve & merge' : 'Merge anyway'}</button>`;
    h += `<textarea class="full" id="rejFb" rows="3" placeholder="What should be changed? (sent to ${esc(t.assignee)})"></textarea><input class="full" id="rejLesson" placeholder="Optional lesson to remember (e.g. “always run the formatter”)"><button class="bad" id="doReject">Send back</button>`;
  }
  if (t.status === 'needs_attention' || t.status === 'cancelled') h += `<button class="ghost" id="doRetry">Retry from scratch</button>`;
  if (!['done', 'cancelled'].includes(t.status)) h += `<button class="ghost" id="doCancel">Cancel task</button>`;
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
function openModal(html) { $('#modalBody').innerHTML = `<button class="close" onclick="document.getElementById('modal').close()">✕</button>` + html; modal.showModal(); }

$('#btnSettings').onclick = async () => {
  const { text } = await api('GET', '/api/config/raw');
  openModal(`<h3>Settings (crew.config.yaml)</h3><p class="muted">Workers, models, Qwen endpoint, scheduler. Applies immediately on save.</p><textarea id="cfg" class="full" rows="26" spellcheck="false" style="font:12px ui-monospace,monospace"></textarea><div class="actions"><button id="saveCfg">Save</button><span id="cfgMsg"></span></div>`);
  $('#cfg').value = text;
  $('#saveCfg').onclick = async () => { try { const r = await api('PUT', '/api/config/raw', { text: $('#cfg').value }); $('#cfgMsg').textContent = r.repoError ? '⚠ saved, but: ' + r.repoError : '✔ saved'; } catch (e) { $('#cfgMsg').textContent = '✖ ' + e.message; } };
};

$('#btnLessons').onclick = async () => {
  const scopes = ['project', ...S.config.workers.map((w) => w.name)];
  openModal(`<h3>Lessons</h3><p class="muted">What the team has learned. Injected into every future brief. Edit freely — delete what's wrong.</p><select id="lsScope" class="full">${scopes.map((s) => `<option>${esc(s)}</option>`).join('')}</select><textarea id="lsText" class="full" rows="16" spellcheck="false"></textarea><div class="actions"><button id="lsSave">Save</button><span id="lsMsg"></span></div>`);
  const load = async () => { $('#lsText').value = (await api('GET', '/api/lessons/' + $('#lsScope').value)).text; };
  $('#lsScope').onchange = load; await load();
  $('#lsSave').onclick = async () => { await api('PUT', '/api/lessons/' + $('#lsScope').value, { text: $('#lsText').value }); $('#lsMsg').textContent = '✔ saved'; };
};

$('#btnNew').onclick = () => {
  openModal(`<h3>New task</h3><input class="full" id="ntTitle" placeholder="Title"><textarea class="full" id="ntBrief" rows="6" placeholder="What should be done? Be specific."></textarea><input class="full" id="ntVerify" placeholder="Check command (optional), e.g. npm test"><select class="full" id="ntWho"><option value="">Any worker (least busy)</option>${S.config.workers.map((w) => `<option>${esc(w.name)}</option>`).join('')}</select><div class="actions"><button id="ntGo">Create</button><span id="ntMsg"></span></div><p class="muted">Tip: it's usually better to describe the goal to the Head and let it write the briefs.</p>`);
  $('#ntGo').onclick = async () => { try { await api('POST', '/api/tasks', { title: $('#ntTitle').value, brief: $('#ntBrief').value, verify: $('#ntVerify').value, assignee: $('#ntWho').value || undefined }); modal.close(); } catch (e) { $('#ntMsg').textContent = '✖ ' + e.message; } };
};

/* ───────── Claude login ───────── */
async function refreshAuth() { try { S.auth = await api('GET', '/api/auth/status'); } catch { /* ignore */ } renderHeader(); if (S.authOpen) renderAuthModal(); }
function renderAuthModal() {
  const p = S.authPhase, a = S.auth || {};
  let h = '<h3>Claude login (for the Head / Opus)</h3>';
  if (p.phase === 'starting') h += '<p>Preparing the login link…</p><div class="actions"><button class="ghost" id="auCancel">Cancel</button></div>';
  else if (p.phase === 'url' || p.phase === 'verifying') {
    h += `<p><b>1.</b> Open this link, sign in and authorise:</p><div class="box"><a href="${esc(p.url)}" target="_blank" rel="noopener" style="color:var(--accent)">Open Claude sign-in ↗</a>\n<span class="muted" style="word-break:break-all">${esc(p.url)}</span></div><div class="actions"><button class="ghost" id="auCopy">Copy link</button></div>
    <p><b>2.</b> Claude then shows a code. Paste it here:</p><input class="full" id="auCode" placeholder="Paste the code" autocomplete="off" ${p.phase === 'verifying' ? 'disabled' : ''}><div class="actions"><button id="auSubmit" ${p.phase === 'verifying' ? 'disabled' : ''}>${p.phase === 'verifying' ? 'Verifying…' : 'Submit code'}</button><button class="ghost" id="auCancel">Cancel</button></div>`;
  } else {
    if (p.phase === 'done') h += '<p style="color:var(--ok)">✔ Logged in.</p>';
    if (p.phase === 'failed') h += `<p style="color:var(--bad)">✖ ${esc(p.message || 'Login failed')}</p>`;
    h += a.loggedIn ? `<p>Currently signed in: <b>${esc(a.method || 'yes')}</b>${a.email ? ' · ' + esc(a.email) : ''}</p>` : '<p>Not signed in. The Head cannot work until you log in (or set <code>ANTHROPIC_API_KEY</code>).</p>';
    if (a.error) h += `<div class="box">${esc(a.error)}</div>`;
    h += `<label><input type="radio" name="auKind" value="sub" checked> Claude subscription (Pro/Max)</label><br><label><input type="radio" name="auKind" value="console"> Anthropic Console (API billing)</label><div class="actions"><button id="auStart">${a.loggedIn ? 'Sign in again' : 'Log in'}</button>${a.loggedIn && !/environment/.test(a.method) ? '<button class="ghost" id="auLogout">Log out</button>' : ''}</div><p class="muted">The login is stored in the container's home volume and survives restarts.</p>`;
  }
  $('#modalBody').innerHTML = `<button class="close" onclick="document.getElementById('modal').close()">✕</button>` + h;
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
$('#composer').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('#input').value.trim(); if (!text) return;
  $('#input').value = '';
  try {
    if (S.tab === 'head') await api('POST', '/api/head', { text });
    else if (S.tab === 'team') await api('POST', '/api/feed', { text });
    else await api('POST', '/api/dm/' + S.tab.slice(3), { text });
  } catch (err) { alert(err.message); $('#input').value = text; }
};
$('#input').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#composer').requestSubmit(); } };
$('#stop').onclick = () => api('POST', '/api/head/stop');

/* ───────── live events ───────── */
let detailTimer = null;
function bump(tab) { if (S.tab !== tab) { S.unread[tab] = (S.unread[tab] || 0) + 1; } }
function onEvent(e) {
  switch (e.type) {
    case 'task': S.tasks.set(e.task.id, e.task); renderRoster(); renderBoard(); if (S.selected === e.task.id) { clearTimeout(detailTimer); detailTimer = setTimeout(loadDetail, 400); } break;
    case 'task_log': if (S.selected === e.id && S.detail && e.attempt === S.detail.attempts.length) { const L = $('#log'); if (L) { L.textContent += e.chunk; L.scrollTop = 1e9; } } break;
    case 'feed': if (e.feed === 'feed') { S.feeds.team.push(e.entry); bump('team'); renderTabs(); if (S.tab === 'team') renderChat(); } break;
    case 'head_message': S.feeds.head.push(e.entry); S.live = ''; if (e.entry.role === 'head' || e.entry.role === 'error') bump('head'); renderTabs(); if (S.tab === 'head') renderChat(); break;
    case 'head_delta': S.live += e.text; if (S.tab === 'head') renderChat(); break;
    case 'head_state': S.headBusy = e.busy; S.cost = e.costUsd; if (!e.busy) S.live = ''; renderHeader(); renderRoster(); if (S.tab === 'head') renderChat(); break;
    case 'head_cleared': S.feeds.head = []; renderChat(); break;
    case 'dm': { const n = e.feed.slice(3); const name = S.config.workers.find((w) => w.name.toLowerCase() === n)?.name || n; (S.feeds.dm[name] ||= []).push(e.entry); if (e.entry.role !== 'user') bump('dm:' + name); renderTabs(); if (S.tab === 'dm:' + name) renderChat(); break; }
    case 'auth': S.authPhase = e; if (e.phase === 'done') { S.auth = e.status ? { ...e.status } : S.auth; setTimeout(() => { if (S.authOpen && S.authPhase.phase === 'done') modal.close(); }, 1200); refreshAuth(); } if (S.authOpen) renderAuthModal(); break;
    case 'config': S.config = e.config; S.repoError = e.repoError; renderAll(); break;
  }
}

async function init() {
  const st = await api('GET', '/api/state');
  S.config = st.config; S.repoError = st.repoError; S.headBusy = st.head.busy; S.cost = st.head.costUsd;
  st.tasks.forEach((t) => S.tasks.set(t.id, t));
  S.feeds.team = st.feed; S.feeds.head = st.headChat;
  renderAll(); $('#chat').scrollTop = 1e9;
  refreshAuth();
  const es = new EventSource('/api/events');
  es.onmessage = (m) => onEvent(JSON.parse(m.data));
  es.onerror = () => {};
}
init();
