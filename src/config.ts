import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { paths } from './paths.js';

export const RoleName = z.enum(['pm', 'developer', 'qa', 'bugFixer', 'security', 'reviewer']);
export type RoleName = z.infer<typeof RoleName>;

export const Check = z.object({ name: z.string(), command: z.string() });
export type Check = z.infer<typeof Check>;

export const Config = z.object({
  /** quick: Developer → QA → Review. standard: PM → Developer → QA → Fix → Security → Review → Release. */
  mode: z.enum(['quick', 'standard']).default('standard'),
  /** Max fix/rework rounds before the release gate rejects the feature. */
  maxIterations: z.number().int().min(1).max(20).default(5),
  /** Default model for every agent. Omit to use your Claude Code default. */
  model: z.string().optional(),
  /** Per-role model override, e.g. { "reviewer": "claude-opus-5-5" }. */
  models: z.partialRecord(RoleName, z.string()).default({}),
  /** Optional per-agent-call spend cap in USD. */
  maxBudgetUsdPerAgent: z.number().positive().optional(),
  /** Max agent turns per call. */
  maxTurnsPerAgent: z.number().int().positive().default(200),
  /** Deterministic checks the orchestrator itself runs (not the AI). Auto-detected on init. */
  checks: z.array(Check).default([]),
  checkTimeoutSec: z.number().int().positive().default(900),
  git: z
    .object({
      /** Create an ai-team/<feature> branch at the start of a run (requires a clean worktree). */
      branch: z.boolean().default(false),
      /** Commit after each implementation/fix step. */
      commit: z.boolean().default(false),
    })
    .default({ branch: false, commit: false }),
  /**
   * How writer agents (developer, bug fixer) get tool permissions.
   * "allowlist": only the tools each role needs are pre-approved; everything else is denied.
   * "bypass": skip all permission checks (only for sandboxes/CI containers).
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
  if (!parsed.success) {
    throw new Error(`Invalid ${file}:\n${z.prettifyError(parsed.error)}`);
  }
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

function detectPackageManager(root: string): string {
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(root, 'bun.lockb')) || fs.existsSync(path.join(root, 'bun.lock'))) return 'bun';
  return 'npm';
}
