import { z } from 'zod';

/**
 * Output contracts for every agent. Agents return JSON that must match these
 * schemas (enforced by the provider via structured output), so the orchestrator
 * never has to guess whether a review "sort of" passed.
 */

export const Severity = z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
export type Severity = z.infer<typeof Severity>;

export const PmOutput = z.object({
  title: z.string().describe('Short feature title'),
  goal: z.string().describe('One paragraph: the problem this solves and for whom'),
  functionalRequirements: z.array(z.string()),
  nonFunctionalRequirements: z.array(z.string()),
  userFlow: z.array(z.string()).describe('Ordered steps of the main user flow'),
  acceptanceCriteria: z
    .array(z.object({ id: z.string().describe('AC-1, AC-2, ...'), criterion: z.string() }))
    .min(1),
  edgeCases: z.array(z.object({ id: z.string().describe('EC-1, EC-2, ...'), case: z.string(), expected: z.string() })),
  errorCases: z.array(z.string()),
  securityConsiderations: z.array(z.string()),
  outOfScope: z.array(z.string()),
  openQuestions: z.array(
    z.object({
      id: z.string().describe('Q-1, Q-2, ...'),
      question: z.string(),
      proposedDefault: z.string().describe('What you will assume if nobody answers'),
    }),
  ),
});
export type PmOutput = z.infer<typeof PmOutput>;

export const DevOutput = z.object({
  summary: z.string(),
  filesChanged: z.array(z.object({ path: z.string(), change: z.string() })),
  criteriaCoverage: z.array(
    z.object({
      id: z.string().describe('Acceptance criterion id'),
      status: z.enum(['DONE', 'PARTIAL', 'NOT_DONE']),
      notes: z.string(),
    }),
  ),
  testsAdded: z.array(z.string()),
  commandsRun: z.array(z.object({ command: z.string(), result: z.string() })),
  notes: z.array(z.string()).describe('Assumptions, follow-ups, known limitations'),
});
export type DevOutput = z.infer<typeof DevOutput>;

export const Bug = z.object({
  id: z.string().describe('BUG-001, BUG-002, ... — reuse the id if the same bug is still present'),
  severity: Severity,
  title: z.string(),
  location: z.string().describe('File/endpoint/component'),
  steps: z.array(z.string()),
  expected: z.string(),
  actual: z.string(),
});
export type Bug = z.infer<typeof Bug>;

export const QaOutput = z.object({
  status: z.enum(['PASS', 'FAIL']),
  summary: z.string(),
  scenarios: z.array(
    z.object({
      category: z.string().describe('Happy path, Validation, Boundary, Auth, Authorization, API errors, Database, Concurrency, Frontend states, Security, ...'),
      scenario: z.string(),
      result: z.enum(['PASS', 'FAIL', 'NOT_TESTABLE']),
      evidence: z.string().describe('How you verified it: test name, command output, code reference'),
    }),
  ),
  bugs: z.array(Bug),
});
export type QaOutput = z.infer<typeof QaOutput>;

export const FixOutput = z.object({
  summary: z.string(),
  fixes: z.array(
    z.object({
      id: z.string().describe('The BUG-/SEC-/REV-/CHECK- id being addressed'),
      status: z.enum(['FIXED', 'NOT_FIXED', 'NOT_A_BUG']),
      rootCause: z.string(),
      change: z.string(),
      regressionTest: z.string().describe('Test added to prevent recurrence, or why none is possible'),
    }),
  ),
  filesChanged: z.array(z.object({ path: z.string(), change: z.string() })),
  commandsRun: z.array(z.object({ command: z.string(), result: z.string() })),
});
export type FixOutput = z.infer<typeof FixOutput>;

export const Finding = z.object({
  id: z.string().describe('SEC-001 / REV-001 ... — reuse the id if the same issue is still present'),
  severity: Severity,
  category: z.string(),
  file: z.string(),
  description: z.string(),
  suggestion: z.string(),
});
export type Finding = z.infer<typeof Finding>;

export const ReviewOutput = z.object({
  status: z.enum(['APPROVED', 'REJECTED']),
  summary: z.string(),
  findings: z.array(Finding),
  missedEdgeCases: z.array(z.string()).describe('Edge cases nobody (PM, QA) considered'),
  lessons: z
    .array(z.string())
    .describe('Durable, project-specific engineering lessons worth remembering for future features (may be empty)'),
});
export type ReviewOutput = z.infer<typeof ReviewOutput>;

export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  return json;
}
