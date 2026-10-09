import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { classifyChecks, runCheck, type CheckResult } from '../src/checks.js';
import { Config, detectChecks, loadConfig } from '../src/config.js';
import { diffGuardrails, planGuardrails, type DiffMetrics } from '../src/guardrails.js';
import { initProject } from '../src/init.js';
import { detectPacks, packGuidance, parsePack } from '../src/packs.js';
import { paths, slugify } from '../src/paths.js';
import { checkWrite } from '../src/providers/types.js';
import { evaluateRelease } from '../src/release.js';
import { renderReport } from '../src/report/html.js';
import { applyRuleUpdates, learnedRules, setProjectRules } from '../src/rules.js';
import { scanDiff } from '../src/scans.js';
import { QaOutput, toJsonSchema } from '../src/schemas.js';
import { newRunState } from '../src/state.js';
import { fillNames, nameOf } from '../src/team.js';
import { truncate, width } from '../src/ui/format.js';
import { approve, dev, plan, qaFail, qaPass, spec, teamPlan, tmpProject } from './helpers.js';

const defaults = Config.parse({});
const metrics = (files: Array<{ path: string; lines?: string[]; added?: number }>, measured = true): DiffMetrics => ({
  files: files.map((f) => ({ path: f.path, added: f.added ?? f.lines?.length ?? 1, deleted: 0, untracked: false, addedLines: f.lines ?? [] })),
  changedLines: files.reduce((s, f) => s + (f.added ?? f.lines?.length ?? 1), 0),
  measured,
});

// ── HAL 9000 ──────────────────────────────────────────────────────────────

test('HAL rejects verdicts made against older code', () => {
  const state = newRunState('x', 'auto', 5);
  state.plan = teamPlan();
  state.lineup = { pm: 'full', architect: 'off', qa: 'full', security: 'light', reviewer: 'full' };
  state.spec = spec();
  state.implementation = dev();
  state.codeVersion = 2;
  state.checks = { results: [], blocking: [], preexisting: [], codeVersion: 2 };
  state.qa = { ...qaPass(), codeVersion: 1 };
  state.security = { ...approve(), codeVersion: 2 };
  state.review = { ...approve(), codeVersion: 2 };
  const decision = evaluateRelease(state, { checksConfigured: true, humanName: 'Mayur' });
  assert.equal(decision.approved, false);
  assert.deepEqual(decision.reasons, ['QA: did not test the latest code']);
  assert.match(decision.verdict, /I'm sorry, Mayur\. I'm afraid I can't merge that\./);

  state.qa.codeVersion = 2;
  const ok = evaluateRelease(state, { checksConfigured: true, humanName: 'Mayur' });
  assert.equal(ok.approved, true);
  assert.match(ok.verdict, /Affirmative, Mayur/);
});

test('HAL skips stages JARVIS did not staff, and counts waivers', () => {
  const state = newRunState('x', 'auto', 5);
  state.plan = plan();
  state.implementation = dev();
  state.codeVersion = 1;
  state.checks = { results: [], blocking: [], preexisting: [], codeVersion: 1 };
  let decision = evaluateRelease(state, { checksConfigured: true });
  assert.equal(decision.approved, true);
  assert.deepEqual(decision.lines.filter((l) => l.status === 'SKIPPED').map((l) => l.label), ['Requirements', 'Design', 'QA', 'Security', 'Code review']);

  state.lineup.qa = 'light';
  state.qa = { ...qaFail('BUG-001', 'MEDIUM'), codeVersion: 1 };
  decision = evaluateRelease(state, { checksConfigured: true });
  assert.equal(decision.approved, false);
  state.waivers.push({ id: 'BUG-001', severity: 'MEDIUM', title: 't', reason: 'out of scope', by: 'lead' });
  decision = evaluateRelease(state, { checksConfigured: true });
  assert.equal(decision.approved, true);
  assert.match(decision.lines.find((l) => l.label === 'QA')!.detail!, /1 waived: BUG-001/);
});

// ── Guardrails ────────────────────────────────────────────────────────────

test('plan guardrails make the lineup consistent with JARVIS’s own size and risk', () => {
  const big = planGuardrails(plan({ size: 'L', risk: 'high', riskAreas: ['payments'] }));
  assert.deepEqual(big.lineup, { pm: 'full', architect: 'off', qa: 'full', security: 'full', reviewer: 'full' });
  assert.ok(big.upgrades.length >= 4);
  const tiny = planGuardrails(plan());
  assert.equal(tiny.upgrades.length, 0);
});

test('diff guardrails: size, sensitive paths, sensitive APIs and dependency changes', () => {
  const solo = plan().lineup;
  const cfg = defaults.guardrails;
  assert.equal(diffGuardrails(solo, metrics([{ path: 'src/errors.js', added: 2 }]), cfg).upgrades.length, 0);
  assert.equal(diffGuardrails(solo, metrics([{ path: 'src/a.js', added: 80 }]), cfg).lineup.reviewer, 'light');
  const auth = diffGuardrails(solo, metrics([{ path: 'src/middleware/auth.js', added: 3 }]), cfg);
  assert.equal(auth.lineup.security, 'light');
  assert.equal(auth.lineup.reviewer, 'light');
  const apis = diffGuardrails(solo, metrics([{ path: 'src/search.js', lines: ['const re = new RegExp(req.query.q);'] }]), cfg);
  assert.equal(apis.lineup.security, 'light');
  const deps = diffGuardrails(solo, metrics([{ path: 'package.json', lines: ['    "left-pad": "^1.3.0",'] }]), cfg);
  assert.match(deps.upgrades[0].reason, /dependencies changed/);
  assert.equal(diffGuardrails(solo, metrics([{ path: 'test/auth.test.js', lines: ['password: "x"'] }]), cfg).upgrades.length, 0, 'tests alone do not trigger');
  assert.equal(diffGuardrails(solo, metrics([{ path: 'README.md', added: 500 }]), cfg).upgrades.length, 0, 'docs alone do not trigger');
});

// ── Scans ─────────────────────────────────────────────────────────────────

test('scan finds secrets, injection and mass assignment in added lines, not in tests', () => {
  const leads = scanDiff(
    metrics([
      {
        path: 'src/routes/users.js',
        lines: [
          "const API_KEY = 'sk_live_51HxQabcdefghijklmnop';",
          'await db.users.updateOne({ id }, { $set: req.body });',
          'const users = await db.users.find(req.query);',
          "const re = new RegExp(req.query.search, 'i');",
          'console.log(user);',
        ],
      },
      { path: 'test/users.test.js', lines: ["const password = 'hunter2hunter2';"] },
    ]),
  );
  const rules = leads.map((l) => l.rule);
  for (const r of ['secret-literal', 'mass-assignment', 'nosql-raw-input', 'regex-user-input', 'debug-log']) assert.ok(rules.includes(r), `expected ${r} in ${rules.join(', ')}`);
  assert.ok(!leads.some((l) => l.file.startsWith('test/') && l.rule === 'secret-literal'), 'plain secrets in tests are ignored');
});

// ── Checks ────────────────────────────────────────────────────────────────

test('classifyChecks separates new failures from pre-existing ones', () => {
  const r = (name: string, passed: boolean, output = ''): CheckResult => ({ name, command: name, passed, exitCode: passed ? 0 : 1, durationMs: 1, timedOut: false, output });
  const baseline = [r('lint', false), r('test', false, '# fail 2'), r('build', true)];
  assert.deepEqual(classifyChecks([r('lint', false), r('test', false, '# fail 2'), r('build', true)], baseline), { blocking: [], preexisting: ['lint', 'test'] });
  assert.deepEqual(classifyChecks([r('lint', false), r('test', false, '# fail 5'), r('build', false)], baseline), { blocking: ['test', 'build'], preexisting: ['lint'] });
});

test('runCheck captures pass, fail and timeout', async () => {
  const cwd = tmpProject();
  const pass = await runCheck({ name: 'ok', command: 'node -e "console.log(42)"' }, cwd, 30);
  assert.equal(pass.passed, true);
  assert.match(pass.output, /42/);
  const failed = await runCheck({ name: 'bad', command: 'node -e "console.error(\'boom\'); process.exit(3)"' }, cwd, 30);
  assert.equal(failed.exitCode, 3);
  const slow = await runCheck({ name: 'slow', command: 'node -e "setTimeout(()=>{}, 60000)"' }, cwd, 1);
  assert.equal(slow.timedOut, true);
});

// ── Rulebook, packs, names ────────────────────────────────────────────────

test('rulebook: project rules section and learned rules (add, dedupe, update, remove, cap)', () => {
  const root = tmpProject();
  initProject(root);
  setProjectRules(root, [{ rule: 'Use validate()', why: 'drops unknown fields', evidence: 'src/validate.js:1' }]);
  assert.match(fs.readFileSync(paths(root).rules, 'utf8'), /1\. Use validate\(\) — _drops unknown fields \(src\/validate\.js:1\)_/);

  let applied = applyRuleUpdates(root, [
    { action: 'add', id: '', rule: 'Rule A', reason: 'r' },
    { action: 'add', id: '', rule: 'rule  a', reason: 'duplicate' },
    { action: 'add', id: '', rule: 'Rule B', reason: 'r' },
  ], 'run-1', 40);
  assert.deepEqual(applied.map((a) => a.id), ['L-001', 'L-002']);
  applied = applyRuleUpdates(root, [{ action: 'update', id: 'L-001', rule: 'Rule A (refined)', reason: 'r' }, { action: 'remove', id: 'L-002', rule: '', reason: 'wrong' }], 'run-2', 40);
  assert.deepEqual(learnedRules(root).map((r) => [r.id, r.text]), [['L-001', 'Rule A (refined)']]);
  applyRuleUpdates(root, [{ action: 'add', id: '', rule: 'Rule C', reason: 'r' }, { action: 'add', id: '', rule: 'Rule D', reason: 'r' }], 'run-3', 2);
  assert.deepEqual(learnedRules(root).map((r) => r.id), ['L-003', 'L-004'], 'removed ids are never reused');
});

test('stack packs: detection from dependencies and per-member sections', () => {
  const root = tmpProject();
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { express: '^5', mongoose: '^8', react: '^19' }, devDependencies: { prisma: '^6' } }));
  assert.deepEqual(detectPacks(root).sort(), ['express', 'mongodb', 'react', 'sql']);
  const security = packGuidance(['mongodb'], 'security');
  assert.match(security, /Operator injection/, '@all section is included');
  assert.match(security, /\$where/, '@security section is included');
  assert.doesNotMatch(packGuidance(['mongodb'], 'pm'), /\$where/);
  assert.equal(parsePack('---\nid: x\ntitle: X\n---\n## @qa\n- a\n').sections.get('qa')?.trim(), '- a');
});

test('team names: defaults, overrides and placeholders', () => {
  assert.equal(nameOf('lead'), 'JARVIS');
  assert.equal(nameOf('developer', { developer: 'Chitti' }), 'Chitti');
  assert.equal(fillNames('{{lead}} briefs {{developer}}; {{gate}} decides', { developer: 'Chitti' }), 'JARVIS briefs Chitti; HAL 9000 decides');
});

// ── Permissions ───────────────────────────────────────────────────────────

test('write limits are enforced by code, per role', () => {
  const root = tmpProject();
  const lab = path.join(root, '.ai-team', 'runs', 'm1', 'qa-lab-1');
  assert.equal(checkWrite('src/a.js', { read: true, run: true, write: 'repo' }, root).allowed, true);
  assert.equal(checkWrite('.ai-team/rules.md', { read: true, run: true, write: 'repo' }, root).allowed, false);
  assert.equal(checkWrite('../outside.js', { read: true, run: true, write: 'repo' }, root).allowed, false);
  assert.equal(checkWrite(path.join(lab, 'probe.mjs'), { read: true, run: true, write: 'lab', labDir: lab }, root).allowed, true);
  assert.equal(checkWrite('src/a.js', { read: true, run: true, write: 'lab', labDir: lab }, root).allowed, false);
  assert.equal(checkWrite('src/a.js', { read: true, run: false, write: 'none' }, root).allowed, false);
});

// ── Config & init ─────────────────────────────────────────────────────────

test('init scaffolds config and rulebook, detects checks, never overwrites without --force', () => {
  const root = tmpProject();
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint .', test: 'echo "Error: no test specified" && exit 1', build: 'tsc' } }));
  fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), '');
  const first = initProject(root);
  assert.ok(first.created.some((f) => f.endsWith('rules.md')));
  const config = loadConfig(root);
  assert.equal(config.mode, 'auto');
  assert.deepEqual(config.checks, [
    { name: 'lint', command: 'pnpm run lint' },
    { name: 'build', command: 'pnpm run build' },
  ]);
  assert.match(fs.readFileSync(paths(root).rules, 'utf8'), /TARS and EDITH enforce it/);
  fs.writeFileSync(paths(root).rules, 'custom');
  assert.equal(initProject(root).created.length, 0);
  assert.equal(fs.readFileSync(paths(root).rules, 'utf8'), 'custom');
});

test('config: v0.1 "standard" mode maps to "full"; invalid config is readable', () => {
  assert.equal(Config.parse({ mode: 'standard' }).mode, 'full');
  const root = tmpProject();
  initProject(root);
  fs.writeFileSync(paths(root).config, JSON.stringify({ mode: 'yolo' }));
  assert.throws(() => loadConfig(root), /Invalid .*config\.json[\s\S]*mode/);
  assert.deepEqual(detectChecks(tmpProject()), []);
});

// ── Output ────────────────────────────────────────────────────────────────

test('terminal width handles emoji and truncation', () => {
  assert.equal(width('🧠 JARVIS'), 9);
  assert.equal(width('\x1b[36mabc\x1b[39m'), 3);
  assert.equal(width(truncate('🦾 FRIDAY is building a very long thing', 12)), 12);
});

test('the HTML report renders a running mission and escapes agent text', () => {
  const state = newRunState('Add <script>alert(1)</script> search', 'auto', 5);
  state.plan = teamPlan({}, { missionName: 'Search <b>' });
  state.lineup = state.plan.lineup;
  const html = renderReport(state, { names: {}, checksConfigured: true });
  assert.match(html, /IN PROGRESS/);
  assert.match(html, /http-equiv="refresh"/);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('Search &lt;b&gt;'));
  assert.match(html, /prefers-color-scheme:dark/);
});

test('schemas convert to JSON Schema for structured output', () => {
  const schema = toJsonSchema(QaOutput) as { type: string; required: string[] };
  assert.equal(schema.type, 'object');
  assert.deepEqual(schema.required.sort(), ['bugs', 'criteria', 'scenarios', 'status', 'summary']);
});

test('slugify', () => {
  assert.equal(slugify('Add Google login (OAuth 2.0)!'), 'add-google-login-oauth-2-0');
  assert.equal(slugify('🚀'), 'feature');
});

test('scan flags regular expressions applied to request data (ReDoS lead)', () => {
  const leads = scanDiff(metrics([{ path: 'src/routes/users.js', lines: ['    email: { type: "string", maxLength: 254, pattern: EMAIL_PATTERN },'] }]));
  assert.ok(leads.some((l) => l.rule === 'regex-on-input' && /CWE-1333/.test(l.standard)));
});
