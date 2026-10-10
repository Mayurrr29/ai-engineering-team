import { changedFiles, completenessGaps } from './completeness.js';
import { isTestFile } from './guardrails.js';
import type { Finding, Severity } from './schemas.js';
import type { RunState } from './state.js';
import { nameOf, type TeamNames } from './team.js';

export type GateStatus = 'PASS' | 'FAIL' | 'SKIPPED' | 'WARN';

export interface GateLine {
  label: string;
  status: GateStatus;
  detail?: string;
}

export interface ReleaseDecision {
  approved: boolean;
  lines: GateLine[];
  reasons: string[];
  /** HAL's line for the human. */
  verdict: string;
}

export const blocks = (severity: Severity) => severity !== 'LOW';

/** Findings that block release: not LOW, and not waived. */
export function blockingFindings(findings: Finding[], state: RunState): Finding[] {
  const waived = new Set(state.waivers.map((w) => w.id));
  return findings.filter((f) => blocks(f.severity) && !waived.has(f.id));
}

/**
 * HAL 9000, the release gate. Deliberately NOT an LLM: it checks the recorded verdicts.
 * Every stage that was staffed must have passed, against the current code version.
 */
export function evaluateRelease(state: RunState, opts: { checksConfigured: boolean; names?: TeamNames; humanName?: string }): ReleaseDecision {
  const names = opts.names ?? {};
  const lines: GateLine[] = [];
  const reasons: string[] = [];
  const fail = (label: string, detail: string) => {
    lines.push({ label, status: 'FAIL', detail });
    reasons.push(`${label}: ${detail}`);
  };
  const fresh = (v?: { codeVersion: number }) => v !== undefined && v.codeVersion === state.codeVersion;
  const waived = new Set(state.waivers.map((w) => w.id));
  const waivedNote = (ids: string[]) => (ids.length ? ` (${ids.length} waived: ${ids.join(', ')})` : '');
  const notStaffed = `not staffed${state.plan ? ` — ${state.plan.size} task` : ''}`;

  if (state.plan) lines.push({ label: 'Mission plan', status: 'PASS', detail: `size ${state.plan.size}, risk ${state.plan.risk}` });

  if (state.lineup.pm === 'off') lines.push({ label: 'Requirements', status: 'SKIPPED', detail: notStaffed });
  else if (state.spec) lines.push({ label: 'Requirements', status: 'PASS', detail: `${state.spec.acceptanceCriteria.length} criteria, ${state.spec.edgeCases.length} edge cases` });
  else fail('Requirements', 'no approved spec');

  if (state.lineup.architect === 'off') lines.push({ label: 'Design', status: 'SKIPPED', detail: notStaffed });
  else if (state.design) lines.push({ label: 'Design', status: 'PASS', detail: `${state.design.decisions.length} decisions, ${state.design.filePlan.length} files planned` });
  else fail('Design', 'no design');

  if (state.implementation) lines.push({ label: 'Implementation', status: 'PASS', detail: `${state.codeVersion} code revision(s)` });
  else fail('Implementation', 'nothing was implemented');

  // Done means done: criteria reported incomplete, planned surfaces left untouched, no change at all, open blockers.
  const gaps = completenessGaps(state);
  if (gaps.length) fail('Completeness', gaps.map((g) => `${g.id}: ${g.title}`).join('; '));
  else if (state.implementation) {
    const done = Object.keys(state.coverage ?? {}).length;
    lines.push({ label: 'Completeness', status: 'PASS', detail: done ? `${done} item(s) reported done` : 'nothing reported open' });
  }
  if (state.plan?.taskType === 'bugfix' && state.diffStat?.measured && !changedFiles(state).some((f) => isTestFile(f))) {
    lines.push({ label: 'Regression test', status: 'WARN', detail: 'bug fix without a test change — the fix is not proven by a test' });
  }

  if (!opts.checksConfigured) lines.push({ label: 'Checks', status: 'SKIPPED', detail: 'none configured' });
  else if (!state.checks) fail('Checks', 'never ran');
  else if (!fresh(state.checks)) fail('Checks', 'did not run against the latest code');
  else if (state.checks.blocking.length) fail('Checks', `failing: ${state.checks.blocking.join(', ')}`);
  else {
    const pre = state.checks.preexisting.length ? ` (already failing before: ${state.checks.preexisting.join(', ')})` : '';
    lines.push({ label: 'Checks', status: state.checks.preexisting.length ? 'WARN' : 'PASS', detail: `${state.checks.results.map((r) => r.name).join(', ')}${pre}` });
  }

  if (state.lineup.qa === 'off') lines.push({ label: 'QA', status: 'SKIPPED', detail: notStaffed });
  else if (!state.qa) fail('QA', 'never ran');
  else if (!fresh(state.qa)) fail('QA', 'did not test the latest code');
  else {
    const open = state.qa.bugs.filter((b) => blocks(b.severity) && !waived.has(b.id));
    const waivedIds = state.qa.bugs.filter((b) => waived.has(b.id)).map((b) => b.id);
    const failedWithoutBugs = state.qa.status === 'FAIL' && state.qa.bugs.length === 0 && !waived.has('QA-FAIL');
    if (open.length) fail('QA', `${open.length} open bug(s): ${open.map((b) => b.id).join(', ')}`);
    else if (failedWithoutBugs) fail('QA', 'QA failed without itemized bugs');
    else lines.push({ label: 'QA', status: 'PASS', detail: `${state.qa.scenarios.length} scenarios${waivedNote(waivedIds)}` });
  }

  for (const [key, label, verdict] of [
    ['security', 'Security', state.security],
    ['reviewer', 'Code review', state.review],
  ] as const) {
    if (state.lineup[key] === 'off') {
      lines.push({ label, status: 'SKIPPED', detail: notStaffed });
      continue;
    }
    if (!verdict) fail(label, 'never ran');
    else if (!fresh(verdict)) fail(label, 'did not review the latest code');
    else {
      const open = blockingFindings(verdict.findings, state);
      const rejectedWithoutFindings = verdict.status === 'REJECTED' && verdict.findings.length === 0 && !waived.has(`${key === 'security' ? 'SEC' : 'REV'}-REJECT`);
      const waivedIds = verdict.findings.filter((f) => waived.has(f.id)).map((f) => f.id);
      const low = verdict.findings.filter((f) => !blocks(f.severity)).length;
      if (open.length) fail(label, `${open.length} blocking finding(s): ${open.map((f) => f.id).join(', ')}`);
      else if (rejectedWithoutFindings) fail(label, 'rejected without itemized findings');
      else lines.push({ label, status: 'PASS', detail: `${low ? `${low} low-severity note(s)` : 'clean'}${waivedNote(waivedIds)}` });
    }
  }

  if (state.integrity.length) lines.push({ label: 'Integrity', status: 'WARN', detail: state.integrity.join('; ') });

  if (state.iteration > state.maxIterations) fail('Iterations', `exceeded limit of ${state.maxIterations}`);
  else lines.push({ label: 'Rounds', status: 'PASS', detail: `${state.iteration}/${state.maxIterations}` });

  const approved = reasons.length === 0;
  const who = opts.humanName ?? 'Dave';
  const verdict = approved
    ? `Affirmative, ${who}. All systems are functioning perfectly.`
    : `I'm sorry, ${who}. I'm afraid I can't merge that.`;
  return { approved, lines, reasons, verdict: `${nameOf('gate', names)}: ${verdict}` };
}

export function renderRelease(state: RunState, decision: ReleaseDecision, flowDiagram: string): string {
  const rows = decision.lines.map((l) => `| ${l.label} | ${l.status} | ${l.detail ?? ''} |`).join('\n');
  const out = [
    `# Release — ${state.plan?.missionName ?? state.feature}`,
    `**STATUS: ${decision.approved ? 'APPROVED ✅' : 'REJECTED ❌'}**`,
    `> ${decision.verdict}`,
    `| Gate | Status | Detail |\n|---|---|---|\n${rows}`,
  ];
  if (!decision.approved) out.push(`## Reasons\n\n${decision.reasons.map((r, i) => `${i + 1}. ${r}`).join('\n')}`);
  if (state.waivers.length) out.push(`## Waivers\n\n${state.waivers.map((w) => `- **${w.id}** (${w.severity}) ${w.title} — waived by ${w.by}: ${w.reason}`).join('\n')}`);
  if (flowDiagram) out.push(`## How the mission went\n\n${flowDiagram}`);
  out.push(`## Mission\n\n- Id: \`${state.id}\`\n- Fix/rework rounds: ${state.iteration}\n- Agent cost: $${state.costUsd.toFixed(2)}${state.budgetUsd ? ` of $${state.budgetUsd.toFixed(2)} budget` : ''}`);
  return out.join('\n\n') + '\n';
}
