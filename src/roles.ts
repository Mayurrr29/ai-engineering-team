import fs from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import type { RoleName } from './config.js';
import { paths, TEMPLATES_DIR } from './paths.js';
import { DevOutput, FixOutput, PmOutput, QaOutput, ReviewOutput } from './schemas.js';

export interface RoleDef {
  name: RoleName;
  title: string;
  file: string;
  schema: z.ZodType;
  canWrite: boolean;
  canRunCommands: boolean;
}

export const ROLES: Record<RoleName, RoleDef> = {
  pm: { name: 'pm', title: 'Product Manager', file: 'pm.md', schema: PmOutput, canWrite: false, canRunCommands: false },
  developer: { name: 'developer', title: 'Developer', file: 'developer.md', schema: DevOutput, canWrite: true, canRunCommands: true },
  qa: { name: 'qa', title: 'QA Engineer', file: 'qa.md', schema: QaOutput, canWrite: false, canRunCommands: true },
  bugFixer: { name: 'bugFixer', title: 'Bug Fixer', file: 'bug-fixer.md', schema: FixOutput, canWrite: true, canRunCommands: true },
  security: { name: 'security', title: 'Security Reviewer', file: 'security.md', schema: ReviewOutput, canWrite: false, canRunCommands: false },
  reviewer: { name: 'reviewer', title: 'Code Reviewer', file: 'reviewer.md', schema: ReviewOutput, canWrite: false, canRunCommands: false },
};

/** Project override in .ai-team/agents/ wins over the bundled template. */
export function loadRolePrompt(root: string, role: RoleDef): string {
  const custom = path.join(paths(root).agents, role.file);
  const file = fs.existsSync(custom) ? custom : path.join(TEMPLATES_DIR, 'agents', role.file);
  return fs.readFileSync(file, 'utf8');
}

function readIfExists(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
}

/** The system prompt addition for a role: role instructions + project rules + lessons + team protocol. */
export function buildSystemPrompt(root: string, role: RoleDef): string {
  const p = paths(root);
  const rules = readIfExists(p.rules) || readIfExists(path.join(TEMPLATES_DIR, 'rules.md'));
  const lessons = readIfExists(p.lessons);
  const parts = [
    `You are the ${role.title} on an AI engineering team that takes a feature from requirements to approved, production-ready code. Other agents (Product Manager, Developer, QA Engineer, Bug Fixer, Security Reviewer, Code Reviewer) handle the other stages. Agents do not trust each other's claims: verify by reading code and running things.`,
    loadRolePrompt(root, role).trim(),
    `# Project rules (mandatory)\n\n${rules}`,
  ];
  if (lessons) parts.push(`# Lessons learned on this project\n\n${lessons}`);
  parts.push(
    [
      '# Team protocol',
      `- Do not touch the \`.ai-team/\` directory; the orchestrator owns it.`,
      '- Do not run git commands that change history or the working tree state (commit, reset, checkout, stash, push). Read-only git (status, diff, log) is fine.',
      role.canWrite
        ? '- You may modify the repository as needed for your task.'
        : '- You must NOT modify any file in the repository.',
      '- Your final answer is structured JSON matching the required schema. Be factual and specific; it is shown to the rest of the team and the human.',
    ].join('\n'),
  );
  return parts.join('\n\n---\n\n');
}
