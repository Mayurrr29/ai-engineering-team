import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { initProject } from '../src/init.js';
import { onboard } from '../src/onboarding.js';
import { Orchestrator } from '../src/orchestrator.js';
import { paths } from '../src/paths.js';
import { MockProvider } from '../src/providers/mock.js';
import { AgentError, type AgentRequest } from '../src/providers/types.js';
import { RunStore } from '../src/state.js';
import {
  approve,
  config,
  debrief,
  design,
  dev,
  fix,
  FULL,
  gitProject,
  plan,
  profile,
  qaFail,
  qaPass,
  reject,
  ruling,
  spec,
  teamPlan,
  tmpProject,
} from './helpers.js';

const roles = (p: MockProvider) => p.calls.map((c) => c.role);
const byRole = (p: MockProvider, role: string) => p.calls.filter((c) => c.role === role);

test('XS mission: JARVIS sends FRIDAY solo; checks run; HAL approves; no extra AI calls', async () => {
  const root = tmpProject();
  initProject(root);
  const provider = new MockProvider({ lead: [plan()], developer: [dev()] });
  const out = await new Orchestrator({ root, config: config(), provider }).build('Change the 404 message');

  assert.equal(out.state.status, 'approved');
  assert.deepEqual(roles(provider), ['lead', 'developer']);
  assert.deepEqual(out.state.lineup, { pm: 'off', architect: 'off', qa: 'off', security: 'off', reviewer: 'off' });
  assert.equal(out.state.debrief?.headline.includes('approved'), true, 'solo missions get a deterministic debrief');
  const files = fs.readdirSync(out.dir);
  for (const f of ['request.md', 'state.json', 'report.html', '01-mission-plan.md', '02-implementation.md', '03-checks-v1.md', '04-release.md', '05-debrief.md']) {
    assert.ok(files.includes(f), `missing ${f} in ${files.join(', ')}`);
  }
  assert.equal(byRole(provider, 'developer')[0].access.write, 'repo');
  assert.equal(byRole(provider, 'lead')[0].access.write, 'none');
});

test('M mission with risk: full lineup, briefs reach members, reviews run in parallel, JARVIS debriefs', async () => {
  const root = tmpProject();
  initProject(root);
  const spans: Record<string, [number, number]> = {};
  const slow = (role: string, output: unknown) => async () => {
    const start = Date.now();
    await new Promise((r) => setTimeout(r, 60));
    spans[role] = [start, Date.now()];
    return output;
  };
  const provider = new MockProvider({
    lead: [teamPlan(), debrief()],
    pm: [spec()],
    developer: [dev()],
    qa: [qaPass()],
    security: [slow('security', approve())],
    reviewer: [slow('reviewer', approve())],
  });
  const out = await new Orchestrator({ root, config: config(), provider }).build('Let users update their profile');

  assert.equal(out.state.status, 'approved');
  assert.deepEqual(roles(provider), ['lead', 'pm', 'developer', 'qa', 'security', 'reviewer', 'lead']);
  assert.ok(spans.security[0] < spans.reviewer[1] && spans.reviewer[0] < spans.security[1], 'security and code review overlap in time');
  assert.match(byRole(provider, 'developer')[0].prompt, /Brief from JARVIS[\s\S]*Check ownership on PATCH/);
  assert.match(byRole(provider, 'qa')[0].prompt, /Focus on IDOR/);
  const qa = byRole(provider, 'qa')[0];
  assert.equal(qa.access.write, 'lab');
  assert.ok(qa.access.labDir && qa.access.labDir.startsWith(out.dir));
  assert.equal(byRole(provider, 'security')[0].access.write, 'none');
  assert.equal(out.state.debrief?.headline, 'Health check shipped.');
  const report = fs.readFileSync(out.reportPath!, 'utf8');
  for (const text of ['JARVIS', 'VISION', 'FRIDAY', 'EVE', 'EDITH', 'TARS', 'HAL 9000', 'APPROVED', 'Requirements traceability', 'War room']) assert.ok(report.includes(text), `report should include ${text}`);
});

test('guardrail: a "solo" change that touches auth code brings in EDITH and TARS', async () => {
  const { root } = gitProject();
  initProject(root);
  const provider = new MockProvider({
    lead: [plan(), debrief()],
    developer: [
      () => {
        fs.mkdirSync(path.join(root, 'src/auth'), { recursive: true });
        fs.writeFileSync(path.join(root, 'src/auth/session.js'), "import jwt from 'jsonwebtoken';\nexport const sign = (u) => jwt.sign({ id: u.id }, process.env.SECRET);\n");
        return dev('Session helper', ['src/auth/session.js']);
      },
    ],
    security: [approve()],
    reviewer: [approve()],
  });
  const out = await new Orchestrator({ root, config: config(), provider }).build('Add a session helper');

  assert.equal(out.state.status, 'approved');
  assert.ok(out.state.lineup.security !== 'off' && out.state.lineup.reviewer !== 'off');
  assert.ok(out.state.upgrades.some((u) => u.member === 'security' && /security-sensitive/.test(u.reason)));
  assert.deepEqual(roles(provider), ['lead', 'developer', 'security', 'reviewer', 'lead'], 'no longer solo, so JARVIS writes the debrief');
  assert.match(byRole(provider, 'reviewer')[0].prompt, /\+export const sign/);
});

test('budget: the mission pauses instead of overspending, and resumes with a higher limit', async () => {
  const root = tmpProject();
  initProject(root);
  const script = { lead: [teamPlan(), debrief()], pm: [spec()], developer: [dev()], qa: [qaPass()], security: [approve()], reviewer: [approve()] };
  const first = new MockProvider(script, 0.4);
  const paused = await new Orchestrator({ root, config: config(), provider: first }).build('Profile update', { budgetUsd: 1 });

  assert.equal(paused.state.status, 'paused');
  assert.equal(paused.state.next, 'qa');
  assert.match(paused.state.error!, /Spending limit reached/);
  assert.ok(Math.abs((byRole(first, 'developer')[0].maxBudgetUsd ?? 0) - 0.2) < 1e-9, 'each call is capped at the remaining budget');

  const second = new MockProvider(script, 0.4);
  const resumed = await new Orchestrator({ root, config: config(), provider: second }).resume(paused.state.id, { budgetUsd: 10 });
  assert.equal(resumed.state.status, 'approved');
  assert.deepEqual(roles(second), ['qa', 'security', 'reviewer', 'lead']);
});

test('baseline: failures that existed before the mission are not blamed on the team', async () => {
  const root = tmpProject();
  const checks = [{ name: 'test', command: `node -e "console.log('# fail 1'); process.exit(1)"` }];
  const provider = new MockProvider({ lead: [plan()], developer: [dev()] });
  const out = await new Orchestrator({ root, config: config({ checks, baselineChecks: true }), provider }).build('Tiny change');

  assert.equal(out.state.status, 'approved');
  assert.deepEqual(out.state.checks?.preexisting, ['test']);
  assert.match(byRole(provider, 'developer')[0].prompt, /Already failing before this mission/);
});

test('baseline: more failing tests than before still blocks, and BAYMAX gets called in', async () => {
  const root = tmpProject();
  const checks = [{ name: 'test', command: `node -e "const n=require('fs').existsSync('broken.flag')?3:1;console.log('# fail '+n);process.exit(1)"` }];
  const provider = new MockProvider({
    lead: [plan()],
    developer: [
      () => {
        fs.writeFileSync(path.join(root, 'broken.flag'), '');
        return dev();
      },
    ],
    bugFixer: [
      () => {
        fs.rmSync(path.join(root, 'broken.flag'));
        return fix('CHECK-test');
      },
    ],
  });
  const out = await new Orchestrator({ root, config: config({ checks, baselineChecks: true }), provider }).build('Tiny change');

  assert.equal(out.state.status, 'approved');
  assert.deepEqual(roles(provider), ['lead', 'developer', 'bugFixer']);
  assert.match(byRole(provider, 'bugFixer')[0].prompt, /CHECK-test/);
});

test('QA: low-severity bugs are recorded as follow-ups without a fix round', async () => {
  const root = tmpProject();
  const provider = new MockProvider({ lead: [teamPlan(), debrief()], pm: [spec()], developer: [dev()], qa: [qaFail('BUG-009', 'LOW')], security: [approve()], reviewer: [approve()] });
  const out = await new Orchestrator({ root, config: config(), provider }).build('x');
  assert.equal(out.state.status, 'approved');
  assert.ok(!roles(provider).includes('bugFixer'));
});

test('QA finds a HIGH bug → BAYMAX fixes → EVE re-tests → approved', async () => {
  const root = tmpProject();
  const provider = new MockProvider({ lead: [teamPlan(), debrief()], pm: [spec()], developer: [dev()], qa: [qaFail(), qaPass()], bugFixer: [fix()], security: [approve()], reviewer: [approve()] });
  const out = await new Orchestrator({ root, config: config(), provider }).build('x');

  assert.equal(out.state.status, 'approved');
  assert.deepEqual(roles(provider), ['lead', 'pm', 'developer', 'qa', 'bugFixer', 'qa', 'security', 'reviewer', 'lead']);
  assert.match(byRole(provider, 'qa')[1].prompt, /previous QA round[\s\S]*BUG-001/);
  assert.match(byRole(provider, 'qa')[1].prompt, /re-test round/);
  assert.deepEqual(byRole(provider, 'qa').map((c) => c.effort), ['medium', 'low'], 're-tests run one effort level lower');
  assert.equal(out.state.qaRounds.length, 2);
});

test('arbitration: a recurring MEDIUM bug goes to JARVIS, who can waive it', async () => {
  const root = tmpProject();
  const provider = new MockProvider({
    lead: [teamPlan(), ruling([{ id: 'BUG-001', ruling: 'waive', reason: 'Out of scope for this mission.', guidance: '' }]), debrief()],
    pm: [spec()],
    developer: [dev()],
    qa: [qaFail('BUG-001', 'MEDIUM')],
    bugFixer: [fix()],
    security: [approve()],
    reviewer: [approve()],
  });
  const out = await new Orchestrator({ root, config: config(), provider }).build('x');

  assert.equal(out.state.status, 'approved');
  assert.deepEqual(roles(provider), ['lead', 'pm', 'developer', 'qa', 'bugFixer', 'qa', 'lead', 'security', 'reviewer', 'lead']);
  assert.deepEqual(out.state.waivers.map((w) => [w.id, w.by]), [['BUG-001', 'lead']]);
});

test('arbitration: JARVIS cannot waive a HIGH bug; without a human the team keeps fixing until the round limit', async () => {
  const root = tmpProject();
  const provider = new MockProvider({
    lead: [teamPlan(), ruling([{ id: 'BUG-002', ruling: 'waive', reason: 'Seems fine.', guidance: 'Should we accept this?' }]), debrief()],
    pm: [spec()],
    developer: [dev()],
    qa: [qaFail('BUG-002', 'HIGH')],
    bugFixer: [fix('BUG-002')],
  });
  const out = await new Orchestrator({ root, config: config({ maxIterations: 3 }), provider }).build('x');

  assert.equal(out.state.status, 'rejected');
  assert.equal(out.state.waivers.length, 0);
  assert.equal(byRole(provider, 'bugFixer').length, 3);
  assert.ok(out.state.events.some((e) => e.kind === 'guardrail' && /can't waive BUG-002/.test(e.text)));
});

test('arbitration: escalations ask the human, who can accept the risk', async () => {
  const root = tmpProject();
  const provider = new MockProvider({
    lead: [teamPlan(), ruling([{ id: 'BUG-004', ruling: 'escalate', reason: 'Product decision.', guidance: 'Should admins be allowed to change emails?' }]), debrief()],
    pm: [spec()],
    developer: [dev()],
    qa: [qaFail('BUG-004', 'HIGH')],
    bugFixer: [fix('BUG-004')],
    security: [approve()],
    reviewer: [approve()],
  });
  const asked: string[] = [];
  const ask = async (q: string) => {
    asked.push(q);
    return 'waive';
  };
  const out = await new Orchestrator({ root, config: config(), provider, ask }).build('x');

  assert.equal(out.state.status, 'approved');
  assert.ok(asked.some((q) => /admins be allowed/.test(q)));
  assert.deepEqual(out.state.waivers.map((w) => [w.id, w.by]), [['BUG-004', 'human']]);
});

test('arbitration: a bug the fixer disputes goes to JARVIS on the next report', async () => {
  const root = tmpProject();
  const provider = new MockProvider({
    lead: [teamPlan(), ruling([{ id: 'BUG-003', ruling: 'waive', reason: 'The spec allows this.', guidance: '' }]), debrief()],
    pm: [spec()],
    developer: [dev()],
    qa: [qaFail('BUG-003', 'MEDIUM')],
    bugFixer: [fix('BUG-003', 'NOT_A_BUG')],
    security: [approve()],
    reviewer: [approve()],
  });
  const out = await new Orchestrator({ root, config: config(), provider }).build('x');
  assert.equal(out.state.status, 'approved');
  assert.equal(byRole(provider, 'bugFixer').length, 1);
  assert.equal(out.state.decisions.length, 1);
});

test('review rejection → FRIDAY reworks → QA and reviews run again on the new code', async () => {
  const root = tmpProject();
  const provider = new MockProvider({
    lead: [teamPlan(), debrief()],
    pm: [spec()],
    developer: [dev(), dev('Moved logic to a service')],
    qa: [qaPass()],
    security: [approve()],
    reviewer: [reject(), approve()],
  });
  const out = await new Orchestrator({ root, config: config(), provider }).build('x');

  assert.equal(out.state.status, 'approved');
  assert.deepEqual(roles(provider), ['lead', 'pm', 'developer', 'qa', 'security', 'reviewer', 'developer', 'qa', 'security', 'reviewer', 'lead']);
  assert.match(byRole(provider, 'developer')[1].prompt, /REV-001[\s\S]*rejected by TARS/);
  assert.equal(out.state.review?.codeVersion, 2);
});

test('a reviewer that says APPROVED but reports a HIGH finding is treated as a rejection', async () => {
  const root = tmpProject();
  const provider = new MockProvider({ lead: [teamPlan(), debrief()], pm: [spec()], developer: [dev()], qa: [qaPass()], security: [approve()], reviewer: [reject('REV-001', 'HIGH', 'APPROVED'), approve()] });
  const out = await new Orchestrator({ root, config: config(), provider }).build('x');
  assert.equal(byRole(provider, 'reviewer').length, 2);
  assert.equal(out.state.status, 'approved');
});

test('full mode: no planning call, DATA designs, everyone at full depth', async () => {
  const root = tmpProject();
  const provider = new MockProvider({ lead: [debrief()], pm: [spec()], architect: [design()], developer: [dev()], qa: [qaPass()], security: [approve()], reviewer: [approve()] });
  const out = await new Orchestrator({ root, config: config({ mode: 'full' }), provider }).build('Payments');
  assert.equal(out.state.status, 'approved');
  assert.deepEqual(out.state.lineup, FULL);
  assert.deepEqual(roles(provider), ['pm', 'architect', 'developer', 'qa', 'security', 'reviewer', 'lead']);
  assert.match(byRole(provider, 'developer')[0].prompt, /## Design/);
});

test('quick mode: Developer → QA (light) → Code Review (light), deterministic debrief', async () => {
  const root = tmpProject();
  const provider = new MockProvider({ developer: [dev()], qa: [qaPass()], reviewer: [approve()] });
  const out = await new Orchestrator({ root, config: config({ mode: 'quick' }), provider }).build('Add dark mode');
  assert.equal(out.state.status, 'approved');
  assert.deepEqual(roles(provider), ['developer', 'qa', 'reviewer']);
  assert.match(byRole(provider, 'developer')[0].prompt, /no separate spec[\s\S]*Add dark mode/);
});

test('open questions are asked; unanswered ones fall back to the PM default', async () => {
  const root = tmpProject();
  const questions = [
    { id: 'Q-1', question: 'Include DB status?', proposedDefault: 'yes' },
    { id: 'Q-2', question: 'Auth required?', proposedDefault: 'no' },
  ];
  const provider = new MockProvider({ lead: [teamPlan(), debrief()], pm: [spec(questions)], developer: [dev()], qa: [qaPass()], security: [approve()], reviewer: [approve()] });
  const ask = async (q: string) => (q.startsWith('Q-1') ? 'no, keep it minimal' : undefined);
  const out = await new Orchestrator({ root, config: config(), provider, ask }).build('x');
  assert.deepEqual(
    out.state.answers.map((a) => [a.id, a.answer, a.source]),
    [
      ['Q-1', 'no, keep it minimal', 'user'],
      ['Q-2', 'no', 'default'],
    ],
  );
  assert.match(byRole(provider, 'developer')[0].prompt, /keep it minimal/);
});

test('the debrief updates the rulebook with what the team learned', async () => {
  const root = tmpProject();
  initProject(root);
  const provider = new MockProvider({
    lead: [teamPlan(), debrief([{ action: 'add', id: '', rule: 'Counters use atomic conditional updates.', reason: 'Race found in QA.' }])],
    pm: [spec()],
    developer: [dev()],
    qa: [qaPass()],
    security: [approve()],
    reviewer: [approve(['Counters use atomic updates'])],
  });
  const out = await new Orchestrator({ root, config: config(), provider }).build('x');
  assert.equal(out.state.ruleUpdates.length, 1);
  const rules = fs.readFileSync(paths(root).rules, 'utf8');
  assert.match(rules, /\*\*\[L-001\]\*\* Counters use atomic conditional updates\./);
  assert.match(byRole(provider, 'lead')[1].prompt, /Lessons proposed by reviewers[\s\S]*Counters use atomic updates/);
});

test('an agent crash marks the mission failed; resume continues from the failed step', async () => {
  const root = tmpProject();
  const crashing = new MockProvider({ lead: [teamPlan()], pm: [spec()], developer: [dev()], qa: [new AgentError('network down')] });
  const first = await new Orchestrator({ root, config: config(), provider: crashing }).build('x');
  assert.equal(first.state.status, 'failed');
  assert.equal(first.state.next, 'qa');

  const healthy = new MockProvider({ lead: [debrief()], qa: [qaPass()], security: [approve()], reviewer: [approve()] });
  const second = await new Orchestrator({ root, config: config(), provider: healthy }).resume(first.state.id);
  assert.equal(second.state.status, 'approved');
  assert.deepEqual(roles(healthy), ['qa', 'security', 'reviewer', 'lead']);
  assert.equal(RunStore.load(root, first.state.id).state.status, 'approved');
});

test('output that breaks the contract fails the step with a clear message', async () => {
  const root = tmpProject();
  const provider = new MockProvider({ lead: [{ missionName: 'incomplete' }] });
  const out = await new Orchestrator({ root, config: config(), provider }).build('x');
  assert.equal(out.state.status, 'failed');
  assert.match(out.state.error!, /does not match the Team Lead contract/);
});

test('renamed members appear in prompts and in the report', async () => {
  const root = tmpProject();
  const provider = new MockProvider({ lead: [plan()], developer: [dev()] });
  const out = await new Orchestrator({ root, config: config({ team: { names: { developer: 'Chitti' } } }), provider }).build('x');
  const devCall = byRole(provider, 'developer')[0] as AgentRequest;
  assert.match(devCall.systemPrompt, /You are Chitti, the Developer/);
  assert.equal(devCall.member, 'Chitti');
  assert.ok(fs.readFileSync(out.reportPath!, 'utf8').includes('Chitti'));
});

test('onboarding writes the project profile, project rules and member notes', async () => {
  const root = tmpProject();
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { express: '^5.0.0' } }));
  initProject(root);
  const provider = new MockProvider({ lead: [profile()] });
  const result = await onboard(root, config({ checks: [] }), provider);

  assert.deepEqual(result.packs.sort(), ['express', 'mongodb']);
  const p = paths(root);
  assert.match(fs.readFileSync(p.project, 'utf8'), /# Demo API[\s\S]*```mermaid/);
  assert.match(fs.readFileSync(p.rules, 'utf8'), /All request bodies go through validate\(\)/);
  assert.match(fs.readFileSync(path.join(p.teamNotes, 'qa.md'), 'utf8'), /Use startApi\(\)/);
  assert.deepEqual(result.addedChecks, [{ name: 'test', command: 'npm test' }]);
  assert.match(provider.calls[0].prompt, /dependencies: express/);

  // Every later member prompt carries the profile, the notes and the stack packs.
  const mission = new MockProvider({ lead: [plan()], developer: [dev()] });
  await new Orchestrator({ root, config: config(), provider: mission }).build('x');
  const sys = byRole(mission, 'developer')[0].systemPrompt;
  assert.match(sys, /# This project[\s\S]*Demo API/);
  assert.match(sys, /# Your notes for this project[\s\S]*Use HttpError/);
  assert.match(sys, /Stack guidance[\s\S]*MongoDB/);
  assert.match(sys, /All request bodies go through validate\(\)/);
});
