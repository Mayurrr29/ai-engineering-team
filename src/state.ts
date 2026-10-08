import fs from 'node:fs';
import path from 'node:path';
import type { CheckResult } from './checks.js';
import { paths, slugify } from './paths.js';
import type { AppliedRuleUpdate } from './rules.js';
import type { ScanLead } from './scans.js';
import type { Debrief, DesignOutput, DevOutput, Effort, FixOutput, LeadDecision, Lineup, MissionPlan, PmOutput, QaOutput, ReviewOutput, Severity } from './schemas.js';
import type { Actor, RoleId } from './team.js';

export type Step =
  | 'baseline'
  | 'plan'
  | 'pm'
  | 'clarify'
  | 'design'
  | 'develop'
  | 'checks'
  | 'qa'
  | 'fix'
  | 'arbitrate'
  | 'review'
  | 'rework'
  | 'release'
  | 'debrief'
  | 'done';

export type RunStatus = 'running' | 'approved' | 'rejected' | 'failed' | 'paused';
export type Mode = 'auto' | 'quick' | 'full';

/** A verdict remembers which version of the code it judged, so stale approvals can't pass the release gate. */
export type Verdict<T> = T & { codeVersion: number };

export interface WorkItem {
  id: string;
  source: 'qa' | 'checks' | 'security' | 'review';
  severity: Severity;
  title: string;
  details: string;
  /** Guidance from the team lead after arbitration. */
  guidance?: string;
}

export interface Waiver {
  id: string;
  severity: Severity;
  title: string;
  reason: string;
  by: 'lead' | 'human';
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

export interface TeamEvent {
  at: string;
  from: Actor;
  to?: Actor | 'team';
  kind: 'start' | 'done' | 'handoff' | 'guardrail' | 'decision' | 'question' | 'answer' | 'warning' | 'fail' | 'note';
  text: string;
}

export interface CallRecord {
  role: RoleId;
  step: Step;
  startedAt: string;
  ms: number;
  costUsd: number;
  turns: number;
  effort?: Effort;
  ok: boolean;
}

export interface ItemHistory {
  /** QA/review rounds in which the item was reported. */
  seen: number;
  /** Times a fixer claimed it was fixed. */
  fixClaims: number;
  /** Times a fixer said it is not a bug or could not fix it. */
  disputes: number;
  arbitrated: boolean;
}

export interface RunState {
  version: 2;
  id: string;
  feature: string;
  mode: Mode;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  status: RunStatus;
  next: Step;
  /** Number of fix/rework rounds performed. */
  iteration: number;
  maxIterations: number;
  /** Incremented every time an agent changes code. */
  codeVersion: number;
  budgetUsd?: number;
  costUsd: number;

  plan?: MissionPlan;
  lineup: Lineup;
  upgrades: Array<{ member: keyof Lineup; to: string; reason: string; at: string }>;
  effort: Partial<Record<RoleId, Effort>>;

  spec?: PmOutput;
  answers: Answer[];
  design?: DesignOutput;
  implementation?: DevOutput;
  fixes: Array<FixOutput & { by: 'bugFixer' | 'developer'; round: number }>;

  baseline?: { results: CheckResult[] };
  checks?: Verdict<{ results: CheckResult[]; blocking: string[]; preexisting: string[] }>;
  qa?: Verdict<QaOutput>;
  qaRounds: Array<{ round: number; codeVersion: number; status: 'PASS' | 'FAIL'; bugIds: string[]; bugs?: Array<{ id: string; title: string; severity: Severity }>; scenarios: number }>;
  security?: Verdict<ReviewOutput>;
  review?: Verdict<ReviewOutput>;
  scans: ScanLead[];
  diffStat?: { files: Array<{ path: string; added: number; deleted: number }>; changedLines: number; measured?: boolean };

  todo: WorkItem[];
  /** Which stage sent the current todo: QA/checks go to the Bug Fixer, reviews go back to the Developer. */
  todoFrom?: 'qa' | 'review';
  waivers: Waiver[];
  decisions: Array<LeadDecision & { at: string }>;
  items: Record<string, ItemHistory>;

  debrief?: Debrief;
  ruleUpdates: AppliedRuleUpdate[];

  events: TeamEvent[];
  calls: CallRecord[];
  integrity: string[];
  artifacts: ArtifactRef[];
  git?: { branch?: string; commits: boolean };
  baseCommit?: string;
  startedDirty?: boolean;
  error?: string;
  seq: number;
}

export function newRunState(feature: string, mode: Mode, maxIterations: number, opts: { budgetUsd?: number; now?: Date } = {}): RunState {
  const now = opts.now ?? new Date();
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
  const iso = now.toISOString();
  return {
    version: 2,
    id: `${stamp}-${slugify(feature)}`,
    feature,
    mode,
    createdAt: iso,
    updatedAt: iso,
    status: 'running',
    next: 'baseline',
    iteration: 0,
    maxIterations,
    codeVersion: 0,
    budgetUsd: opts.budgetUsd,
    costUsd: 0,
    lineup: { pm: 'off', architect: 'off', qa: 'off', security: 'off', reviewer: 'off' },
    upgrades: [],
    effort: {},
    answers: [],
    fixes: [],
    qaRounds: [],
    scans: [],
    todo: [],
    waivers: [],
    decisions: [],
    items: {},
    ruleUpdates: [],
    events: [],
    calls: [],
    integrity: [],
    artifacts: [],
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
    let store = new RunStore(root, state);
    // Two missions started in the same minute for the same feature get distinct ids.
    for (let i = 2; fs.existsSync(store.dir); i++) {
      state.id = `${state.id.replace(/-\d+$/, '')}-${i}`;
      store = new RunStore(root, state);
    }
    fs.mkdirSync(store.dir, { recursive: true });
    store.writeArtifact('plan', 'request.md', `# Mission request\n\n${state.feature}\n`, false);
    store.save();
    return store;
  }

  static load(root: string, id: string): RunStore {
    const file = path.join(paths(root).runs, id, 'state.json');
    if (!fs.existsSync(file)) throw new Error(`No mission "${id}" found in ${paths(root).runs}`);
    const state = JSON.parse(fs.readFileSync(file, 'utf8')) as RunState;
    if ((state as { version?: number }).version !== 2) {
      throw new Error(`Mission ${id} was created by ai-team v0.1 and can't be resumed by this version. Start a new mission with ai-team build.`);
    }
    return new RunStore(root, state);
  }

  static latestId(root: string): string | undefined {
    return RunStore.ids(root).at(-1);
  }

  static ids(root: string): string[] {
    const dir = paths(root).runs;
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((d) => fs.existsSync(path.join(dir, d, 'state.json')))
      .sort();
  }

  /** Lists missions, tolerating v0.1 state files. */
  static list(root: string): Array<Pick<RunState, 'id' | 'feature' | 'status' | 'mode' | 'iteration' | 'costUsd' | 'createdAt'> & { version: number; missionName?: string }> {
    return RunStore.ids(root).map((id) => {
      const s = JSON.parse(fs.readFileSync(path.join(paths(root).runs, id, 'state.json'), 'utf8'));
      return {
        id: s.id,
        feature: s.feature,
        status: s.status,
        mode: s.mode,
        iteration: s.iteration ?? 0,
        costUsd: s.costUsd ?? 0,
        createdAt: s.createdAt,
        version: s.version ?? 1,
        missionName: s.plan?.missionName,
      };
    });
  }

  save(): void {
    this.state.updatedAt = new Date().toISOString();
    const file = path.join(this.dir, 'state.json');
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, file);
  }

  /** Writes a numbered artifact (e.g. 04-qa-round1.md) and records it in state. */
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

  event(from: Actor, kind: TeamEvent['kind'], text: string, to?: TeamEvent['to']): void {
    this.state.events.push({ at: new Date().toISOString(), from, to, kind, text });
  }
}
