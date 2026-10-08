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

function changes(state: RunState, diff?: DiffSnapshot): string {
  const files = reportedFiles(state);
  const parts = [
    `Files reported as changed (the list may be incomplete — the diff below is the source of truth):\n${files.length ? files.map((f) => `- ${f}`).join('\n') : '- (none reported)'}`,
    `Developer summary: ${state.implementation?.summary ?? 'n/a'}`,
  ];
  if (state.fixes.length) parts.push(`Fix rounds so far:\n${state.fixes.map((f) => `- round ${f.round} (${f.by}): ${f.summary}`).join('\n')}`);
  if (diff) {
    const caveat = state.startedDirty ? ' It may also include changes that were already uncommitted before the mission started.' : '';
    parts.push(`### Diff since the mission started (computed by the orchestrator)${caveat}\n\n\`\`\`\n${diff.stat || '(no tracked changes)'}\n\`\`\``);
    if (diff.untracked.length) parts.push(`New files (read them in full):\n${diff.untracked.map((f) => `- ${f}`).join('\n')}`);
    if (diff.patch) parts.push(`\`\`\`diff\n${diff.patch}\n\`\`\`${diff.truncated ? '\n(diff truncated — read the remaining changed files directly)' : ''}`);
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
  return [requirements(state), task('Design the solution for this mission and write the build plan.', brief(state, 'architect', env))].join('\n\n');
}

export function developPrompt(state: RunState, env: PromptEnv): string {
  const preexisting = state.baseline?.results.filter((r) => !r.passed).map((r) => r.name) ?? [];
  return [
    requirements(state),
    design(state),
    preexisting.length ? section('Already failing before this mission', `${preexisting.join(', ')} — not your job unless your change is related.`) : '',
    task(
      'Implement this mission in the repository: every acceptance criterion, the listed edge and error cases, and tests that prove them.',
      brief(state, 'developer', env),
    ),
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function qaPrompt(state: RunState, env: PromptEnv & { diff?: DiffSnapshot; labDir: string; depth: Depth }): string {
  const parts = [requirements(state), design(state), changes(state, env.diff), checksSection(state)];
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

export function fixPrompt(state: RunState, env: PromptEnv): string {
  return [
    section('Items to fix', workItems(state.todo)),
    guidanceFromLead(state, env),
    requirements(state),
    changes(state),
    task(
      `Fix the ${state.todo.length} item(s) above, found by ${nameOf('qa', env.names)} and the automated checks. For each: reproduce, fix the root cause, add a regression test, and run the related tests.`,
      brief(state, 'bugFixer', env),
    ),
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function reworkPrompt(state: RunState, env: PromptEnv): string {
  const sources = [...new Set(state.todo.map((t) => (t.source === 'security' ? nameOf('security', env.names) : nameOf('reviewer', env.names))))].join(' and ');
  return [
    section('Findings to address', workItems(state.todo)),
    guidanceFromLead(state, env),
    requirements(state),
    design(state),
    changes(state),
    task(
      `Your implementation was rejected by ${sources}. Address every finding above: fix it properly, or explain with evidence why it isn't a problem. In \`criteriaCoverage\` use the finding ids; list every file you changed.`,
    ),
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function securityPrompt(state: RunState, env: PromptEnv & { diff?: DiffSnapshot; leads: ScanLead[]; depth: Depth }): string {
  const parts = [requirements(state), design(state), changes(state, env.diff), leadsSection(env.leads, 'security')];
  if (state.security?.findings.length) {
    parts.push(section('Your findings from the previous round (re-verify; reuse ids if still present)', state.security.findings.map((f) => `- ${f.id} (${f.severity}) ${f.description}`).join('\n')));
  }
  parts.push(task(`Review the security of this change. ${depthNote(env.depth)}`, brief(state, 'security', env)));
  return parts.filter(Boolean).join('\n\n');
}

export function reviewPrompt(state: RunState, env: PromptEnv & { diff?: DiffSnapshot; leads: ScanLead[]; depth: Depth }): string {
  const parts = [requirements(state), design(state), changes(state, env.diff), checksSection(state), leadsSection(env.leads, 'reviewer')];
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
