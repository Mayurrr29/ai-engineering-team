import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runCheck } from '../src/checks.js';
import { detectChecks, loadConfig } from '../src/config.js';
import { initProject } from '../src/init.js';
import { slugify } from '../src/paths.js';
import { evaluateRelease } from '../src/release.js';
import { toJsonSchema, QaOutput } from '../src/schemas.js';
import { newRunState } from '../src/state.js';
import { approve, dev, qaPass, spec, tmpProject } from './helpers.js';

test('release gate rejects verdicts made against older code', () => {
  const state = newRunState('x', 'standard', 5);
  state.spec = spec();
  state.implementation = dev();
  state.codeVersion = 2;
  state.checks = { results: [], codeVersion: 2 };
  state.qa = { ...qaPass(), codeVersion: 1 };
  state.security = { ...approve(), codeVersion: 2 };
  state.review = { ...approve(), codeVersion: 2 };
  const decision = evaluateRelease(state, { securityEnabled: true, checksConfigured: true });
  assert.equal(decision.approved, false);
  assert.deepEqual(decision.reasons, ['QA: did not test the latest code']);

  state.qa.codeVersion = 2;
  assert.equal(evaluateRelease(state, { securityEnabled: true, checksConfigured: true }).approved, true);
});

test('release gate requires every stage', () => {
  const decision = evaluateRelease(newRunState('x', 'standard', 5), { securityEnabled: true, checksConfigured: true });
  assert.equal(decision.approved, false);
  assert.deepEqual(
    decision.lines.filter((l) => l.status === 'FAIL').map((l) => l.label),
    ['Requirements', 'Implementation', 'Checks', 'QA', 'Security', 'Code Review'],
  );
});

test('init scaffolds files, detects checks, and never overwrites without --force', () => {
  const root = tmpProject();
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ scripts: { lint: 'eslint .', test: 'echo "Error: no test specified" && exit 1', build: 'tsc' } }),
  );
  fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), '');
  const first = initProject(root);
  assert.ok(first.created.some((f) => f.endsWith('reviewer.md')));
  const config = loadConfig(root);
  assert.deepEqual(config.checks, [
    { name: 'lint', command: 'pnpm run lint' },
    { name: 'build', command: 'pnpm run build' },
  ]);

  fs.writeFileSync(path.join(root, '.ai-team/rules.md'), 'custom');
  const second = initProject(root);
  assert.equal(second.created.length, 0);
  assert.equal(fs.readFileSync(path.join(root, '.ai-team/rules.md'), 'utf8'), 'custom');
});

test('detectChecks returns nothing without package.json', () => {
  assert.deepEqual(detectChecks(tmpProject()), []);
});

test('invalid config gives a readable error', () => {
  const root = tmpProject();
  initProject(root);
  fs.writeFileSync(path.join(root, '.ai-team/config.json'), JSON.stringify({ mode: 'yolo' }));
  assert.throws(() => loadConfig(root), /Invalid .*config\.json[\s\S]*mode/);
});

test('runCheck captures pass, fail and timeout', async () => {
  const cwd = tmpProject();
  const pass = await runCheck({ name: 'ok', command: 'node -e "console.log(42)"' }, cwd, 30);
  assert.equal(pass.passed, true);
  assert.match(pass.output, /42/);
  const failed = await runCheck({ name: 'bad', command: 'node -e "console.error(\'boom\'); process.exit(3)"' }, cwd, 30);
  assert.equal(failed.passed, false);
  assert.equal(failed.exitCode, 3);
  assert.match(failed.output, /boom/);
  const slow = await runCheck({ name: 'slow', command: 'node -e "setTimeout(()=>{}, 60000)"' }, cwd, 1);
  assert.equal(slow.passed, false);
  assert.equal(slow.timedOut, true);
});

test('schemas convert to JSON Schema for structured output', () => {
  const schema = toJsonSchema(QaOutput) as { type: string; required: string[] };
  assert.equal(schema.type, 'object');
  assert.deepEqual(schema.required.sort(), ['bugs', 'scenarios', 'status', 'summary']);
});

test('slugify', () => {
  assert.equal(slugify('Add Google login (OAuth 2.0)!'), 'add-google-login-oauth-2-0');
  assert.equal(slugify('🚀'), 'feature');
});
