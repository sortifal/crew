import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_PATH = path.resolve(process.env.CREW_CONFIG || path.join(ROOT, 'crew.config.yaml'));

const DEFAULTS = {
  project: { name: 'Project', repo: '', baseBranch: 'main' },
  head: { model: 'opus', autoReview: true },
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

export function normalize(raw) {
  const c = merge(DEFAULTS, raw || {});
  if (!Array.isArray(c.workers) || c.workers.length === 0) throw new Error('config: at least one worker is required');
  const names = new Set();
  for (const w of c.workers) {
    if (!w.name || !/^[A-Za-z][\w-]*$/.test(w.name)) throw new Error(`config: invalid worker name "${w.name}" (letters, digits, - and _ only)`);
    if (names.has(w.name.toLowerCase())) throw new Error(`config: duplicate worker "${w.name}"`);
    names.add(w.name.toLowerCase());
    w.role ||= 'Developer';
    w.persona ||= '';
  }
  c.project.repo = c.project.repo ? path.resolve(String(c.project.repo).replace(/^~/, process.env.HOME || '~')) : '';
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

export const workerByName = (name) =>
  config.workers.find((w) => w.name.toLowerCase() === String(name || '').toLowerCase());
