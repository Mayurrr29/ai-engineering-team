import type { CheckResult } from './checks.js';
import type { Debrief, DesignOutput, DevOutput, FixOutput, LeadDecision, MissionPlan, PmOutput, QaOutput, ReviewOutput } from './schemas.js';
import type { Answer, RunState, WorkItem } from './state.js';
import { MEMBERS, nameOf, type TeamNames } from './team.js';

const list = (items: string[], empty = '_None._') => (items.length ? items.map((i) => `- ${i}`).join('\n') : empty);
const fence = (text: string, lang = '') => '```' + lang + '\n' + text.replace(/```/g, "'''") + '\n```';

/** Models often number list items themselves; avoid "1. 1. ...". */
export function stripNumber(text: string): string {
  return text.replace(/^\s*(?:step\s*)?\d+[.):]\s*/i, '');
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

/** Strips code fences an agent may have wrapped around Mermaid source. */
export function mermaidSource(text: string): string {
  return text
    .trim()
    .replace(/^```(?:mermaid)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
}

export function renderPlan(plan: MissionPlan, state: RunState, names: TeamNames): string {
  const lineupRows = (['pm', 'architect', 'developer', 'qa', 'security', 'reviewer'] as const).map((role) => {
    const depth = role === 'developer' ? 'full' : state.lineup[role];
    const plannedDepth = role === 'developer' ? 'full' : plan.lineup[role];
    const upgraded = depth !== plannedDepth ? ` (raised from ${plannedDepth} by guardrail)` : '';
    return `| ${MEMBERS[role].icon} ${nameOf(role, names)} | ${MEMBERS[role].title} | ${depth}${upgraded} | ${state.effort[role] ?? '-'} | ${cell(plan.briefs[role] || '—')} |`;
  });
  return [
    `# Mission plan — ${plan.missionName}`,
    `> ${plan.summary}`,
    `| Size | Risk | Risk areas | Surfaces | Estimated cost |\n|---|---|---|---|---|\n| **${plan.size}** | ${plan.risk} | ${plan.riskAreas.join(', ') || 'none'} | ${plan.surfaces.join(', ') || '-'} | $${plan.estimatedCostUsd.toFixed(2)} |`,
    `## Why this team\n\n${plan.rationale}`,
    `## Lineup\n\n| Member | Role | Depth | Effort | Brief |\n|---|---|---|---|---|\n${lineupRows.join('\n')}\n\n${nameOf('bugFixer', names)} is on call and joins only if something is broken. ${nameOf('gate', names)} runs at the end.`,
    state.upgrades.length ? `## Guardrail upgrades\n\n${list(state.upgrades.map((u) => `${u.member} → ${u.to}: ${u.reason}`))}` : '',
    plan.keyFiles.length ? `## Key files\n\n${list(plan.keyFiles.map((f) => `\`${f}\``))}` : '',
    plan.budgetNote ? `## Budget note\n\n${plan.budgetNote}` : '',
  ]
    .filter(Boolean)
    .join('\n\n') + '\n';
}

export function renderSpec(spec: PmOutput, answers: Answer[] = []): string {
  const out = [
    `# ${spec.title}`,
    `## Goal\n\n${spec.goal}`,
    `## Functional requirements\n\n${list(spec.functionalRequirements)}`,
    `## Non-functional requirements\n\n${list(spec.nonFunctionalRequirements)}`,
    `## User flow\n\n${spec.userFlow.map((s, i) => `${i + 1}. ${stripNumber(s)}`).join('\n') || '_None._'}`,
    `## Acceptance criteria\n\n${spec.acceptanceCriteria.map((a) => `- **${a.id}** ${a.criterion}`).join('\n')}`,
    `## Edge cases\n\n${list(spec.edgeCases.map((e) => `**${e.id}** ${e.case} → _${e.expected}_`))}`,
    `## Error cases\n\n${list(spec.errorCases)}`,
    `## Security considerations\n\n${list(spec.securityConsiderations)}`,
    `## Out of scope\n\n${list(spec.outOfScope)}`,
  ];
  if (answers.length) {
    out.push(
      `## Decisions\n\n${answers
        .map((a) => `- **${a.id}** ${a.question}\n  → ${a.answer} _(${a.source === 'user' ? 'answered by you' : 'default assumed'})_`)
        .join('\n')}`,
    );
  } else if (spec.openQuestions.length) {
    out.push(`## Open questions\n\n${list(spec.openQuestions.map((q) => `**${q.id}** ${q.question} (default: ${q.proposedDefault})`))}`);
  }
  return out.join('\n\n') + '\n';
}

export function renderDesign(d: DesignOutput, opts: { diagrams?: boolean } = {}): string {
  const diagrams = opts.diagrams ?? true;
  const out = [
    `# Design`,
    d.summary,
    `## Approach\n\n${d.approach}`,
    d.decisions.length
      ? `## Decisions\n\n${d.decisions
          .map((a) => `### ${a.id} — ${a.title}\n\n**Context:** ${a.context}\n\n**Decision:** ${a.decision}\n\n**Alternatives:** ${a.alternatives.join('; ') || 'none'}\n\n**Consequences:** ${a.consequences}`)
          .join('\n\n')}`
      : '',
    d.dataModel.length ? `## Data model\n\n${list(d.dataModel.map((m) => `**${m.entity}** — ${m.change}${m.fields.length ? ` (${m.fields.join(', ')})` : ''}`))}` : '',
    d.apiContracts.length
      ? `## API contracts\n\n| Method | Path | Auth | Request | Response | Errors |\n|---|---|---|---|---|---|\n${d.apiContracts
          .map((c) => `| ${c.method} | \`${cell(c.path)}\` | ${cell(c.auth)} | ${cell(c.request)} | ${cell(c.response)} | ${cell(c.errors.join(', '))} |`)
          .join('\n')}`
      : '',
    diagrams && d.sequenceDiagram.trim() ? `## Main flow\n\n${fence(mermaidSource(d.sequenceDiagram), 'mermaid')}` : '',
    diagrams && d.erDiagram.trim() ? `## Entities\n\n${fence(mermaidSource(d.erDiagram), 'mermaid')}` : '',
    `## File plan\n\n${list(d.filePlan.map((f) => `\`${f.path}\` (${f.action}) — ${f.purpose}`))}`,
    `## Test plan\n\n${list(d.testPlan)}`,
    `## Risks\n\n${list(d.risks)}`,
  ];
  return out.filter(Boolean).join('\n\n') + '\n';
}

export function renderImplementation(dev: DevOutput, title = 'Implementation'): string {
  return [
    `# ${title}`,
    dev.summary,
    `## Files changed\n\n${list(dev.filesChanged.map((f) => `\`${f.path}\` — ${f.change}`))}`,
    `## Coverage\n\n${dev.criteriaCoverage.length ? `| Item | Status | Tests | Notes |\n|---|---|---|---|\n${dev.criteriaCoverage.map((c) => `| ${c.id} | ${c.status} | ${cell(c.tests.join(', '))} | ${cell(c.notes)} |`).join('\n')}` : '_None._'}`,
    `## Tests added\n\n${list(dev.testsAdded)}`,
    `## Commands run\n\n${list(dev.commandsRun.map((c) => `\`${c.command}\` → ${c.result}`))}`,
    `## Notes\n\n${list(dev.notes)}`,
  ].join('\n\n') + '\n';
}

export function renderChecks(results: CheckResult[], opts: { title?: string; preexisting?: string[] } = {}): string {
  const title = opts.title ?? 'Checks';
  if (!results.length) return `# ${title}\n\n_No checks configured. Add them to \`.ai-team/config.json\`._\n`;
  const pre = new Set(opts.preexisting ?? []);
  const table = [
    '| Check | Command | Result | Time |',
    '|---|---|---|---|',
    ...results.map(
      (r) =>
        `| ${r.name} | \`${r.command}\` | ${r.passed ? 'PASS' : r.timedOut ? 'TIMEOUT' : `FAIL (exit ${r.exitCode})${pre.has(r.name) ? ' — already failing before the mission' : ''}`} | ${(r.durationMs / 1000).toFixed(1)}s |`,
    ),
  ].join('\n');
  const failures = results.filter((r) => !r.passed).map((r) => `## ${r.name} output (tail)\n\n${fence(r.output.trim())}`);
  return [`# ${title}`, table, ...failures].join('\n\n') + '\n';
}

export function renderQa(qa: QaOutput, round: number): string {
  const criteria = qa.criteria.length
    ? ['| Criterion | Result | Evidence |', '|---|---|---|', ...qa.criteria.map((c) => `| ${c.id} | ${c.result} | ${cell(c.evidence)} |`)].join('\n')
    : '_None._';
  const scenarios = qa.scenarios.length
    ? ['| Category | Scenario | Result | Evidence |', '|---|---|---|---|', ...qa.scenarios.map((s) => `| ${cell(s.category)} | ${cell(s.scenario)} | ${s.result} | ${cell(s.evidence)} |`)].join('\n')
    : '_None._';
  const bugs = qa.bugs.length
    ? qa.bugs
        .map((b) =>
          [
            `### ${b.id} — ${b.title}`,
            `**Severity:** ${b.severity}  \n**Location:** ${b.location}`,
            `**Steps:**\n${b.steps.map((s, i) => `${i + 1}. ${stripNumber(s)}`).join('\n')}`,
            `**Expected:** ${b.expected}  \n**Actual:** ${b.actual}`,
          ].join('\n\n'),
        )
        .join('\n\n')
    : '_No bugs found._';
  return [`# QA report — round ${round}`, `**QA STATUS: ${qa.status}**`, qa.summary, `## Acceptance criteria\n\n${criteria}`, `## Scenarios\n\n${scenarios}`, `## Bugs\n\n${bugs}`].join('\n\n') + '\n';
}

export function renderFix(fix: FixOutput, title: string, items: WorkItem[]): string {
  return [
    `# ${title}`,
    fix.summary,
    `## Items addressed\n\n${list(items.map((i) => `**${i.id}** (${i.severity}) ${i.title}`))}`,
    `## Fixes\n\n${
      fix.fixes.length
        ? fix.fixes.map((f) => `### ${f.id} — ${f.status}\n\n**Root cause:** ${f.rootCause}\n\n**Change:** ${f.change}\n\n**Regression test:** ${f.regressionTest}`).join('\n\n')
        : '_None._'
    }`,
    `## Files changed\n\n${list(fix.filesChanged.map((f) => `\`${f.path}\` — ${f.change}`))}`,
    `## Commands run\n\n${list(fix.commandsRun.map((c) => `\`${c.command}\` → ${c.result}`))}`,
  ].join('\n\n') + '\n';
}

export function renderReview(review: ReviewOutput, title: string): string {
  const findings = review.findings.length
    ? [
        '| ID | Severity | Category | File | Issue | Suggestion | Standard |',
        '|---|---|---|---|---|---|---|',
        ...review.findings.map((f) => `| ${f.id} | ${f.severity} | ${cell(f.category)} | ${cell(f.file)} | ${cell(f.description)} | ${cell(f.suggestion)} | ${cell(f.standard)} |`),
      ].join('\n')
    : '_No findings._';
  const threats = review.threats.length
    ? `## Threat model (STRIDE)\n\n| Category | Threat | Mitigated |\n|---|---|---|\n${review.threats.map((t) => `| ${t.category} | ${cell(t.threat)} | ${t.mitigated ? 'yes' : '**no**'} |`).join('\n')}`
    : '';
  return [
    `# ${title}`,
    `**STATUS: ${review.status}** · code health: ${review.codeHealth}`,
    review.summary,
    `## Findings\n\n${findings}`,
    threats,
    `## Done well\n\n${list(review.praise)}`,
    `## Missed edge cases\n\n${list(review.missedEdgeCases)}`,
    `## Lessons\n\n${list(review.lessons)}`,
  ]
    .filter(Boolean)
    .join('\n\n') + '\n';
}

export function renderDecision(decision: LeadDecision, names: TeamNames): string {
  return [
    `# ${nameOf('lead', names)}'s ruling`,
    decision.summary,
    `| Item | Ruling | Reason | Guidance |\n|---|---|---|---|\n${decision.rulings.map((r) => `| ${r.id} | **${r.ruling}** | ${cell(r.reason)} | ${cell(r.guidance)} |`).join('\n')}`,
  ].join('\n\n') + '\n';
}

export function renderDebrief(d: Debrief, names: TeamNames): string {
  return [
    `# Mission debrief — from ${nameOf('lead', names)}`,
    `**${d.headline}**`,
    d.summary,
    `## What was built\n\n${list(d.whatWasBuilt)}`,
    `## Decisions you should know about\n\n${list(d.decisions)}`,
    `## Evidence\n\n${list(d.evidence)}`,
    `## Risks and follow-ups\n\n${list(d.risks)}`,
    `## How to try it\n\n${list(d.howToTry)}`,
  ].join('\n\n') + '\n';
}

/** A Mermaid flowchart of the steps this mission actually went through. */
export function renderRunFlow(state: RunState, names: TeamNames): string {
  const label: Partial<Record<string, string>> = {
    plan: `${nameOf('lead', names)}: plan`,
    pm: `${nameOf('pm', names)}: spec`,
    clarify: 'Clarifications',
    design: `${nameOf('architect', names)}: design`,
    develop: `${nameOf('developer', names)}: build`,
    checks: 'Checks',
    qa: `${nameOf('qa', names)}: test`,
    fix: `${nameOf('bugFixer', names)}: fix`,
    arbitrate: `${nameOf('lead', names)}: ruling`,
    review: 'Reviews',
    rework: `${nameOf('developer', names)}: rework`,
    release: `${nameOf('gate', names)}: gate`,
    debrief: `${nameOf('lead', names)}: debrief`,
  };
  const steps = state.events.filter((e) => e.kind === 'start' && e.text.startsWith('step:')).map((e) => e.text.slice(5));
  if (!steps.length) return '';
  const lines = ['flowchart LR'];
  steps.forEach((s, i) => lines.push(`  s${i}["${(label[s] ?? s).replace(/"/g, "'")}"]`));
  for (let i = 1; i < steps.length; i++) lines.push(`  s${i - 1} --> s${i}`);
  return fence(lines.join('\n'), 'mermaid');
}
