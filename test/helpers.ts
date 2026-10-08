import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Config } from '../src/config.js';
import type { Debrief, DesignOutput, DevOutput, FixOutput, LeadDecision, Lineup, MissionPlan, PmOutput, ProjectProfile, QaOutput, ReviewOutput, Severity } from '../src/schemas.js';

export function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ai-team-test-'));
}

/** A temp git repository with one committed file. */
export function gitProject(files: Record<string, string> = { 'src/app.js': 'export const a = 1;\n' }): { root: string; git: (...args: string[]) => string } {
  const root = tmpProject();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Tess Tester');
  git('config', 'core.autocrlf', 'false');
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  git('add', '-A');
  git('commit', '-qm', 'init');
  return { root, git };
}

export function config(overrides: Record<string, unknown> = {}): Config {
  return Config.parse({ checks: [{ name: 'test', command: 'node -e "process.exit(0)"' }], baselineChecks: false, ...overrides });
}

const OFF: Lineup = { pm: 'off', architect: 'off', qa: 'off', security: 'off', reviewer: 'off' };
export const FULL: Lineup = { pm: 'full', architect: 'full', qa: 'full', security: 'full', reviewer: 'full' };

export function plan(overrides: Partial<MissionPlan> = {}): MissionPlan {
  return {
    missionName: 'Health check endpoint',
    summary: 'Add a health check',
    taskType: 'feature',
    size: 'XS',
    risk: 'low',
    riskAreas: [],
    surfaces: ['backend'],
    lineup: OFF,
    effort: { pm: 'medium', architect: 'medium', developer: 'low', qa: 'medium', bugFixer: 'medium', security: 'medium', reviewer: 'medium' },
    briefs: { pm: '', architect: '', developer: 'Add GET /health returning 200.', qa: '', bugFixer: '', security: '', reviewer: '' },
    keyFiles: ['src/app.js'],
    rationale: 'Tiny contained change.',
    estimatedCostUsd: 0.2,
    budgetNote: '',
    ...overrides,
  };
}

export const teamPlan = (lineup: Partial<Lineup> = {}, extra: Partial<MissionPlan> = {}) =>
  plan({
    size: 'M',
    risk: 'medium',
    riskAreas: ['authorization'],
    lineup: { pm: 'full', architect: 'off', qa: 'full', security: 'light', reviewer: 'full', ...lineup },
    briefs: { pm: 'Spec the ownership rules.', architect: '', developer: 'Check ownership on PATCH.', qa: 'Focus on IDOR.', bugFixer: '', security: 'Look for mass assignment.', reviewer: 'Check conventions.' },
    ...extra,
  });

export const spec = (openQuestions: PmOutput['openQuestions'] = []): PmOutput => ({
  title: 'Health check endpoint',
  goal: 'Let load balancers check service health.',
  functionalRequirements: ['GET /health returns 200 with { status: "ok" }'],
  nonFunctionalRequirements: ['Responds in < 50ms'],
  userFlow: ['1. Load balancer calls GET /health'],
  acceptanceCriteria: [{ id: 'AC-1', criterion: 'GET /health returns 200 and { status: "ok" }' }],
  edgeCases: [{ id: 'EC-1', case: 'DB down', expected: 'Returns 503' }],
  errorCases: ['DB unreachable → 503'],
  securityConsiderations: ['No sensitive data in response'],
  outOfScope: ['Detailed metrics'],
  openQuestions,
});

export const design = (): DesignOutput => ({
  summary: 'Add a route',
  approach: 'One route in app.js',
  decisions: [{ id: 'ADR-1', title: 'Inline route', context: 'Small', decision: 'Inline', alternatives: ['Router'], consequences: 'Simple' }],
  dataModel: [],
  apiContracts: [{ method: 'GET', path: '/health', auth: 'none', request: '-', response: '{ status }', errors: ['503'] }],
  sequenceDiagram: 'sequenceDiagram\n  LB->>API: GET /health\n  API-->>LB: 200',
  erDiagram: '',
  filePlan: [{ path: 'src/app.js', action: 'modify', purpose: 'route' }],
  testPlan: ['health.test.js'],
  risks: [],
});

export const dev = (summary = 'Added /health route', files = ['src/routes/health.ts']): DevOutput => ({
  summary,
  filesChanged: files.map((p) => ({ path: p, change: 'changed' })),
  criteriaCoverage: [{ id: 'AC-1', status: 'DONE', tests: ['health.test.ts'], notes: '' }],
  testsAdded: ['health.test.ts'],
  commandsRun: [{ command: 'npm test', result: 'pass' }],
  notes: [],
});

export const qaPass = (): QaOutput => ({
  status: 'PASS',
  summary: 'All good',
  criteria: [{ id: 'AC-1', result: 'PASS', evidence: 'lab script' }],
  scenarios: [{ category: 'Happy path', scenario: 'GET /health', result: 'PASS', evidence: 'health.test.ts' }],
  bugs: [],
});

export const qaFail = (id = 'BUG-001', severity: Severity = 'HIGH'): QaOutput => ({
  status: 'FAIL',
  summary: 'Found a bug',
  criteria: [{ id: 'AC-1', result: 'FAIL', evidence: 'returns 200 when DB down' }],
  scenarios: [{ category: 'Database', scenario: 'DB down', result: 'FAIL', evidence: 'returns 200' }],
  bugs: [{ id, severity, title: 'Returns 200 when DB is down', location: 'src/routes/health.ts', steps: ['Stop DB', 'GET /health'], expected: '503', actual: '200' }],
});

export const fix = (id = 'BUG-001', status: 'FIXED' | 'NOT_FIXED' | 'NOT_A_BUG' = 'FIXED'): FixOutput => ({
  summary: `Handled ${id}`,
  fixes: [{ id, status, rootCause: 'No DB ping', change: 'Ping DB', regressionTest: 'health.test.ts: db down' }],
  filesChanged: [{ path: 'src/routes/health.ts', change: 'ping db' }],
  commandsRun: [],
});

export const approve = (lessons: string[] = []): ReviewOutput => ({
  status: 'APPROVED',
  summary: 'LGTM',
  findings: [],
  praise: ['Clear tests'],
  codeHealth: 'improves',
  threats: [],
  missedEdgeCases: [],
  lessons,
});

export const reject = (id = 'REV-001', severity: Severity = 'HIGH', status: 'APPROVED' | 'REJECTED' = 'REJECTED'): ReviewOutput => ({
  status,
  summary: 'Problems found',
  findings: [{ id, severity, category: 'issue: architecture', file: 'src/routes/health.ts:4', description: 'Logic in route handler', suggestion: 'Move to service', standard: '' }],
  praise: [],
  codeHealth: 'neutral',
  threats: [],
  missedEdgeCases: [],
  lessons: [],
});

export const ruling = (rulings: LeadDecision['rulings']): LeadDecision => ({ summary: 'Ruling given', rulings });

export const debrief = (ruleUpdates: Debrief['ruleUpdates'] = []): Debrief => ({
  headline: 'Health check shipped.',
  summary: 'Done.',
  whatWasBuilt: ['GET /health'],
  decisions: [],
  evidence: ['tests pass'],
  risks: [],
  howToTry: ['curl localhost:3000/health'],
  ruleUpdates,
});

export const profile = (): ProjectProfile => ({
  projectName: 'Demo API',
  summary: 'A demo API.',
  stack: { languages: ['JavaScript'], frameworks: ['Express'], databases: ['MongoDB'], testing: ['node:test'], packageManager: 'npm', other: [] },
  architecture: { overview: 'Routes call the db module.', modules: [{ path: 'src/routes', purpose: 'HTTP routes' }], diagram: 'flowchart LR\n  A["Routes"] --> B["DB"]' },
  conventions: [{ topic: 'Validation', convention: 'Use validate()', evidence: 'src/validate.js:1' }],
  commands: [{ name: 'test', command: 'npm test', purpose: 'Run tests' }],
  howToRun: ['npm start'],
  howToTest: ['npm test'],
  sensitiveAreas: [{ path: 'src/auth.js', reason: 'Authentication' }],
  rules: [{ rule: 'All request bodies go through validate()', why: 'It drops unknown fields', evidence: 'src/validate.js:10' }],
  memberNotes: { pm: ['Money is in cents'], architect: [], developer: ['Use HttpError'], qa: ['Use startApi()'], bugFixer: [], security: ['Tokens are in sessions'], reviewer: [] },
  stackPacks: ['mongodb'],
});
