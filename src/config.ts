import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { paths } from './paths.js';
import { Effort } from './schemas.js';
import { RoleId } from './team.js';

export { RoleId };

export const Check = z.object({ name: z.string(), command: z.string() });
export type Check = z.infer<typeof Check>;

const Mode = z.preprocess(
  // v0.1 used "standard" for the full pipeline.
  (v) => (v === 'standard' ? 'full' : v),
  z.enum(['auto', 'quick', 'full']),
);

export const Config = z.object({
  /**
   * auto: JARVIS sizes the mission and picks the team (default).
   * quick: Developer → QA (light) → Code Review (light).
   * full: everyone, full depth.
   */
  mode: Mode.default('auto'),
  /** Optional spending limit per mission, in USD. The team pauses (resumable) instead of exceeding it. */
  budgetUsd: z.number().positive().optional(),
  /** Max fix/rework rounds before the release gate rejects the mission. */
  maxIterations: z.number().int().min(1).max(20).default(5),
  /** Default model for every agent. Omit to use your Claude Code default. */
  model: z.string().optional(),
  /** Per-role model override, e.g. { "reviewer": "claude-opus-5-5" }. */
  models: z.partialRecord(RoleId, z.string()).default({}),
  /** Per-role effort override; otherwise JARVIS chooses per mission. */
  effort: z.partialRecord(RoleId, Effort).default({}),
  /** Optional cap per single agent call, in USD. */
  maxBudgetUsdPerAgent: z.number().positive().optional(),
  maxTurnsPerAgent: z.number().int().positive().default(200),
  team: z
    .object({
      /** Rename members, e.g. { "developer": "Chitti" }. Keys: lead, pm, architect, developer, qa, bugFixer, security, reviewer, gate. */
      names: z.partialRecord(z.enum(['lead', 'pm', 'architect', 'developer', 'qa', 'bugFixer', 'security', 'reviewer', 'gate']), z.string()).default({}),
    })
    .default({ names: {} }),
  /** Deterministic checks the orchestrator runs itself (not the AI). Auto-detected on init. */
  checks: z.array(Check).default([]),
  checkTimeoutSec: z.number().int().positive().default(900),
  /** Run checks once before the mission starts, so failures that already existed aren't blamed on the team. */
  baselineChecks: z.boolean().default(true),
  git: z
    .object({
      branch: z.boolean().default(false),
      commit: z.boolean().default(false),
    })
    .default({ branch: false, commit: false }),
  guardrails: z
    .object({
      /** Above this many changed lines, the Code Reviewer joins even if JARVIS planned a solo mission. */
      soloMaxChangedLines: z.number().int().positive().default(40),
      /** Above this many changed files, the Code Reviewer joins even if JARVIS planned a solo mission. */
      soloMaxFiles: z.number().int().positive().default(3),
      /** Extra regex patterns (matched against changed file paths) that count as security-sensitive. */
      sensitivePaths: z.array(z.string()).default([]),
    })
    .default({ soloMaxChangedLines: 40, soloMaxFiles: 3, sensitivePaths: [] }),
  loop: z
    .object({
      /**
       * From this QA or review round on, NEW issues of MEDIUM or LOW severity are recorded as follow-ups instead of
       * starting another fix round (HIGH/CRITICAL and already-reported issues still block). 0 = always block.
       */
      deferNewIssuesFromRound: z.number().int().min(0).default(3),
    })
    .default({ deferNewIssuesFromRound: 3 }),
  rules: z
    .object({
      /** Let JARVIS add, update and remove learned rules after each mission. */
      autoLearn: z.boolean().default(true),
      maxLearned: z.number().int().positive().default(40),
    })
    .default({ autoLearn: true, maxLearned: 40 }),
  ui: z
    .object({
      /** Live Mission Control panel in interactive terminals. */
      live: z.boolean().default(true),
      emoji: z.boolean().default(true),
      /** Open the HTML mission report in the browser when a mission ends (interactive terminals only). */
      openReport: z.boolean().default(true),
    })
    .default({ live: true, emoji: true, openReport: true }),
  /**
   * How tool permissions work for agents.
   * "allowlist": each role gets only the tools it needs, and writes are limited to its area.
   * "bypass": skip permission checks entirely (sandboxes/CI containers only). Write areas are still enforced.
   */
  permissions: z.enum(['allowlist', 'bypass']).default('allowlist'),
});
export type Config = z.infer<typeof Config>;

export function loadConfig(root: string): Config {
  const file = paths(root).config;
  if (!fs.existsSync(file)) return Config.parse({});
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Invalid JSON in ${file}: ${(err as Error).message}`);
  }
  const parsed = Config.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid ${file}:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

const NPM_DEFAULT_TEST = 'echo "Error: no test specified" && exit 1';

/** Detects lint/typecheck/test/build scripts from package.json. */
export function detectChecks(root: string): Check[] {
  const pkgFile = path.join(root, 'package.json');
  if (!fs.existsSync(pkgFile)) return [];
  let scripts: Record<string, string> = {};
  try {
    scripts = JSON.parse(fs.readFileSync(pkgFile, 'utf8')).scripts ?? {};
  } catch {
    return [];
  }
  const runner = detectPackageManager(root);
  const wanted: Array<[string, string[]]> = [
    ['lint', ['lint']],
    ['typecheck', ['typecheck', 'type-check', 'tsc']],
    ['test', ['test']],
    ['build', ['build']],
  ];
  const checks: Check[] = [];
  for (const [name, candidates] of wanted) {
    const script = candidates.find((c) => scripts[c] && scripts[c] !== NPM_DEFAULT_TEST);
    if (script) checks.push({ name, command: `${runner} run ${script}` });
  }
  return checks;
}

export function detectPackageManager(root: string): string {
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(root, 'bun.lockb')) || fs.existsSync(path.join(root, 'bun.lock'))) return 'bun';
  return 'npm';
}
