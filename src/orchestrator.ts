import fs from 'node:fs';
import { runChecks } from './checks.js';
import type { Config, RoleName } from './config.js';
import * as git from './git.js';
import { paths, slugify } from './paths.js';
import * as P from './prompts.js';
import { AgentError, type AIProvider } from './providers/types.js';
import { evaluateRelease, renderRelease, type ReleaseDecision } from './release.js';
import { renderChecks, renderFix, renderImplementation, renderQa, renderReview, renderSpec, stripNumber } from './render.js';
import { buildSystemPrompt, ROLES } from './roles.js';
import { DevOutput, FixOutput, PmOutput, QaOutput, ReviewOutput, toJsonSchema, type Severity } from './schemas.js';
import { newRunState, RunStore, type RunState, type Step, type WorkItem } from './state.js';
import { banner, c, silentLogger, type Logger } from './ui.js';

export interface OrchestratorOptions {
  root: string;
  config: Config;
  provider: AIProvider;
  logger?: Logger;
  /** Ask the human a question; return undefined to accept the default. Omit for non-interactive runs. */
  ask?: (question: string, proposedDefault: string) => Promise<string | undefined>;
}

export interface RunOutcome {
  state: RunState;
  decision?: ReleaseDecision;
  dir: string;
}

const STAGE_TITLES: Record<Exclude<Step, 'done'>, string> = {
  pm: 'Product Manager',
  clarify: 'Clarifications',
  develop: 'Developer',
  checks: 'Checks (lint / typecheck / tests / build)',
  qa: 'QA Engineer',
  fix: 'Bug Fixer',
  security: 'Security Reviewer',
  review: 'Code Reviewer',
  rework: 'Developer (rework)',
  release: 'Release Manager',
};

export class Orchestrator {
  private readonly log: Logger;
  private stageCounter = 0;

  constructor(private readonly opts: OrchestratorOptions) {
    this.log = opts.logger ?? silentLogger;
  }

  private securityEnabled(state: RunState): boolean {
    return state.mode === 'standard';
  }

  /** Starts a new run for a feature request. */
  async build(feature: string): Promise<RunOutcome> {
    const { root, config } = this.opts;
    const state = newRunState(feature, config.mode, config.maxIterations);
    const store = RunStore.create(root, state);
    this.setupGit(store);
    store.save();
    this.log.info(`${c.dim('Run')} ${state.id}  ${c.dim('mode')} ${state.mode}  ${c.dim('artifacts')} ${store.dir}`);
    return this.drive(store);
  }

  /** Continues an interrupted or failed run from its last unfinished step. */
  async resume(runId: string): Promise<RunOutcome> {
    const store = RunStore.load(this.opts.root, runId);
    if (store.state.status === 'approved' || store.state.status === 'rejected') {
      throw new Error(`Run ${runId} already finished (${store.state.status}).`);
    }
    store.state.status = 'running';
    store.state.error = undefined;
    this.log.info(`${c.dim('Resuming')} ${runId} ${c.dim('at')} ${store.state.next}`);
    return this.drive(store);
  }

  private async drive(store: RunStore): Promise<RunOutcome> {
    const { state } = store;
    let decision: ReleaseDecision | undefined;
    while (state.next !== 'done') {
      const step = state.next;
      this.stageCounter += 1;
      this.log.stage(this.stageCounter, STAGE_TITLES[step]);
      try {
        if (step === 'release') decision = this.release(store);
        else await this.runStep(store, step);
      } catch (err) {
        state.status = 'failed';
        state.error = (err as Error).message;
        if (err instanceof AgentError) state.costUsd += err.costUsd;
        store.save();
        this.log.fail(`${STAGE_TITLES[step]} failed: ${state.error}`);
        this.log.info(`Fix the problem, then run ${c.bold(`ai-team resume ${state.id}`)}`);
        return { state, dir: store.dir };
      }
      store.save();
    }
    return { state, decision, dir: store.dir };
  }

  private async runStep(store: RunStore, step: Exclude<Step, 'release' | 'done'>): Promise<void> {
    switch (step) {
      case 'pm':
        return this.stepPm(store);
      case 'clarify':
        return this.stepClarify(store);
      case 'develop':
        return this.stepDevelop(store);
      case 'checks':
        return this.stepChecks(store);
      case 'qa':
        return this.stepQa(store);
      case 'fix':
        return this.stepFix(store);
      case 'security':
        return this.stepReview(store, 'security');
      case 'review':
        return this.stepReview(store, 'reviewer');
      case 'rework':
        return this.stepRework(store);
    }
  }

  // ── Steps ────────────────────────────────────────────────────────────────

  private async stepPm(store: RunStore) {
    const { state } = store;
    const spec = await this.callAgent(store, 'pm', P.pmPrompt(state), PmOutput);
    state.spec = spec;
    this.log.ok(`Requirements: ${spec.functionalRequirements.length} functional, ${spec.acceptanceCriteria.length} acceptance criteria`);
    this.log.ok(`${spec.edgeCases.length} edge cases identified`);
    if (spec.openQuestions.length) this.log.warn(`${spec.openQuestions.length} open question(s)`);
    state.next = spec.openQuestions.length ? 'clarify' : 'develop';
    if (!spec.openQuestions.length) store.writeArtifact('pm', 'requirements.md', renderSpec(spec));
  }

  private async stepClarify(store: RunStore) {
    const { state } = store;
    const spec = state.spec!;
    for (const q of spec.openQuestions) {
      const answered = this.opts.ask ? await this.opts.ask(`${q.id}: ${q.question}`, q.proposedDefault) : undefined;
      const answer = answered?.trim();
      state.answers.push({ id: q.id, question: q.question, answer: answer || q.proposedDefault, source: answer ? 'user' : 'default' });
      if (!answer) this.log.info(`${c.dim(`${q.id} → default:`)} ${q.proposedDefault}`);
    }
    store.writeArtifact('clarify', 'requirements.md', renderSpec(spec, state.answers));
    this.log.ok('Requirements finalized');
    state.next = 'develop';
  }

  private async stepDevelop(store: RunStore) {
    const { state } = store;
    const dev = await this.callAgent(store, 'developer', P.developPrompt(state), DevOutput);
    state.implementation = dev;
    state.codeVersion += 1;
    store.writeArtifact('develop', 'implementation.md', renderImplementation(dev));
    this.log.ok(`${dev.filesChanged.length} file(s) changed, ${dev.testsAdded.length} test(s) added`);
    const open = dev.criteriaCoverage.filter((c) => c.status !== 'DONE');
    if (open.length) this.log.warn(`Developer reports ${open.length} criteria not fully done: ${open.map((o) => o.id).join(', ')}`);
    this.commit(store, `ai-team: implement ${slugify(state.feature)}`);
    state.next = 'checks';
  }

  private async stepChecks(store: RunStore) {
    const { state } = store;
    const { checks, checkTimeoutSec } = this.opts.config;
    if (!checks.length) this.log.warn('No checks configured — add them to .ai-team/config.json');
    const results = await runChecks(checks, this.opts.root, checkTimeoutSec);
    state.checks = { results, codeVersion: state.codeVersion };
    for (const r of results) (r.passed ? this.log.ok : this.log.fail)(`${r.name} ${c.dim(`(${(r.durationMs / 1000).toFixed(1)}s)`)}`);
    store.writeArtifact('checks', `checks-v${state.codeVersion}.md`, renderChecks(results));
    state.next = 'qa';
  }

  private async stepQa(store: RunStore) {
    const { state } = store;
    const qa = await this.callAgent(store, 'qa', P.qaPrompt(state, this.diff(state)), QaOutput);
    state.qa = { ...qa, codeVersion: state.codeVersion };
    store.writeArtifact('qa', `qa-round${state.iteration + 1}.md`, renderQa(qa, state.iteration + 1));
    this.log.ok(`${qa.scenarios.length} test scenarios`);

    const todo: WorkItem[] = qa.bugs.map((b) => ({
      id: b.id,
      source: 'qa',
      severity: b.severity,
      title: b.title,
      details: `Location: ${b.location}\nSteps:\n${b.steps.map((s, i) => `${i + 1}. ${stripNumber(s)}`).join('\n')}\nExpected: ${b.expected}\nActual: ${b.actual}`,
    }));
    for (const r of state.checks?.results ?? []) {
      if (!r.passed) {
        todo.push({ id: `CHECK-${r.name}`, source: 'checks', severity: 'HIGH', title: `\`${r.command}\` is failing`, details: `Exit code: ${r.exitCode}${r.timedOut ? ' (timed out)' : ''}\nOutput (tail):\n${r.output}` });
      }
    }
    if (qa.status === 'FAIL' && todo.length === 0) {
      todo.push({ id: 'QA-FAIL', source: 'qa', severity: 'HIGH', title: 'QA failed without itemized bugs', details: qa.summary });
    }

    if (todo.length) {
      this.log.fail(`${todo.length} issue(s): ${todo.map((t) => t.id).join(', ')}`);
      this.loopBack(store, todo, 'fix');
    } else {
      this.log.ok('QA PASSED');
      state.todo = [];
      state.next = this.securityEnabled(state) ? 'security' : 'review';
    }
  }

  private async stepFix(store: RunStore) {
    const { state } = store;
    const fix = await this.callAgent(store, 'bugFixer', P.fixPrompt(state), FixOutput);
    state.fixes.push(fix);
    state.codeVersion += 1;
    store.writeArtifact('fix', `fix-round${state.iteration}.md`, renderFix(fix, `Bug fixes — round ${state.iteration}`, state.todo));
    for (const f of fix.fixes) (f.status === 'FIXED' ? this.log.ok : this.log.warn)(`${f.id} ${f.status.toLowerCase().replace(/_/g, ' ')}`);
    this.commit(store, `ai-team: fix ${state.todo.map((t) => t.id).join(', ')}`.slice(0, 200));
    state.todo = [];
    state.next = 'checks';
  }

  private async stepReview(store: RunStore, role: 'security' | 'reviewer') {
    const { state } = store;
    const diff = this.diff(state);
    const prompt = role === 'security' ? P.securityPrompt(state, diff) : P.reviewPrompt(state, diff);
    const review = await this.callAgent(store, role, prompt, ReviewOutput);
    // The gate, not the agent, decides what blocks: any non-LOW finding rejects.
    const blocking = review.findings.filter((f) => f.severity !== 'LOW');
    const status = review.status === 'APPROVED' && blocking.length === 0 ? 'APPROVED' : 'REJECTED';
    const verdict = { ...review, status, codeVersion: state.codeVersion } as const;
    const label = role === 'security' ? 'Security review' : 'Code review';
    if (role === 'security') state.security = verdict;
    else state.review = verdict;
    store.writeArtifact(role === 'security' ? 'security' : 'review', `${role === 'security' ? 'security' : 'code-review'}-v${state.codeVersion}.md`, renderReview(verdict, `${label} — code revision ${state.codeVersion}`));

    if (status === 'APPROVED') {
      this.log.ok(`${label} APPROVED${review.findings.length ? c.dim(` (${review.findings.length} low-severity note(s))`) : ''}`);
      state.todo = [];
      state.next = role === 'security' ? 'review' : 'release';
      return;
    }
    const items = (blocking.length ? blocking : review.findings).map<WorkItem>((f) => ({
      id: f.id,
      source: role === 'security' ? 'security' : 'review',
      severity: f.severity,
      title: `${f.category}: ${f.description.split('\n')[0].slice(0, 120)}`,
      details: `File: ${f.file}\nIssue: ${f.description}\nSuggestion: ${f.suggestion}`,
    }));
    if (!items.length) items.push({ id: role === 'security' ? 'SEC-REJECT' : 'REV-REJECT', source: role === 'security' ? 'security' : 'review', severity: 'HIGH', title: 'Rejected without itemized findings', details: review.summary });
    this.log.fail(`${label} REJECTED: ${items.map((i) => `${i.id} (${i.severity})`).join(', ')}`);
    this.loopBack(store, items, 'rework');
  }

  private async stepRework(store: RunStore) {
    const { state } = store;
    const dev = await this.callAgent(store, 'developer', P.reworkPrompt(state), DevOutput);
    state.fixes.push({ summary: dev.summary, fixes: [], filesChanged: dev.filesChanged, commandsRun: dev.commandsRun });
    state.codeVersion += 1;
    store.writeArtifact('rework', `rework-round${state.iteration}.md`, renderImplementation(dev, `Rework — round ${state.iteration} (${state.todo.map((t) => t.id).join(', ')})`));
    this.log.ok(`${dev.filesChanged.length} file(s) changed`);
    this.commit(store, `ai-team: address review findings ${state.todo.map((t) => t.id).join(', ')}`.slice(0, 200));
    state.todo = [];
    state.next = 'checks';
  }

  private release(store: RunStore): ReleaseDecision {
    const { state } = store;
    const decision = evaluateRelease(state, { securityEnabled: this.securityEnabled(state), checksConfigured: this.opts.config.checks.length > 0 });
    store.writeArtifact('release', 'release.md', renderRelease(state, decision));
    state.status = decision.approved ? 'approved' : 'rejected';
    state.next = 'done';
    if (decision.approved) {
      this.recordLessons(state);
      this.commit(store, `ai-team: ${slugify(state.feature)} approved`);
    }
    const lines = decision.lines.map<[string, string]>((l) => [l.label, `${l.status}${l.detail ? c.dim(` — ${l.detail}`) : ''}`]);
    lines.push(['Cost', `$${state.costUsd.toFixed(2)}`]);
    this.log.raw('\n' + banner(lines, decision.approved ? c.green(c.bold('APPROVED ✅')) : c.red(c.bold('REJECTED ❌'))));
    if (!decision.approved) decision.reasons.forEach((r, i) => this.log.raw(`  ${i + 1}. ${r}`));
    return decision;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Sends work back for another round, or to the release gate if the iteration budget is spent. */
  private loopBack(store: RunStore, items: WorkItem[], step: 'fix' | 'rework') {
    const { state } = store;
    state.todo = sortBySeverity(items);
    if (state.iteration >= state.maxIterations) {
      this.log.warn(`Iteration limit (${state.maxIterations}) reached — sending to the release gate`);
      state.next = 'release';
      return;
    }
    state.iteration += 1;
    this.log.info(c.dim(`Round ${state.iteration}/${state.maxIterations} → ${step === 'fix' ? 'Bug Fixer' : 'Developer'}`));
    state.next = step;
  }

  private async callAgent<T>(store: RunStore, roleName: RoleName, prompt: string, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { message: string } } }): Promise<T> {
    const role = ROLES[roleName];
    const { config, root, provider } = this.opts;
    const result = await provider.run({
      role: roleName,
      systemPrompt: buildSystemPrompt(root, role),
      prompt,
      outputSchema: toJsonSchema(role.schema),
      canWrite: role.canWrite,
      canRunCommands: role.canRunCommands,
      cwd: root,
      model: config.models[roleName] ?? config.model,
      maxTurns: config.maxTurnsPerAgent,
      maxBudgetUsd: config.maxBudgetUsdPerAgent,
      bypassPermissions: config.permissions === 'bypass',
      onActivity: (line) => this.log.activity(line),
    });
    store.state.costUsd += result.costUsd;
    const parsed = schema.safeParse(result.output);
    if (!parsed.success) throw new AgentError(`${role.title} returned output that does not match its contract: ${parsed.error.message}`);
    return parsed.data;
  }

  private setupGit(store: RunStore) {
    const { config, root } = this.opts;
    if (!git.isGitRepo(root)) {
      if (config.git.branch || config.git.commit) this.log.warn('Git integration is enabled but this is not a git repository — skipping');
      return;
    }
    store.state.baseCommit = git.headCommit(root);
    store.state.startedDirty = !git.isClean(root);
    if (!config.git.branch && !config.git.commit) return;
    if (store.state.startedDirty) {
      this.log.warn('Working tree has uncommitted changes — git branch/commits disabled for this run so your work is not mixed in');
      return;
    }
    store.state.git = { commits: config.git.commit };
    if (config.git.branch) {
      store.state.git.branch = git.createBranch(root, `ai-team/${slugify(store.state.feature)}`);
      this.log.ok(`Branch ${store.state.git.branch}`);
    }
  }

  /** The real diff since the run started, so reviewers don't depend on agents' self-reports. */
  private diff(state: RunState): git.DiffSnapshot | undefined {
    if (!state.baseCommit) return undefined;
    try {
      return git.diffSince(this.opts.root, state.baseCommit);
    } catch (err) {
      this.log.warn(`Could not compute git diff: ${(err as Error).message.split('\n')[0]}`);
      return undefined;
    }
  }

  private commit(store: RunStore, message: string) {
    if (!store.state.git?.commits) return;
    try {
      if (git.commitAll(this.opts.root, message)) this.log.ok(c.dim(`commit: ${message}`));
    } catch (err) {
      this.log.warn(`git commit failed: ${(err as Error).message.split('\n')[0]}`);
    }
  }

  private recordLessons(state: RunState) {
    const lessons = [...new Set([...(state.security?.lessons ?? []), ...(state.review?.lessons ?? [])])];
    if (!lessons.length) return;
    const file = paths(this.opts.root).lessons;
    if (!fs.existsSync(file)) return;
    const existing = fs.readFileSync(file, 'utf8');
    const fresh = lessons.filter((l) => !existing.includes(l));
    if (!fresh.length) return;
    fs.appendFileSync(file, `\n## ${state.spec?.title ?? state.feature} (${state.createdAt.slice(0, 10)})\n\n${fresh.map((l) => `- ${l}`).join('\n')}\n`);
    this.log.ok(`${fresh.length} lesson(s) added to engineering memory`);
  }
}

const SEVERITY_ORDER: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
function sortBySeverity(items: WorkItem[]): WorkItem[] {
  return [...items].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
}
