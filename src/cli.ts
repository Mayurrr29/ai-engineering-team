#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { Command, InvalidArgumentError } from 'commander';
import { loadConfig, type Config } from './config.js';
import { isSolo } from './guardrails.js';
import { initProject } from './init.js';
import { onboard } from './onboarding.js';
import { Orchestrator } from './orchestrator.js';
import { detectPacks } from './packs.js';
import { loadProfile } from './playbooks.js';
import { paths } from './paths.js';
import { ClaudeCodeProvider } from './providers/claude.js';
import { evaluateRelease } from './release.js';
import { writeReport } from './report/html.js';
import { RunStore, type RunState } from './state.js';
import { MEMBERS, nameOf, ROSTER_ORDER } from './team.js';
import { c, pad, supportsEmoji } from './ui/format.js';
import { MissionControl, PlainUI, type UIOptions } from './ui/mission-control.js';
import type { TeamUI } from './ui/types.js';
import * as git from './git.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
const root = process.cwd();

const program = new Command()
  .name('ai-team')
  .description('An AI engineering team for your repo, led by JARVIS: plan → spec → design → build → test → fix → security → review → release.')
  .version(pkg.version);

program
  .command('init')
  .description('Set up .ai-team/ and let JARVIS study the project (onboarding)')
  .option('-f, --force', 'overwrite existing config and rulebook')
  .option('--skip-onboarding', "only scaffold files; don't run JARVIS's onboarding")
  .action(async (opts: { force?: boolean; skipOnboarding?: boolean }) => {
    const existing = safeConfig();
    const result = initProject(root, opts.force, existing?.team.names ?? {});
    console.log(`\n${c.bold(c.cyan('AI ENGINEERING TEAM'))} ${c.gray('· initialized')}\n`);
    result.created.forEach((f) => console.log(`  ${c.green('+')} ${f}`));
    result.skipped.forEach((f) => console.log(`  ${c.gray(`= ${f} (exists, kept)`)}`));
    const checks = result.config.checks ?? [];
    console.log(`\n  Checks detected: ${checks.length ? checks.map((ch) => ch.name).join(', ') : c.yellow('none yet')}`);
    console.log(`  Stack packs: ${detectPacks(root).join(', ') || c.gray('none detected')}`);
    if (opts.skipOnboarding) {
      console.log(`\n  Run ${c.bold('ai-team onboard')} when you want JARVIS to study the project.\n`);
      return;
    }
    await runOnboarding();
  });

program
  .command('onboard')
  .description('JARVIS studies the codebase and (re)writes the project profile, project rules and member notes')
  .action(async () => {
    if (!fs.existsSync(paths(root).dir)) initProject(root);
    await runOnboarding();
  });

program
  .command('build')
  .description('Run a mission: take a request from idea to an approved change')
  .argument('<request...>', 'what to build, e.g. "Allow instructors to create discount coupons"')
  .option('-q, --quick', 'fixed quick team: Developer → QA (light) → Code Review (light)')
  .option('--full', 'fixed full team: everyone at full depth')
  .option('-b, --budget <usd>', 'spending limit for this mission in USD (pauses instead of exceeding it)', positiveNumber)
  .option('-y, --yes', "don't ask questions; accept the team's proposed defaults")
  .option('-m, --max-iterations <n>', 'max fix/rework rounds', positiveInt)
  .option('--model <model>', 'model for every member (overrides config)')
  .option('--git', 'create a branch and commit after each step')
  .option('--quiet', 'hide live tool activity')
  .option('--no-live', 'plain line-by-line output instead of the live panel')
  .option('--no-open', "don't open the mission report when done")
  .action(async (words: string[], opts: BuildOptions) => {
    const request = words.join(' ').trim();
    if (!request) throw new InvalidArgumentError('Describe what to build.');
    if (opts.quick && opts.full) throw new InvalidArgumentError('Choose either --quick or --full.');
    const config = withOverrides(loadProjectConfig(), opts);
    const ui = createUI(config, opts);
    const outcome = await createOrchestrator(config, ui, opts).build(request, { budgetUsd: opts.budget });
    finish(config, outcome.state, outcome.reportPath, opts);
  });

program
  .command('resume')
  .description('Continue a paused, failed or interrupted mission from where it stopped')
  .argument('[mission-id]', 'mission to resume (default: most recent)')
  .option('-b, --budget <usd>', 'new spending limit for the mission', positiveNumber)
  .option('-y, --yes', "don't ask questions")
  .option('--quiet', 'hide live tool activity')
  .option('--no-live', 'plain line-by-line output')
  .option('--no-open', "don't open the mission report when done")
  .action(async (id: string | undefined, opts: BuildOptions) => {
    const missionId = id ?? RunStore.latestId(root);
    if (!missionId) throw new Error('No missions found.');
    const config = loadProjectConfig();
    const ui = createUI(config, opts);
    const outcome = await createOrchestrator(config, ui, opts).resume(missionId, { budgetUsd: opts.budget });
    finish(config, outcome.state, outcome.reportPath, opts);
  });

program
  .command('status')
  .description('Show the status of a mission')
  .argument('[mission-id]', 'mission to show (default: most recent)')
  .action((id?: string) => {
    const missionId = id ?? RunStore.latestId(root);
    if (!missionId) return console.log('No missions yet. Start one with: ai-team build "your request"');
    const config = safeConfig() ?? loadConfig(root);
    const store = RunStore.load(root, missionId);
    printStatus(store.state, store.dir, config);
  });

program
  .command('runs')
  .alias('missions')
  .description('List all missions in this project')
  .action(() => {
    const runs = RunStore.list(root);
    if (!runs.length) return console.log('No missions yet.');
    for (const r of runs) {
      console.log(`${statusIcon(r.status)} ${c.bold(r.missionName ?? r.id)}  ${c.gray(`${r.status} · ${r.mode} · ${r.iteration} round(s) · $${r.costUsd.toFixed(2)} · ${r.id}`)}\n    ${r.feature}`);
    }
  });

program
  .command('report')
  .description('Open the visual mission report in your browser')
  .argument('[mission-id]', 'mission to show (default: most recent)')
  .option('--no-open', 'only print the path')
  .action((id: string | undefined, opts: { open: boolean }) => {
    const missionId = id ?? RunStore.latestId(root);
    if (!missionId) return console.log('No missions yet.');
    const config = safeConfig() ?? loadConfig(root);
    const store = RunStore.load(root, missionId);
    const file = writeReport(store, { names: config.team.names, checksConfigured: config.checks.length > 0, humanName: humanName() });
    console.log(`Mission report: ${c.cyan(file)}`);
    if (opts.open) openInBrowser(file);
  });

program
  .command('team')
  .description('Meet the team')
  .action(() => {
    const config = safeConfig() ?? loadConfig(root);
    const emoji = config.ui.emoji && supportsEmoji();
    console.log(`\n${c.bold(c.cyan('AI ENGINEERING TEAM'))}\n`);
    for (const role of ROSTER_ORDER) {
      const m = MEMBERS[role];
      const name = nameOf(role, config.team.names);
      console.log(`  ${emoji ? m.icon : '•'} ${c[m.color](c.bold(pad(name, 10)))} ${pad(m.title, 18)} ${c.gray(`(${m.origin})`)}`);
      console.log(`     ${c.gray(m.tagline)}`);
    }
    console.log(`\n  ${c.gray('Rename anyone in .ai-team/config.json → "team": { "names": { "developer": "Chitti" } }')}\n`);
  });

program
  .command('doctor')
  .description('Check the setup: Node, config, checks, onboarding, Claude access')
  .option('--no-ping', 'skip the live Claude connectivity test')
  .action(async (opts: { ping: boolean }) => {
    let ok = true;
    const line = (pass: boolean, msg: string) => {
      ok &&= pass;
      console.log(`  ${pass ? c.green('✓') : c.red('✗')} ${msg}`);
    };
    const note = (msg: string) => console.log(`  ${c.yellow('!')} ${msg}`);
    const major = Number(process.versions.node.split('.')[0]);
    line(major >= 20, `Node ${process.versions.node}${major >= 20 ? '' : ' (need >= 20)'}`);
    const initialized = fs.existsSync(paths(root).dir);
    line(initialized, initialized ? '.ai-team/ found' : '.ai-team/ missing — run: ai-team init');
    try {
      const config = loadConfig(root);
      line(true, `config valid (mode: ${config.mode}, max rounds: ${config.maxIterations}${config.budgetUsd ? `, budget $${config.budgetUsd}` : ''})`);
      if (config.checks.length) line(true, `checks: ${config.checks.map((ch) => `${ch.name} (${ch.command})`).join(', ')}`);
      else note("no checks configured — the release gate can't verify tests/build");
    } catch (err) {
      line(false, (err as Error).message);
    }
    if (initialized) {
      if (loadProfile(root)) line(true, 'onboarding done (project profile, rules and member notes)');
      else note('JARVIS has not onboarded this project yet — run: ai-team onboard');
      if (fs.existsSync(paths(root).legacyAgents)) note('found .ai-team/agents/ from v0.1 — v0.2 uses built-in playbooks; put project notes in .ai-team/team/<role>.md');
    }
    console.log(`  ${c.gray('·')} stack packs: ${detectPacks(root).join(', ') || 'none detected'}`);
    console.log(`  ${c.gray('·')} git: ${git.isGitRepo(root) ? 'repository found (diffs, guardrails and scans enabled)' : 'not a git repository — guardrails fall back to reported file lists'}`);
    if (opts.ping) {
      process.stdout.write('  … contacting Claude');
      try {
        const { query } = await import('@anthropic-ai/claude-agent-sdk');
        let reply = '';
        for await (const m of query({ prompt: 'Reply with exactly: OK', options: { cwd: root, tools: [], maxTurns: 1, settingSources: [], persistSession: false } })) {
          if (m.type === 'result') reply = m.subtype === 'success' ? m.result : `error: ${m.subtype}`;
        }
        process.stdout.write('\r');
        line(/OK/i.test(reply), `Claude reachable${/OK/i.test(reply) ? '' : ` (${reply.slice(0, 120)})`}`);
      } catch (err) {
        process.stdout.write('\r');
        line(false, `Claude not reachable: ${(err as Error).message.split('\n')[0]}\n      Log in with Claude Code (run \`claude\` once) or set ANTHROPIC_API_KEY.`);
      }
    }
    console.log(ok ? c.green('\nAll good.') : c.red('\nSome checks failed.'));
    if (!ok) process.exitCode = 1;
  });

program.parseAsync().catch((err: Error) => {
  process.stdout.write('\x1b[?25h');
  console.error(c.red(`\nError: ${err.message}`));
  process.exit(1);
});

// ── helpers ────────────────────────────────────────────────────────────────

interface BuildOptions {
  quick?: boolean;
  full?: boolean;
  budget?: number;
  yes?: boolean;
  maxIterations?: number;
  model?: string;
  git?: boolean;
  quiet?: boolean;
  live?: boolean;
  open?: boolean;
}

function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError('Must be a positive integer.');
  return n;
}

function positiveNumber(value: string): number {
  const n = Number(value.replace(/^\$/, ''));
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError('Must be a positive number (USD).');
  return n;
}

function safeConfig(): Config | undefined {
  try {
    return loadConfig(root);
  } catch {
    return undefined;
  }
}

function loadProjectConfig(): Config {
  if (!fs.existsSync(paths(root).dir)) {
    console.log(c.yellow(`No .ai-team/ here — running with defaults. Run ${c.bold('ai-team init')} so JARVIS can study the project first.`));
  }
  return loadConfig(root);
}

function withOverrides(config: Config, opts: BuildOptions): Config {
  return {
    ...config,
    mode: opts.quick ? 'quick' : opts.full ? 'full' : config.mode,
    maxIterations: opts.maxIterations ?? config.maxIterations,
    model: opts.model ?? config.model,
    git: opts.git ? { branch: true, commit: true } : config.git,
  };
}

function uiOptions(config: Config, opts: { quiet?: boolean }): UIOptions {
  return { names: config.team.names, emoji: config.ui.emoji && supportsEmoji(), verbose: !opts.quiet };
}

function createUI(config: Config, opts: BuildOptions): TeamUI {
  const live = process.stdout.isTTY && config.ui.live && opts.live !== false && !process.env.CI;
  return live ? new MissionControl(uiOptions(config, opts)) : new PlainUI(uiOptions(config, opts));
}

function createOrchestrator(config: Config, ui: TeamUI, opts: BuildOptions): Orchestrator {
  const interactive = process.stdin.isTTY && !opts.yes;
  process.once('SIGINT', () => {
    process.stdout.write('\x1b[?25h');
    console.log(c.yellow(`\n\nInterrupted. Progress is saved — continue with: ${c.bold('ai-team resume')}`));
    process.exit(130);
  });
  return new Orchestrator({ root, config, provider: new ClaudeCodeProvider(), ui, ask: interactive ? askHuman : undefined });
}

async function askHuman(question: string, proposedDefault: string): Promise<string | undefined> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`\n  ${c.yellow('?')} ${question}\n    ${c.gray(`[Enter = ${proposedDefault}]`)} › `);
    return answer.trim() || undefined;
  } finally {
    rl.close();
  }
}

async function runOnboarding() {
  const config = loadConfig(root);
  const lead = nameOf('lead', config.team.names);
  const emoji = config.ui.emoji && supportsEmoji();
  console.log(`\n${emoji ? `${MEMBERS.lead.icon} ` : ''}${c.bold(c.cyan(lead))} is studying your codebase (first day on the job)…`);
  let last = 0;
  const started = Date.now();
  try {
    const result = await onboard(root, config, new ClaudeCodeProvider(), (line) => {
      if (Date.now() - last < 400) return;
      last = Date.now();
      console.log(c.gray(`    ↳ ${line}`));
    });
    const p = result.profile;
    console.log(`\n  ${c.green('✓')} ${c.bold(p.projectName)} — ${p.summary}`);
    console.log(`  ${c.green('✓')} ${p.conventions.length} conventions · ${p.rules.length} project rules · ${p.sensitiveAreas.length} sensitive areas · notes for 7 teammates`);
    console.log(`  ${c.green('✓')} stack packs: ${result.packs.join(', ') || 'none'}`);
    if (result.addedChecks.length) console.log(`  ${c.green('✓')} checks adopted from the codebase: ${result.addedChecks.map((ch) => `${ch.name} (${ch.command})`).join(', ')}`);
    console.log(c.gray(`\n  Wrote ${result.files.join(', ')}`));
    console.log(c.gray(`  Onboarding took ${Math.round((Date.now() - started) / 1000)}s · $${result.costUsd.toFixed(2)}`));
    console.log(`\n  Next: ${c.bold('ai-team build "your request"')}   ${c.gray('(review .ai-team/rules.md any time)')}\n`);
  } catch (err) {
    console.log(c.red(`\n  Onboarding failed: ${(err as Error).message}`));
    console.log(c.gray('  The team still works without it; try again later with: ai-team onboard\n'));
    process.exitCode = 1;
  }
}

function finish(config: Config, state: RunState, reportPath: string | undefined, opts: BuildOptions) {
  // The visual report is for team missions and plans; answers and small solo changes are complete in the terminal.
  const worthOpening = state.status === 'planned' || (state.status !== 'answered' && !isSolo(state.lineup));
  if (reportPath && worthOpening && opts.open !== false && config.ui.openReport && process.stdout.isTTY && !process.env.CI) openInBrowser(reportPath);
  if (!['approved', 'answered', 'planned'].includes(state.status)) process.exitCode = 1;
}

function openInBrowser(file: string) {
  try {
    const child =
      process.platform === 'win32'
        ? spawn('cmd', ['/c', 'start', '""', `"${file}"`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true })
        : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [file], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    // opening a browser is a convenience; the path is printed anyway
  }
}

function humanName(): string | undefined {
  return git.isGitRepo(root) ? git.userFirstName(root) : undefined;
}

function statusIcon(status: string): string {
  return ({ running: c.blue('●'), approved: c.green('✔'), rejected: c.red('✘'), failed: c.yellow('!'), paused: c.yellow('Ⅱ'), answered: c.green('?'), planned: c.green('▤') } as Record<string, string>)[status] ?? '·';
}

function printStatus(state: RunState, dir: string, config: Config) {
  const names = config.team.names;
  if (state.status === 'answered' || state.status === 'planned') {
    console.log(`\n${statusIcon(state.status)} ${c.bold(state.plan?.missionName ?? state.feature)}  ${c.gray(state.status)}  ${c.gray(`$${state.costUsd.toFixed(2)}`)}`);
    if (state.answer) console.log(`\n${state.answer.answer}\n`);
    console.log(`  ${c.gray('Report:')} ${path.join(dir, 'report.html')}\n`);
    return;
  }
  const decision = evaluateRelease(state, { checksConfigured: config.checks.length > 0, names, humanName: humanName() });
  console.log(`\n${statusIcon(state.status)} ${c.bold(state.plan?.missionName ?? state.feature)}  ${c.gray(state.status)}`);
  console.log(c.gray(`  ${state.id} · ${state.mode} mode · next: ${state.next} · round ${state.iteration}/${state.maxIterations} · $${state.costUsd.toFixed(2)}${state.budgetUsd ? ` of $${state.budgetUsd.toFixed(2)}` : ''}\n`));
  if (state.plan) {
    const staffed = (['pm', 'architect', 'qa', 'security', 'reviewer'] as const).filter((r) => state.lineup[r] !== 'off').map((r) => `${nameOf(r, names)} (${state.lineup[r]})`);
    console.log(`  ${c.bold('Team:')} ${nameOf('lead', names)} (lead), ${nameOf('developer', names)}${staffed.length ? `, ${staffed.join(', ')}` : ''}`);
  }
  for (const l of decision.lines) {
    const pending = state.status === 'running' || state.status === 'failed' || state.status === 'paused';
    const status = l.status === 'FAIL' && pending ? c.gray('pending') : l.status === 'PASS' ? c.green('pass') : l.status === 'FAIL' ? c.red('fail') : l.status === 'WARN' ? c.yellow('warn') : c.gray('skip');
    console.log(`  ${pad(l.label, 16)} ${status}${l.detail ? c.gray(`  ${l.detail}`) : ''}`);
  }
  if (state.error) console.log(c.red(`\n  ${state.error}`));
  console.log(`\n  ${c.gray('Report:')} ${path.join(dir, 'report.html')}  ${c.gray('(ai-team report)')}\n`);
}
