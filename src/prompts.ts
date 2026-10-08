import type { DiffSnapshot } from './git.js';
import { renderChecks, renderSpec } from './render.js';
import type { RunState, WorkItem } from './state.js';

const section = (title: string, body: string) => `## ${title}\n\n${body.trim()}`;

function specOrRequest(state: RunState): string {
  if (state.spec) return section('Approved specification', renderSpec(state.spec, state.answers));
  return section('Feature request (quick mode: no PM spec — infer sensible acceptance criteria from the request)', state.feature);
}

/** All files any agent reported touching so far. */
export function changedFiles(state: RunState): string[] {
  const files = new Set<string>();
  state.implementation?.filesChanged.forEach((f) => files.add(f.path));
  state.fixes.forEach((fx) => fx.filesChanged.forEach((f) => files.add(f.path)));
  return [...files];
}

function changeContext(state: RunState, diff?: DiffSnapshot): string {
  const files = changedFiles(state);
  const list = files.length ? files.map((f) => `- ${f}`).join('\n') : '- (none reported)';
  const parts = [
    `Files reported as changed by the team (verify — the list may be incomplete):\n${list}`,
    `Developer summary: ${state.implementation?.summary ?? 'n/a'}`,
  ];
  if (state.fixes.length) parts.push(`Fix rounds so far:\n${state.fixes.map((f, i) => `${i + 1}. ${f.summary}`).join('\n')}`);
  if (diff) {
    const caveat = state.startedDirty ? ' It may also include changes that were already uncommitted before the run started.' : '';
    parts.push(`### Actual diff since the run started (computed by the orchestrator — this is the source of truth)${caveat}\n\n\`\`\`\n${diff.stat || '(no tracked changes)'}\n\`\`\``);
    if (diff.untracked.length) parts.push(`New untracked files (read them in full):\n${diff.untracked.map((f) => `- ${f}`).join('\n')}`);
    if (diff.patch) {
      parts.push(`\`\`\`diff\n${diff.patch}\n\`\`\`${diff.truncated ? '\n(diff truncated — read the remaining changed files directly)' : ''}`);
    }
  }
  return section('What changed', parts.join('\n\n'));
}

function checksContext(state: RunState): string {
  if (!state.checks) return section('Deterministic checks', 'Not run.');
  return section('Deterministic checks (run by the orchestrator against the current code)', renderChecks(state.checks.results).replace(/^# Checks\s*/, ''));
}

export function pmPrompt(state: RunState): string {
  return [
    `Produce the specification for this feature request. Explore the codebase first so the spec fits what already exists.`,
    section('Feature request', state.feature),
  ].join('\n\n');
}

export function developPrompt(state: RunState): string {
  return [
    'Implement this feature in the repository. Implement every acceptance criterion, handle the listed edge and error cases, add tests, and run the project checks before you finish.',
    specOrRequest(state),
  ].join('\n\n');
}

export function qaPrompt(state: RunState, diff?: DiffSnapshot): string {
  const parts = [
    `Test the implementation of this feature (QA round ${state.iteration + 1}). Try to break it. Verify every acceptance criterion and edge case with evidence.`,
    specOrRequest(state),
    changeContext(state, diff),
    checksContext(state),
  ];
  if (state.qa?.bugs.length) {
    parts.push(
      section(
        'Bugs reported in the previous QA round (re-verify each; reuse its id if still present)',
        state.qa.bugs.map((b) => `- ${b.id} (${b.severity}) ${b.title} — ${b.location}`).join('\n'),
      ),
    );
  }
  return parts.join('\n\n');
}

function workItems(items: WorkItem[]): string {
  return items.map((i) => `### ${i.id} — ${i.title}\nSource: ${i.source} · Severity: ${i.severity}\n\n${i.details.trim()}`).join('\n\n');
}

export function fixPrompt(state: RunState): string {
  return [
    `Fix the following ${state.todo.length} item(s) found by QA and the deterministic checks. Reproduce, fix the root cause, add a regression test, and run the checks.`,
    section('Items to fix', workItems(state.todo)),
    specOrRequest(state),
    changeContext(state),
  ].join('\n\n');
}

export function reworkPrompt(state: RunState): string {
  const source = state.todo[0]?.source === 'security' ? 'the Security Reviewer' : 'the Code Reviewer';
  return [
    `Your implementation was REJECTED by ${source}. Address every finding below — fix it properly, or explain precisely why it is not a problem. Then run the checks. In \`notes\`, list every finding id and how you addressed it; list all files you changed in \`filesChanged\`.`,
    section('Findings to address', workItems(state.todo)),
    specOrRequest(state),
    changeContext(state),
  ].join('\n\n');
}

export function securityPrompt(state: RunState, diff?: DiffSnapshot): string {
  const parts = [
    'Perform a security review of the changes made for this feature. Read the actual code that changed and the code paths it touches.',
    specOrRequest(state),
    changeContext(state, diff),
  ];
  if (state.security?.findings.length) {
    parts.push(section('Findings from your previous round (re-verify; reuse ids if still present)', state.security.findings.map((f) => `- ${f.id} (${f.severity}) ${f.description}`).join('\n')));
  }
  return parts.join('\n\n');
}

export function reviewPrompt(state: RunState, diff?: DiffSnapshot): string {
  const parts = [
    'Review the changes made for this feature as a strict senior reviewer would review a pull request. Read the actual diff and surrounding code.',
    specOrRequest(state),
    changeContext(state, diff),
    checksContext(state),
  ];
  if (state.qa) parts.push(section('QA result', `${state.qa.status}: ${state.qa.summary}`));
  if (state.security) parts.push(section('Security review result', `${state.security.status}: ${state.security.summary}`));
  if (state.review?.findings.length) {
    parts.push(section('Findings from your previous round (re-verify; reuse ids if still present)', state.review.findings.map((f) => `- ${f.id} (${f.severity}) ${f.description}`).join('\n')));
  }
  return parts.join('\n\n');
}
