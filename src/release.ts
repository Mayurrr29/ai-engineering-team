import type { RunState } from './state.js';

export type GateStatus = 'PASS' | 'FAIL' | 'SKIPPED' | 'PENDING';

export interface GateLine {
  label: string;
  status: GateStatus;
  detail?: string;
}

export interface ReleaseDecision {
  approved: boolean;
  lines: GateLine[];
  reasons: string[];
}

/**
 * The release gate is deliberately NOT an LLM. It checks the recorded artifacts:
 * every verdict must be a pass AND must have been made against the current code version.
 */
export function evaluateRelease(state: RunState, opts: { securityEnabled: boolean; checksConfigured: boolean }): ReleaseDecision {
  const lines: GateLine[] = [];
  const reasons: string[] = [];
  const fail = (label: string, detail: string) => {
    lines.push({ label, status: 'FAIL', detail });
    reasons.push(`${label}: ${detail}`);
  };
  const fresh = (v?: { codeVersion: number }) => v !== undefined && v.codeVersion === state.codeVersion;

  if (state.mode === 'quick') lines.push({ label: 'Requirements', status: 'SKIPPED', detail: 'quick mode' });
  else if (state.spec) lines.push({ label: 'Requirements', status: 'PASS', detail: `${state.spec.acceptanceCriteria.length} acceptance criteria, ${state.spec.edgeCases.length} edge cases` });
  else fail('Requirements', 'no approved spec');

  if (state.implementation) lines.push({ label: 'Implementation', status: 'PASS', detail: `${state.codeVersion} code revision(s)` });
  else fail('Implementation', 'nothing was implemented');

  if (!opts.checksConfigured) lines.push({ label: 'Checks', status: 'SKIPPED', detail: 'none configured' });
  else if (!state.checks) fail('Checks', 'never ran');
  else if (!fresh(state.checks)) fail('Checks', 'did not run against the latest code');
  else {
    const failed = state.checks.results.filter((r) => !r.passed).map((r) => r.name);
    if (failed.length) fail('Checks', `failing: ${failed.join(', ')}`);
    else lines.push({ label: 'Checks', status: 'PASS', detail: state.checks.results.map((r) => r.name).join(', ') });
  }

  if (!state.qa) fail('QA', 'never ran');
  else if (!fresh(state.qa)) fail('QA', 'did not test the latest code');
  else if (state.qa.status !== 'PASS' || state.qa.bugs.length) fail('QA', `${state.qa.bugs.length} open bug(s)`);
  else lines.push({ label: 'QA', status: 'PASS', detail: `${state.qa.scenarios.length} scenarios` });

  if (!opts.securityEnabled) lines.push({ label: 'Security', status: 'SKIPPED', detail: state.mode === 'quick' ? 'quick mode' : 'disabled' });
  else if (!state.security) fail('Security', 'never ran');
  else if (!fresh(state.security)) fail('Security', 'did not review the latest code');
  else if (state.security.status !== 'APPROVED') fail('Security', `${blocking(state.security.findings).length} blocking finding(s)`);
  else lines.push({ label: 'Security', status: 'PASS', detail: nonBlockingNote(state.security.findings) });

  if (!state.review) fail('Code Review', 'never ran');
  else if (!fresh(state.review)) fail('Code Review', 'did not review the latest code');
  else if (state.review.status !== 'APPROVED') fail('Code Review', `${blocking(state.review.findings).length} blocking finding(s)`);
  else lines.push({ label: 'Code Review', status: 'PASS', detail: nonBlockingNote(state.review.findings) });

  if (state.iteration > state.maxIterations) fail('Iterations', `exceeded limit of ${state.maxIterations}`);
  else lines.push({ label: 'Iterations', status: 'PASS', detail: `${state.iteration}/${state.maxIterations}` });

  return { approved: reasons.length === 0, lines, reasons };
}

function blocking(findings: { severity: string }[]) {
  return findings.filter((f) => f.severity !== 'LOW');
}

function nonBlockingNote(findings: { severity: string }[]): string | undefined {
  const low = findings.filter((f) => f.severity === 'LOW').length;
  return low ? `${low} low-severity note(s)` : undefined;
}

export function renderRelease(state: RunState, decision: ReleaseDecision): string {
  const rows = decision.lines.map((l) => `| ${l.label} | ${l.status} | ${l.detail ?? ''} |`).join('\n');
  const out = [
    `# Release — ${state.spec?.title ?? state.feature}`,
    `**STATUS: ${decision.approved ? 'APPROVED ✅' : 'REJECTED ❌'}**`,
    `| Gate | Status | Detail |\n|---|---|---|\n${rows}`,
  ];
  if (!decision.approved) out.push(`## Reasons\n\n${decision.reasons.map((r, i) => `${i + 1}. ${r}`).join('\n')}`);
  out.push(`## Run\n\n- Run id: \`${state.id}\`\n- Fix/rework rounds: ${state.iteration}\n- Agent cost: $${state.costUsd.toFixed(2)}`);
  return out.join('\n\n') + '\n';
}
