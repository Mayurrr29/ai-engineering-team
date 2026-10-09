import fs from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import { costTable, estimateMission, readStats, recordStats } from './budget.js';
import { classifyChecks, runChecks } from './checks.js';
import type { Config } from './config.js';
import * as git from './git.js';
import { diffGuardrails, isSolo, planGuardrails, type DiffMetrics, type Upgrade } from './guardrails.js';
import { detectPacks, type PackId } from './packs.js';
import { buildSystemPrompt, loadProfile, type PromptContext } from './playbooks.js';
import { paths, slugify } from './paths.js';
import * as P from './prompts.js';
import { AgentError, type Access, type AIProvider } from './providers/types.js';
import { blocks, evaluateRelease, renderRelease, type ReleaseDecision } from './release.js';
import { renderChecks, renderDebrief, renderDecision, renderDesign, renderFix, renderImplementation, renderPlan, renderQa, renderReview, renderRunFlow, renderSpec, stripNumber } from './render.js';
import { writeReport } from './report/html.js';
import { applyRuleUpdates, ensureRulebook, learnedRules } from './rules.js';
import { scanDiff } from './scans.js';
import {
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
    if (!decision && state.status !== 'running') decision = evaluateRelease(state, this.gateOpts());
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
    store.event('architect', 'handoff', `Design ready: ${design.approach}`, 'developer');
    store.writeArtifact('design', 'design.md', renderDesign(design));
    state.next = 'develop';
  }

  private async stepDevelop(store: RunStore) {
    const { state } = store;
    const dev = await this.call(store, 'developer', 'develop', P.developPrompt(state, this.env()), DevOutput, { access: WRITE, detail: 'building' });
    state.implementation = dev;
    state.codeVersion += 1;
    store.writeArtifact('develop', 'implementation.md', renderImplementation(dev));
    const open = dev.criteriaCoverage.filter((c) => c.status !== 'DONE');
    const summary = `${dev.filesChanged.length} file(s) · ${dev.testsAdded.length} test(s)${open.length ? ` · ${open.length} not fully done` : ''}`;
    this.ui.member('developer', 'done', summary);
    store.event('developer', 'handoff', `Implemented: ${dev.summary}`, state.lineup.qa !== 'off' ? 'qa' : 'team');
    if (open.length) this.ui.log('warn', `Reports ${open.length} item(s) not fully done: ${open.map((o) => o.id).join(', ')}`, 'developer');
    this.afterCodeChange(store, `implement ${slugify(state.feature)}`);
    state.next = 'checks';
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
      P.qaPrompt(state, { ...this.env(), diff: this.diff(state), labDir, depth: state.lineup.qa }),
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

    const items = this.qaItems(state);
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
    const fix = await this.call(store, 'bugFixer', 'fix', P.fixPrompt(state, this.env()), FixOutput, { access: WRITE, detail: `fixing ${items.map((t) => t.id).join(', ')}` });
    state.fixes.push({ ...fix, by: 'bugFixer', round: state.iteration });
    for (const f of fix.fixes) {
      const h = this.history(state, f.id);
      if (f.status === 'FIXED') h.fixClaims += 1;
      else h.disputes += 1;
    }
    state.codeVersion += 1;
    store.writeArtifact('fix', `fix-round${state.iteration}.md`, renderFix(fix, `Bug fixes — round ${state.iteration}`, items));
    const fixed = fix.fixes.filter((f) => f.status === 'FIXED').map((f) => f.id);
    const disputed = fix.fixes.filter((f) => f.status !== 'FIXED');
    this.ui.member('bugFixer', 'done', `${fixed.length} fixed${disputed.length ? ` · ${disputed.length} disputed` : ''}`);
    store.event('bugFixer', 'handoff', `${fixed.length ? `Fixed ${fixed.join(', ')}. ` : ''}${disputed.map((d) => `${d.id}: ${d.status} — ${d.rootCause}`).join(' ')}`.trim(), 'qa');
    for (const d of disputed) this.ui.log('warn', `${d.id} ${d.status.toLowerCase().replace(/_/g, ' ')}: ${d.rootCause}`, 'bugFixer');
    this.afterCodeChange(store, `fix ${items.map((t) => t.id).join(', ')}`);
    state.todo = [];
    state.next = 'checks';
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
      state.next = from === 'qa' ? this.afterQaStep(state) : 'release';
      return;
    }
    this.loopBack(store, remaining, from === 'qa' ? 'fix' : 'rework');
  }

  private async stepReview(store: RunStore) {
    const { state } = store;
    state.reviewRounds = (state.reviewRounds ?? 0) + 1;
    const diff = this.diff(state);
    const jobs: Array<Promise<{ role: 'security' | 'reviewer'; review: ReviewOutput }>> = [];
    if (state.lineup.security !== 'off') {
      jobs.push(
        this.call(store, 'security', 'review', P.securityPrompt(state, { ...this.env(), diff, leads: state.scans, depth: state.lineup.security }), ReviewOutput, {
          access: READ,
          detail: 'attacking the change',
          readOnlyRepo: true,
        }).then((review) => ({ role: 'security' as const, review })),
      );
    }
    if (state.lineup.reviewer !== 'off') {
      jobs.push(
        this.call(store, 'reviewer', 'review', P.reviewPrompt(state, { ...this.env(), diff, leads: state.scans, depth: state.lineup.reviewer }), ReviewOutput, {
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

    if (!items.length) {
      state.todo = [];
      state.next = 'release';
      return;
    }
    this.route(store, sortBySeverity(items), 'review');
  }

  private async stepRework(store: RunStore) {
    const { state } = store;
    const items = state.todo;
    const dev = await this.call(store, 'developer', 'rework', P.reworkPrompt(state, this.env()), DevOutput, { access: WRITE, detail: `addressing ${items.map((t) => t.id).join(', ')}` });
    state.fixes.push({ summary: dev.summary, fixes: [], filesChanged: dev.filesChanged, commandsRun: dev.commandsRun, by: 'developer', round: state.iteration });
    for (const item of items) {
      const cov = dev.criteriaCoverage.find((c) => c.id === item.id);
      const h = this.history(state, item.id);
      if (!cov || cov.status === 'DONE') h.fixClaims += 1;
      else h.disputes += 1;
    }
    state.codeVersion += 1;
    store.writeArtifact('rework', `rework-round${state.iteration}.md`, renderImplementation(dev, `Rework — round ${state.iteration} (${items.map((t) => t.id).join(', ')})`));
    this.ui.member('developer', 'done', `reworked · ${dev.filesChanged.length} file(s)`);
    store.event('developer', 'handoff', `Addressed ${items.map((t) => t.id).join(', ')}: ${dev.summary}`, 'team');
    this.afterCodeChange(store, `address ${items.map((t) => t.id).join(', ')}`);
    state.todo = [];
    state.next = 'checks';
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
    const lean = isSolo(state.lineup) || state.mode === 'quick';
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

  /** Sends items to the fixer/developer, or to the team lead first when the team is stuck. */
  private route(store: RunStore, items: WorkItem[], from: 'qa' | 'review') {
    const { state } = store;
    // Late rounds verify fixes; brand-new minor issues found there become follow-ups instead of endless fix rounds.
    const round = from === 'qa' ? state.qaRounds.length : (state.reviewRounds ?? 1);
    const deferFrom = this.config.loop.deferNewIssuesFromRound;
    if (deferFrom > 0 && round >= deferFrom) {
      const deferred = items.filter((i) => i.source !== 'checks' && (i.severity === 'MEDIUM' || i.severity === 'LOW') && !state.items[i.id]);
      if (deferred.length) {
        for (const d of deferred) {
          state.waivers.push({ id: d.id, severity: d.severity, title: d.title, reason: `New ${d.severity} issue found in round ${round}; kept as a follow-up instead of another fix round.`, by: 'policy' });
        }
        store.event('system', 'note', `Follow-ups (new minor issues in round ${round}, not blocking): ${deferred.map((d) => `${d.id} ${d.title}`).join('; ')}`, 'team');
        this.ui.log('info', `follow-ups recorded (round ${round}): ${deferred.map((d) => `${d.id} ${d.severity}`).join(', ')}`, 'system');
        items = items.filter((i) => !deferred.includes(i));
        if (!items.length) {
          state.todo = [];
          state.next = from === 'qa' ? this.afterQaStep(state) : 'release';
          return;
        }
      }
    }
    for (const item of items) this.history(state, item.id).seen += 1;
    state.todoFrom = from;
    const stuck = items.filter((i) => {
      const h = state.items[i.id];
      return !h.arbitrated && ((h.seen >= 2 && h.fixClaims >= 1) || h.disputes >= 1);
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
    opts: { access: Access; effort?: Effort; maxTurns?: number; detail?: string; readOnlyRepo?: boolean },
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
    const before = opts.readOnlyRepo ? git.treeFingerprint(this.root) : undefined;
    this.ui.member(role, 'working', opts.detail);
    const started = Date.now();
    const record = (ok: boolean, costUsd: number, turns: number) => {
      state.costUsd += costUsd;
      state.calls.push({ role, step, startedAt: new Date(started).toISOString(), ms: Date.now() - started, costUsd, turns, effort, ok });
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
        onActivity: (line) => this.ui.activity(role, line),
      });
    } catch (err) {
      record(false, err instanceof AgentError ? err.costUsd : 0, 0);
      this.ui.member(role, 'failed', (err as Error).message.slice(0, 80));
      throw err;
    }
    record(true, result.costUsd, result.turns);
    if (before !== undefined && git.treeFingerprint(this.root) !== before) {
      const note = `${this.name(role)} (read-only) changed files in the repository`;
      state.integrity.push(note);
      store.event('gate', 'warning', note, 'team');
      this.ui.log('warn', note, 'gate');
    }
    const parsed = schema.safeParse(result.output);
    if (!parsed.success) {
      this.ui.member(role, 'failed', 'invalid output');
      throw new AgentError(`${this.name(role)} returned output that does not match the ${MEMBERS[role].title} contract: ${parsed.error.message}`);
    }
    return parsed.data;
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
