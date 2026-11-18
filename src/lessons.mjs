import fs from 'node:fs';
import { config, workerByName } from './config.mjs';
import { dataPath, emit } from './store.mjs';

const fileFor = (scope) => dataPath('lessons', `${scope === 'project' ? 'project' : scope.toLowerCase()}.md`);

export function scopes() {
  return ['project', 'codebase', ...config.workers.map((w) => w.name)];
}
export function validScope(scope) {
  return scope === 'project' || scope === 'codebase' || !!workerByName(scope);
}
export function getLessons(scope) {
  try { return fs.readFileSync(fileFor(scope), 'utf8'); } catch { return ''; }
}
export function setLessons(scope, text) {
  fs.mkdirSync(dataPath('lessons'), { recursive: true });
  fs.writeFileSync(fileFor(scope), text);
  emit('lessons', { scope });
}
export function addLesson(scope, text, taskId) {
  const line = `- (${new Date().toISOString().slice(0, 10)}${taskId ? `, task #${taskId}` : ''}) ${String(text).trim().replace(/\n+/g, ' ')}`;
  const cur = getLessons(scope);
  if (cur.includes(String(text).trim())) return false; // exact duplicate
  setLessons(scope, (cur && !cur.endsWith('\n') ? cur + '\n' : cur) + line + '\n');
  return true;
}

/** Text injected into a worker's brief: project-wide lessons + the worker's own. Newest kept when too long. */
export function lessonsFor(workerName) {
  const cap = config.lessons.maxChars;
  const tail = (s) => (s.length > cap ? '…' + s.slice(-cap) : s);
  const parts = [];
  const cb = getLessons('codebase').trim();
  const p = getLessons('project').trim();
  const w = getLessons(workerName).trim();
  if (p) parts.push('### Team-wide\n' + tail(p));
  if (cb) parts.push('### Codebase notes (found by teammates; saves you exploring)\n' + tail(cb));
  if (w) parts.push(`### Your own (${workerName})\n` + tail(w));
  return parts.join('\n\n');
}

/** Teammates' findings about the codebase: the "## Notes for the team" section of an approved task's report goes to the shared notes. */
export function addNotesFrom(report, taskId) {
  const m = String(report || '').match(/^#{1,4}\s*Notes for the team\s*\n([\s\S]*?)(?=^#{1,4}\s|$(?![\s\S]))/im);
  if (!m) return 0;
  const lines = m[1].split('\n').map((x) => x.replace(/^\s*[-*•]\s*/, '').trim()).filter((x) => x.length > 8 && !/^none\b|^nothing\b|^n\/a/i.test(x)).slice(0, 5);
  const cur = getLessons('codebase');
  const fresh = lines.map((x) => x.slice(0, 240)).filter((x) => !cur.includes(x));
  if (!fresh.length) return 0;
  const day = new Date().toISOString().slice(0, 10);
  setLessons('codebase', (cur && !cur.endsWith('\n') ? cur + '\n' : cur) + fresh.map((x) => `- (${day}, task #${taskId}) ${x}`).join('\n') + '\n');
  return fresh.length;
}
