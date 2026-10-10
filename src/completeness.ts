import { isDocFile, isTestFile } from './guardrails.js';
import type { Severity } from './schemas.js';
import type { RunState } from './state.js';

/**
 * Deterministic "is the job actually done?" checks. A member saying it finished is not proof:
 * these look at what the members reported as incomplete and at the change that was really made.
 * Both the orchestrator (to send work back early) and the release gate use them.
 */

export interface Gap {
  id: string;
  severity: Severity;
  title: string;
  details: string;
}

const FRONTEND_EXT = /\.(tsx|jsx|vue|svelte|astro|css|scss|sass|less|html?)$/i;
const FRONTEND_DIR = /(^|\/)(components|pages|views|layouts|styles|public|frontend|client|web|ui|app)\//i;
const SCRIPT_EXT = /\.(m|c)?[jt]s$/i;

export function isFrontendFile(p: string): boolean {
  const file = p.replace(/\\/g, '/');
  if (isTestFile(file) || isDocFile(file)) return false;
  return FRONTEND_EXT.test(file) || (FRONTEND_DIR.test(file) && SCRIPT_EXT.test(file) && !/(^|\/)(api|server|routes)\//i.test(file));
}

const SURFACE_CHECKS: Record<string, { matches: (p: string) => boolean; title: string; details: string }> = {
  frontend: {
    matches: isFrontendFile,
    title: 'The plan includes frontend work, but no frontend file changed',
    details:
      'The mission plan lists the frontend as an affected surface, yet the change touches no UI files (components, pages, styles, templates). Build the user-facing part of the request — including loading, empty and error states — or, if the UI genuinely needs no change, mark this item NOT_DONE and explain why with evidence so the team lead can rule on it.',
  },
  tests: {
    matches: (p) => isTestFile(p.replace(/\\/g, '/')),
    title: 'The plan includes tests, but no test file changed',
    details: 'Add or update tests that prove the change, using the project’s test framework — or explain with evidence why existing tests already cover it.',
  },
  docs: {
    matches: (p) => isDocFile(p),
    title: 'The plan includes documentation, but no documentation changed',
    details: 'Update the documentation the request affects, or explain why none is needed.',
  },
};

/** Tasks that end with an answer or a plan instead of a code change. */
export function isNonCodeTask(state: RunState): boolean {
  return state.plan?.taskType === 'question' || state.plan?.taskType === 'planning';
}

export function changedFiles(state: RunState): string[] {
  return state.diffStat?.files.map((f) => f.path) ?? [];
}

/** Everything that still stands between the current code and "done", excluding waived items. */
export function completenessGaps(state: RunState): Gap[] {
  if (!state.implementation || isNonCodeTask(state)) return [];
  const waived = new Set(state.waivers.map((w) => w.id));
  const gaps: Gap[] = [];

  for (const [id, c] of Object.entries(state.coverage ?? {})) {
    if (c.status === 'DONE') continue;
    gaps.push({
      id,
      severity: 'HIGH',
      title: `${id} was reported ${c.status.replace('_', ' ').toLowerCase()}`,
      details: `The developer reported ${id} as ${c.status}${c.notes ? `: ${c.notes}` : ''}. Finish it, or explain precisely what blocks it.`,
    });
  }

  const files = changedFiles(state);
  if (state.diffStat?.measured && files.length === 0) {
    gaps.push({
      id: 'NO-CHANGE',
      severity: 'MEDIUM',
      title: 'No code changed',
      details: 'The orchestrator measured the repository and nothing changed since the mission started. Implement the request, or explain with evidence why the code already does what was asked (mark this item NOT_DONE with that evidence).',
    });
  }

  if (files.length) {
    for (const surface of state.plan?.surfaces ?? []) {
      const check = SURFACE_CHECKS[surface];
      if (check && !files.some(check.matches)) gaps.push({ id: `SURFACE-${surface}`, severity: 'MEDIUM', title: check.title, details: check.details });
    }
  }

  for (const b of state.signals ?? []) {
    if (b.kind !== 'blocker' || b.resolved) continue;
    gaps.push({ id: b.id, severity: 'HIGH', title: `Blocker raised by ${b.from}: ${b.summary}`, details: `${b.summary}${b.evidence ? `\nEvidence: ${b.evidence}` : ''}` });
  }

  return gaps.filter((g) => !waived.has(g.id));
}
