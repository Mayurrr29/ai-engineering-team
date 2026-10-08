import fs from 'node:fs';
import path from 'node:path';
import { packGuidance, type PackId } from './packs.js';
import { paths, TEMPLATES_DIR } from './paths.js';
import { readRulebook } from './rules.js';
import type { ProjectProfile } from './schemas.js';
import { fillNames, MEMBERS, nameOf, ROSTER_ORDER, type RoleId, type TeamNames } from './team.js';

export interface PromptContext {
  names: TeamNames;
  packs: PackId[];
  profile?: ProjectProfile;
}

const NOTES_START = '<!-- ai-team:notes:start -->';
const NOTES_END = '<!-- ai-team:notes:end -->';

/** Built-in playbook, or a full override from .ai-team/playbooks/<file>. */
export function loadPlaybook(root: string, role: RoleId): string {
  const file = MEMBERS[role].playbook!;
  const override = path.join(paths(root).playbooks, file);
  return fs.readFileSync(fs.existsSync(override) ? override : path.join(TEMPLATES_DIR, 'playbooks', file), 'utf8');
}

export function teamNotesFile(root: string, role: RoleId): string {
  return path.join(paths(root).teamNotes, `${role}.md`);
}

/** Writes the generated notes section for a member, keeping anything a human added outside it. */
export function writeTeamNotes(root: string, role: RoleId, names: TeamNames, notes: string[]): void {
  const file = teamNotesFile(root, role);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const generated = notes.length ? notes.map((n) => `- ${n}`).join('\n') : '- (nothing project-specific yet)';
  const header = `# Notes for ${nameOf(role, names)} (${MEMBERS[role].title})\n\nWritten by ${nameOf('lead', names)} during onboarding. Anything you add outside the marked block is kept on re-onboarding.\n\n`;
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `${header}${NOTES_START}\n${generated}\n${NOTES_END}\n`);
    return;
  }
  const text = fs.readFileSync(file, 'utf8');
  const a = text.indexOf(NOTES_START);
  const b = text.indexOf(NOTES_END);
  const next = a === -1 || b === -1 ? `${text.trimEnd()}\n\n${NOTES_START}\n${generated}\n${NOTES_END}\n` : `${text.slice(0, a + NOTES_START.length)}\n${generated}\n${text.slice(b)}`;
  fs.writeFileSync(file, next);
}

function readTeamNotes(root: string, role: RoleId): string {
  const file = teamNotesFile(root, role);
  if (!fs.existsSync(file)) return '';
  return fs
    .readFileSync(file, 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^# .*\n/, '')
    .replace(/^Written by .*\n/m, '')
    .trim();
}

/** Compact project briefing injected into every member's prompt. */
export function renderProjectSummary(p: ProjectProfile): string {
  const lines = [`**${p.projectName}** — ${p.summary}`];
  const stack = [...p.stack.languages, ...p.stack.frameworks, ...p.stack.databases, ...p.stack.testing].filter(Boolean);
  if (stack.length) lines.push(`Stack: ${stack.join(', ')}${p.stack.packageManager ? ` (${p.stack.packageManager})` : ''}`);
  if (p.architecture.overview) lines.push(`Architecture: ${p.architecture.overview}`);
  if (p.architecture.modules.length) lines.push(`Key modules:\n${p.architecture.modules.map((m) => `- \`${m.path}\` — ${m.purpose}`).join('\n')}`);
  if (p.conventions.length) lines.push(`Conventions:\n${p.conventions.map((c) => `- ${c.topic}: ${c.convention}${c.evidence ? ` (${c.evidence})` : ''}`).join('\n')}`);
  if (p.commands.length) lines.push(`Commands:\n${p.commands.map((c) => `- \`${c.command}\` — ${c.purpose}`).join('\n')}`);
  if (p.howToTest.length) lines.push(`How to test:\n${p.howToTest.map((s) => `- ${s}`).join('\n')}`);
  if (p.sensitiveAreas.length) lines.push(`Sensitive areas:\n${p.sensitiveAreas.map((s) => `- \`${s.path}\` — ${s.reason}`).join('\n')}`);
  return lines.join('\n\n');
}

export function loadProfile(root: string): ProjectProfile | undefined {
  const file = paths(root).projectJson;
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).profile as ProjectProfile;
  } catch {
    return undefined;
  }
}

export function buildSystemPrompt(root: string, role: RoleId, ctx: PromptContext, canWrite: boolean): string {
  const { names } = ctx;
  const me = MEMBERS[role];
  const roster = ROSTER_ORDER.filter((r) => r !== role)
    .map((r) => `${nameOf(r, names)} (${MEMBERS[r].title})`)
    .join(', ');

  const parts: string[] = [
    [
      `You are ${nameOf(role, names)}, the ${me.title} on this project's AI engineering team. Your teammates: ${roster}.`,
      `Personality: ${me.voice} It shows in tone only — accuracy and substance always come first, and structured output fields stay plain and factual.`,
      `The team takes a request from idea to approved code in this repository. Members don't take each other's claims on trust: they verify by reading code and running things.`,
    ].join('\n\n'),
    fillNames(loadPlaybook(root, role), names).trim(),
  ];

  const guidance = packGuidance(ctx.packs, role);
  if (guidance) parts.push(`# Stack guidance for this project\n\n${guidance}`);
  if (ctx.profile) parts.push(`# This project\n\n${renderProjectSummary(ctx.profile)}`);
  const notes = readTeamNotes(root, role);
  if (notes) parts.push(`# Your notes for this project\n\n${notes}`);
  parts.push(`# Team rulebook (mandatory)\n\n${fillNames(readRulebook(root), names).replace(/<!--[\s\S]*?-->/g, '').trim()}`);

  const legacy = paths(root).legacyLessons;
  if (fs.existsSync(legacy)) parts.push(`# Lessons learned on this project\n\n${fs.readFileSync(legacy, 'utf8').trim()}`);

  parts.push(
    [
      '# Team protocol',
      '- The `.ai-team/` directory belongs to the orchestrator: read it if useful, never modify it.',
      '- Read-only git commands (status, diff, log, show) are fine. Never run git commands that change history or the working tree (commit, reset, checkout, stash, rebase, push).',
      '- Consider the reversibility of your actions: local, reversible actions such as editing files or running tests are fine; never run destructive commands (deleting data or branches, `rm -rf`, dropping tables).',
      canWrite ? '- You may modify the repository as your task requires.' : '- Do not modify files in the repository.',
      '- Your final answer is structured JSON matching the required schema. It goes to your teammates and the human: keep every text field concise, specific and factual.',
    ].join('\n'),
  );
  return parts.join('\n\n---\n\n');
}
