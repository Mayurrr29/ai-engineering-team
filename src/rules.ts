import fs from 'node:fs';
import path from 'node:path';
import { paths, TEMPLATES_DIR } from './paths.js';
import type { Debrief } from './schemas.js';

const PROJECT_START = '<!-- ai-team:project-rules:start -->';
const PROJECT_END = '<!-- ai-team:project-rules:end -->';
const LEARNED_START = '<!-- ai-team:learned:start -->';
const LEARNED_END = '<!-- ai-team:learned:end -->';

export interface LearnedRule {
  id: string;
  text: string;
  meta: string;
}

export interface AppliedRuleUpdate {
  action: 'add' | 'update' | 'remove';
  id: string;
  rule: string;
  reason: string;
}

/** Creates the rulebook from the template if missing; adds the managed sections to v0.1 rulebooks. */
export function ensureRulebook(root: string): string {
  const file = paths(root).rules;
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(path.join(TEMPLATES_DIR, 'rules.md'), file);
  }
  let text = fs.readFileSync(file, 'utf8');
  let changed = false;
  if (!text.includes(PROJECT_START)) {
    text += `\n## Project rules\n\nWritten during onboarding from what this codebase actually does. Run \`ai-team onboard\` to refresh them.\n\n${PROJECT_START}\n_Not generated yet — run \`ai-team onboard\`._\n${PROJECT_END}\n`;
    changed = true;
  }
  if (!text.includes(LEARNED_START)) {
    text += `\n## Learned rules\n\nAdded after missions, from what the team learned. Edit or delete freely.\n\n${LEARNED_START}\n${LEARNED_END}\n`;
    changed = true;
  }
  if (changed) fs.writeFileSync(file, text);
  return text;
}

export function readRulebook(root: string): string {
  const file = paths(root).rules;
  if (!fs.existsSync(file)) return fs.readFileSync(path.join(TEMPLATES_DIR, 'rules.md'), 'utf8');
  return fs.readFileSync(file, 'utf8');
}

function replaceSection(text: string, start: string, end: string, body: string): string {
  const a = text.indexOf(start);
  const b = text.indexOf(end);
  if (a === -1 || b === -1 || b < a) return text;
  return `${text.slice(0, a + start.length)}\n${body.trim() ? `${body.trim()}\n` : ''}${text.slice(b)}`;
}

function section(text: string, start: string, end: string): string {
  const a = text.indexOf(start);
  const b = text.indexOf(end);
  if (a === -1 || b === -1 || b < a) return '';
  return text.slice(a + start.length, b);
}

export function setProjectRules(root: string, rules: Array<{ rule: string; why: string; evidence: string }>): void {
  ensureRulebook(root);
  const file = paths(root).rules;
  const body = rules.length
    ? rules.map((r, i) => `${i + 1}. ${r.rule} — _${r.why}${r.evidence ? ` (${r.evidence})` : ''}_`).join('\n')
    : '_No project-specific rules found._';
  fs.writeFileSync(file, replaceSection(fs.readFileSync(file, 'utf8'), PROJECT_START, PROJECT_END, body));
}

const LEARNED_LINE = /^- \*\*\[(L-\d+)\]\*\* (.*?)(?: _\((.*)\)_)?\s*$/;

export function learnedRules(root: string): LearnedRule[] {
  const text = readRulebook(root);
  return section(text, LEARNED_START, LEARNED_END)
    .split(/\r?\n/)
    .map((line) => LEARNED_LINE.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ id: m[1], text: m[2], meta: m[3] ?? '' }));
}

/** Applies JARVIS's rule updates to the learned section. Returns what was actually applied. */
export function applyRuleUpdates(root: string, updates: Debrief['ruleUpdates'], runId: string, maxLearned: number): AppliedRuleUpdate[] {
  ensureRulebook(root);
  const rules = learnedRules(root);
  const applied: AppliedRuleUpdate[] = [];
  const normalized = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const counter = Number(/<!-- next-id: (\d+) -->/.exec(section(readRulebook(root), LEARNED_START, LEARNED_END))?.[1] ?? 0);
  // A persistent counter: ids of removed rules are never reused, so old mission reports stay accurate.
  let next = Math.max(counter, Math.max(0, ...rules.map((r) => Number(r.id.slice(2)))) + 1);
  const stamp = `${new Date().toISOString().slice(0, 10)} · ${runId}`;

  for (const update of updates) {
    const rule = update.rule.replace(/\s+/g, ' ').trim();
    if (update.action === 'add') {
      if (!rule || rules.some((r) => normalized(r.text) === normalized(rule))) continue;
      const id = `L-${String(next++).padStart(3, '0')}`;
      rules.push({ id, text: rule, meta: stamp });
      applied.push({ action: 'add', id, rule, reason: update.reason });
    } else {
      const index = rules.findIndex((r) => r.id === update.id.trim());
      if (index === -1) continue;
      if (update.action === 'remove') {
        applied.push({ action: 'remove', id: rules[index].id, rule: rules[index].text, reason: update.reason });
        rules.splice(index, 1);
      } else if (rule) {
        rules[index] = { ...rules[index], text: rule, meta: stamp };
        applied.push({ action: 'update', id: rules[index].id, rule, reason: update.reason });
      }
    }
  }
  while (rules.length > maxLearned) {
    const dropped = rules.shift()!;
    applied.push({ action: 'remove', id: dropped.id, rule: dropped.text, reason: `Rulebook limit (${maxLearned}) reached; oldest rule retired.` });
  }
  if (applied.length) {
    const body = [`<!-- next-id: ${next} -->`, ...rules.map((r) => `- **[${r.id}]** ${r.text}${r.meta ? ` _(${r.meta})_` : ''}`)].join('\n');
    const file = paths(root).rules;
    fs.writeFileSync(file, replaceSection(fs.readFileSync(file, 'utf8'), LEARNED_START, LEARNED_END, body));
  }
  return applied;
}
