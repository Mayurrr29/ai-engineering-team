import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { initProject } from '../src/init.js';
import { Orchestrator } from '../src/orchestrator.js';
import { MockProvider } from '../src/providers/mock.js';
import { changedBetween, snapshotTree } from '../src/git.js';
import { approve, config, design, dev, fix, gitProject, plan, qaFail, qaPass, reject, ruling, teamPlan } from './helpers.js';
import type { Signal } from '../src/schemas.js';

const roles = (p: MockProvider) => p.calls.map((c) => c.role);

// ── Release gate: a successful agent response is not proof of a successful task ──

test('gate: a developer who reports an acceptance criterion as not done cannot be approved', async () => {
  const { root } = gitProject();
  initProject(root);
  const partial = () => {
    fs.writeFileSync(path.join(root, 'src/app.js'), 'export const a = 2;\n');
    return { ...dev(), criteriaCoverage: [{ id: 'AC-1', status: 'PARTIAL' as const, tests: [], notes: 'Validation missing' }] };
  };
  // JARVIS can't waive an unfinished acceptance criterion (HIGH): it goes to the human, who isn't there.
  const provider = new MockProvider({ lead: [plan(), ruling([{ id: 'AC-1', ruling: 'waive', reason: 'good enough', guidance: '' }])], developer: [partial] });
  const out = await new Orchestrator({ root, config: config({ maxIterations: 1 }), provider }).build('Change a constant');

  assert.deepEqual(roles(provider), ['lead', 'developer', 'developer', 'lead'], 'sent back before any review; disputed twice → ruling');
  assert.match(provider.calls[2].prompt, /AC-1 was reported partial/);
  assert.equal(out.state.status, 'rejected');
  assert.ok(out.decision?.reasons.some((r) => /Completeness: AC-1/.test(r)), out.decision?.reasons.join('; '));
});

test('gate: an implementation mission that changed no code is not approved', async () => {
  const { root } = gitProject();
  initProject(root);
  const provider = new MockProvider({ lead: [plan(), ruling([{ id: 'NO-CHANGE', ruling: 'fix', reason: 'The message is still the old one', guidance: 'Edit src/errors.js' }])], developer: [dev()] });
  const out = await new Orchestrator({ root, config: config({ maxIterations: 1 }), provider }).build('Change the 404 message');

  assert.equal(out.state.status, 'rejected');
  assert.ok(out.decision?.reasons.some((r) => /NO-CHANGE: No code changed/.test(r)), out.decision?.reasons.join('; '));
});

test('gate: when the team lead accepts the evidence that nothing needed changing, the waiver is recorded', async () => {
  const { root } = gitProject();
  initProject(root);
  const provider = new MockProvider({
    lead: [plan(), ruling([{ id: 'NO-CHANGE', ruling: 'waive', reason: 'src/errors.js already returns the requested message', guidance: '' }])],
    developer: [{ ...dev(), criteriaCoverage: [{ id: 'AC-1', status: 'DONE' as const, tests: [], notes: '' }] }],
  });
  const out = await new Orchestrator({ root, config: config(), provider }).build('Make sure the 404 message says "Resource not found"');

  assert.equal(out.state.status, 'approved');
  assert.ok(out.state.waivers.some((w) => w.id === 'NO-CHANGE' && w.by === 'lead'));
});

test('gate: files a read-only member changed (e.g. through Bash) are restored, and the gate records it', async () => {
  const { root } = gitProject({ 'src/app.js': 'export const a = 1;\n', 'src/keep.js': 'export const k = 1;\n' });
  initProject(root);
  const provider = new MockProvider({
    lead: [plan({ size: 'S', lineup: { pm: 'off', architect: 'off', qa: 'light', security: 'off', reviewer: 'off' } })],
    developer: [
      () => {
        fs.writeFileSync(path.join(root, 'src/app.js'), 'export const a = 2;\n');
        return dev('changed a', ['src/app.js']);
      },
    ],
    qa: [
      () => {
        // A read-only member "fixing" things through the shell: edits the developer's file, another file, and adds one.
        fs.writeFileSync(path.join(root, 'src/app.js'), 'export const a = 999;\n');
        fs.writeFileSync(path.join(root, 'src/keep.js'), 'export const k = 999;\n');
        fs.writeFileSync(path.join(root, 'src/qa-tmp.js'), 'scratch\n');
        return qaPass();
      },
    ],
  });
  const out = await new Orchestrator({ root, config: config(), provider }).build('Change a');

  assert.equal(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), 'export const a = 2;\n', "the developer's version is back");
  assert.equal(fs.readFileSync(path.join(root, 'src/keep.js'), 'utf8'), 'export const k = 1;\n');
  assert.equal(fs.existsSync(path.join(root, 'src/qa-tmp.js')), false);
  assert.ok(out.state.integrity.some((n) => /EVE.*restored/i.test(n)), out.state.integrity.join('; '));
});

test('gate: a planned frontend surface with no frontend change is sent back, not silently dropped', async () => {
  const { root } = gitProject({ 'src/api/users.js': 'export const u = 1;\n', 'web/src/Profile.tsx': 'export const P = () => null;\n' });
  initProject(root);
  let devCalls = 0;
  const provider = new MockProvider({
    lead: [plan({ size: 'S', surfaces: ['backend', 'frontend'] })],
    developer: [
      () => {
        devCalls += 1;
        if (devCalls === 1) {
          fs.writeFileSync(path.join(root, 'src/api/users.js'), 'export const u = 2;\n');
          return dev('API only', ['src/api/users.js']);
        }
        fs.writeFileSync(path.join(root, 'web/src/Profile.tsx'), 'export const P = () => "profile";\n');
        return dev('Added the UI', ['web/src/Profile.tsx']);
      },
    ],
  });
  const out = await new Orchestrator({ root, config: config(), provider }).build('Let users edit their display name on the profile page');

  assert.equal(devCalls, 2, 'the missing UI work goes back to the developer');
  assert.match(provider.calls.filter((c) => c.role === 'developer')[1].prompt, /frontend/i);
  assert.equal(out.state.status, 'approved');
});

test('snapshots see a same-size edit made in the same second as the index (racy git)', () => {
  const { root, git } = gitProject({ 'a.txt': 'one\n' });
  git('status'); // refreshes the index right now
  const before = snapshotTree(root)!;
  fs.writeFileSync(path.join(root, 'a.txt'), 'two\n');
  const after = snapshotTree(root)!;
  assert.deepEqual(changedBetween(root, before, after), [{ status: 'modified', path: 'a.txt' }]);
  assert.equal(git('status', '--porcelain'), 'M a.txt', "the user's index is untouched");
});

// ── Intent routing: not every request is a build ──

test('a question is answered by one read-only call: no developer, no code gate', async () => {
  const root = gitProject().root;
  initProject(root);
  const provider = new MockProvider({
    lead: [plan({ taskType: 'question', size: 'XS' })],
    architect: [{ answer: 'Auth lives in src/auth.js: requireAuth reads the Bearer token.', evidence: ['src/auth.js:4'], followUps: [] }],
  });
  const out = await new Orchestrator({ root, config: config(), provider }).build('How does authentication work here?');

  assert.deepEqual(roles(provider), ['lead', 'architect']);
  assert.equal(provider.calls[1].access.write, 'none');
  assert.equal(out.state.status, 'answered');
  assert.match(out.state.answer?.answer ?? '', /requireAuth/);
});

test('a clean small team mission ends without an extra AI debrief call', async () => {
  const { root } = gitProject();
  initProject(root);
  const provider = new MockProvider({
    lead: [plan({ size: 'S', lineup: { pm: 'off', architect: 'off', qa: 'off', security: 'off', reviewer: 'light' } })],
    developer: [
      () => {
        fs.writeFileSync(path.join(root, 'src/app.js'), 'export const a = 2;\n');
        return dev('changed a', ['src/app.js']);
      },
    ],
    reviewer: [approve()],
  });
  const out = await new Orchestrator({ root, config: config(), provider }).build('Change a');
  assert.equal(out.state.status, 'approved');
  assert.deepEqual(roles(provider), ['lead', 'developer', 'reviewer']);
});

test('JARVIS answers a question his triage already settled: one call in total', async () => {
  const root = gitProject().root;
  initProject(root);
  const provider = new MockProvider({ lead: [plan({ taskType: 'question', answer: 'Requests are authenticated in src/auth.js:4 (requireAuth).' })] });
  const out = await new Orchestrator({ root, config: config(), provider }).build('Where are requests authenticated?');

  assert.deepEqual(roles(provider), ['lead']);
  assert.equal(out.state.status, 'answered');
  assert.equal(out.decision, undefined, 'no release gate for an answer');
  assert.ok(fs.readdirSync(out.dir).some((f) => f.endsWith('answer.md')));
});

test('planning mission: the architect writes a plan with milestones; nothing is built', async () => {
  const root = gitProject().root;
  initProject(root);
  const milestones = [{ name: 'Schema', deliverables: ['coupons collection'], acceptance: ['migrations run'], dependsOn: [] }];
  const provider = new MockProvider({ lead: [plan({ taskType: 'planning', size: 'L' })], architect: [{ ...design(), milestones }] });
  const out = await new Orchestrator({ root, config: config(), provider }).build('Plan how we would add multi-currency pricing');

  assert.deepEqual(roles(provider), ['lead', 'architect']);
  assert.match(provider.calls[1].prompt, /Mode: planning/);
  assert.equal(out.state.status, 'planned');
  const planFile = fs.readdirSync(out.dir).find((f) => f.endsWith('design.md'))!;
  assert.match(fs.readFileSync(path.join(out.dir, planFile), 'utf8'), /## Milestones[\s\S]*Schema/);
});

test('fixes: the developer fixes QA findings in her own session; after a ruling with new guidance, BAYMAX takes over', async () => {
  const { root } = gitProject();
  initProject(root);
  let n = 1; // the committed file says a = 1
  const change = () => fs.writeFileSync(path.join(root, 'src/app.js'), `export const a = ${++n};\n`);
  const provider = new MockProvider({
    lead: [plan({ size: 'S', lineup: { pm: 'off', architect: 'off', qa: 'light', security: 'off', reviewer: 'off' } }), ruling([{ id: 'BUG-001', ruling: 'fix', reason: 'Still broken', guidance: 'Ping the DB with a timeout instead' }])],
    developer: [() => (change(), dev('first', ['src/app.js'])), () => (change(), fix())],
    bugFixer: [() => (change(), fix())],
    qa: [qaFail(), qaFail(), qaPass()],
  });
  const out = await new Orchestrator({ root, config: config(), provider }).build('Health check');

  assert.equal(out.state.status, 'approved', out.state.error);
  assert.deepEqual(roles(provider), ['lead', 'developer', 'qa', 'developer', 'qa', 'lead', 'bugFixer', 'qa', 'lead']);
  const [build, inSession] = provider.calls.filter((c) => c.role === 'developer');
  assert.equal(build.resumeSessionId, undefined);
  assert.equal(inSession.resumeSessionId, 'mock-developer-2', 'continues her own session');
  assert.doesNotMatch(inSession.prompt, /Approved specification|Request \(no separate spec/, 'no need to resend what she already has');
  assert.match(provider.calls.find((c) => c.role === 'bugFixer')!.prompt, /Ping the DB with a timeout/);
});

test('re-reviews get only the change since the reviewer last looked', async () => {
  const { root } = gitProject();
  initProject(root);
  const provider = new MockProvider({
    lead: [plan({ size: 'S', lineup: { pm: 'off', architect: 'off', qa: 'off', security: 'off', reviewer: 'light' } }), ruling([])],
    developer: [
      () => (fs.writeFileSync(path.join(root, 'src/app.js'), 'export const a = 2;\nexport const first = true;\n'), dev('first', ['src/app.js'])),
      () => (fs.writeFileSync(path.join(root, 'src/app.js'), 'export const a = 2;\nexport const first = true;\nexport const second = true;\n'), dev('second', ['src/app.js'])),
    ],
    reviewer: [reject(), approve()],
  });
  const out = await new Orchestrator({ root, config: config(), provider }).build('Change a');

  assert.equal(out.state.status, 'approved');
  const [first, second] = provider.calls.filter((c) => c.role === 'reviewer');
  assert.match(first.prompt, /\+export const first = true/);
  assert.match(second.prompt, /What changed since you last looked \(revision 1 → 2\)/);
  assert.match(second.prompt, /\+export const second = true/);
  assert.doesNotMatch(second.prompt, /\+export const first = true/, 'the part already reviewed is not resent');
});

const signal = (s: Partial<Signal>): Signal => ({ kind: 'concern', to: 'team', summary: '', evidence: '', member: '', proposedDefault: '', ...s });

test('signals: a recruit request adds a reviewer; an assumption reaches the reviewer, not the human', async () => {
  const { root } = gitProject();
  initProject(root);
  const provider = new MockProvider({
    lead: [plan()],
    developer: [
      () => {
        fs.writeFileSync(path.join(root, 'src/app.js'), 'export const a = 2;\n');
        return {
          ...dev('changed', ['src/app.js']),
          signals: [
            signal({ kind: 'recruit', to: 'lead', member: 'security', summary: 'This touches how tokens are compared', evidence: 'src/app.js:1' }),
            signal({ kind: 'assumption', to: 'team', summary: 'Empty names are rejected with 400', evidence: 'spec is silent' }),
          ],
        };
      },
    ],
    security: [approve()],
  });
  const asked: string[] = [];
  const out = await new Orchestrator({ root, config: config(), provider, ask: async (q) => (asked.push(q), undefined) }).build('Change a');

  assert.equal(out.state.status, 'approved');
  assert.deepEqual(roles(provider), ['lead', 'developer', 'security']);
  assert.ok(out.state.upgrades.some((u) => u.member === 'security' && /requested by FRIDAY/.test(u.reason)));
  assert.match(provider.calls[2].prompt, /Assumption from FRIDAY[\s\S]*Empty names are rejected/);
  assert.deepEqual(asked, [], 'assumptions are not questions');
});

test('signals: a question for the human is asked once; an answer that differs from the default sends the work back', async () => {
  const { root } = gitProject();
  initProject(root);
  let n = 1; // the committed file says a = 1
  const provider = new MockProvider({
    lead: [plan()],
    developer: [
      () => {
        fs.writeFileSync(path.join(root, 'src/app.js'), `export const a = ${++n};\n`);
        return { ...dev('built', ['src/app.js']), signals: [signal({ kind: 'question', to: 'human', summary: 'Should archived courses still be listed?', proposedDefault: 'no' })] };
      },
      () => {
        fs.writeFileSync(path.join(root, 'src/app.js'), `export const a = ${++n};\n`);
        return { ...dev('applied the decision', ['src/app.js']), criteriaCoverage: [{ id: 'SIG-1', status: 'DONE' as const, tests: ['list.test.js'], notes: '' }] };
      },
    ],
  });
  const asked: string[] = [];
  const out = await new Orchestrator({ root, config: config(), provider, ask: async (q) => (asked.push(q), 'yes, greyed out') }).build('List courses');

  assert.equal(asked.length, 1);
  assert.equal(out.state.status, 'approved');
  assert.deepEqual(roles(provider), ['lead', 'developer', 'developer']);
  assert.match(provider.calls[2].prompt, /SIG-1[\s\S]*yes, greyed out/);
});

test('signals: a blocker goes to the team lead, who can unblock it with guidance', async () => {
  const { root } = gitProject();
  initProject(root);
  let n = 1; // the committed file says a = 1
  const provider = new MockProvider({
    lead: [plan(), ruling([{ id: 'BLOCK-1', ruling: 'fix', reason: 'Use the existing helper', guidance: 'Use HttpError from src/errors.js' }])],
    developer: [
      () => {
        fs.writeFileSync(path.join(root, 'src/app.js'), `export const a = ${++n};\n`);
        return { ...dev('half done', ['src/app.js']), signals: [signal({ kind: 'blocker', to: 'lead', summary: 'No error helper exists for 409s', evidence: 'grep found none' })] };
      },
      () => (fs.writeFileSync(path.join(root, 'src/app.js'), `export const a = ${++n};\n`), dev('unblocked', ['src/app.js'])),
    ],
  });
  const out = await new Orchestrator({ root, config: config(), provider }).build('Return 409 on duplicates');

  assert.deepEqual(roles(provider), ['lead', 'developer', 'lead', 'developer']);
  assert.match(provider.calls[3].prompt, /Use HttpError from src\/errors\.js/);
  assert.equal(out.state.status, 'approved');
});

test('bug fixes run in debugging mode, and the gate warns when no test proves the fix', async () => {
  const { root } = gitProject();
  initProject(root);
  const provider = new MockProvider({
    lead: [plan({ taskType: 'bugfix' })],
    developer: [() => (fs.writeFileSync(path.join(root, 'src/app.js'), 'export const a = 2;\n'), { ...dev('fixed', ['src/app.js']), rootCause: 'off-by-one in skip' })],
  });
  const out = await new Orchestrator({ root, config: config(), provider }).build('Page 1 skips the oldest orders');

  assert.match(provider.calls[1].prompt, /Mode: debugging[\s\S]*Reproduce it first/);
  assert.equal(out.state.status, 'approved');
  assert.ok(out.decision?.lines.some((l) => l.label === 'Regression test' && l.status === 'WARN'));
});

test('a reviewer who asks for QA mid-review gets it, and an approval that still stands is not re-run', async () => {
  const { root } = gitProject();
  initProject(root);
  const provider = new MockProvider({
    lead: [plan({ size: 'S', lineup: { pm: 'off', architect: 'off', qa: 'off', security: 'light', reviewer: 'light' } })],
    developer: [() => (fs.writeFileSync(path.join(root, 'src/app.js'), 'export const a = 2;\n'), dev('changed', ['src/app.js']))],
    security: [approve()],
    reviewer: [{ ...approve(), signals: [signal({ kind: 'recruit', to: 'lead', member: 'qa', summary: 'Nobody exercised the new error path', evidence: 'src/app.js:1' })] }],
    qa: [qaPass()],
  });
  const out = await new Orchestrator({ root, config: config(), provider }).build('Change a');

  assert.equal(out.state.status, 'approved', out.decision?.reasons.join('; '));
  assert.deepEqual(roles(provider), ['lead', 'developer', 'security', 'reviewer', 'qa']);
});

test('the HTML report renders answers and the team ledger', async () => {
  const root = gitProject().root;
  initProject(root);
  const provider = new MockProvider({ lead: [plan({ taskType: 'question', answer: 'It uses **requireAuth**.' })] });
  const out = await new Orchestrator({ root, config: config(), provider }).build('How is auth done?');
  const html = fs.readFileSync(out.reportPath!, 'utf8');
  assert.match(html, /ANSWERED/);
  assert.match(html, /Answer from JARVIS/);
});
