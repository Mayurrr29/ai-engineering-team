import type { CheckResult } from './checks.js';
import type { DevOutput, FixOutput, PmOutput, QaOutput, ReviewOutput } from './schemas.js';
import type { Answer, WorkItem } from './state.js';

const list = (items: string[], empty = '_None._') => (items.length ? items.map((i) => `- ${i}`).join('\n') : empty);
const fence = (text: string) => '```\n' + text.replace(/```/g, "'''") + '\n```';

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
        .map((a) => `- **${a.id}** ${a.question}\n  → ${a.answer} _(${a.source === 'user' ? 'answered by user' : 'default assumed'})_`)
        .join('\n')}`,
    );
  } else if (spec.openQuestions.length) {
    out.push(`## Open questions\n\n${list(spec.openQuestions.map((q) => `**${q.id}** ${q.question} (default: ${q.proposedDefault})`))}`);
  }
  return out.join('\n\n') + '\n';
}

export function renderImplementation(dev: DevOutput, title = 'Implementation'): string {
  return [
    `# ${title}`,
    dev.summary,
    `## Files changed\n\n${list(dev.filesChanged.map((f) => `\`${f.path}\` — ${f.change}`))}`,
    `## Acceptance criteria coverage\n\n${list(dev.criteriaCoverage.map((c) => `**${c.id}** ${c.status} — ${c.notes}`))}`,
    `## Tests added\n\n${list(dev.testsAdded)}`,
    `## Commands run\n\n${list(dev.commandsRun.map((c) => `\`${c.command}\` → ${c.result}`))}`,
    `## Notes\n\n${list(dev.notes)}`,
  ].join('\n\n') + '\n';
}

export function renderChecks(results: CheckResult[]): string {
  if (!results.length) return '# Checks\n\n_No checks configured. Add them to `.ai-team/config.json`._\n';
  const table = [
    '| Check | Command | Result | Time |',
    '|---|---|---|---|',
    ...results.map(
      (r) => `| ${r.name} | \`${r.command}\` | ${r.passed ? 'PASS' : r.timedOut ? 'TIMEOUT' : `FAIL (exit ${r.exitCode})`} | ${(r.durationMs / 1000).toFixed(1)}s |`,
    ),
  ].join('\n');
  const failures = results
    .filter((r) => !r.passed)
    .map((r) => `## ${r.name} output (tail)\n\n${fence(r.output.trim())}`);
  return ['# Checks', table, ...failures].join('\n\n') + '\n';
}

export function renderQa(qa: QaOutput, round: number): string {
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
  return [`# QA Report — round ${round}`, `**QA STATUS: ${qa.status}**`, qa.summary, `## Scenarios\n\n${scenarios}`, `## Bugs\n\n${bugs}`].join('\n\n') + '\n';
}

export function renderFix(fix: FixOutput, title: string, items: WorkItem[]): string {
  return [
    `# ${title}`,
    fix.summary,
    `## Items addressed\n\n${list(items.map((i) => `**${i.id}** (${i.severity}) ${i.title}`))}`,
    `## Fixes\n\n${
      fix.fixes.length
        ? fix.fixes
            .map((f) => `### ${f.id} — ${f.status}\n\n**Root cause:** ${f.rootCause}\n\n**Change:** ${f.change}\n\n**Regression test:** ${f.regressionTest}`)
            .join('\n\n')
        : '_None._'
    }`,
    `## Files changed\n\n${list(fix.filesChanged.map((f) => `\`${f.path}\` — ${f.change}`))}`,
    `## Commands run\n\n${list(fix.commandsRun.map((c) => `\`${c.command}\` → ${c.result}`))}`,
  ].join('\n\n') + '\n';
}

export function renderReview(review: ReviewOutput, title: string): string {
  const findings = review.findings.length
    ? ['| ID | Severity | Category | File | Issue | Suggestion |', '|---|---|---|---|---|---|', ...review.findings.map((f) => `| ${f.id} | ${f.severity} | ${cell(f.category)} | ${cell(f.file)} | ${cell(f.description)} | ${cell(f.suggestion)} |`)].join('\n')
    : '_No findings._';
  return [
    `# ${title}`,
    `**STATUS: ${review.status}**`,
    review.summary,
    `## Findings\n\n${findings}`,
    `## Missed edge cases\n\n${list(review.missedEdgeCases)}`,
    `## Lessons\n\n${list(review.lessons)}`,
  ].join('\n\n') + '\n';
}

/** Models often number list items themselves; avoid "1. 1. ...". */
export function stripNumber(text: string): string {
  return text.replace(/^\s*(?:step\s*)?\d+[.):]\s*/i, '');
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}
