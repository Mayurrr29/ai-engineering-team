import fs from 'node:fs';
import path from 'node:path';
import { detectChecks, detectPackageManager, type Check, type Config } from './config.js';
import { detectPacks, type PackId } from './packs.js';
import { buildSystemPrompt, writeTeamNotes } from './playbooks.js';
import { paths } from './paths.js';
import { onboardPrompt } from './prompts.js';
import { AgentError, type AIProvider } from './providers/types.js';
import { mermaidSource } from './render.js';
import { ensureRulebook, setProjectRules } from './rules.js';
import { ProjectProfile, toJsonSchema } from './schemas.js';
import { nameOf, type RoleId } from './team.js';

export interface OnboardResult {
  profile: ProjectProfile;
  costUsd: number;
  packs: PackId[];
  addedChecks: Check[];
  files: string[];
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.turbo', '.cache', '.ai-team', '.venv', 'venv', '__pycache__', 'target', 'vendor']);

/** A cheap, deterministic snapshot of the repository so JARVIS starts from facts, not guesses. */
export function repositoryFacts(root: string): string {
  const lines: string[] = [];
  const pkgFile = path.join(root, 'package.json');
  if (fs.existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      lines.push(`package.json: name "${pkg.name ?? ''}", type "${pkg.type ?? 'commonjs'}"`);
      if (pkg.scripts) lines.push(`scripts: ${Object.entries(pkg.scripts).map(([k, v]) => `${k}=\`${v}\``).join(', ')}`);
      const deps = Object.keys(pkg.dependencies ?? {});
      const dev = Object.keys(pkg.devDependencies ?? {});
      if (deps.length) lines.push(`dependencies: ${deps.join(', ')}`);
      if (dev.length) lines.push(`devDependencies: ${dev.join(', ')}`);
    } catch {
      lines.push('package.json: unreadable');
    }
  }
  lines.push(`package manager: ${detectPackageManager(root)}`);
  const checks = detectChecks(root);
  lines.push(`checks detected: ${checks.length ? checks.map((c) => `${c.name} (\`${c.command}\`)`).join(', ') : 'none'}`);
  const packs = detectPacks(root);
  lines.push(`stack packs detected from dependencies: ${packs.join(', ') || 'none'}`);

  const tree: string[] = [];
  const counts = new Map<string, number>();
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        const rel = path.relative(root, path.join(dir, e.name)).replace(/\\/g, '/');
        if (depth < 3) tree.push(`${'  '.repeat(depth)}${e.name}/`);
        walk(path.join(dir, e.name), depth + 1);
        void rel;
      } else {
        const ext = path.extname(e.name) || e.name;
        counts.set(ext, (counts.get(ext) ?? 0) + 1);
        if (depth < 2 && tree.length < 120) tree.push(`${'  '.repeat(depth)}${e.name}`);
      }
    }
  };
  walk(root, 0);
  lines.push(`files by type: ${[...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([e, n]) => `${e} ${n}`).join(', ')}`);
  lines.push(`tree (first levels):\n\`\`\`\n${tree.slice(0, 120).join('\n')}\n\`\`\``);
  for (const readme of ['README.md', 'readme.md', 'README']) {
    const file = path.join(root, readme);
    if (fs.existsSync(file)) {
      lines.push(`${readme} (first 60 lines):\n\`\`\`\n${fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(0, 60).join('\n')}\n\`\`\``);
      break;
    }
  }
  if (fs.existsSync(path.join(root, 'CLAUDE.md'))) lines.push('CLAUDE.md exists (already loaded into your context).');
  return lines.join('\n');
}

export function renderProjectMarkdown(p: ProjectProfile, packs: PackId[]): string {
  const rows = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join('\n') : '_None._');
  return [
    `# ${p.projectName}`,
    p.summary,
    `## Stack\n\n| Languages | Frameworks | Databases | Testing | Package manager |\n|---|---|---|---|---|\n| ${p.stack.languages.join(', ') || '-'} | ${p.stack.frameworks.join(', ') || '-'} | ${p.stack.databases.join(', ') || '-'} | ${p.stack.testing.join(', ') || '-'} | ${p.stack.packageManager || '-'} |`,
    `Stack packs active: ${packs.join(', ') || 'none'}`,
    `## Architecture\n\n${p.architecture.overview}`,
    p.architecture.diagram.trim() ? '```mermaid\n' + mermaidSource(p.architecture.diagram) + '\n```' : '',
    `## Modules\n\n${rows(p.architecture.modules.map((m) => `\`${m.path}\` — ${m.purpose}`))}`,
    `## Conventions\n\n| Topic | Convention | Evidence |\n|---|---|---|\n${p.conventions.map((c) => `| ${c.topic} | ${c.convention.replace(/\|/g, '\\|')} | \`${c.evidence}\` |`).join('\n')}`,
    `## Commands\n\n${rows(p.commands.map((c) => `\`${c.command}\` — ${c.purpose}`))}`,
    `## How to run\n\n${rows(p.howToRun)}`,
    `## How to test\n\n${rows(p.howToTest)}`,
    `## Sensitive areas\n\n${rows(p.sensitiveAreas.map((s) => `\`${s.path}\` — ${s.reason}`))}`,
  ]
    .filter(Boolean)
    .join('\n\n') + '\n';
}

/** JARVIS studies the repository and writes the team's project knowledge. */
export async function onboard(
  root: string,
  config: Config,
  provider: AIProvider,
  onActivity?: (line: string) => void,
): Promise<OnboardResult> {
  ensureRulebook(root);
  const names = config.team.names;
  const detected = detectPacks(root);
  const result = await provider.run({
    role: 'lead',
    member: nameOf('lead', names),
    systemPrompt: buildSystemPrompt(root, 'lead', { names, packs: detected }, false, 'onboarding'),
    prompt: onboardPrompt(repositoryFacts(root)),
    outputSchema: toJsonSchema(ProjectProfile),
    access: { read: true, run: false, write: 'none' },
    cwd: root,
    model: config.models.lead ?? config.model,
    effort: config.effort.lead ?? 'medium',
    maxTurns: 80,
    maxBudgetUsd: config.maxBudgetUsdPerAgent,
    bypassPermissions: config.permissions === 'bypass',
    onActivity,
  });
  const parsed = ProjectProfile.safeParse(result.output);
  if (!parsed.success) throw new AgentError(`${nameOf('lead', names)} returned an invalid project profile: ${parsed.error.message}`, result.costUsd);
  const profile = parsed.data;
  const packs = [...new Set([...detected, ...profile.stackPacks])];

  const p = paths(root);
  fs.mkdirSync(p.dir, { recursive: true });
  fs.writeFileSync(p.projectJson, JSON.stringify({ version: 1, onboarding: { at: new Date().toISOString(), costUsd: result.costUsd }, packs, profile }, null, 2) + '\n');
  fs.writeFileSync(p.project, renderProjectMarkdown(profile, packs));
  setProjectRules(root, profile.rules);
  const files = [p.projectJson, p.project, p.rules];
  for (const role of Object.keys(profile.memberNotes) as Array<Exclude<RoleId, 'lead'>>) {
    writeTeamNotes(root, role, names, profile.memberNotes[role]);
    files.push(path.join(p.teamNotes, `${role}.md`));
  }

  // If the project had no checks we could detect, adopt the commands JARVIS found.
  const addedChecks: Check[] = [];
  if (!config.checks.length && fs.existsSync(p.config)) {
    for (const cmd of profile.commands) {
      const name = cmd.name.toLowerCase();
      if (['lint', 'typecheck', 'test', 'build'].includes(name) && !addedChecks.some((c) => c.name === name)) addedChecks.push({ name, command: cmd.command });
    }
    if (addedChecks.length) {
      const raw = JSON.parse(fs.readFileSync(p.config, 'utf8'));
      raw.checks = addedChecks;
      fs.writeFileSync(p.config, JSON.stringify(raw, null, 2) + '\n');
    }
  }
  return { profile, costUsd: result.costUsd, packs, addedChecks, files: files.map((f) => path.relative(root, f)) };
}
