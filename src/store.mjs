import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { config } from './config.mjs';

export const bus = new EventEmitter();
bus.setMaxListeners(100);
export const emit = (type, data = {}) => bus.emit('event', { type, ...data });

const file = (name) => path.join(config.dataDir, name);

export function load(name, fallback) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return fallback; }
}
export function save(name, obj) {
  fs.mkdirSync(path.dirname(file(name)), { recursive: true });
  const tmp = file(name) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file(name));
}
export const dataPath = (...p) => path.join(config.dataDir, ...p);

/* ---- feeds (team channel, head chat, DMs) ---- */
const feeds = new Map();
function feedFor(name) {
  if (!feeds.has(name)) feeds.set(name, load(`${name}.json`, []));
  return feeds.get(name);
}
export function pushFeed(name, entry, evt) {
  const list = feedFor(name);
  const e = { id: (list.at(-1)?.id || 0) + 1, ts: Date.now(), ...entry };
  list.push(e);
  if (list.length > 2000) list.splice(0, list.length - 2000);
  save(`${name}.json`, list);
  emit(evt || 'feed', { feed: name, entry: e });
  return e;
}
export const getFeed = (name, limit = 300) => feedFor(name).slice(-limit);
export function clearFeed(name) { feeds.set(name, []); save(`${name}.json`, []); }

/* ---- tasks ---- */
let tasks = null;
const T = () => (tasks ??= load('tasks.json', []));
export const allTasks = () => T();
export const getTask = (id) => T().find((t) => t.id === Number(id));
export function createTaskRecord(fields) {
  const id = (T().reduce((m, t) => Math.max(m, t.id), 0)) + 1;
  const t = {
    id, status: 'queued', attempts: [], createdAt: Date.now(), updatedAt: Date.now(),
    dependsOn: [], acceptance: [], verify: '', feedback: [], ...fields,
  };
  T().push(t);
  persistTasks();
  emit('task', { task: t });
  return t;
}
export function persistTasks() { save('tasks.json', T()); }
export function touch(t) { t.updatedAt = Date.now(); persistTasks(); emit('task', { task: t }); }
