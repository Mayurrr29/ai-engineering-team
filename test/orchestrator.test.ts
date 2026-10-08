import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { initProject } from '../src/init.js';
import { Orchestrator } from '../src/orchestrator.js';
import { MockProvider } from '../src/providers/mock.js';
import { AgentError } from '../src/providers/types.js';
import { RunStore } from '../src/state.js';
import { approve, config, dev, fix, qaFail, qaPass, reject, spec, tmpProject } from './helpers.js';

const roles = (p: MockProvider) => p.calls.map((c) => c.role);

test('standard happy path: PM → Dev → Checks → QA → Security → Review → APPROVED', async () => {
  const root = tmpProject();
  initProject(root);
  const provider = new MockProvider({ pm: [spec()], developer: [dev()], qa: [qaPass()], security: [approve()], reviewer: [approve(['Health routes live in src/routes'])] });
  const out = await new Orchestrator({ root, config: config(), provider }).build('Add a health check endpoint');

  assert.equal(out.state.status, 'approved');
  assert.equal(out.decision?.approved, true);
  assert.deepEqual(roles(provider), ['pm', 'developer', 'qa', 'security', 'reviewer']);
  assert.equal(out.state.codeVersion, 1);
  const files = fs.readdirSync(out.dir);
  for (const f of ['request.md', 'state.json', '01-requirements.md', '02-implementation.md', '03-checks-v1.md', '04-qa-round1.md', '05-security-v1.md', '06-code-review-v1.md', '07-release.md']) {
    assert.ok(files.includes(f), `missing artifact ${f} in ${files.join(', ')}`);
  }
  assert.match(fs.readFileSync(path.join(out.dir, '07-release.md'), 'utf8'), /APPROVED/);
  assert.match(fs.readFileSync(path.join(root, '.ai-team/memory/lessons.md'), 'utf8'), /Health routes live in src\/routes/);
});

test('agents get role-appropriate permissions and the project rules', async () => {
  const root = tmpProject();
  initProject(root);
  fs.appendFileSync(path.join(root, '.ai-team/rules.md'), '\n99. Always use tabs.\n');
  const provider = new MockProvider({ pm: [spec()], developer: [dev()], qa: [qaPass()], security: [approve()], reviewer: [approve()] });
  await new Orchestrator({ root, config: config(), provider }).build('x');
  const byRole = Object.fromEntries(provider.calls.map((c) => [c.role, c]));
  assert.equal(byRole.pm.canWrite, false);
  assert.equal(byRole.developer.canWrite, true);
  assert.equal(byRole.qa.canWrite, false);
  assert.equal(byRole.qa.canRunCommands, true);
  assert.equal(byRole.reviewer.canWrite, false);
  for (const call of provider.calls) assert.match(call.systemPrompt, /Always use tabs/);
  assert.match(byRole.developer.prompt, /AC-1/);
});

test('QA finds a bug → Bug Fixer → QA re-verifies → approved', async () => {
  const root = tmpProject();
  const provider = new MockProvider({ pm: [spec()], developer: [dev()], qa: [qaFail(), qaPass()], bugFixer: [fix()], security: [approve()], reviewer: [approve()] });
  const out = await new Orchestrator({ root, config: config(), provider }).build('x');

  assert.equal(out.state.status, 'approved');
  assert.deepEqual(roles(provider), ['pm', 'developer', 'qa', 'bugFixer', 'qa', 'security', 'reviewer']);
  assert.equal(out.state.iteration, 1);
  assert.equal(out.state.codeVersion, 2);
  const fixCall = provider.calls.find((c) => c.role === 'bugFixer')!;
  assert.match(fixCall.prompt, /BUG-001/);
  const secondQa = provider.calls.filter((c) => c.role === 'qa')[1];
  assert.match(secondQa.prompt, /previous QA round[\s\S]*BUG-001/);
});

test('reviewer rejection → developer rework → full QA/security/review again', async () => {
  const root = tmpProject();
  const provider = new MockProvider({ pm: [spec()], developer: [dev(), dev('Moved logic to service')], qa: [qaPass()], security: [approve()], reviewer: [reject(), approve()] });
  const out = await new Orchestrator({ root, config: config(), provider }).build('x');

  assert.equal(out.state.status, 'approved');
  assert.deepEqual(roles(provider), ['pm', 'developer', 'qa', 'security', 'reviewer', 'developer', 'qa', 'security', 'reviewer']);
  assert.match(provider.calls[5].prompt, /REJECTED by the Code Reviewer[\s\S]*REV-001/);
});

test('reviewer says APPROVED but reports a HIGH finding → gate treats it as rejected', async () => {
  const root = tmpProject();
  const provider = new MockProvider({ pm: [spec()], developer: [dev()], qa: [qaPass()], security: [approve()], reviewer: [reject('REV-001', 'HIGH', 'APPROVED'), approve()] });
  const out = await new Orchestrator({ root, config: config(), provider }).build('x');
  assert.equal(provider.calls.filter((c) => c.role === 'reviewer').length, 2);
  assert.equal(out.state.status, 'approved');
});

test('LOW-only findings do not block approval', async () => {
  const root = tmpProject();
  const provider = new MockProvider({ pm: [spec()], developer: [dev()], qa: [qaPass()], security: [approve()], reviewer: [reject('REV-001', 'LOW', 'APPROVED')] });
  const out = await new Orchestrator({ root, config: config(), provider }).build('x');
  assert.equal(out.state.status, 'approved');
});

test('a failing deterministic check is sent to the Bug Fixer even if QA passes', async () => {
  const root = tmpProject();
  const checks = [{ name: 'test', command: `node -e "process.exit(require('fs').existsSync('fixed.flag') ? 0 : 1)"` }];
  const provider = new MockProvider({
    pm: [spec()],
    developer: [dev()],
    qa: [qaPass()],
    bugFixer: [
      () => {
        fs.writeFileSync(path.join(root, 'fixed.flag'), '');
        return fix('CHECK-test');
      },
    ],
    security: [approve()],
    reviewer: [approve()],
  });
  const out = await new Orchestrator({ root, config: config({ checks }), provider }).build('x');

  assert.equal(out.state.status, 'approved');
  assert.match(provider.calls.find((c) => c.role === 'bugFixer')!.prompt, /CHECK-test/);
  assert.ok(out.state.checks!.results.every((r) => r.passed));
});

test('iteration limit reached → release gate REJECTS with reasons', async () => {
  const root = tmpProject();
  const provider = new MockProvider({ pm: [spec()], developer: [dev()], qa: [qaFail()], bugFixer: [fix()], security: [approve()], reviewer: [approve()] });
  const out = await new Orchestrator({ root, config: config({ maxIterations: 2 }), provider }).build('x');

  assert.equal(out.state.status, 'rejected');
  assert.equal(out.state.iteration, 2);
  assert.equal(provider.calls.filter((c) => c.role === 'bugFixer').length, 2);
  assert.ok(out.decision!.reasons.some((r) => r.startsWith('QA')));
  assert.ok(!roles(provider).includes('reviewer'));
});

test('agent crash marks the run failed; resume continues from the failed step', async () => {
  const root = tmpProject();
  const crashing = new MockProvider({ pm: [spec()], developer: [dev()], qa: [new AgentError('network down')] });
  const first = await new Orchestrator({ root, config: config(), provider: crashing }).build('x');
  assert.equal(first.state.status, 'failed');
  assert.equal(first.state.next, 'qa');
  assert.match(first.state.error!, /network down/);

  const healthy = new MockProvider({ qa: [qaPass()], security: [approve()], reviewer: [approve()] });
  const second = await new Orchestrator({ root, config: config(), provider: healthy }).resume(first.state.id);
  assert.equal(second.state.status, 'approved');
  assert.deepEqual(roles(healthy), ['qa', 'security', 'reviewer']);
  assert.equal(RunStore.load(root, first.state.id).state.status, 'approved');
});

test('output that violates the contract fails the step', async () => {
  const root = tmpProject();
  const provider = new MockProvider({ pm: [{ title: 'missing everything' }] });
  const out = await new Orchestrator({ root, config: config(), provider }).build('x');
  assert.equal(out.state.status, 'failed');
  assert.match(out.state.error!, /does not match its contract/);
});

test('open questions are asked; unanswered ones fall back to the PM default', async () => {
  const root = tmpProject();
  const questions = [
    { id: 'Q-1', question: 'Include DB status?', proposedDefault: 'yes' },
    { id: 'Q-2', question: 'Auth required?', proposedDefault: 'no' },
  ];
  const provider = new MockProvider({ pm: [spec(questions)], developer: [dev()], qa: [qaPass()], security: [approve()], reviewer: [approve()] });
  const asked: string[] = [];
  const ask = async (q: string) => {
    asked.push(q);
    return q.startsWith('Q-1') ? 'no, keep it minimal' : undefined;
  };
  const out = await new Orchestrator({ root, config: config(), provider, ask }).build('x');

  assert.equal(asked.length, 2);
  assert.deepEqual(
    out.state.answers.map((a) => [a.id, a.answer, a.source]),
    [
      ['Q-1', 'no, keep it minimal', 'user'],
      ['Q-2', 'no', 'default'],
    ],
  );
  assert.match(provider.calls.find((c) => c.role === 'developer')!.prompt, /keep it minimal/);
});

test('quick mode skips PM and security', async () => {
  const root = tmpProject();
  const provider = new MockProvider({ developer: [dev()], qa: [qaPass()], reviewer: [approve()] });
  const out = await new Orchestrator({ root, config: config({ mode: 'quick' }), provider }).build('Add dark mode');
  assert.equal(out.state.status, 'approved');
  assert.deepEqual(roles(provider), ['developer', 'qa', 'reviewer']);
  assert.match(provider.calls[0].prompt, /quick mode[\s\S]*Add dark mode/);
});

test('git: branch + commits per step, and reviewers receive the real diff', async () => {
  const { execFileSync } = await import('node:child_process');
  const root = tmpProject();
  const g = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  g('init', '-q');
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'test');
  g('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(root, 'app.js'), 'export const a = 1;\n');
  g('add', '-A');
  g('commit', '-qm', 'init');

  const provider = new MockProvider({
    pm: [spec()],
    developer: [
      () => {
        fs.writeFileSync(path.join(root, 'app.js'), 'export const a = 1;\nexport const health = () => "ok";\n');
        fs.writeFileSync(path.join(root, 'health.test.js'), '// new test\n');
        return dev();
      },
    ],
    qa: [qaPass()],
    security: [approve()],
    reviewer: [approve()],
  });
  const out = await new Orchestrator({ root, config: config({ git: { branch: true, commit: true } }), provider }).build('Add health check');

  assert.equal(out.state.status, 'approved');
  assert.equal(g('rev-parse', '--abbrev-ref', 'HEAD'), 'ai-team/add-health-check');
  assert.match(g('log', '--format=%s'), /ai-team: implement add-health-check/);
  const reviewPrompt = provider.calls.find((c) => c.role === 'reviewer')!.prompt;
  assert.match(reviewPrompt, /Actual diff since the run started/);
  assert.match(reviewPrompt, /\+export const health/);
  assert.match(reviewPrompt, /health\.test\.js/);
  assert.doesNotMatch(reviewPrompt, /\.ai-team\/runs/);
});
