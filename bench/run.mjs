#!/usr/bin/env node
// Proving Ground runner.
//
//   node bench/run.mjs --reference                      check that hidden tests fail on the base app and pass on reference solutions
//   node bench/run.mjs --cli <cli.js> --label <name>     run ai-team on every scenario and score it with the hidden tests
//   node bench/run.mjs --solo --label <name>             baseline: one plain Claude Code agent, no team
//   node bench/run.mjs --rescore --label <name>          re-run the hidden tests on an earlier run's final code
//
// Options: --scenarios 01-profile-update,02-coupons  --parallel 4  --build-args "--quick"  --init-args "--skip-onboarding"
//          --timeout-min 90  --keep (keep work dirs)
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'learnhub-api');
const SCENARIOS_DIR = path.join(HERE, 'scenarios');
const RUNS_DIR = path.join(HERE, '.runs');
const RESULTS_DIR = path.join(HERE, 'results');

const args = parseArgs(process.argv.slice(2));
const allScenarios = fs.readdirSync(SCENARIOS_DIR).filter((d) => /^\d\d-/.test(d)).sort();
const scenarios = args.scenarios ? args.scenarios.split(',') : allScenarios;

ensureFixtureInstalled();

if (args.reference) {
  await validateReference();
} else if (args.rescore) {
  rescore();
} else if (args.solo) {
  if (!args.label) args.label = 'solo-claude-code';
  await runPool(runSolo);
} else {
  if (!args.cli || !args.label) {
    console.error('Usage: node bench/run.mjs --cli <path to ai-team cli.js> --label <name> [--scenarios a,b] [--parallel n]');
    process.exit(1);
  }
  await runTeam();
}

// ── modes ──────────────────────────────────────────────────────────────────

async function validateReference() {
  let ok = true;
  for (const scenario of scenarios) {
    const base = prepareWorkdir('reference-base', scenario);
    const baseHidden = runHidden(base, scenario);
    const ref = prepareWorkdir('reference', scenario);
    overlay(path.join(SCENARIOS_DIR, scenario, 'reference'), ref);
    const refHidden = runHidden(ref, scenario);
    const refVisible = runTap(ref, listTests(path.join(ref, 'test')));
    const good = refHidden.failed === 0 && refHidden.passed > 0 && refVisible.failed === 0;
    ok &&= good;
    console.log(
      `${good ? '✓' : '✗'} ${scenario.padEnd(20)} base app: ${baseHidden.passed}/${baseHidden.total} hidden · reference: ${refHidden.passed}/${refHidden.total} hidden, ${refVisible.passed}/${refVisible.total} visible`,
    );
    for (const f of refHidden.failures) console.log(`    reference failed: ${f}`);
    if (!args.keep) for (const dir of [base, ref]) fs.rmSync(dir, { recursive: true, force: true });
  }
  process.exit(ok ? 0 : 1);
}

async function runTeam() {
  await runPool(runScenario);
}

async function runPool(fn) {
  const parallel = Number(args.parallel ?? 2);
  const queue = [...scenarios];
  const workers = Array.from({ length: Math.min(parallel, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
  console.log(`\nResults written to ${path.join(RESULTS_DIR, args.label)}. Compare with: node bench/compare.mjs`);
}

/** Baseline: one Claude Code agent with its default system prompt, given the same request. No team. */
async function runSolo(scenario) {
  const label = args.label;
  const task = fs.readFileSync(path.join(SCENARIOS_DIR, scenario, 'task.md'), 'utf8').trim();
  const work = prepareWorkdir(label, scenario);
  const log = path.join(work, '..', `${scenario}.log`);
  fs.writeFileSync(log, `# ${label} · ${scenario}\n# task: ${task}\n\n`);
  console.log(`▶ ${label} · ${scenario} → ${work}`);
  const sdk = path.join(HERE, '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs');
  const { query } = await import(pathToFileURL(sdk).href);
  const tools = ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write', 'TodoWrite'];
  const started = Date.now();
  let cost = 0;
  let status = 'no-result';
  try {
    const options = { cwd: work, tools, allowedTools: tools, permissionMode: 'dontAsk', systemPrompt: { type: 'preset', preset: 'claude_code' }, settingSources: ['project'], maxTurns: 200 };
    const prompt = `${task}\n\nImplement this in the repository, following its existing conventions, with tests. Run the tests when you're done.`;
    for await (const m of query({ prompt, options })) {
      if (m.type === 'assistant') for (const b of m.message.content) if (b.type === 'tool_use') fs.appendFileSync(log, `· ${b.name} ${JSON.stringify(b.input).slice(0, 160)}\n`);
      if (m.type === 'result') {
        cost = m.total_cost_usd;
        status = m.subtype === 'success' ? 'done' : m.subtype;
        fs.appendFileSync(log, `\n${m.subtype === 'success' ? m.result : m.subtype}\n`);
      }
    }
  } catch (err) {
    status = 'error';
    fs.appendFileSync(log, `\nerror: ${err.message}\n`);
  }
  writeResult(label, scenario, task, work, { status, costUsd: cost, wallMs: Date.now() - started, iterations: null, lineup: 'solo agent', exitCodes: {} });
}

function rescore() {
  const dir = path.join(RESULTS_DIR, args.label);
  for (const scenario of scenarios) {
    const file = path.join(dir, `${scenario}.json`);
    const work = path.join(RUNS_DIR, args.label, scenario);
    if (!fs.existsSync(file) || !fs.existsSync(work)) continue;
    const result = JSON.parse(fs.readFileSync(file, 'utf8'));
    const hidden = runHidden(work, scenario);
    result.hidden = { passed: hidden.passed, total: hidden.total, failures: hidden.failures };
    result.rescoredAt = new Date().toISOString();
    fs.writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
    console.log(`↻ ${args.label} · ${scenario}: hidden ${hidden.passed}/${hidden.total}${hidden.failures.length ? ` (failed: ${hidden.failures.join('; ')})` : ''}`);
  }
}

function writeResult(label, scenario, task, work, extra) {
  const hidden = runHidden(work, scenario);
  const visible = runTap(work, listTests(path.join(work, 'test')));
  const result = {
    scenario,
    label,
    task,
    at: new Date().toISOString(),
    exitCodes: extra.exitCodes,
    status: extra.status,
    costUsd: round(extra.costUsd ?? 0),
    onboardingCostUsd: round(extra.onboardingCostUsd ?? 0),
    iterations: extra.iterations,
    lineup: extra.lineup,
    wallMinutes: round(extra.wallMs / 60000, 1),
    hidden: { passed: hidden.passed, total: hidden.total, failures: hidden.failures },
    visible: { passed: visible.passed, total: visible.total, failures: visible.failures },
    filesChanged: changedFiles(work),
  };
  fs.mkdirSync(path.join(RESULTS_DIR, label), { recursive: true });
  fs.writeFileSync(path.join(RESULTS_DIR, label, `${scenario}.json`), JSON.stringify(result, null, 2) + '\n');
  console.log(
    `■ ${label} · ${scenario}: ${result.status} · hidden ${hidden.passed}/${hidden.total} · visible ${visible.passed}/${visible.total} · $${result.costUsd} · ${result.wallMinutes} min`,
  );
}

async function runScenario(scenario) {
  const label = args.label;
  const task = fs.readFileSync(path.join(SCENARIOS_DIR, scenario, 'task.md'), 'utf8').trim();
  const work = prepareWorkdir(label, scenario);
  const log = path.join(work, '..', `${scenario}.log`);
  fs.writeFileSync(log, `# ${label} · ${scenario}\n# task: ${task}\n\n`);
  console.log(`▶ ${label} · ${scenario} → ${work}`);

  const started = Date.now();
  const initArgs = splitArgs(args['init-args']);
  const init = await runLogged(process.execPath, [path.resolve(args.cli), 'init', ...initArgs], work, log, 30);
  const buildArgs = splitArgs(args['build-args']);
  const build = await runLogged(process.execPath, [path.resolve(args.cli), 'build', task, '--yes', ...buildArgs], work, log, Number(args['timeout-min'] ?? 90));
  const wallMs = Date.now() - started;

  const state = latestState(work);
  writeResult(label, scenario, task, work, {
    status: state?.status ?? 'no-state',
    costUsd: state?.costUsd ?? 0,
    onboardingCostUsd: readOnboardingCost(work),
    iterations: state?.iteration ?? null,
    lineup: state?.lineup ?? null,
    wallMs,
    exitCodes: { init: init.code, build: build.code },
  });
}

// ── helpers ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else out[key] = argv[++i];
  }
  return out;
}

function splitArgs(value) {
  return typeof value === 'string' && value.trim() ? value.trim().split(/\s+/) : [];
}

function ensureFixtureInstalled() {
  if (!fs.existsSync(path.join(FIXTURE, 'node_modules', 'express'))) {
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], { cwd: FIXTURE, stdio: 'inherit', shell: process.platform === 'win32' });
  }
}

function prepareWorkdir(label, scenario) {
  const work = path.join(RUNS_DIR, label, scenario);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  fs.cpSync(FIXTURE, work, { recursive: true, filter: (src) => !src.includes(`${path.sep}node_modules`) || src.endsWith('learnhub-api') });
  fs.cpSync(path.join(FIXTURE, 'node_modules'), path.join(work, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(work, '.gitignore'), 'node_modules/\n');
  const git = (...a) => execFileSync('git', a, { cwd: work, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'bench@example.com');
  git('config', 'user.name', 'Proving Ground');
  git('config', 'core.autocrlf', 'false');
  git('add', '-A');
  git('commit', '-qm', 'LearnHub API baseline');
  return work;
}

function overlay(from, to) {
  fs.cpSync(from, to, { recursive: true });
}

function runHidden(work, scenario) {
  const dir = path.join(work, 'test-hidden');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir);
  fs.copyFileSync(path.join(SCENARIOS_DIR, '_shared', 'api.js'), path.join(dir, '_api.js'));
  fs.copyFileSync(path.join(SCENARIOS_DIR, scenario, 'hidden.test.js'), path.join(dir, 'hidden.test.js'));
  const result = runTap(work, [path.join(dir, 'hidden.test.js')]);
  return result;
}

function listTests(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => /\.test\.(m|c)?js$/.test(f))
    .map((f) => path.join(dir, f));
}

function runTap(cwd, files) {
  if (!files.length) return { passed: 0, failed: 0, total: 0, failures: [] };
  let out = '';
  try {
    out = execFileSync(process.execPath, ['--test', '--test-reporter=tap', ...files], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5 * 60_000,
    });
  } catch (err) {
    out = `${err.stdout ?? ''}`;
  }
  const passed = Number(/^# pass (\d+)/m.exec(out)?.[1] ?? 0);
  const failed = Number(/^# fail (\d+)/m.exec(out)?.[1] ?? 0);
  const cancelled = Number(/^# cancelled (\d+)/m.exec(out)?.[1] ?? 0);
  const failures = [...out.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1].trim()).filter((name) => !/\.(m|c)?js$/.test(name));
  return { passed, failed: failed + cancelled, total: passed + failed + cancelled, failures };
}

function runLogged(cmd, cmdArgs, cwd, logFile, timeoutMin) {
  return new Promise((resolve) => {
    const out = fs.openSync(logFile, 'a');
    const child = spawn(cmd, cmdArgs, { cwd, stdio: ['ignore', out, out], env: { ...process.env, NO_COLOR: '1', CI: '1' } });
    const timer = setTimeout(() => {
      fs.appendFileSync(logFile, `\n[bench] timed out after ${timeoutMin} min\n`);
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
      else child.kill('SIGKILL');
    }, timeoutMin * 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      fs.closeSync(out);
      resolve({ code });
    });
  });
}

function latestState(work) {
  const runs = path.join(work, '.ai-team', 'runs');
  if (!fs.existsSync(runs)) return undefined;
  const ids = fs.readdirSync(runs).filter((d) => fs.existsSync(path.join(runs, d, 'state.json'))).sort();
  if (!ids.length) return undefined;
  return JSON.parse(fs.readFileSync(path.join(runs, ids.at(-1), 'state.json'), 'utf8'));
}

function readOnboardingCost(work) {
  const file = path.join(work, '.ai-team', 'project.json');
  if (!fs.existsSync(file)) return 0;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).onboarding?.costUsd ?? 0;
  } catch {
    return 0;
  }
}

function changedFiles(work) {
  try {
    const tracked = execFileSync('git', ['diff', '--name-only', 'HEAD', '--', '.', ':(exclude).ai-team'], { cwd: work, encoding: 'utf8' });
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', '.', ':(exclude).ai-team', ':(exclude)test-hidden'], { cwd: work, encoding: 'utf8' });
    return [...tracked.split('\n'), ...untracked.split('\n')].filter(Boolean);
  } catch {
    return [];
  }
}

function round(n, digits = 2) {
  return Math.round(n * 10 ** digits) / 10 ** digits;
}
