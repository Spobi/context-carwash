import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

const TIMEOUT_MS = 2000;

// One git query; null if git is missing, slow, or this is not a repository.
function git(cwd, args) {
  try {
    const result = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      // A background status must not hold the index lock against the user's own git.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

function canonical(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

// The folder a brief belongs to: the git worktree root, or the directory
// itself outside a repository.
export function worktreeRoot(cwd) {
  return canonical(git(cwd, ['rev-parse', '--show-toplevel']) || cwd);
}

// Where the repository stands, for telling later whether it moved. Fields that
// cannot be read are null, and a null is never reported as a change.
export function repoState(cwd) {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!top) return { worktree: canonical(cwd), branch: null, head: null, dirty: null };
  const status = git(cwd, ['status', '--porcelain']);
  return {
    worktree: canonical(top),
    branch: git(cwd, ['branch', '--show-current']) || null,
    head: git(cwd, ['rev-parse', 'HEAD']),
    dirty: status === null ? null : status !== '',
  };
}
