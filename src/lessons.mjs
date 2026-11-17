import fs from 'node:fs';
import { config, workerByName } from './config.mjs';
import { dataPath, emit } from './store.mjs';

const fileFor = (scope) => dataPath('lessons', `${scope === 'project' ? 'project' : scope.toLowerCase()}.md`);

export function scopes() {
  return ['project', ...config.workers.map((w) => w.name)];
}
export function validScope(scope) {
  return scope === 'project' || !!workerByName(scope);
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
  const p = getLessons('project').trim();
  const w = getLessons(workerName).trim();
  if (p) parts.push('### Team-wide\n' + tail(p));
  if (w) parts.push(`### Your own (${workerName})\n` + tail(w));
  return parts.join('\n\n');
}
