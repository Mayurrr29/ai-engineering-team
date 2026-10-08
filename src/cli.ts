#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { Command, InvalidArgumentError } from 'commander';
import { loadConfig, type Config } from './config.js';
import { initProject } from './init.js';
import { Orchestrator } from './orchestrator.js';
import { paths } from './paths.js';
import { ClaudeCodeProvider } from './providers/claude.js';
import { evaluateRelease } from './release.js';
import { RunStore, type RunState } from './state.js';
import { banner, c, consoleLogger } from './ui.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
const root = process.cwd();

const program = new Command()
  .name('ai-team')
  .description('An AI engineering team for your repo: PM → Developer → QA → Bug Fixer → Security → Code Review → Release.')
  .version(pkg.version);

program
  .command('init')
  .description('Set up .ai-team/ (config, rules, agent prompts, memory) in the current project')
  .option('-f, --force', 'overwrite existing files')
  .action((opts: { force?: boolean }) => {
    const result = initProject(root, opts.force);
    console.log(c.bold('AI Engineering Team initialized\n'));
    result.created.forEach((f) => console.log(`  ${c.green('+')} ${f}`));
    result.skipped.forEach((f) => console.log(`  ${c.dim(`= ${f} (exists, kept)`)}`));
    const checks = result.config.checks ?? [];
    console.log(`\n  Checks detected: ${checks.length ? checks.map((ch) => ch.name).join(', ') : c.yellow('none — add them to .ai-team/config.json')}`);
    console.log(`\nNext:\n  1. Edit ${c.bold('.ai-team/rules.md')} with your project's rules\n  2. Run ${c.bold('ai-team build "your feature"')}`);
  });

program
  .command('build')
  .description('Take a feature from requirements to an approved release')
  .argument('<feature...>', 'the feature request, e.g. "Allow instructors to create discount coupons"')
  .option('-q, --quick', 'quick mode: Developer → QA → Review (no PM spec, no security review)')
  .option('-y, --yes', 'never ask questions; accept the PM\'s proposed defaults')
  .option('-m, --max-iterations <n>', 'max fix/rework rounds', positiveInt)
  .option('--model <model>', 'model for every agent (overrides config)')
  .option('--git', 'create a branch and commit after each step')
  .option('--quiet', 'hide live agent activity')
  .action(async (words: string[], opts: { quick?: boolean; yes?: boolean; maxIterations?: number; model?: string; git?: boolean; quiet?: boolean }) => {
    const feature = words.join(' ').trim();
    if (!feature) throw new InvalidArgumentError('Describe the feature to build.');
    const config = withOverrides(loadProjectConfig(), opts);
    const orchestrator = createOrchestrator(config, opts);
    const outcome = await orchestrator.build(feature);
    finish(outcome.state, outcome.dir);
  });

program
  .command('resume')
  .description('Continue an interrupted or failed run from where it stopped')
  .argument('[run-id]', 'run to resume (default: most recent)')
  .option('-y, --yes', 'never ask questions')
  .option('--quiet', 'hide live agent activity')
  .action(async (runId: string | undefined, opts: { yes?: boolean; quiet?: boolean }) => {
    const id = runId ?? RunStore.latestId(root);
    if (!id) throw new Error('No runs found.');
    const orchestrator = createOrchestrator(loadProjectConfig(), opts);
    const outcome = await orchestrator.resume(id);
    finish(outcome.state, outcome.dir);
  });

program
  .command('status')
  .description('Show the status board of a run')
  .argument('[run-id]', 'run to show (default: most recent)')
  .action((runId?: string) => {
    const id = runId ?? RunStore.latestId(root);
    if (!id) return console.log('No runs yet. Start one with: ai-team build "your feature"');
    const store = RunStore.load(root, id);
    printStatus(store.state, store.dir, loadProjectConfig());
  });

program
  .command('runs')
  .description('List all runs in this project')
  .action(() => {
    const runs = RunStore.list(root);
    if (!runs.length) return console.log('No runs yet.');
    for (const r of runs) {
      console.log(`${statusIcon(r.status)} ${c.bold(r.id)}  ${c.dim(`${r.status} · ${r.mode} · ${r.iteration} round(s) · $${r.costUsd.toFixed(2)}`)}\n    ${r.feature}`);
    }
  });

program
  .command('doctor')
  .description('Check that everything is set up (Node, config, checks, Claude access)')
  .option('--no-ping', 'skip the live Claude connectivity test')
  .action(async (opts: { ping: boolean }) => {
    let ok = true;
    const line = (pass: boolean, msg: string) => {
      ok &&= pass;
      console.log(`  ${pass ? c.green('✓') : c.red('✗')} ${msg}`);
    };
    const major = Number(process.versions.node.split('.')[0]);
    line(major >= 20, `Node ${process.versions.node}${major >= 20 ? '' : ' (need >= 20)'}`);
    const initialized = fs.existsSync(paths(root).dir);
    line(initialized, initialized ? '.ai-team/ found' : '.ai-team/ missing — run: ai-team init');
    try {
      const config = loadConfig(root);
      line(true, `config valid (mode: ${config.mode}, max iterations: ${config.maxIterations})`);
      if (config.checks.length) line(true, `checks: ${config.checks.map((ch) => `${ch.name} (${ch.command})`).join(', ')}`);
      else console.log(`  ${c.yellow('!')} no checks configured — the release gate can't verify tests/build`);
    } catch (err) {
      line(false, (err as Error).message);
    }
    if (opts.ping) {
      process.stdout.write(`  … contacting Claude`);
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
  console.error(c.red(`\nError: ${err.message}`));
  process.exit(1);
});

// ── helpers ────────────────────────────────────────────────────────────────

function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError('Must be a positive integer.');
  return n;
}

function loadProjectConfig(): Config {
  if (!fs.existsSync(paths(root).dir)) {
    console.log(c.yellow(`No .ai-team/ here — running with defaults. Run ${c.bold('ai-team init')} to customize rules, agents and checks.`));
  }
  return loadConfig(root);
}

function withOverrides(config: Config, opts: { quick?: boolean; maxIterations?: number; model?: string; git?: boolean }): Config {
  return {
    ...config,
    mode: opts.quick ? 'quick' : config.mode,
    maxIterations: opts.maxIterations ?? config.maxIterations,
    model: opts.model ?? config.model,
    git: opts.git ? { branch: true, commit: true } : config.git,
  };
}

function createOrchestrator(config: Config, opts: { yes?: boolean; quiet?: boolean }): Orchestrator {
  const interactive = process.stdin.isTTY && !opts.yes;
  return new Orchestrator({
    root,
    config,
    provider: new ClaudeCodeProvider(),
    logger: consoleLogger(!opts.quiet),
    ask: interactive ? askHuman : undefined,
  });
}

async function askHuman(question: string, proposedDefault: string): Promise<string | undefined> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`  ${c.yellow('?')} ${question}\n    ${c.dim(`[Enter = ${proposedDefault}]`)} › `);
    return answer.trim() || undefined;
  } finally {
    rl.close();
  }
}

function finish(state: RunState, dir: string) {
  console.log(`\n${c.dim('Artifacts:')} ${path.relative(root, dir) || dir}`);
  if (state.status === 'approved') console.log(c.green('Feature approved. Review the diff and merge when you are happy.'));
  else if (state.status === 'rejected') console.log(c.red('Feature rejected. See release.md for reasons; adjust and run again.'));
  if (state.status !== 'approved') process.exitCode = 1;
}

function statusIcon(status: RunState['status']): string {
  return { running: c.blue('●'), approved: c.green('✔'), rejected: c.red('✘'), failed: c.yellow('!') }[status];
}

function printStatus(state: RunState, dir: string, config: Config) {
  const decision = evaluateRelease(state, { securityEnabled: state.mode === 'standard', checksConfigured: config.checks.length > 0 });
  console.log(`${c.bold(state.spec?.title ?? state.feature)}  ${statusIcon(state.status)} ${state.status}`);
  console.log(c.dim(`${state.id} · ${state.mode} mode · next: ${state.next} · round ${state.iteration}/${state.maxIterations} · $${state.costUsd.toFixed(2)}\n`));
  const lines = decision.lines.map<[string, string]>((l) => {
    const pending = state.status === 'running' || state.status === 'failed';
    const status = l.status === 'FAIL' && pending ? 'PENDING' : l.status;
    return [l.label, `${status}${l.detail ? c.dim(` — ${l.detail}`) : ''}`];
  });
  console.log(banner(lines, state.status.toUpperCase()));
  if (state.error) console.log(c.red(`\nLast error: ${state.error}`));
  console.log(`\n${c.dim('Artifacts:')} ${path.relative(root, dir)}`);
  state.artifacts.forEach((a) => console.log(c.dim(`  ${a.file}`)));
}
