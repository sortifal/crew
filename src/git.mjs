import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { config } from './config.mjs';
import { dataPath } from './store.mjs';

export function git(cwd, args, { allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !allowFail) return reject(new Error(`git ${args.join(' ')}: ${(stderr || err.message).trim()}`));
      resolve({ code: err ? err.code ?? 1 : 0, out: stdout, err: stderr });
    });
  });
}

export async function ensureRepo() {
  const repo = config.project.repo;
  if (!repo || !fs.existsSync(repo)) throw new Error(`project.repo does not exist: "${repo}"`);
  const r = await git(repo, ['rev-parse', '--git-dir'], { allowFail: true });
  if (r.code) throw new Error(`${repo} is not a git repository`);
  const b = await git(repo, ['rev-parse', '--verify', config.project.baseBranch], { allowFail: true });
  if (b.code) throw new Error(`base branch "${config.project.baseBranch}" not found (does the repo have a commit?)`);
  // keep crew scratch files out of every worktree's status
  const gitDir = (await git(repo, ['rev-parse', '--git-common-dir'])).out.trim();
  const exclude = path.resolve(repo, gitDir, 'info', 'exclude');
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  const cur = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  if (!/^\.crew\/$/m.test(cur)) fs.appendFileSync(exclude, (cur.endsWith('\n') || !cur ? '' : '\n') + '.crew/\n');
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'task';
export const branchName = (t) => `crew/t${t.id}-${slug(t.title)}`;
export const worktreePath = (t) => dataPath('worktrees', `t${t.id}`);

export async function ensureWorktree(t) {
  const repo = config.project.repo;
  const wt = worktreePath(t);
  if (fs.existsSync(wt)) return wt;
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  const branch = branchName(t);
  const exists = (await git(repo, ['rev-parse', '--verify', branch], { allowFail: true })).code === 0;
  await git(repo, exists ? ['worktree', 'add', wt, branch] : ['worktree', 'add', '-b', branch, wt, config.project.baseBranch]);
  t.branch = branch;
  t.worktree = wt;
  return wt;
}

export async function commitAll(t, message) {
  const wt = worktreePath(t);
  await git(wt, ['add', '-A']);
  const st = await git(wt, ['status', '--porcelain']);
  if (!st.out.trim()) return false;
  await git(wt, ['-c', 'user.name=Crew', '-c', 'user.email=crew@localhost', 'commit', '-m', message]);
  return true;
}

export async function diffOf(t, { maxChars = 60000 } = {}) {
  const repo = config.project.repo;
  const range = `${config.project.baseBranch}...${branchName(t)}`;
  const stat = (await git(repo, ['diff', '--stat', range], { allowFail: true })).out;
  let patch = (await git(repo, ['diff', range], { allowFail: true })).out;
  let truncated = false;
  if (patch.length > maxChars) { patch = patch.slice(0, maxChars); truncated = true; }
  return { stat, patch, truncated };
}

export async function mergeTask(t, message) {
  const repo = config.project.repo;
  const base = config.project.baseBranch;
  const head = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).out.trim();
  if (head !== base) throw new Error(`repo is on "${head}", expected "${base}" – check out ${base} in ${repo} first`);
  const dirty = (await git(repo, ['status', '--porcelain', '--untracked-files=no'])).out.trim();
  if (dirty) throw new Error(`repo has uncommitted changes to tracked files; commit or stash them first`);
  const r = await git(repo, ['-c', 'user.name=Crew', '-c', 'user.email=crew@localhost', 'merge', '--no-ff', '-m', message, branchName(t)], { allowFail: true });
  if (r.code) {
    await git(repo, ['merge', '--abort'], { allowFail: true });
    throw new Error(`merge conflict – ${base} moved since this task started. Ask a worker to rebase/resolve (reject with feedback).`);
  }
  await cleanup(t);
}

export async function cleanup(t) {
  const repo = config.project.repo;
  await git(repo, ['worktree', 'remove', '--force', worktreePath(t)], { allowFail: true });
  await git(repo, ['branch', '-D', branchName(t)], { allowFail: true });
}

export async function updateFromBase(t) {
  // bring the worktree up to date with base (used before a retry after rejection)
  const wt = worktreePath(t);
  const r = await git(wt, ['-c', 'user.name=Crew', '-c', 'user.email=crew@localhost', 'merge', '--no-edit', config.project.baseBranch], { allowFail: true });
  if (r.code) { await git(wt, ['merge', '--abort'], { allowFail: true }); return false; }
  return true;
}
