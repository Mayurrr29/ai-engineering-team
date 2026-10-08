import fs from 'node:fs';
import path from 'node:path';
import type { CheckResult } from './checks.js';
import { paths, slugify } from './paths.js';
import type { DevOutput, FixOutput, PmOutput, QaOutput, ReviewOutput, Severity } from './schemas.js';

export type Step = 'pm' | 'clarify' | 'develop' | 'checks' | 'qa' | 'fix' | 'security' | 'review' | 'rework' | 'release' | 'done';
export type RunStatus = 'running' | 'approved' | 'rejected' | 'failed';

/** A verdict remembers which version of the code it judged, so stale approvals can't pass the release gate. */
export type Verdict<T> = T & { codeVersion: number };

export interface WorkItem {
  id: string;
  source: 'qa' | 'checks' | 'security' | 'review';
  severity: Severity;
  title: string;
  details: string;
}

export interface Answer {
  id: string;
  question: string;
  answer: string;
  source: 'user' | 'default';
}

export interface ArtifactRef {
  step: Step;
  file: string;
  at: string;
}

export interface RunState {
  version: 1;
  id: string;
  feature: string;
  mode: 'quick' | 'standard';
  createdAt: string;
  updatedAt: string;
  status: RunStatus;
  next: Step;
  /** Number of fix/rework rounds performed. */
  iteration: number;
  maxIterations: number;
  /** Incremented every time an agent changes code. */
  codeVersion: number;
  spec?: PmOutput;
  answers: Answer[];
  implementation?: DevOutput;
  fixes: FixOutput[];
  checks?: Verdict<{ results: CheckResult[] }>;
  qa?: Verdict<QaOutput>;
  security?: Verdict<ReviewOutput>;
  review?: Verdict<ReviewOutput>;
  todo: WorkItem[];
  artifacts: ArtifactRef[];
  costUsd: number;
  git?: { branch?: string; commits: boolean };
  /** HEAD when the run started; reviewers get the diff against it. */
  baseCommit?: string;
  /** Whether the working tree had uncommitted changes when the run started. */
  startedDirty?: boolean;
  error?: string;
  seq: number;
}

export function newRunState(feature: string, mode: 'quick' | 'standard', maxIterations: number, now = new Date()): RunState {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
  const iso = now.toISOString();
  return {
    version: 1,
    id: `${stamp}-${slugify(feature)}`,
    feature,
    mode,
    createdAt: iso,
    updatedAt: iso,
    status: 'running',
    next: mode === 'quick' ? 'develop' : 'pm',
    iteration: 0,
    maxIterations,
    codeVersion: 0,
    answers: [],
    fixes: [],
    todo: [],
    artifacts: [],
    costUsd: 0,
    seq: 0,
  };
}

export class RunStore {
  readonly dir: string;

  constructor(
    readonly root: string,
    readonly state: RunState,
  ) {
    this.dir = path.join(paths(root).runs, state.id);
  }

  static create(root: string, state: RunState): RunStore {
    const store = new RunStore(root, state);
    fs.mkdirSync(store.dir, { recursive: true });
    store.writeArtifact('pm', 'request.md', `# Feature request\n\n${state.feature}\n`, false);
    store.save();
    return store;
  }

  static load(root: string, id: string): RunStore {
    const file = path.join(paths(root).runs, id, 'state.json');
    if (!fs.existsSync(file)) throw new Error(`No run "${id}" found in ${paths(root).runs}`);
    const state = JSON.parse(fs.readFileSync(file, 'utf8')) as RunState;
    return new RunStore(root, state);
  }

  /** Most recent run id, or undefined. */
  static latestId(root: string): string | undefined {
    const dir = paths(root).runs;
    if (!fs.existsSync(dir)) return undefined;
    const ids = fs
      .readdirSync(dir)
      .filter((d) => fs.existsSync(path.join(dir, d, 'state.json')))
      .sort();
    return ids.at(-1);
  }

  static list(root: string): RunState[] {
    const dir = paths(root).runs;
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .sort()
      .map((d) => path.join(dir, d, 'state.json'))
      .filter((f) => fs.existsSync(f))
      .map((f) => JSON.parse(fs.readFileSync(f, 'utf8')) as RunState);
  }

  save(): void {
    this.state.updatedAt = new Date().toISOString();
    const file = path.join(this.dir, 'state.json');
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, file);
  }

  /** Writes a numbered artifact (e.g. 03-qa-round1.md) and records it in state. */
  writeArtifact(step: Step, name: string, content: string, numbered = true): string {
    let file = name;
    if (numbered) {
      this.state.seq += 1;
      file = `${String(this.state.seq).padStart(2, '0')}-${name}`;
    }
    fs.writeFileSync(path.join(this.dir, file), content);
    this.state.artifacts.push({ step, file, at: new Date().toISOString() });
    return path.join(this.dir, file);
  }
}
