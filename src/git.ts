import { execFileSync } from 'node:child_process';
import { TEAM_DIR } from './paths.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function isGitRepo(cwd: string): boolean {
  try {
    return git(cwd, ['rev-parse', '--is-inside-work-tree']) === 'true';
  } catch {
    return false;
  }
}

/** Clean apart from the orchestrator's own .ai-team/ directory. */
export function isClean(cwd: string): boolean {
  const status = git(cwd, ['status', '--porcelain', '--', '.', `:(exclude)${TEAM_DIR}`]);
  return status.length === 0;
}

export function createBranch(cwd: string, name: string): string {
  let branch = name;
  for (let i = 2; branchExists(cwd, branch); i++) branch = `${name}-${i}`;
  git(cwd, ['checkout', '-b', branch]);
  return branch;
}

function branchExists(cwd: string, name: string): boolean {
  try {
    git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
    return true;
  } catch {
    return false;
  }
}

export function headCommit(cwd: string): string | undefined {
  try {
    return git(cwd, ['rev-parse', 'HEAD']);
  } catch {
    return undefined; // repo without commits
  }
}

export interface DiffSnapshot {
  stat: string;
  patch: string;
  untracked: string[];
  truncated: boolean;
}

/** Everything that changed since `base` (committed or not), excluding .ai-team/. */
export function diffSince(cwd: string, base: string, maxChars = 60_000): DiffSnapshot {
  const scope = ['--', '.', `:(exclude)${TEAM_DIR}`];
  const stat = git(cwd, ['diff', '--stat', base, ...scope]);
  const fullPatch = git(cwd, ['diff', base, ...scope]);
  const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard', ...scope]).split('\n').filter(Boolean);
  const truncated = fullPatch.length > maxChars;
  return { stat, patch: truncated ? fullPatch.slice(0, maxChars) : fullPatch, untracked, truncated };
}

/** Stages everything and commits. Returns false when there was nothing to commit. */
export function commitAll(cwd: string, message: string): boolean {
  git(cwd, ['add', '-A']);
  if (git(cwd, ['diff', '--cached', '--name-only']).length === 0) return false;
  git(cwd, ['commit', '-m', message]);
  return true;
}
