import path from 'node:path';
import type { ReleaseDecision } from '../release.js';
import type { RunState } from '../state.js';
import { MEMBERS, nameOf, type TeamNames } from '../team.js';
import { c, pad, width } from './format.js';

interface FinishOptions {
  names: TeamNames;
  emoji: boolean;
}

function box(lines: string[], color: (s: string) => string): string {
  const inner = Math.max(...lines.map(width), 30);
  const top = color(`╭${'─'.repeat(inner + 2)}╮`);
  const bottom = color(`╰${'─'.repeat(inner + 2)}╯`);
  return [top, ...lines.map((l) => `${color('│')} ${pad(l, inner)} ${color('│')}`), bottom].join('\n');
}

/** The end-of-mission screen: HAL's verdict, JARVIS's debrief, and where to look next. */
export function printFinish(state: RunState, decision: ReleaseDecision | undefined, reportPath: string | undefined, opts: FinishOptions): void {
  const { names, emoji } = opts;
  const out: string[] = [''];

  const solo = !(['pm', 'architect', 'qa', 'security', 'reviewer'] as const).some((r) => state.lineup[r] !== 'off');
  if (state.status === 'answered' && state.answer) {
    // A question gets its answer right here, not a report.
    out.push(c.bold(c.cyan('Answer')));
    const lines = state.answer.answer.split('\n');
    out.push(...lines.slice(0, 40).map((l) => `  ${l}`));
    if (lines.length > 40) out.push(c.gray(`  … ${lines.length - 40} more line(s) in the mission report`));
    for (const e of state.answer.evidence.slice(0, 6)) out.push(`  ${c.gray('•')} ${c.gray(e)}`);
  } else if (state.status === 'planned' && state.design) {
    out.push(`${c.bold(c.cyan('Plan ready'))}  ${state.design.summary}`);
    for (const [i, m] of state.design.milestones.entries()) out.push(`  ${c.gray(`${i + 1}.`)} ${m.name}`);
  } else if (decision && solo && decision.approved) {
    // Small solo change: one line from the gate instead of the full board.
    const checks = state.checks?.results.map((r) => `${r.name} ${r.passed ? '✓' : '✗'}`).join(' · ');
    out.push(`${emoji ? `${MEMBERS.gate.icon} ` : ''}${c.green(c.bold('APPROVED'))}${checks ? c.gray(`  checks: ${checks}`) : c.gray('  no checks configured — not verified by tests')}`);
  } else if (decision && (state.status === 'approved' || state.status === 'rejected')) {
    const approved = decision.approved;
    const color = approved ? c.green : c.red;
    const mark = (s: string) => (s === 'PASS' ? c.green('✓ PASS') : s === 'FAIL' ? c.red('✗ FAIL') : s === 'WARN' ? c.yellow('! WARN') : c.gray('– SKIP'));
    const labelWidth = Math.max(...decision.lines.map((l) => l.label.length)) + 2;
    const lines = [
      `${emoji ? `${MEMBERS.gate.icon} ` : ''}${c.bold(`${nameOf('gate', names)} · RELEASE GATE`)}`,
      '',
      ...decision.lines.map((l) => `${pad(l.label, labelWidth)}${mark(l.status)}${l.detail ? c.gray(`  ${l.detail.length > 60 ? `${l.detail.slice(0, 57)}…` : l.detail}`) : ''}`),
      '',
      c.bold(color(approved ? 'STATUS: APPROVED ✓' : 'STATUS: REJECTED ✗')),
      c.italic(c.gray(decision.verdict)),
    ];
    out.push(box(lines, color));
    if (!approved) decision.reasons.forEach((r, i) => out.push(c.red(`  ${i + 1}. ${r}`)));
  } else if (state.status === 'paused' || state.status === 'failed') {
    const color = state.status === 'paused' ? c.yellow : c.red;
    out.push(
      box(
        [
          c.bold(color(state.status === 'paused' ? 'MISSION PAUSED' : 'MISSION NEEDS ATTENTION')),
          state.error ?? '',
          '',
          state.status === 'paused'
            ? `Resume with a higher limit:  ai-team resume ${state.id} --budget ${((state.budgetUsd ?? 0) * 1.5 + 1).toFixed(0)}`
            : `Fix the problem, then:  ai-team resume ${state.id}`,
        ],
        color,
      ),
    );
  }

  const d = state.debrief;
  const notes = (state.signals ?? []).filter((s) => s.kind === 'assumption' || s.kind === 'concern');
  if (notes.length) out.push(`  ${c.yellow('Raised by the team:')} ${notes.slice(0, 3).map((s) => s.summary).join(' · ')}${notes.length > 3 ? c.gray(` (+${notes.length - 3} in the report)`) : ''}`);
  if (d) {
    out.push('');
    out.push(`${emoji ? `${MEMBERS.lead.icon} ` : ''}${c.bold(c.cyan(nameOf('lead', names)))} ${c.gray('· debrief')}`);
    out.push(`  ${c.bold(d.headline)}`);
    for (const item of d.whatWasBuilt.slice(0, 5)) out.push(`  ${c.gray('•')} ${item}`);
    if (d.risks.length) out.push(`  ${c.yellow('Risks:')} ${d.risks.slice(0, 3).join(' · ')}`);
    if (d.howToTry.length) out.push(`  ${c.gray('Try it:')} ${d.howToTry[0]}`);
  }
  if (state.ruleUpdates.length) out.push(`  ${c.gray(`Rulebook: ${state.ruleUpdates.length} update(s) — see .ai-team/rules.md`)}`);

  out.push('');
  out.push(`  ${c.gray('Cost')} $${state.costUsd.toFixed(2)}${state.budgetUsd ? c.gray(` of $${state.budgetUsd.toFixed(2)}`) : ''}   ${c.gray('Rounds')} ${state.iteration}   ${c.gray('Artifacts')} ${path.relative(process.cwd(), path.dirname(reportPath ?? '.')) || '.'}`);
  if (reportPath) out.push(`  ${c.bold('Mission report:')} ${c.cyan(reportPath)}  ${c.gray('(ai-team report)')}`);
  out.push('');
  console.log(out.join('\n'));
}
