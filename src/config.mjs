import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_PATH = path.resolve(process.env.CREW_CONFIG || path.join(ROOT, 'crew.config.yaml'));

const DEFAULTS = {
  project: { name: 'Project', repo: '', baseBranch: 'main', context: '' },
  head: { model: 'opus', autoReview: true, instructions: '' },
  workers: [{ name: 'Dev', role: 'Developer', persona: '' }],
  qwen: {
    command: 'qwen',
    args: ['--yolo', '-p', '{prompt}'],
    env: {},
    endpoint: 'http://localhost:8080/v1',
    apiKey: 'local',
    model: 'qwen3-coder',
    timeoutMinutes: 30,
  },
  scheduler: { maxParallel: 1, autoRetries: 1, maxAttempts: 4 },
  lessons: { maxChars: 6000 },
  dataDir: '',
};

function merge(base, over) {
  if (Array.isArray(base) || Array.isArray(over) || typeof base !== 'object' || base === null) return over ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) out[k] = k in base ? merge(base[k], v) : v;
  return out;
}

const posNum = (v, label, { int = false, min = 0, allowEmpty = false } = {}) => {
  if (allowEmpty && (v === '' || v === null || v === undefined)) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || (int && !Number.isInteger(n))) throw new Error(`config: ${label} must be ${int ? 'an integer' : 'a number'} ≥ ${min}`);
  return n;
};

export function normalize(raw) {
  const c = merge(DEFAULTS, raw || {});
  if (!Array.isArray(c.workers) || c.workers.length === 0) throw new Error('config: at least one agent is required');
  const names = new Set();
  for (const w of c.workers) {
    if (!w.name || !/^[A-Za-z][\w-]*$/.test(w.name)) throw new Error(`config: invalid agent name "${w.name}" (start with a letter; letters, digits, - and _ only)`);
    if (names.has(w.name.toLowerCase())) throw new Error(`config: duplicate agent "${w.name}"`);
    if (w.name.toLowerCase() === 'head' || w.name.toLowerCase() === 'you' || w.name.toLowerCase() === 'project') throw new Error(`config: "${w.name}" is a reserved name`);
    names.add(w.name.toLowerCase());
    w.role = String(w.role || 'Developer');
    w.persona = String(w.persona || '');
    w.enabled = w.enabled !== false;
    w.model = String(w.model || '').trim();
    w.endpoint = String(w.endpoint || '').trim();
    w.instructions = String(w.instructions || '');
    w.timeoutMinutes = posNum(w.timeoutMinutes, `${w.name}: timeout`, { min: 1, allowEmpty: true });
    w.autoRetries = posNum(w.autoRetries, `${w.name}: auto-retries`, { int: true, min: 0, allowEmpty: true });
  }
  c.project.repo = c.project.repo ? path.resolve(String(c.project.repo).replace(/^~/, process.env.HOME || '~')) : '';
  c.project.name = String(c.project.name || 'Project');
  c.project.baseBranch = String(c.project.baseBranch || 'main').trim();
  c.project.context = String(c.project.context || '');
  c.head.model = String(c.head.model || 'opus').trim();
  c.head.autoReview = c.head.autoReview !== false;
  c.head.instructions = String(c.head.instructions || '');
  if (!Array.isArray(c.qwen.args)) throw new Error('config: qwen.args must be a list');
  c.qwen.args = c.qwen.args.map(String);
  c.qwen.timeoutMinutes = posNum(c.qwen.timeoutMinutes, 'local model timeout', { min: 1 });
  c.scheduler.maxParallel = posNum(c.scheduler.maxParallel, 'max parallel runs', { int: true, min: 1 });
  c.scheduler.autoRetries = posNum(c.scheduler.autoRetries, 'auto-retries', { int: true, min: 0 });
  c.scheduler.maxAttempts = posNum(c.scheduler.maxAttempts, 'max attempts', { int: true, min: 1 });
  c.lessons.maxChars = posNum(c.lessons.maxChars, 'lessons size', { int: true, min: 500 });
  c.dataDir = path.resolve(c.dataDir || path.join(ROOT, 'data'));
  return c;
}

export const config = {};

export function loadConfig(text) {
  const src = text ?? fs.readFileSync(CONFIG_PATH, 'utf8');
  const next = normalize(YAML.parse(src));
  for (const k of Object.keys(config)) delete config[k];
  Object.assign(config, next);
  return config;
}

export function saveConfigText(text) {
  loadConfig(text); // validates, throws on error
  fs.writeFileSync(CONFIG_PATH, text);
}

/** Per-agent settings with fallbacks to the global local-model / scheduler settings. */
export function workerSettings(w) {
  const q = config.qwen;
  return {
    model: w.model || q.model,
    endpoint: w.endpoint || q.endpoint,
    apiKey: q.apiKey,
    timeoutMinutes: w.timeoutMinutes || q.timeoutMinutes,
    autoRetries: w.autoRetries ?? config.scheduler.autoRetries,
  };
}

const SECTIONS = ['project', 'head', 'workers', 'qwen', 'scheduler', 'lessons'];
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
/** Write a structured config (from the settings UI) to the YAML file, keeping the file's header comments. */
export function saveConfigObject(obj) {
  const cur = fs.readFileSync(CONFIG_PATH, 'utf8');
  const doc = YAML.parseDocument(cur);
  const clean = {
    project: pick(obj.project || {}, ['name', 'repo', 'baseBranch', 'context']),
    head: pick(obj.head || {}, ['model', 'autoReview', 'instructions']),
    workers: (obj.workers || []).map((w) => {
      const o = pick(w, ['name', 'role', 'persona']);
      if (w.enabled === false) o.enabled = false;
      for (const k of ['model', 'endpoint', 'instructions']) if (String(w[k] || '').trim()) o[k] = String(w[k]).trim();
      for (const k of ['timeoutMinutes', 'autoRetries']) if (w[k] !== null && w[k] !== undefined && w[k] !== '') o[k] = Number(w[k]);
      return o;
    }),
    qwen: pick(obj.qwen || {}, ['command', 'args', 'env', 'endpoint', 'apiKey', 'model', 'timeoutMinutes']),
    scheduler: pick(obj.scheduler || {}, ['maxParallel', 'autoRetries', 'maxAttempts']),
    lessons: pick(obj.lessons || {}, ['maxChars']),
  };
  for (const k of SECTIONS) doc.set(k, doc.createNode(clean[k]));
  const text = String(doc);
  loadConfig(text); // validates – throws before anything is written
  fs.writeFileSync(CONFIG_PATH, text);
}

export const workerByName = (name) =>
  config.workers.find((w) => w.name.toLowerCase() === String(name || '').toLowerCase());
