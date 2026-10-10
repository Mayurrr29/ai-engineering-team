import type { CheckResult } from './checks.js';
import type { DiffSnapshot } from './git.js';
import type { LearnedRule } from './rules.js';
import type { ScanLead } from './scans.js';
import { renderChecks, renderDesign, renderSpec } from './render.js';
import type { Depth } from './schemas.js';
import type { RunState, WorkItem } from './state.js';
import { nameOf, type RoleId, type TeamNames } from './team.js';

const section = (title: string, body: string) => `## ${title}\n\n${body.trim()}`;

export interface PromptEnv {
  names: TeamNames;
}

/** The change since a member last judged the code. */
export interface DeltaDiff {
  fromVersion: number;
  stat: string;
  patch: string;
  truncated: boolean;
}

function brief(state: RunState, role: RoleId, env: PromptEnv): string {
  const text = state.plan?.briefs[role as Exclude<RoleId, 'lead'>]?.trim();
  return text ? section(`Brief from ${nameOf('lead', env.names)}`, text) : '';
}

function depthNote(depth: Depth | undefined): string {
  if (depth === 'light') return 'Depth: **light** — focus on the acceptance criteria and the top risks in your brief; be quick and targeted.';
  if (depth === 'full') return 'Depth: **full** — systematic coverage using your whole method.';
  return '';
}

function requirements(state: RunState): string {
  if (state.spec) return section('Approved specification', renderSpec(state.spec, state.answers));
  return section(
    'Request (no separate spec for this mission — derive the acceptance criteria from the request and the codebase conventions)',
    state.feature,
  );
}

function design(state: RunState): string {
  return state.design ? section('Design', renderDesign(state.design, { diagrams: false })) : '';
}

/** All files any member reported touching. */
export function reportedFiles(state: RunState): string[] {
  const files = new Set<string>();
  state.implementation?.filesChanged.forEach((f) => files.add(f.path));
  state.fixes.forEach((fx) => fx.filesChanged.forEach((f) => files.add(f.path)));
  return [...files];
}

function changes(state: RunState, diff?: DiffSnapshot, delta?: DeltaDiff): string {
  const files = reportedFiles(state);
  const parts = [
    `Files reported as changed (the list may be incomplete — the diff below is the source of truth):\n${files.length ? files.map((f) => `- ${f}`).join('\n') : '- (none reported)'}`,
    `Developer summary: ${state.implementation?.summary ?? 'n/a'}`,
  ];
  if (state.fixes.length) parts.push(`Fix rounds so far:\n${state.fixes.map((f) => `- round ${f.round} (${f.by}): ${f.summary}`).join('\n')}`);
  if (diff) {
    const caveat = state.startedDirty ? ' It may also include changes that were already uncommitted before the mission started.' : '';
    parts.push(`### Diff since the mission started (computed by the orchestrator)${caveat}\n\n\`\`\`\n${diff.stat || '(no tracked changes)'}\n\`\`\``);
    if (diff.untracked.length) parts.push(`New files:\n${diff.untracked.map((f) => `- ${f}`).join('\n')}`);
    if (delta) {
      // Re-review: the member already judged everything up to delta.fromVersion. Send only what changed since.
      parts.push(
        `### What changed since you last looked (revision ${delta.fromVersion} → ${state.codeVersion})\n\nYou already reviewed the rest of the change. Focus on this delta and on how it interacts with the code around it; read any file directly if you need more context.\n\n\`\`\`\n${delta.stat || '(no changes)'}\n\`\`\`${delta.patch ? `\n\n\`\`\`diff\n${delta.patch}\n\`\`\`${delta.truncated ? '\n(delta truncated — read the changed files directly)' : ''}` : ''}`,
      );
    } else if (diff.patch) {
      parts.push(`\`\`\`diff\n${diff.patch}\n\`\`\`${diff.truncated ? '\n(diff truncated — read the remaining changed files directly)' : ''}`);
    }
  }
  return section('What changed', parts.join('\n\n'));
}

function checksSection(state: RunState): string {
  if (!state.checks) return '';
  const { results, preexisting } = state.checks;
  const note = preexisting.length ? `\n\nAlready failing before this mission (not caused by it): ${preexisting.join(', ')}.` : '';
  return section('Automated checks on the current code (run by the orchestrator)', renderChecks(results).replace(/^# Checks\s*/, '') + note);
}

function leadsSection(leads: ScanLead[], audience: 'security' | 'reviewer'): string {
  const mine = leads.filter((l) => l.audience === audience || audience === 'security');
  if (!mine.length) return '';
  return section(
    'Automated scan leads (pattern matches in the added lines — verify each; they can be false positives)',
    mine.map((l) => `- [${l.rule}] ${l.title} (${l.severity}, ${l.standard}) in \`${l.file}\`: \`${l.snippet.replace(/`/g, "'")}\``).join('\n'),
  );
}

function guidanceFromLead(state: RunState, env: PromptEnv): string {
  const withGuidance = state.todo.filter((t) => t.guidance);
  if (!withGuidance.length) return '';
  return section(
    `Guidance from ${nameOf('lead', env.names)} (the previous approach didn't work — follow this)`,
    withGuidance.map((t) => `- **${t.id}**: ${t.guidance}`).join('\n'),
  );
}

const DOWNSTREAM: RoleId[] = ['qa', 'security', 'reviewer', 'bugFixer', 'developer', 'lead'];

/**
 * Only the ledger entries meant for this member: signals addressed to them or the whole team, plus the decisions
 * (human answers and teammates' assumptions) that anyone checking the work must know so they don't flag them as bugs.
 */
export function teamNotes(state: RunState, role: RoleId, env: PromptEnv): string {
  const lines: string[] = [];
  for (const a of state.answers.filter((a) => !state.spec?.openQuestions.some((q) => q.id === a.id))) {
    lines.push(`- **Decision ${a.id}** — ${a.question} → ${a.answer} (${a.source === 'user' ? 'answered by the human' : 'default, nobody answered'})`);
  }
  for (const s of state.signals ?? []) {
    if (s.from === role || s.kind === 'question' || s.kind === 'recruit') continue;
    const forMe = s.to === role || s.to === 'team' || (s.kind === 'assumption' && DOWNSTREAM.includes(role)) || (s.kind === 'blocker' && role === 'lead');
    if (!forMe) continue;
    const label = s.kind === 'assumption' ? 'Assumption' : s.kind === 'blocker' ? 'Blocker' : 'Concern';
    lines.push(`- **${label} from ${nameOf(s.from, env.names)}** (${s.id}): ${s.summary}${s.evidence ? ` — evidence: ${s.evidence}` : ''}`);
  }
  if (!lines.length) return '';
  return section('Notes from the team (decisions already made and points raised for you)', lines.slice(-12).join('\n'));
}

function workItems(items: WorkItem[]): string {
  return items.map((i) => `### ${i.id} — ${i.title}\nSource: ${i.source} · Severity: ${i.severity}\n\n${i.details.trim()}`).join('\n\n');
}

function task(text: string, ...extra: string[]): string {
  return [section('Your task', text), ...extra.filter(Boolean)].join('\n\n');
}

// ── Prompts per step ──────────────────────────────────────────────────────

export function planPrompt(state: RunState, env: PromptEnv & { costTable: string; checks: string[]; packs: string[]; hasProfile: boolean }): string {
  const budget = state.budgetUsd ? `$${state.budgetUsd.toFixed(2)} for the whole mission.` : 'No budget limit set — still keep the team as small as the task safely allows.';
  return [
    section('Mission request', state.feature),
    section('Budget', budget),
    section('Typical costs on this project', env.costTable),
    section(
      'Automatic support (no AI cost)',
      `Checks that run after every code change: ${env.checks.length ? env.checks.join(', ') : 'none configured'}.\nStack packs active: ${env.packs.length ? env.packs.join(', ') : 'none'}.${env.hasProfile ? '' : '\nThe team has not onboarded this project yet, so members will explore it as they go.'}`,
    ),
    task(
      `Plan this mission (mode: mission planning). Size it, assess its risk, choose the smallest lineup that will deliver it correctly and safely, set each member's effort, and write a brief for every staffed member. Read only as much code as you need to size the work.`,
    ),
  ].join('\n\n');
}

export function pmPrompt(state: RunState, env: PromptEnv): string {
  const size = state.plan?.size;
  return [
    section('Mission request', state.feature),
    task(
      `Write the specification for this request. Explore the codebase first so it fits what already exists.${size ? `\n\n${nameOf('lead', env.names)} sized this mission **${size}** — keep the spec within the budget for that size.` : ''}`,
      brief(state, 'pm', env),
    ),
  ].join('\n\n');
}

export function designPrompt(state: RunState, env: PromptEnv): string {
  const planning = state.plan?.taskType === 'planning';
  return [
    requirements(state),
    task(
      planning
        ? 'Mode: planning. The human wants a plan, not code — nothing will be built in this mission. Study the codebase, then write the design: decisions with trade-offs, data model and API changes, risks, and ordered `milestones` (each with deliverables, acceptance criteria and dependencies) that a team could execute one by one.'
        : 'Design the solution for this mission and write the build plan.',
      brief(state, 'architect', env),
    ),
  ].join('\n\n');
}

export function answerPrompt(state: RunState, env: PromptEnv): string {
  return [
    section('Question from the human', state.feature),
    state.plan?.briefs.architect ? section(`Note from ${nameOf('lead', env.names)}`, state.plan.briefs.architect) : '',
    task(
      'Mode: answering. The human asked a question; nothing will be changed. Investigate the repository until you can answer with evidence, then answer directly: the answer first, then the supporting detail with file:line references. Say plainly what you could not verify.',
    ),
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function developPrompt(state: RunState, env: PromptEnv): string {
  const preexisting = state.baseline?.results.filter((r) => !r.passed).map((r) => r.name) ?? [];
  return [
    requirements(state),
    design(state),
    preexisting.length ? section('Already failing before this mission', `${preexisting.join(', ')} — not your job unless your change is related.`) : '',
    state.plan?.keyFiles.length ? section(`Where to start (${nameOf('lead', env.names)} already looked)`, state.plan.keyFiles.map((f) => `- \`${f}\``).join('\n')) : '',
    surfacesNote(state),
    teamNotes(state, 'developer', env),
    task(
      state.plan?.taskType === 'bugfix'
        ? 'Mode: debugging. Fix the reported problem at its root cause. Reproduce it first with a failing test, confirm the cause with evidence before changing code, then fix it, make the reproduction pass and check for the same mistake nearby. Report the root cause in `rootCause` and use criteria ids AC-1… for what the fix must achieve.'
        : 'Implement this mission in the repository: every acceptance criterion, the listed edge and error cases, and tests that prove them. If there is no separate spec, write the acceptance criteria you derived as AC-1, AC-2… in `criteriaCoverage`.',
      brief(state, 'developer', env),
    ),
  ]
    .filter(Boolean)
    .join('\n\n');
}

function surfacesNote(state: RunState): string {
  const surfaces = state.plan?.surfaces ?? [];
  if (!surfaces.length) return '';
  return section(
    'Parts of the system this request affects',
    `${surfaces.join(', ')}. Every listed part is part of "done" — the orchestrator checks the change against this list.${surfaces.includes('frontend') ? ' For the frontend that means the user-facing screens and their loading, empty and error states, not just the API behind them.' : ''}`,
  );
}

export function qaPrompt(state: RunState, env: PromptEnv & { diff?: DiffSnapshot; delta?: DeltaDiff; labDir: string; depth: Depth }): string {
  const parts = [requirements(state), design(state), changes(state, env.diff, env.delta), checksSection(state), teamNotes(state, 'qa', env)];
  if (state.qa?.bugs.length) {
    parts.push(
      section(
        'Bugs reported in the previous QA round (re-verify each; reuse its id if still present)',
        state.qa.bugs.map((b) => `- ${b.id} (${b.severity}) ${b.title} — ${b.location}`).join('\n'),
      ),
    );
  }
  const round = state.qaRounds.length + 1;
  const retest =
    round > 1
      ? `\n\nThis is a **re-test round** after fixes. Verify each previously reported bug with its original reproduction (your earlier lab scripts are in the sibling \`qa-lab-*\` directories — reuse them), probe the code the fix touched and anything it could have broken, and keep an eye out for risks you didn't cover before. You don't need to repeat scenarios that passed earlier and that the fix couldn't affect.`
      : '';
  parts.push(
    task(
      `Test this change (QA round ${round}). Verify every acceptance criterion and edge case with evidence, then try to break it.${retest}\n\nYour lab directory: \`${env.labDir}\` — write throwaway test scripts there (they can import the project's code); don't modify project files.\n\n${depthNote(env.depth)}`,
      brief(state, 'qa', env),
    ),
  );
  return parts.filter(Boolean).join('\n\n');
}

/** Continuing a member's own session: they already have the spec, the design and their change in context. */
interface SessionEnv {
  inSession?: boolean;
  delta?: DeltaDiff;
}

function sinceYourLastTurn(state: RunState, delta?: DeltaDiff): string {
  if (!delta) return '';
  return section(
    `The code changed since your last turn (revision ${delta.fromVersion} → ${state.codeVersion}, by teammates)`,
    `\`\`\`\n${delta.stat || '(no changes)'}\n\`\`\`${delta.patch ? `\n\n\`\`\`diff\n${delta.patch}\n\`\`\`` : ''}`,
  );
}

export function fixPrompt(state: RunState, env: PromptEnv & SessionEnv): string {
  if (env.inSession) {
    return [
      section(`${nameOf('qa', env.names)} and the checks found problems in your change`, workItems(state.todo)),
      sinceYourLastTurn(state, env.delta),
      teamNotes(state, 'developer', env),
      task(
        `Fix the ${state.todo.length} item(s) above. For each: reproduce it (a failing test), find the root cause rather than the symptom, fix it, make the test pass, and check the rest of your change for the same mistake. If an item is not a bug according to the spec, mark it NOT_A_BUG and cite the evidence; if you can't fix it, NOT_FIXED and say exactly what blocks you. Answer in the fix-report format: per item id, status, root cause, change and regression test, plus every file you changed.`,
      ),
    ]
      .filter(Boolean)
      .join('\n\n');
  }
  return [
    section('Items to fix', workItems(state.todo)),
    guidanceFromLead(state, env),
    requirements(state),
    changes(state),
    teamNotes(state, 'bugFixer', env),
    task(
      `Fix the ${state.todo.length} item(s) above, found by ${nameOf('qa', env.names)} and the automated checks. For each: reproduce, fix the root cause, add a regression test, and run the related tests.`,
      brief(state, 'bugFixer', env),
    ),
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function reworkPrompt(state: RunState, env: PromptEnv & SessionEnv): string {
  const sourceName = (t: WorkItem) => (t.source === 'security' ? nameOf('security', env.names) : t.source === 'completeness' || t.source === 'checks' ? 'the orchestrator’s completeness checks' : nameOf('reviewer', env.names));
  const sources = [...new Set(state.todo.map(sourceName))].join(' and ');
  if (env.inSession) {
    return [
      section('Items to address', workItems(state.todo)),
      guidanceFromLead(state, env),
      sinceYourLastTurn(state, env.delta),
      teamNotes(state, 'developer', env),
      task(
        `Your change was sent back by ${sources}. Address every item above: fix it properly, or explain with evidence why it isn't a problem (status NOT_DONE with the evidence in notes — the team lead will rule). In \`criteriaCoverage\` use the item ids; list every file you changed.`,
      ),
    ]
      .filter(Boolean)
      .join('\n\n');
  }
  return [
    section('Items to address', workItems(state.todo)),
    guidanceFromLead(state, env),
    requirements(state),
    design(state),
    changes(state),
    surfacesNote(state),
    teamNotes(state, 'developer', env),
    task(
      `Your implementation was sent back by ${sources}. Address every item above: fix it properly, or explain with evidence why it isn't a problem (status NOT_DONE with the evidence in notes — the team lead will rule). In \`criteriaCoverage\` use the item ids; list every file you changed.`,
    ),
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function securityPrompt(state: RunState, env: PromptEnv & { diff?: DiffSnapshot; delta?: DeltaDiff; leads: ScanLead[]; depth: Depth }): string {
  const parts = [requirements(state), design(state), changes(state, env.diff, env.delta), leadsSection(env.leads, 'security'), teamNotes(state, 'security', env)];
  if (state.security?.findings.length) {
    parts.push(section('Your findings from the previous round (re-verify; reuse ids if still present)', state.security.findings.map((f) => `- ${f.id} (${f.severity}) ${f.description}`).join('\n')));
  }
  parts.push(task(`Review the security of this change. ${depthNote(env.depth)}`, brief(state, 'security', env)));
  return parts.filter(Boolean).join('\n\n');
}

export function reviewPrompt(state: RunState, env: PromptEnv & { diff?: DiffSnapshot; delta?: DeltaDiff; leads: ScanLead[]; depth: Depth }): string {
  const parts = [requirements(state), design(state), changes(state, env.diff, env.delta), checksSection(state), leadsSection(env.leads, 'reviewer'), teamNotes(state, 'reviewer', env)];
  if (state.qa) parts.push(section('QA result', `${state.qa.status}: ${state.qa.summary}`));
  if (state.review?.findings.length) {
    parts.push(section('Your findings from the previous round (re-verify; reuse ids if still present)', state.review.findings.map((f) => `- ${f.id} (${f.severity}) ${f.description}`).join('\n')));
  }
  parts.push(task(`Review this change as a strict senior reviewer would review a pull request. ${depthNote(env.depth)}`, brief(state, 'reviewer', env)));
  return parts.filter(Boolean).join('\n\n');
}

export function arbitratePrompt(state: RunState, env: PromptEnv): string {
  const history = state.todo
    .map((t) => {
      const h = state.items[t.id];
      return `- **${t.id}** (${t.severity}, from ${t.source}): ${t.title}\n  Reported in ${h?.seen ?? 1} round(s); fix attempts claimed: ${h?.fixClaims ?? 0}; disputed by fixer: ${h?.disputes ?? 0}.\n  ${t.details.replace(/\n/g, '\n  ')}`;
    })
    .join('\n');
  const lastFix = state.fixes.at(-1);
  const fixerView = lastFix
    ? section(
        `What the last fixer (${lastFix.by === 'bugFixer' ? nameOf('bugFixer', env.names) : nameOf('developer', env.names)}) said`,
        lastFix.fixes.length
          ? lastFix.fixes.map((f) => `- ${f.id}: ${f.status} — ${f.rootCause} ${f.change}`).join('\n')
          : lastFix.summary,
      )
    : '';
  return [
    requirements(state),
    changes(state),
    fixerView,
    section('Items in dispute or recurring', history),
    teamNotes(state, 'lead', env),
    task(
      'Mode: arbitration. The team is stuck on the items above. Read the relevant code and the spec, then rule on each item: fix (with guidance that changes the approach), waive (MEDIUM/LOW only, with a reason), or escalate (a one-line product question for the human).',
    ),
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function debriefPrompt(state: RunState, env: PromptEnv & { gateSummary: string; learned: LearnedRule[] }): string {
  const lessons = [...new Set([...(state.security?.lessons ?? []), ...(state.review?.lessons ?? [])])];
  const evidence = [
    state.implementation ? `Tests added: ${state.implementation.testsAdded.join(', ') || 'none listed'}` : '',
    state.qa ? `QA: ${state.qa.status}, ${state.qa.scenarios.length} scenarios, ${state.qaRounds.length} round(s); bugs found over the mission: ${[...new Set(state.qaRounds.flatMap((r) => r.bugIds))].join(', ') || 'none'}` : 'QA: not staffed',
    state.security ? `Security: ${state.security.status} — ${state.security.summary}` : 'Security: not staffed',
    state.review ? `Code review: ${state.review.status} — ${state.review.summary}` : 'Code review: not staffed',
    state.checks ? `Checks: ${state.checks.results.map((r) => `${r.name} ${r.passed ? 'pass' : 'fail'}`).join(', ') || 'none configured'}` : '',
    state.waivers.length ? `Waived: ${state.waivers.map((w) => `${w.id} (${w.reason})`).join('; ')}` : '',
  ].filter(Boolean);
  return [
    section('Mission request', state.feature),
    state.spec
      ? section(
          'Specification (summary)',
          `${state.spec.title}: ${state.spec.goal}\nAcceptance criteria: ${state.spec.acceptanceCriteria.length} · edge cases: ${state.spec.edgeCases.length}\nDecisions: ${state.answers.map((a) => `${a.id} ${a.question} → ${a.answer}`).join('; ') || 'none'}`,
        )
      : '',
    section('Implementation summary', `${state.implementation?.summary ?? 'n/a'}\n\nFiles: ${reportedFiles(state).join(', ') || 'n/a'}\n\nDeveloper notes: ${state.implementation?.notes.join(' ') || 'none'}`),
    section('Evidence', evidence.map((e) => `- ${e}`).join('\n')),
    section(`Release gate (${nameOf('gate', env.names)})`, env.gateSummary),
    section('Lessons proposed by reviewers', lessons.length ? lessons.map((l) => `- ${l}`).join('\n') : 'none'),
    section('Current learned rules', env.learned.length ? env.learned.map((r) => `- [${r.id}] ${r.text}`).join('\n') : 'none yet'),
    task('Mode: debrief. Write the mission report for the human, and propose rulebook updates (zero is fine).'),
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function onboardPrompt(facts: string): string {
  return [section('What the orchestrator already detected', facts), task('Mode: onboarding. Study this repository and write the project profile for the team.')].join('\n\n');
}

export function checksForPrompt(results: CheckResult[]): string {
  return renderChecks(results);
}
