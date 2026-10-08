import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Config } from '../src/config.js';
import type { DevOutput, FixOutput, PmOutput, QaOutput, ReviewOutput } from '../src/schemas.js';

export function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ai-team-test-'));
}

export function config(overrides: Partial<Config> = {}): Config {
  return Config.parse({ checks: [{ name: 'test', command: 'node -e "process.exit(0)"' }], ...overrides });
}

export const spec = (openQuestions: PmOutput['openQuestions'] = []): PmOutput => ({
  title: 'Health check endpoint',
  goal: 'Let load balancers check service health.',
  functionalRequirements: ['GET /health returns 200 with { status: "ok" }'],
  nonFunctionalRequirements: ['Responds in < 50ms'],
  userFlow: ['Load balancer calls GET /health'],
  acceptanceCriteria: [{ id: 'AC-1', criterion: 'GET /health returns 200 and { status: "ok" }' }],
  edgeCases: [{ id: 'EC-1', case: 'DB down', expected: 'Returns 503' }],
  errorCases: ['DB unreachable → 503'],
  securityConsiderations: ['No sensitive data in response'],
  outOfScope: ['Detailed metrics'],
  openQuestions,
});

export const dev = (summary = 'Added /health route'): DevOutput => ({
  summary,
  filesChanged: [{ path: 'src/routes/health.ts', change: 'new route' }],
  criteriaCoverage: [{ id: 'AC-1', status: 'DONE', notes: '' }],
  testsAdded: ['health.test.ts'],
  commandsRun: [{ command: 'npm test', result: 'pass' }],
  notes: [],
});

export const qaPass = (): QaOutput => ({
  status: 'PASS',
  summary: 'All good',
  scenarios: [{ category: 'Happy path', scenario: 'GET /health', result: 'PASS', evidence: 'health.test.ts' }],
  bugs: [],
});

export const qaFail = (id = 'BUG-001'): QaOutput => ({
  status: 'FAIL',
  summary: 'Found a bug',
  scenarios: [{ category: 'Database', scenario: 'DB down', result: 'FAIL', evidence: 'returns 200' }],
  bugs: [{ id, severity: 'HIGH', title: 'Returns 200 when DB is down', location: 'src/routes/health.ts', steps: ['Stop DB', 'GET /health'], expected: '503', actual: '200' }],
});

export const fix = (id = 'BUG-001'): FixOutput => ({
  summary: `Fixed ${id}`,
  fixes: [{ id, status: 'FIXED', rootCause: 'No DB ping', change: 'Ping DB', regressionTest: 'health.test.ts: db down' }],
  filesChanged: [{ path: 'src/routes/health.ts', change: 'ping db' }],
  commandsRun: [],
});

export const approve = (lessons: string[] = []): ReviewOutput => ({ status: 'APPROVED', summary: 'LGTM', findings: [], missedEdgeCases: [], lessons });

export const reject = (id = 'REV-001', severity: 'HIGH' | 'LOW' = 'HIGH', status: 'APPROVED' | 'REJECTED' = 'REJECTED'): ReviewOutput => ({
  status,
  summary: 'Problems found',
  findings: [{ id, severity, category: 'Architecture', file: 'src/routes/health.ts', description: 'Logic in route handler', suggestion: 'Move to service' }],
  missedEdgeCases: [],
  lessons: [],
});
