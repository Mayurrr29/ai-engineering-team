import fs from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import { costTable, estimateMission, readStats, recordStats } from './budget.js';
import { classifyChecks, runChecks } from './checks.js';
import { completenessGaps, isNonCodeTask } from './completeness.js';
import type { Config } from './config.js';
import * as git from './git.js';
import { diffGuardrails, isSolo, planGuardrails, raise, type DiffMetrics, type Upgrade } from './guardrails.js';
import { detectPacks, type PackId } from './packs.js';
import { buildSystemPrompt, loadProfile, type PromptContext } from './playbooks.js';
import { paths, slugify } from './paths.js';
import * as P from './prompts.js';
import { AgentError, type Access, type AIProvider, type TokenUsage } from './providers/types.js';
import { blocks, evaluateRelease, renderRelease, type ReleaseDecision } from './release.js';
import { renderAnswer, renderChecks, renderDebrief, renderDecision, renderDesign, renderFix, renderImplementation, renderPlan, renderQa, renderReview, renderRunFlow, renderSpec, stripNumber } from './render.js';
import { writeReport } from './report/html.js';
import { applyRuleUpdates, ensureRulebook, learnedRules } from './rules.js';
import { scanDiff } from './scans.js';
import {
  AnswerOutput,
  Debrief,
  DesignOutput,
  DevOutput,
  FixOutput,
  LeadDecision,
  MissionPlan,
  PmOutput,
  QaOutput,
  ReviewOutput,
  toJsonSchema,
  type Effort,
  type Lineup,
  type Severity,
  type Signal,
} from './schemas.js';
import { newRunState, RunStore, type Mode, type RunState, type Step, type WorkItem } from './state.js';
import { MEMBERS, nameOf, type RoleId, type TeamNames } from './team.js';
import { silentUI, type TeamUI } from './ui/types.js';

export interface OrchestratorOptions {
  root: string;
  config: Config;
  provider: AIProvider;
  ui?: TeamUI;
  /** Ask the human a question; return undefined to accept the default. Omit for non-interactive runs. */
  ask?: (question: string, proposedDefault: string) => Promise<string | undefined>;
}

export interface RunOutcome {
  state: RunState;
  decision?: ReleaseDecision;
  dir: string;
  reportPath?: string;
}

class BudgetExhausted extends Error {}

const STEP_TITLES: Record<Exclude<Step, 'done'>, string> = {
  baseline: 'Baseline checks',
  plan: 'Mission planning',
  pm: 'Specification',
  clarify: 'Clarifications',
  design: 'Design',
  develop: 'Implementation',
  checks: 'Checks',
  qa: 'QA',
  fix: 'Bug fixing',
  arbitrate: 'Team lead ruling',
  review: 'Reviews',
  rework: 'Rework',
  release: 'Release gate',
  debrief: 'Debrief',
  answer: 'Answer',
};

const SEVERITY_ORDER: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const READ: Access = { read: true, run: false, write: 'none' };
const NONE: Access = { read: false, run: false, write: 'none' };
const WRITE: Access = { read: true, run: true, write: 'repo' };

export class Orchestrator {
  private readonly ui: TeamUI;
  private readonly names: TeamNames;
  private ctx!: PromptContext;
  private diffCache?: { version: number; diff?: git.DiffSnapshot };

  constructor(private readonly opts: OrchestratorOptions) {
    this.ui = opts.ui ?? silentUI;
    this.names = opts.config.team.names;
  }

  private get root() {
    return this.opts.root;
  }
  private get config() {
    return this.opts.config;
  }
  private name(role: RoleId | 'gate') {
    return nameOf(role, this.names);
  }

  /** Starts a new mission. */
  async build(feature: string, opts: { budgetUsd?: number } = {}): Promise<RunOutcome> {
    const state = newRunState(feature, this.config.mode as Mode, this.config.maxIterations, { budgetUsd: opts.budgetUsd ?? this.config.budgetUsd });
    const store = RunStore.create(this.root, state);
    this.setupGit(store);
    if (!this.config.checks.length || !this.config.baselineChecks) state.next = 'plan';
    store.save();
    return this.drive(store);
  }

  /** Continues a failed, paused or interrupted mission from its last unfinished step. */
  async resume(runId: string, opts: { budgetUsd?: number } = {}): Promise<RunOutcome> {
    const store = RunStore.load(this.root, runId);
    const { state } = store;
    if (state.status === 'approved' || state.status === 'rejected') throw new Error(`Mission ${runId} already finished (${state.status}).`);
    if (opts.budgetUsd !== undefined) state.budgetUsd = opts.budgetUsd;
    state.status = 'running';
    state.error = undefined;
    store.event('system', 'note', `Mission resumed at step "${state.next}".`);
    return this.drive(store);
  }

  private async drive(store: RunStore): Promise<RunOutcome> {
    const { state } = store;
    ensureRulebook(this.root);
    this.ctx = { names: this.names, packs: this.packs(), profile: loadProfile(this.root) };
    this.ui.start(state);
    let decision: ReleaseDecision | undefined;
    while (state.next !== 'done') {
      const step = state.next;
      store.event('system', 'start', `step:${step}`);
      try {
        if (step === 'release') decision = this.release(store);
        else await this.runStep(store, step);
      } catch (err) {
        const budget = err instanceof BudgetExhausted || (err instanceof AgentError && err.kind === 'budget');
        state.status = budget ? 'paused' : 'failed';
        state.error = budget
          ? `Spending limit reached ($${state.costUsd.toFixed(2)} of $${(state.budgetUsd ?? 0).toFixed(2)}) during ${STEP_TITLES[step].toLowerCase()}.`
          : (err as Error).message;
        store.event('system', budget ? 'warning' : 'fail', state.error);
        this.ui.log(budget ? 'warn' : 'fail', `${STEP_TITLES[step]} ${budget ? 'paused' : 'failed'}: ${state.error}`);
        const reportPath = this.save(store);
        this.ui.finish(state, undefined, reportPath);
        return { state, dir: store.dir, reportPath };
      }
      this.save(store);
      this.ui.update(state);
    }
    if (!decision && (state.status === 'approved' || state.status === 'rejected')) decision = evaluateRelease(state, this.gateOpts());
    const reportPath = this.save(store);
    this.ui.finish(state, decision, reportPath);
    return { state, decision, dir: store.dir, reportPath };
  }

  private save(store: RunStore): string | undefined {
    store.save();
    try {
      return writeReport(store, { names: this.names, checksConfigured: this.config.checks.length > 0, humanName: this.humanName() });
    } catch (err) {
      this.ui.log('warn', `Could not write the HTML report: ${(err as Error).message}`);
      return undefined;
    }
  }

  private async runStep(store: RunStore, step: Exclude<Step, 'release' | 'done'>): Promise<void> {
    switch (step) {
      case 'baseline':
        return this.stepBaseline(store);
      case 'plan':
        return this.stepPlan(store);
      case 'pm':
        return this.stepPm(store);
      case 'clarify':
        return this.stepClarify(store);
      case 'design':
        return this.stepDesign(store);
      case 'develop':
        return this.stepDevelop(store);
      case 'checks':
        return this.stepChecks(store);
      case 'qa':
        return this.stepQa(store);
      case 'fix':
        return this.stepFix(store);
      case 'arbitrate':
        return this.stepArbitrate(store);
      case 'review':
        return this.stepReview(store);
      case 'rework':
        return this.stepRework(store);
      case 'debrief':
        return this.stepDebrief(store);
      case 'answer':
        return this.stepAnswer(store);
    }
  }

  // ── Steps ────────────────────────────────────────────────────────────────

  private async stepBaseline(store: RunStore) {
    const { state } = store;
    this.ui.log('info', 'Running checks on the untouched code first (baseline)…');
    const results = await runChecks(this.config.checks, this.root, this.config.checkTimeoutSec);
    state.baseline = { results };
    store.writeArtifact('baseline', 'checks-baseline.md', renderChecks(results, { title: 'Baseline checks (before the mission)' }));
    const failing = results.filter((r) => !r.passed).map((r) => r.name);
    if (failing.length) {
      store.event('system', 'warning', `Already failing before the mission: ${failing.join(', ')}. The team won't be blamed for these.`, 'team');
      this.ui.log('warn', `Already failing before the mission: ${failing.join(', ')} — the team won't be blamed for these`);
    } else {
      this.ui.log('ok', `Baseline: ${results.map((r) => r.name).join(', ')} all passing`);
    }
    state.next = 'plan';
  }

  private async stepPlan(store: RunStore) {
    const { state } = store;
    let plan: MissionPlan;
    if (state.mode === 'auto') {
      const stats = readStats(this.root);
      plan = await this.call(store, 'lead', 'plan', P.planPrompt(state, { names: this.names, costTable: costTable(stats), checks: this.config.checks.map((c) => c.name), packs: this.ctx.packs, hasProfile: !!this.ctx.profile }), MissionPlan, {
        access: READ,
        effort: this.config.effort.lead ?? 'medium',
        maxTurns: 30,
        detail: 'sizing the mission',
      });
    } else {
      plan = fixedPlan(state.mode, state.feature);
    }
    state.plan = plan;
    if (plan.taskType === 'question' || plan.taskType === 'planning') {
      this.routeNonCode(store, plan);
      return;
    }
    const guarded = planGuardrails(plan);
    state.lineup = guarded.lineup;
    this.recordUpgrades(store, guarded.upgrades);
    state.effort = { ...plan.effort, ...this.config.effort, lead: this.config.effort.lead ?? 'medium' };
    const estimate = estimateMission(readStats(this.root), plan.size, state.lineup);
    if (state.mode === 'auto') plan.estimatedCostUsd = plan.estimatedCostUsd || estimate;

    const team = this.staffedRoles(state).map((r) => this.name(r));
    const headline = `${plan.size} · risk ${plan.risk}${plan.riskAreas.length ? ` (${plan.riskAreas.join(', ')})` : ''} · ${team.length === 1 ? `solo: ${team[0]}` : `team of ${team.length}: ${team.join(', ')}`}`;
    store.event('lead', 'handoff', `Mission planned — ${headline}. ${plan.rationale}`, 'team');
    this.ui.member('lead', 'done', headline);
    if (state.budgetUsd && estimate > state.budgetUsd) {
      store.event('lead', 'warning', `Estimated cost $${estimate.toFixed(2)} is above the $${state.budgetUsd.toFixed(2)} budget. ${plan.budgetNote}`, 'human');
      this.ui.log('warn', `Estimated $${estimate.toFixed(2)} vs budget $${state.budgetUsd.toFixed(2)}. ${plan.budgetNote}`, 'lead');
    }
    store.writeArtifact('plan', 'mission-plan.md', renderPlan(plan, state, this.names));
    state.next = state.lineup.pm === 'full' ? 'pm' : state.lineup.architect === 'full' ? 'design' : 'develop';
  }

  /** Questions and planning requests end with an answer or a plan: no developer, no code gate. */
  private routeNonCode(store: RunStore, plan: MissionPlan) {
    const { state } = store;
    store.writeArtifact('plan', 'mission-plan.md', renderPlan(plan, state, this.names));
    if (plan.taskType === 'question') {
      state.lineup = { pm: 'off', architect: 'off', qa: 'off', security: 'off', reviewer: 'off' };
      if (plan.answer.trim()) {
        this.ui.member('lead', 'done', 'answered');
        this.finishNonCode(store, { answer: plan.answer.trim(), evidence: [], followUps: [] });
        return;
      }
      state.lineup.architect = 'full';
      this.ui.member('lead', 'done', `question → ${this.name('architect')}`);
      store.event('lead', 'handoff', `This is a question, not a change. ${this.name('architect')} will answer it.`, 'architect');
      state.next = 'answer';
      return;
    }
    // planning: a spec when the request is ambiguous, always a design; nothing gets built.
    state.lineup = { pm: plan.lineup.pm, architect: 'full', qa: 'off', security: 'off', reviewer: 'off' };
    state.effort = { ...plan.effort, ...this.config.effort };
    this.ui.member('lead', 'done', `planning · ${state.lineup.pm === 'full' ? `${this.name('pm')} + ` : ''}${this.name('architect')}`);
    store.event('lead', 'handoff', `Planning mission: the result is a plan, not code. ${plan.rationale}`, 'team');
    state.next = state.lineup.pm === 'full' ? 'pm' : 'design';
  }

  private async stepAnswer(store: RunStore) {
    const { state } = store;
    const answer = await this.call(store, 'architect', 'answer', P.answerPrompt(state, this.env()), AnswerOutput, {
      access: READ,
      effort: state.plan?.effort.architect ?? 'medium',
      detail: 'answering',
    });
    this.ui.member('architect', 'done', 'answered');
    this.finishNonCode(store, answer);
  }

  private finishNonCode(store: RunStore, answer?: AnswerOutput) {
    const { state } = store;
    if (answer) {
      state.answer = answer;
      store.writeArtifact('answer', 'answer.md', renderAnswer(state.feature, answer));
      store.event(state.calls.at(-1)?.role ?? 'lead', 'handoff', answer.answer.split('\n')[0].slice(0, 200), 'human');
    }
    state.status = answer ? 'answered' : 'planned';
    recordStats(this.root, state.calls.filter((c) => c.ok).map((c) => ({ role: c.role, costUsd: c.costUsd, ms: c.ms })));
    state.finishedAt = new Date().toISOString();
    state.next = 'done';
  }

  private async stepPm(store: RunStore) {
    const { state } = store;
    const spec = await this.call(store, 'pm', 'pm', P.pmPrompt(state, this.env()), PmOutput, { access: READ, detail: 'writing the spec' });
    state.spec = spec;
    const summary = `${spec.acceptanceCriteria.length} criteria · ${spec.edgeCases.length} edge cases${spec.openQuestions.length ? ` · ${spec.openQuestions.length} question(s)` : ''}`;
    this.ui.member('pm', 'done', summary);
    store.event('pm', 'handoff', `Spec ready: ${summary}.`, spec.openQuestions.length ? 'human' : state.lineup.architect === 'full' ? 'architect' : 'developer');
    if (spec.openQuestions.length) {
      state.next = 'clarify';
      return;
    }
    store.writeArtifact('pm', 'requirements.md', renderSpec(spec));
    state.next = state.lineup.architect === 'full' ? 'design' : 'develop';
  }

  private async stepClarify(store: RunStore) {
    const { state } = store;
    const spec = state.spec!;
    if (this.opts.ask) this.ui.suspend();
    try {
      for (const q of spec.openQuestions) {
        if (state.answers.some((a) => a.id === q.id)) continue;
        store.event('pm', 'question', `${q.id}: ${q.question} (default: ${q.proposedDefault})`, 'human');
        const answered = this.opts.ask ? await this.opts.ask(`${q.id}: ${q.question}`, q.proposedDefault) : undefined;
        const answer = answered?.trim();
        state.answers.push({ id: q.id, question: q.question, answer: answer || q.proposedDefault, source: answer ? 'user' : 'default' });
        store.event('human', 'answer', `${q.id}: ${answer || `(default) ${q.proposedDefault}`}`, 'pm');
      }
    } finally {
      if (this.opts.ask) this.ui.resume();
    }
    store.writeArtifact('clarify', 'requirements.md', renderSpec(spec, state.answers));
    this.ui.log('ok', `Requirements finalized (${state.answers.filter((a) => a.source === 'user').length} answered, ${state.answers.filter((a) => a.source === 'default').length} default)`, 'pm');
    state.next = state.lineup.architect === 'full' ? 'design' : 'develop';
  }

  private async stepDesign(store: RunStore) {
    const { state } = store;
    const design = await this.call(store, 'architect', 'design', P.designPrompt(state, this.env()), DesignOutput, { access: READ, detail: 'designing' });
    state.design = design;
    const summary = `${design.decisions.length} decisions · ${design.filePlan.length} files planned`;
    this.ui.member('architect', 'done', summary);
    store.writeArtifact('design', 'design.md', renderDesign(design));
    if (state.plan?.taskType === 'planning') {
      store.event('architect', 'handoff', `Plan ready: ${design.approach}`, 'human');
      this.finishNonCode(store);
      return;
    }
    store.event('architect', 'handoff', `Design ready: ${design.approach}`, 'developer');
    state.next = 'develop';
  }

  private async stepDevelop(store: RunStore) {
    const { state } = store;
    const dev = await this.call(store, 'developer', 'develop', P.developPrompt(state, this.env()), DevOutput, { access: WRITE, detail: state.plan?.taskType === 'bugfix' ? 'debugging' : 'building' });
    state.implementation = dev;
    state.coverage = Object.fromEntries(dev.criteriaCoverage.map((c) => [c.id, { status: c.status, notes: c.notes }]));
    state.codeVersion += 1;
    store.writeArtifact('develop', 'implementation.md', renderImplementation(dev));
    const open = dev.criteriaCoverage.filter((c) => c.status !== 'DONE');
    const summary = `${dev.filesChanged.length} file(s) · ${dev.testsAdded.length} test(s)${open.length ? ` · ${open.length} not fully done` : ''}`;
    this.ui.member('developer', 'done', summary);
    store.event('developer', 'handoff', `Implemented: ${dev.summary}`, state.lineup.qa !== 'off' ? 'qa' : 'team');
    if (open.length) this.ui.log('warn', `Reports ${open.length} item(s) not fully done: ${open.map((o) => o.id).join(', ')}`, 'developer');
    this.afterCodeChange(store, `implement ${slugify(state.feature)}`);
    state.next = 'checks';
    await this.absorbSignals(store, 'developer', dev.signals);
  }

  private async stepChecks(store: RunStore) {
    const { state } = store;
    const { checks, checkTimeoutSec } = this.config;
    const results = await runChecks(checks, this.root, checkTimeoutSec);
    const { blocking, preexisting } = classifyChecks(results, state.baseline?.results);
    state.checks = { results, blocking, preexisting, codeVersion: state.codeVersion };
    if (results.length) {
      store.writeArtifact('checks', `checks-v${state.codeVersion}.md`, renderChecks(results, { preexisting }));
      for (const r of results) {
        const note = preexisting.includes(r.name) ? ' (already failing before the mission)' : '';
        this.ui.log(r.passed ? 'ok' : preexisting.includes(r.name) ? 'warn' : 'fail', `check ${r.name} ${r.passed ? 'passed' : 'failed'} in ${(r.durationMs / 1000).toFixed(1)}s${note}`, 'system');
      }
      store.event('system', blocking.length ? 'warning' : 'note', `Checks on revision ${state.codeVersion}: ${results.map((r) => `${r.name} ${r.passed ? '✓' : '✗'}`).join(' · ')}`, 'team');
    }

    // Incomplete work goes straight back to the developer: testing and reviewing it would be wasted.
    const gaps = this.completenessItems(state);
    if (gaps.length) {
      this.ui.log('warn', `not done yet: ${gaps.map((g) => g.id).join(', ')}`, 'system');
      store.event('system', 'note', `Not done yet: ${gaps.map((g) => `${g.id} — ${g.title}`).join('; ')}`, 'developer');
      this.route(store, [...gaps, ...this.checkItems(state)], 'completeness');
      return;
    }
    if (state.lineup.qa !== 'off') state.next = 'qa';
    else if (blocking.length) this.route(store, this.checkItems(state), 'qa');
    else state.next = this.afterQaStep(state);
  }

  private async stepQa(store: RunStore) {
    const { state } = store;
    const round = state.qaRounds.length + 1;
    const labDir = path.join(store.dir, `qa-lab-${round}`);
    fs.mkdirSync(labDir, { recursive: true });
    const qa = await this.call(
      store,
      'qa',
      'qa',
      P.qaPrompt(state, { ...this.env(), diff: this.diff(state), delta: this.delta(state, state.qa?.codeVersion), labDir, depth: state.lineup.qa }),
      QaOutput,
      {
        access: { read: true, run: true, write: 'lab', labDir },
        // Re-test rounds verify fixes and probe what they touched; they need less thinking than the first sweep.
        effort: round > 1 ? lowerEffort(state.effort.qa) : undefined,
        detail: `testing (round ${round})`,
        readOnlyRepo: true,
      },
    );
    state.qa = { ...qa, codeVersion: state.codeVersion };
    state.qaRounds.push({ round, codeVersion: state.codeVersion, status: qa.status, bugIds: qa.bugs.map((b) => b.id), bugs: qa.bugs.map((b) => ({ id: b.id, title: b.title, severity: b.severity })), scenarios: qa.scenarios.length });
    store.writeArtifact('qa', `qa-round${round}.md`, renderQa(qa, round));
    await this.absorbSignals(store, 'qa', qa.signals);

    const items = [...this.qaItems(state), ...this.completenessItems(state)];
    if (items.length) {
      this.ui.member('qa', 'done', `${qa.scenarios.length} scenarios · ${items.length} issue(s): ${items.map((i) => `${i.id} ${i.severity}`).join(', ')}`);
      store.event('qa', 'handoff', `Found ${items.map((i) => `${i.id} (${i.severity}) ${i.title}`).join('; ')}`, 'bugFixer');
      this.route(store, items, 'qa');
    } else {
      const low = qa.bugs.filter((b) => !blocks(b.severity)).length;
      this.ui.member('qa', 'done', `${qa.scenarios.length} scenarios · passed${low ? ` · ${low} minor note(s)` : ''}`);
      store.event('qa', 'handoff', `QA passed: ${qa.scenarios.length} scenarios.${low ? ` ${low} low-severity note(s) recorded as follow-ups.` : ''}`, 'team');
      state.todo = [];
      state.next = this.afterQaStep(state);
    }
  }

  private async stepFix(store: RunStore) {
    const { state } = store;
    const items = state.todo;
    const detail = `fixing ${items.map((t) => t.id).join(', ')}`;
    const session = this.fixerSession(state);
    let by: 'developer' | 'bugFixer' = session ? 'developer' : 'bugFixer';
    let fix: FixOutput;
    try {
      fix = session
        ? await this.call(store, 'developer', 'fix', P.fixPrompt(state, { ...this.env(), inSession: true, delta: this.delta(state, session.codeVersion) }), FixOutput, { access: WRITE, detail, resumeSessionId: session.id })
        : await this.call(store, 'bugFixer', 'fix', P.fixPrompt(state, this.env()), FixOutput, { access: WRITE, detail });
    } catch (err) {
      if (!session || err instanceof BudgetExhausted || (err instanceof AgentError && err.kind === 'budget')) throw err;
      this.ui.log('warn', `${this.name('developer')}'s session could not continue (${(err as Error).message.slice(0, 80)}) — ${this.name('bugFixer')} takes over`, 'system');
      delete state.sessions?.developer;
      by = 'bugFixer';
      fix = await this.call(store, 'bugFixer', 'fix', P.fixPrompt(state, this.env()), FixOutput, { access: WRITE, detail });
    }
    state.fixes.push({ ...fix, by, round: state.iteration });
    for (const f of fix.fixes) {
      const h = this.history(state, f.id);
      if (f.status === 'FIXED') h.fixClaims += 1;
      else h.disputes += 1;
      if (f.status === 'FIXED' && state.coverage?.[f.id]) state.coverage[f.id] = { status: 'DONE', notes: f.change };
    }
    state.codeVersion += 1;
    store.writeArtifact('fix', `fix-round${state.iteration}.md`, renderFix(fix, `Bug fixes — round ${state.iteration}`, items));
    const fixed = fix.fixes.filter((f) => f.status === 'FIXED').map((f) => f.id);
    const disputed = fix.fixes.filter((f) => f.status !== 'FIXED');
    this.ui.member(by, 'done', `${fixed.length} fixed${disputed.length ? ` · ${disputed.length} disputed` : ''}`);
    store.event(by, 'handoff', `${fixed.length ? `Fixed ${fixed.join(', ')}. ` : ''}${disputed.map((d) => `${d.id}: ${d.status} — ${d.rootCause}`).join(' ')}`.trim(), 'qa');
    for (const d of disputed) this.ui.log('warn', `${d.id} ${d.status.toLowerCase().replace(/_/g, ' ')}: ${d.rootCause}`, by);
    this.afterCodeChange(store, `fix ${items.map((t) => t.id).join(', ')}`);
    state.todo = [];
    state.next = 'checks';
    await this.absorbSignals(store, by, fix.signals);
  }

  /**
   * The developer fixes QA's findings in her own session: she knows the code and her context is cached. The Bug
   * Fixer comes in with fresh eyes when the team lead asked for a different approach, or when there's no session.
   */
  private fixerSession(state: RunState): { id: string; codeVersion: number } | undefined {
    if (this.config.loop.fixer !== 'auto') return undefined;
    if (state.todo.some((t) => t.guidance)) return undefined;
    return state.sessions?.developer;
  }

  private async stepArbitrate(store: RunStore) {
    const { state } = store;
    const decision = await this.call(store, 'lead', 'arbitrate', P.arbitratePrompt(state, this.env()), LeadDecision, {
      access: READ,
      effort: this.config.effort.lead ?? 'high',
      maxTurns: 30,
      detail: `ruling on ${state.todo.map((t) => t.id).join(', ')}`,
    });
    state.decisions.push({ ...decision, at: new Date().toISOString() });
    store.writeArtifact('arbitrate', `ruling-${state.decisions.length}.md`, renderDecision(decision, this.names));
    this.ui.member('lead', 'done', decision.summary);
    store.event('lead', 'decision', decision.summary, 'team');

    const remaining: WorkItem[] = [];
    for (const item of state.todo) {
      this.history(state, item.id).arbitrated = true;
      const blocker = state.signals?.find((b) => b.id === item.id);
      if (blocker) blocker.resolved = true;
      const ruling = decision.rulings.find((r) => r.id === item.id) ?? { id: item.id, ruling: 'fix' as const, reason: 'No ruling given.', guidance: '' };
      let verdict = ruling.ruling;
      if (verdict === 'waive' && (item.severity === 'HIGH' || item.severity === 'CRITICAL')) {
        verdict = 'escalate';
        store.event('gate', 'guardrail', `${this.name('lead')} can't waive ${item.id} (${item.severity}); escalating to the human.`, 'human');
      }
      if (verdict === 'waive') {
        state.waivers.push({ id: item.id, severity: item.severity, title: item.title, reason: ruling.reason, by: 'lead' });
        this.ui.log('event', `waived ${item.id}: ${ruling.reason}`, 'lead');
        continue;
      }
      if (verdict === 'escalate') {
        const question = ruling.guidance || ruling.reason;
        store.event('lead', 'question', `${item.id}: ${question}`, 'human');
        let answer: string | undefined;
        if (this.opts.ask) {
          this.ui.suspend();
          try {
            answer = (await this.opts.ask(`${item.id} (${item.severity}): ${question}\n    Type "waive" to accept the risk, or give the team instructions`, 'keep fixing'))?.trim();
          } finally {
            this.ui.resume();
          }
        }
        if (answer && /^waive$/i.test(answer)) {
          state.waivers.push({ id: item.id, severity: item.severity, title: item.title, reason: 'Accepted by the human after escalation.', by: 'human' });
          store.event('human', 'answer', `${item.id}: waived`, 'lead');
          continue;
        }
        if (answer) store.event('human', 'answer', `${item.id}: ${answer}`, 'lead');
        remaining.push({ ...item, guidance: answer || ruling.reason });
        continue;
      }
      remaining.push({ ...item, guidance: ruling.guidance || ruling.reason });
    }

    const from = state.todoFrom ?? 'qa';
    if (!remaining.length) {
      state.todo = [];
      state.next = this.nextAfterClearing(state, from);
      return;
    }
    this.loopBack(store, remaining, from === 'qa' ? 'fix' : 'rework');
  }

  private async stepReview(store: RunStore) {
    const { state } = store;
    state.reviewRounds = (state.reviewRounds ?? 0) + 1;
    const diff = this.diff(state);
    const jobs: Array<Promise<{ role: 'security' | 'reviewer'; review: ReviewOutput }>> = [];
    // A reviewer whose approval already covers the current code isn't asked again (e.g. a teammate joined later).
    const stands = (v?: { codeVersion: number; status: string }) => v?.codeVersion === state.codeVersion && v.status === 'APPROVED';
    if (state.lineup.security !== 'off' && !stands(state.security)) {
      jobs.push(
        this.call(store, 'security', 'review', P.securityPrompt(state, { ...this.env(), diff, delta: this.delta(state, state.security?.codeVersion), leads: state.scans, depth: state.lineup.security }), ReviewOutput, {
          access: READ,
          detail: 'attacking the change',
          readOnlyRepo: true,
        }).then((review) => ({ role: 'security' as const, review })),
      );
    }
    if (state.lineup.reviewer !== 'off' && !stands(state.review)) {
      jobs.push(
        this.call(store, 'reviewer', 'review', P.reviewPrompt(state, { ...this.env(), diff, delta: this.delta(state, state.review?.codeVersion), leads: state.scans, depth: state.lineup.reviewer }), ReviewOutput, {
          access: READ,
          detail: 'reviewing the diff',
          readOnlyRepo: true,
        }).then((review) => ({ role: 'reviewer' as const, review })),
      );
    }
    const settled = await Promise.allSettled(jobs);
    const failed = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');

    const items: WorkItem[] = [];
    for (const s of settled) {
      if (s.status !== 'fulfilled') continue;
      const { role, review } = s.value;
      const open = review.findings.filter((f) => blocks(f.severity) && !state.waivers.some((w) => w.id === f.id));
      const rejectedEmpty = review.status === 'REJECTED' && review.findings.length === 0;
      const status = open.length === 0 && !rejectedEmpty ? 'APPROVED' : 'REJECTED';
      const verdict = { ...review, status, codeVersion: state.codeVersion } as const;
      if (role === 'security') state.security = verdict;
      else state.review = verdict;
      const label = role === 'security' ? 'Security review' : 'Code review';
      store.writeArtifact('review', `${role === 'security' ? 'security' : 'code-review'}-v${state.codeVersion}.md`, renderReview(verdict, `${label} — code revision ${state.codeVersion}`));
      for (const f of open) {
        items.push({
          id: f.id,
          source: role === 'security' ? 'security' : 'review',
          severity: f.severity,
          title: `${f.category}: ${f.description.split('\n')[0].slice(0, 120)}`,
          details: `File: ${f.file}\nIssue: ${f.description}\nSuggestion: ${f.suggestion}${f.standard ? `\nStandard: ${f.standard}` : ''}`,
        });
      }
      if (rejectedEmpty) {
        const id = role === 'security' ? 'SEC-REJECT' : 'REV-REJECT';
        if (!state.waivers.some((w) => w.id === id)) items.push({ id, source: role === 'security' ? 'security' : 'review', severity: 'HIGH', title: 'Rejected without itemized findings', details: review.summary });
      }
      const low = review.findings.filter((f) => !blocks(f.severity)).length;
      const summary = status === 'APPROVED' ? `approved${low ? ` · ${low} low-severity note(s)` : ''}` : `rejected: ${open.map((f) => `${f.id} ${f.severity}`).join(', ') || 'see summary'}`;
      this.ui.member(role, 'done', summary);
      store.event(role, 'handoff', status === 'APPROVED' ? `Approved. ${review.summary}` : `Rejected: ${open.map((f) => `${f.id} (${f.severity}) ${f.description.split('\n')[0]}`).join('; ')}`, status === 'APPROVED' ? 'gate' : 'developer');
    }
    if (failed) throw failed.reason;
    for (const s of settled) if (s.status === 'fulfilled') await this.absorbSignals(store, s.value.role, s.value.review.signals);
    items.push(...this.completenessItems(state));

    if (!items.length) {
      state.todo = [];
      state.next = this.pendingStage(state);
      return;
    }
    this.route(store, sortBySeverity(items), 'review');
  }

  private async stepRework(store: RunStore) {
    const { state } = store;
    const items = state.todo;
    const detail = `addressing ${items.map((t) => t.id).join(', ')}`;
    const session = state.sessions?.developer;
    let dev: DevOutput;
    try {
      dev = session
        ? await this.call(store, 'developer', 'rework', P.reworkPrompt(state, { ...this.env(), inSession: true, delta: this.delta(state, session.codeVersion) }), DevOutput, { access: WRITE, detail, resumeSessionId: session.id })
        : await this.call(store, 'developer', 'rework', P.reworkPrompt(state, this.env()), DevOutput, { access: WRITE, detail });
    } catch (err) {
      if (!session || err instanceof BudgetExhausted || (err instanceof AgentError && err.kind === 'budget')) throw err;
      this.ui.log('warn', `${this.name('developer')}'s session could not continue (${(err as Error).message.slice(0, 80)}) — starting fresh`, 'system');
      delete state.sessions?.developer;
      dev = await this.call(store, 'developer', 'rework', P.reworkPrompt(state, this.env()), DevOutput, { access: WRITE, detail });
    }
    state.fixes.push({ summary: dev.summary, fixes: [], filesChanged: dev.filesChanged, commandsRun: dev.commandsRun, signals: dev.signals, by: 'developer', round: state.iteration });
    for (const item of items) {
      const cov = dev.criteriaCoverage.find((c) => c.id === item.id);
      const h = this.history(state, item.id);
      if (!cov || cov.status === 'DONE') h.fixClaims += 1;
      else h.disputes += 1;
    }
    for (const c of dev.criteriaCoverage) if (state.coverage?.[c.id]) state.coverage[c.id] = { status: c.status, notes: c.notes };
    state.codeVersion += 1;
    store.writeArtifact('rework', `rework-round${state.iteration}.md`, renderImplementation(dev, `Rework — round ${state.iteration} (${items.map((t) => t.id).join(', ')})`));
    this.ui.member('developer', 'done', `reworked · ${dev.filesChanged.length} file(s)`);
    store.event('developer', 'handoff', `Addressed ${items.map((t) => t.id).join(', ')}: ${dev.summary}`, 'team');
    this.afterCodeChange(store, `address ${items.map((t) => t.id).join(', ')}`);
    state.todo = [];
    state.next = 'checks';
    await this.absorbSignals(store, 'developer', dev.signals);
  }

  private release(store: RunStore): ReleaseDecision {
    const { state } = store;
    this.ui.member('gate', 'working', 'checking every verdict');
    const decision = evaluateRelease(state, this.gateOpts());
    store.writeArtifact('release', 'release.md', renderRelease(state, decision, renderRunFlow(state, this.names)));
    state.status = decision.approved ? 'approved' : 'rejected';
    this.ui.member('gate', decision.approved ? 'done' : 'failed', decision.approved ? 'APPROVED' : 'REJECTED');
    store.event('gate', 'decision', `${decision.approved ? 'APPROVED' : 'REJECTED'} — ${decision.verdict}${decision.reasons.length ? ` Reasons: ${decision.reasons.join('; ')}` : ''}`, 'human');
    state.next = 'debrief';
    return decision;
  }

  private async stepDebrief(store: RunStore) {
    const { state } = store;
    const decision = evaluateRelease(state, this.gateOpts());
    let debrief: Debrief;
    // An AI-written debrief pays off when there is something to learn or explain; otherwise the facts are enough.
    const lessons = [...(state.security?.lessons ?? []), ...(state.review?.lessons ?? [])].length;
    const eventful = state.iteration > 0 || state.waivers.length > 0 || !decision.approved || lessons > 0 || state.plan?.size === 'L' || state.plan?.size === 'XL';
    const lean = isSolo(state.lineup) || state.mode === 'quick' || !eventful;
    if (lean) {
      debrief = basicDebrief(state, decision, this.names);
    } else {
      try {
        const gateSummary = `${decision.approved ? 'APPROVED' : 'REJECTED'}\n${decision.lines.map((l) => `- ${l.label}: ${l.status}${l.detail ? ` — ${l.detail}` : ''}`).join('\n')}`;
        debrief = await this.call(store, 'lead', 'debrief', P.debriefPrompt(state, { ...this.env(), gateSummary, learned: learnedRules(this.root) }), Debrief, {
          access: NONE,
          effort: 'low',
          maxTurns: 4,
          detail: 'writing the debrief',
        });
      } catch (err) {
        if (err instanceof BudgetExhausted || (err instanceof AgentError && err.kind === 'budget')) {
          debrief = basicDebrief(state, decision, this.names);
        } else {
          this.ui.log('warn', `Debrief fell back to a basic summary: ${(err as Error).message}`, 'lead');
          debrief = basicDebrief(state, decision, this.names);
        }
      }
    }
    state.debrief = debrief;
    store.writeArtifact('debrief', 'debrief.md', renderDebrief(debrief, this.names));
    store.event('lead', 'handoff', debrief.headline, 'human');
    this.ui.member('lead', 'done', 'debrief ready');

    if (this.config.rules.autoLearn && debrief.ruleUpdates.length && fs.existsSync(paths(this.root).dir)) {
      state.ruleUpdates = applyRuleUpdates(this.root, debrief.ruleUpdates, state.id, this.config.rules.maxLearned);
      if (state.ruleUpdates.length) {
        store.event('lead', 'note', `Rulebook updated: ${state.ruleUpdates.map((u) => `${u.action} ${u.id}`).join(', ')}`, 'team');
        this.ui.log('event', `rulebook: ${state.ruleUpdates.map((u) => `${u.action} ${u.id} "${u.rule.slice(0, 60)}"`).join('; ')}`, 'lead');
      }
    }
    recordStats(
      this.root,
      state.calls.filter((c) => c.ok).map((c) => ({ role: c.role, costUsd: c.costUsd, ms: c.ms })),
    );
    if (decision.approved) this.commit(store, `ai-team: ${slugify(state.feature)} approved`);
    state.finishedAt = new Date().toISOString();
    state.next = 'done';
  }

  // ── Flow helpers ─────────────────────────────────────────────────────────

  private afterQaStep(state: RunState): Step {
    return state.lineup.security !== 'off' || state.lineup.reviewer !== 'off' ? 'review' : 'release';
  }

  /** Where the mission continues once the current batch of items is resolved or waived without new code. */
  private nextAfterClearing(state: RunState, from: 'qa' | 'review' | 'completeness'): Step {
    if (from === 'qa') return this.afterQaStep(state);
    if (from === 'review') return this.pendingStage(state);
    return state.lineup.qa !== 'off' ? 'qa' : this.afterQaStep(state);
  }

  /** The first staffed stage that hasn't judged the current code yet (members can join mid-mission), else the gate. */
  private pendingStage(state: RunState): Step {
    const fresh = (v?: { codeVersion: number }) => v?.codeVersion === state.codeVersion;
    if (state.lineup.qa !== 'off' && !fresh(state.qa)) return 'qa';
    if ((state.lineup.security !== 'off' && !fresh(state.security)) || (state.lineup.reviewer !== 'off' && !fresh(state.review))) return 'review';
    return 'release';
  }

  private completenessItems(state: RunState): WorkItem[] {
    return completenessGaps(state).map((g) => ({ id: g.id, source: 'completeness' as const, severity: g.severity, title: g.title, details: g.details }));
  }

  /**
   * Routes what members raised beyond their own deliverable. Recruit requests add members (never remove),
   * questions for the human are asked once, blockers go to the team lead, and assumptions and concerns land
   * in the ledger, from which each member gets only the entries meant for them.
   */
  private async absorbSignals(store: RunStore, from: RoleId, signals: Signal[] = []) {
    const { state } = store;
    state.signals ??= [];
    for (const signal of signals) {
      const summary = signal.summary.trim();
      if (!summary) continue;
      const key = `${signal.kind}:${summary.toLowerCase()}`;
      if (state.signals.some((s) => `${s.kind}:${s.summary.trim().toLowerCase()}` === key)) continue;
      const id = `${signal.kind === 'blocker' ? 'BLOCK' : 'SIG'}-${state.signals.length + 1}`;
      state.signals.push({ ...signal, summary, id, from, at: new Date().toISOString(), codeVersion: state.codeVersion });
      const who = this.name(from);

      if (signal.kind === 'recruit' && signal.member) {
        const member = signal.member;
        const upgrades: Upgrade[] = [];
        raise(state.lineup, member, 'light', `requested by ${who}: ${summary}`, upgrades);
        if (upgrades.length) {
          this.recordUpgrades(store, upgrades);
          // Someone joining after the build reviews the current code; make sure the flow reaches them.
          if (state.next === 'release' && (member === 'security' || member === 'reviewer')) state.next = 'review';
          if (state.next === 'release' && member === 'qa') state.next = 'qa';
        }
        continue;
      }
      if (signal.kind === 'question' && signal.to === 'human') {
        await this.askHuman(store, id, summary, signal.proposedDefault, from);
        continue;
      }
      if (signal.kind === 'blocker') {
        store.event(from, 'warning', `Blocker (${id}): ${summary}`, 'lead');
        this.ui.log('warn', `${who} is blocked: ${summary}`, from);
        continue;
      }
      store.event(from, 'note', `${signal.kind === 'assumption' ? 'Assumption' : 'Concern'} (${id}): ${summary}`, signal.to === 'human' || signal.to === 'team' ? 'team' : signal.to);
      if (signal.kind === 'concern') this.ui.log('event', `${who} → ${signal.to}: ${summary}`, from);
    }
  }

  /** Asks the human one question (once per mission). An answer that differs from the default sends the change back for rework. */
  private async askHuman(store: RunStore, id: string, question: string, proposedDefault: string, from: RoleId) {
    const { state } = store;
    if (state.answers.some((a) => a.question.trim().toLowerCase() === question.toLowerCase())) return;
    store.event(from, 'question', `${id}: ${question} (default: ${proposedDefault || 'none'})`, 'human');
    let answered: string | undefined;
    if (this.opts.ask) {
      this.ui.suspend();
      try {
        answered = (await this.opts.ask(`${id} (${this.name(from)}): ${question}`, proposedDefault))?.trim();
      } finally {
        this.ui.resume();
      }
    }
    const differs = !!answered && answered.toLowerCase() !== proposedDefault.trim().toLowerCase();
    state.answers.push({ id, question, answer: answered || proposedDefault, source: answered ? 'user' : 'default' });
    store.event('human', 'answer', `${id}: ${answered || `(default) ${proposedDefault}`}`, from);
    if (differs && state.implementation && !isNonCodeTask(state)) {
      // The work so far assumed the default; the human decided otherwise. It becomes an open item like any other.
      state.coverage = { ...state.coverage, [id]: { status: 'NOT_DONE', notes: `The team assumed "${proposedDefault}"; the human decided: "${answered}". Apply that decision.` } };
      store.event('system', 'note', `${id}: the human's answer changes the plan — back to ${this.name('developer')}.`, 'developer');
    }
  }

  /** Sends items to the fixer/developer, or to the team lead first when the team is stuck. */
  private route(store: RunStore, items: WorkItem[], from: 'qa' | 'review' | 'completeness') {
    const { state } = store;
    // Late rounds verify fixes; brand-new minor issues found there become follow-ups instead of endless fix rounds.
    const round = from === 'qa' ? state.qaRounds.length : from === 'review' ? (state.reviewRounds ?? 1) : 0;
    const deferFrom = this.config.loop.deferNewIssuesFromRound;
    if (deferFrom > 0 && round >= deferFrom) {
      const deferred = items.filter((i) => i.source !== 'checks' && i.source !== 'completeness' && (i.severity === 'MEDIUM' || i.severity === 'LOW') && !state.items[i.id]);
      if (deferred.length) {
        for (const d of deferred) {
          state.waivers.push({ id: d.id, severity: d.severity, title: d.title, reason: `New ${d.severity} issue found in round ${round}; kept as a follow-up instead of another fix round.`, by: 'policy' });
        }
        store.event('system', 'note', `Follow-ups (new minor issues in round ${round}, not blocking): ${deferred.map((d) => `${d.id} ${d.title}`).join('; ')}`, 'team');
        this.ui.log('info', `follow-ups recorded (round ${round}): ${deferred.map((d) => `${d.id} ${d.severity}`).join(', ')}`, 'system');
        items = items.filter((i) => !deferred.includes(i));
        if (!items.length) {
          state.todo = [];
          state.next = this.nextAfterClearing(state, from);
          return;
        }
      }
    }
    for (const item of items) this.history(state, item.id).seen += 1;
    state.todoFrom = from;
    const stuck = items.filter((i) => {
      const h = state.items[i.id];
      const blocker = state.signals?.some((b) => b.id === i.id && b.kind === 'blocker');
      return !h.arbitrated && ((h.seen >= 2 && h.fixClaims >= 1) || h.disputes >= 1 || blocker);
    });
    if (stuck.length) {
      state.todo = sortBySeverity(items);
      store.event('system', 'note', `Recurring or disputed: ${stuck.map((s) => s.id).join(', ')} — asking ${this.name('lead')} for a ruling.`, 'lead');
      this.ui.log('warn', `${stuck.map((s) => s.id).join(', ')} keep coming back — ${this.name('lead')} will rule`, 'system');
      state.next = 'arbitrate';
      return;
    }
    this.loopBack(store, items, from === 'qa' ? 'fix' : 'rework');
  }

  /** Sends work back for another round, or to the release gate if the round budget is spent. */
  private loopBack(store: RunStore, items: WorkItem[], step: 'fix' | 'rework') {
    const { state } = store;
    state.todo = sortBySeverity(items);
    if (state.iteration >= state.maxIterations) {
      this.ui.log('warn', `Round limit (${state.maxIterations}) reached — sending to ${this.name('gate')}`);
      store.event('system', 'warning', `Round limit (${state.maxIterations}) reached with ${items.length} open item(s).`, 'gate');
      state.next = 'release';
      return;
    }
    state.iteration += 1;
    const who = step === 'fix' ? 'bugFixer' : 'developer';
    this.ui.member(who, 'queued', `round ${state.iteration}: ${items.map((i) => i.id).join(', ')}`);
    state.next = step;
  }

  private qaItems(state: RunState): WorkItem[] {
    const qa = state.qa!;
    const waived = new Set(state.waivers.map((w) => w.id));
    const items: WorkItem[] = qa.bugs
      .filter((b) => blocks(b.severity) && !waived.has(b.id))
      .map((b) => ({
        id: b.id,
        source: 'qa',
        severity: b.severity,
        title: b.title,
        details: `Location: ${b.location}\nSteps:\n${b.steps.map((s, i) => `${i + 1}. ${stripNumber(s)}`).join('\n')}\nExpected: ${b.expected}\nActual: ${b.actual}`,
      }));
    items.push(...this.checkItems(state));
    if (qa.status === 'FAIL' && qa.bugs.length === 0 && !waived.has('QA-FAIL')) {
      items.push({ id: 'QA-FAIL', source: 'qa', severity: 'HIGH', title: 'QA failed without itemized bugs', details: qa.summary });
    }
    return sortBySeverity(items);
  }

  private checkItems(state: RunState): WorkItem[] {
    if (!state.checks) return [];
    return state.checks.results
      .filter((r) => state.checks!.blocking.includes(r.name))
      .map((r) => ({
        id: `CHECK-${r.name}`,
        source: 'checks' as const,
        severity: 'HIGH' as const,
        title: `\`${r.command}\` is failing`,
        details: `Exit code: ${r.exitCode}${r.timedOut ? ' (timed out)' : ''}\nOutput (tail):\n${r.output}`,
      }));
  }

  private history(state: RunState, id: string) {
    return (state.items[id] ??= { seen: 0, fixClaims: 0, disputes: 0, arbitrated: false });
  }

  /** Commit, diff, scan and re-check guardrails after any member changed code. */
  private afterCodeChange(store: RunStore, message: string) {
    const { state } = store;
    this.commit(store, `ai-team: ${message}`.slice(0, 200));
    if (state.baseCommit) {
      const snapshot = git.snapshotTree(this.root);
      if (snapshot) (state.snapshots ??= {})[state.codeVersion] = snapshot;
    }
    const diff = this.diff(state);
    const metrics: DiffMetrics = diff
      ? { files: diff.files, changedLines: diff.changedLines, measured: true }
      : { files: P.reportedFiles(state).map((p) => ({ path: p, added: 0, deleted: 0, untracked: false, addedLines: [] })), changedLines: 0, measured: false };
    state.diffStat = { files: metrics.files.map((f) => ({ path: f.path, added: f.added, deleted: f.deleted })), changedLines: metrics.changedLines, measured: metrics.measured };
    state.scans = scanDiff(metrics);
    if (state.scans.length) store.event('system', 'note', `Automated scan: ${state.scans.length} lead(s) for review (${[...new Set(state.scans.map((s) => s.rule))].join(', ')}).`, 'security');
    const guarded = diffGuardrails(state.lineup, metrics, this.config.guardrails);
    state.lineup = guarded.lineup;
    this.recordUpgrades(store, guarded.upgrades);
  }

  private recordUpgrades(store: RunStore, upgrades: Upgrade[]) {
    if (!upgrades.length) return;
    const { state } = store;
    for (const u of upgrades) {
      const role = u.member as RoleId;
      state.upgrades.push({ ...u, at: new Date().toISOString() });
      state.effort[role] ??= u.to === 'full' ? 'high' : 'medium';
      store.event('gate', 'guardrail', `Guardrail: ${this.name(role)} joins at ${u.to} depth — ${u.reason}.`, 'team');
      this.ui.log('warn', `guardrail: ${this.name(role)} joins (${u.to}) — ${u.reason}`, 'gate');
    }
    this.ui.update(state);
  }

  private diff(state: RunState): git.DiffSnapshot | undefined {
    if (!state.baseCommit) return undefined;
    if (this.diffCache?.version === state.codeVersion) return this.diffCache.diff;
    let diff: git.DiffSnapshot | undefined;
    try {
      diff = git.diffSince(this.root, state.baseCommit);
    } catch (err) {
      this.ui.log('warn', `Could not compute git diff: ${(err as Error).message.split('\n')[0]}`);
    }
    this.diffCache = { version: state.codeVersion, diff };
    return diff;
  }

  /** What changed since a member last judged the code (undefined on their first look). */
  private delta(state: RunState, judgedVersion: number | undefined): P.DeltaDiff | undefined {
    if (judgedVersion === undefined || judgedVersion === state.codeVersion) return undefined;
    const from = state.snapshots?.[judgedVersion];
    const to = state.snapshots?.[state.codeVersion];
    if (!from || !to) return undefined;
    try {
      return { fromVersion: judgedVersion, ...git.diffBetween(this.root, from, to) };
    } catch {
      return undefined;
    }
  }

  // ── Agent calls ──────────────────────────────────────────────────────────

  private env(): P.PromptEnv {
    return { names: this.names };
  }

  private async call<T>(
    store: RunStore,
    role: RoleId,
    step: Step,
    prompt: string,
    schema: z.ZodType<T>,
    opts: { access: Access; effort?: Effort; maxTurns?: number; detail?: string; readOnlyRepo?: boolean; resumeSessionId?: string },
  ): Promise<T> {
    const { state } = store;
    const { config, provider } = this.opts;
    let maxBudgetUsd = config.maxBudgetUsdPerAgent;
    if (state.budgetUsd !== undefined) {
      const remaining = state.budgetUsd - state.costUsd;
      if (remaining <= 0.005) throw new BudgetExhausted();
      maxBudgetUsd = Math.min(maxBudgetUsd ?? Infinity, remaining);
    }
    const effort = opts.effort ?? state.effort[role];
    const before = opts.readOnlyRepo && state.baseCommit ? git.snapshotTree(this.root) : undefined;
    this.ui.member(role, 'working', opts.detail);
    const started = Date.now();
    const record = (ok: boolean, costUsd: number, turns: number, tokens?: TokenUsage) => {
      state.costUsd += costUsd;
      state.calls.push({ role, step, startedAt: new Date(started).toISOString(), ms: Date.now() - started, costUsd, turns, effort, ok, tokens });
      this.ui.update(state);
    };
    let result;
    try {
      result = await provider.run({
        role,
        member: this.name(role),
        systemPrompt: buildSystemPrompt(this.root, role, this.ctx, opts.access.write !== 'none'),
        prompt,
        outputSchema: toJsonSchema(schema),
        access: opts.access,
        cwd: this.root,
        model: config.models[role] ?? config.model,
        effort,
        maxTurns: opts.maxTurns ?? config.maxTurnsPerAgent,
        maxBudgetUsd: Number.isFinite(maxBudgetUsd) ? maxBudgetUsd : undefined,
        bypassPermissions: config.permissions === 'bypass',
        resumeSessionId: opts.resumeSessionId,
        onActivity: (line) => this.ui.activity(role, line),
      });
    } catch (err) {
      record(false, err instanceof AgentError ? err.costUsd : 0, 0);
      this.ui.member(role, 'failed', (err as Error).message.slice(0, 80));
      throw err;
    }
    record(true, result.costUsd, result.turns, result.tokens);
    // Writers' sessions can be continued later (rework, fixes); their code revision is set once the change is counted.
    if (result.sessionId && opts.access.write === 'repo') (state.sessions ??= {})[role] = { id: result.sessionId, codeVersion: state.codeVersion + 1 };
    if (before) this.undoStrayEdits(store, role, before);
    const parsed = schema.safeParse(result.output);
    if (!parsed.success) {
      this.ui.member(role, 'failed', 'invalid output');
      throw new AgentError(`${this.name(role)} returned output that does not match the ${MEMBERS[role].title} contract: ${parsed.error.message}`);
    }
    return parsed.data;
  }

  /**
   * Read-only members can still reach the shell (QA needs it to run tests), so the tool hook alone can't stop
   * every write. After their call, anything they changed in the repository is put back exactly as it was.
   */
  private undoStrayEdits(store: RunStore, role: RoleId, before: string) {
    const { state } = store;
    const after = git.snapshotTree(this.root);
    if (!after || after === before) return;
    let changes: git.TreeChange[] = [];
    try {
      changes = git.changedBetween(this.root, before, after);
      git.restoreFromSnapshot(this.root, before, changes);
    } catch (err) {
      const note = `${this.name(role)} (read-only) changed files in the repository and they could not be restored: ${(err as Error).message.split('\n')[0]}`;
      state.integrity.push(note);
      store.event('gate', 'warning', note, 'team');
      this.ui.log('warn', note, 'gate');
      return;
    }
    if (!changes.length) return;
    const list = changes.map((c) => `${c.path} (${c.status})`).join(', ');
    const note = `${this.name(role)} (read-only) changed ${changes.length} file(s) in the repository; restored: ${list}`;
    state.integrity.push(note);
    store.event('gate', 'guardrail', note, 'team');
    this.ui.log('warn', note, 'gate');
  }

  private staffedRoles(state: RunState): RoleId[] {
    const roles: RoleId[] = [];
    if (state.lineup.pm !== 'off') roles.push('pm');
    if (state.lineup.architect !== 'off') roles.push('architect');
    roles.push('developer');
    for (const r of ['qa', 'security', 'reviewer'] as const) if (state.lineup[r] !== 'off') roles.push(r);
    return roles;
  }

  private packs(): PackId[] {
    const detected = detectPacks(this.root);
    const fromProfile = loadProfile(this.root)?.stackPacks ?? [];
    return [...new Set([...detected, ...fromProfile])];
  }

  private gateOpts() {
    return { checksConfigured: this.config.checks.length > 0, names: this.names, humanName: this.humanName() };
  }

  private humanName(): string | undefined {
    return git.isGitRepo(this.root) ? git.userFirstName(this.root) : undefined;
  }

  private setupGit(store: RunStore) {
    const { config, root } = this.opts;
    if (!git.isGitRepo(root)) {
      if (config.git.branch || config.git.commit) this.ui.log('warn', 'Git integration is enabled but this is not a git repository — skipping');
      return;
    }
    store.state.baseCommit = git.headCommit(root);
    store.state.startedDirty = !git.isClean(root);
    if (!config.git.branch && !config.git.commit) return;
    if (store.state.startedDirty) {
      this.ui.log('warn', 'Working tree has uncommitted changes — git branch/commits disabled for this mission so your work is not mixed in');
      return;
    }
    store.state.git = { commits: config.git.commit };
    if (config.git.branch) {
      store.state.git.branch = git.createBranch(root, `ai-team/${slugify(store.state.feature)}`);
      this.ui.log('ok', `Branch ${store.state.git.branch}`);
    }
  }

  private commit(store: RunStore, message: string) {
    if (!store.state.git?.commits) return;
    try {
      if (git.commitAll(this.root, message)) this.ui.log('info', `commit: ${message}`);
    } catch (err) {
      this.ui.log('warn', `git commit failed: ${(err as Error).message.split('\n')[0]}`);
    }
  }
}

function lowerEffort(effort: Effort | undefined): Effort | undefined {
  if (!effort) return undefined;
  const order: Effort[] = ['low', 'medium', 'high', 'xhigh'];
  return order[Math.max(0, order.indexOf(effort) - 1)];
}

function sortBySeverity(items: WorkItem[]): WorkItem[] {
  return [...items].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
}

/** The plan used in the fixed quick/full modes, where JARVIS doesn't size the mission. */
export function fixedPlan(mode: Mode, feature: string): MissionPlan {
  const full = mode === 'full';
  const effort: Effort = full ? 'high' : 'medium';
  const lineup: Lineup = full
    ? { pm: 'full', architect: 'full', qa: 'full', security: 'full', reviewer: 'full' }
    : { pm: 'off', architect: 'off', qa: 'light', security: 'off', reviewer: 'light' };
  const words = feature.replace(/\s+/g, ' ').trim().split(' ');
  return {
    missionName: words.slice(0, 6).join(' ') + (words.length > 6 ? '…' : ''),
    summary: feature,
    taskType: 'feature',
    size: full ? 'L' : 'S',
    risk: full ? 'high' : 'low',
    riskAreas: [],
    surfaces: [],
    lineup,
    effort: { pm: effort, architect: effort, developer: effort, qa: effort, bugFixer: effort, security: effort, reviewer: effort },
    briefs: { pm: '', architect: '', developer: '', qa: '', bugFixer: '', security: '', reviewer: '' },
    keyFiles: [],
    rationale: full ? 'Fixed "full" mode: every member at full depth.' : 'Fixed "quick" mode: Developer, light QA and a light code review.',
    estimatedCostUsd: 0,
    budgetNote: '',
    answer: '',
  };
}

/** A deterministic debrief for lean missions, so a solo task doesn't pay for an extra AI call. */
export function basicDebrief(state: RunState, decision: ReleaseDecision, names: TeamNames): Debrief {
  const name = state.plan?.missionName ?? state.feature;
  const dev = state.implementation;
  return {
    headline: decision.approved ? `${name}: done and approved.` : `${name}: not approved — ${decision.reasons[0] ?? 'see the release gate'}.`,
    summary: `${nameOf('developer', names)} ${dev ? `changed ${dev.filesChanged.length} file(s)` : 'did not finish the implementation'}${state.iteration ? ` and the team went through ${state.iteration} fix round(s)` : ''}. ${decision.approved ? 'Every staffed check passed.' : 'The release gate found open problems.'}`,
    whatWasBuilt: dev ? dev.filesChanged.map((f) => `${f.path}: ${f.change}`) : [],
    decisions: dev?.notes ?? [],
    evidence: [
      ...(dev?.testsAdded.length ? [`Tests added: ${dev.testsAdded.join(', ')}`] : []),
      ...(state.checks?.results ?? []).map((r) => `${r.name}: ${r.passed ? 'passed' : 'failed'}`),
      ...(state.qa ? [`QA: ${state.qa.status} (${state.qa.scenarios.length} scenarios)`] : []),
      ...(state.review ? [`Code review: ${state.review.status}`] : []),
    ],
    risks: decision.reasons,
    howToTry: state.checks?.results.map((r) => `Run \`${r.command}\``) ?? [],
    ruleUpdates: [],
  };
}
