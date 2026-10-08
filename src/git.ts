import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { TEAM_DIR } from './paths.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();
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
  return git(cwd, ['status', '--porcelain', '--', '.', `:(exclude)${TEAM_DIR}`]).length === 0;
}

export function headCommit(cwd: string): string | undefined {
  try {
    return git(cwd, ['rev-parse', 'HEAD']);
  } catch {
    return undefined; // repository without commits
  }
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

/** Stages everything and commits. Returns false when there was nothing to commit. */
export function commitAll(cwd: string, message: string): boolean {
  git(cwd, ['add', '-A']);
  if (git(cwd, ['diff', '--cached', '--name-only']).length === 0) return false;
  git(cwd, ['commit', '-m', message]);
  return true;
}

export function userFirstName(cwd: string): string | undefined {
  try {
    const name = git(cwd, ['config', 'user.name']);
    return name.split(/\s+/)[0] || undefined;
  } catch {
    return undefined;
  }
}

export interface DiffFile {
  path: string;
  added: number;
  deleted: number;
  untracked: boolean;
  /** Added lines (capped), used by guardrails and scans. */
  addedLines: string[];
}

export interface DiffSnapshot {
  stat: string;
  patch: string;
  untracked: string[];
  truncated: boolean;
  files: DiffFile[];
  changedLines: number;
}

const MAX_ADDED_LINES_PER_FILE = 2000;
const MAX_UNTRACKED_BYTES = 512 * 1024;

/** Everything that changed since `base` (committed or not), excluding .ai-team/. */
export function diffSince(cwd: string, base: string, maxChars = 60_000): DiffSnapshot {
  const scope = ['--', '.', `:(exclude)${TEAM_DIR}`];
  const stat = git(cwd, ['diff', '--stat', base, ...scope]);
  const fullPatch = git(cwd, ['diff', base, ...scope]);
  const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard', ...scope]).split('\n').filter(Boolean);

  const files = new Map<string, DiffFile>();
  for (const line of git(cwd, ['diff', '--numstat', base, ...scope]).split('\n').filter(Boolean)) {
    const [added, deleted, ...rest] = line.split('\t');
    const file = rest.join('\t');
    files.set(file, { path: file, added: Number(added) || 0, deleted: Number(deleted) || 0, untracked: false, addedLines: [] });
  }
  let current: DiffFile | undefined;
  for (const line of fullPatch.split('\n')) {
    if (line.startsWith('+++ ')) {
      const name = line.slice(4).replace(/^b\//, '');
      current = files.get(name);
    } else if (current && line.startsWith('+') && current.addedLines.length < MAX_ADDED_LINES_PER_FILE) {
      current.addedLines.push(line.slice(1));
    }
  }
  for (const file of untracked) {
    const abs = path.join(cwd, file);
    let lines: string[] = [];
    try {
      const st = fs.statSync(abs);
      if (st.isFile() && st.size <= MAX_UNTRACKED_BYTES) lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
    } catch {
      // unreadable: count as zero lines
    }
    files.set(file, { path: file, added: lines.length, deleted: 0, untracked: true, addedLines: lines.slice(0, MAX_ADDED_LINES_PER_FILE) });
  }

  const list = [...files.values()];
  // New files aren't in `git diff`; show their contents as additions so reviewers see everything.
  const newFiles = list
    .filter((f) => f.untracked && f.addedLines.length)
    .map((f) => `diff --git a/${f.path} b/${f.path}\nnew file\n--- /dev/null\n+++ b/${f.path}\n${f.addedLines.map((l) => `+${l}`).join('\n')}`)
    .join('\n');
  const combined = [fullPatch, newFiles].filter(Boolean).join('\n');
  const truncated = combined.length > maxChars;
  return {
    stat,
    patch: truncated ? combined.slice(0, maxChars) : combined,
    untracked,
    truncated,
    files: list,
    changedLines: list.reduce((sum, f) => sum + f.added + f.deleted, 0),
  };
}

/** A cheap fingerprint of the working tree (excluding .ai-team/), used to detect unexpected edits by read-only members. */
export function treeFingerprint(cwd: string): string | undefined {
  try {
    return git(cwd, ['status', '--porcelain', '--', '.', `:(exclude)${TEAM_DIR}`]) + '\n' + git(cwd, ['diff', '--stat', '--', '.', `:(exclude)${TEAM_DIR}`]);
  } catch {
    return undefined;
  }
}
