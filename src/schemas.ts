import { z } from 'zod';

/**
 * Output contracts for every agent. Agents return JSON that must match these schemas
 * (enforced through structured output), so the orchestrator never has to guess whether
 * a review "sort of" passed.
 */

export const Severity = z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
export type Severity = z.infer<typeof Severity>;

export const Depth = z.enum(['off', 'light', 'full']);
export type Depth = z.infer<typeof Depth>;
export const OnOff = z.enum(['off', 'full']);
export const Effort = z.enum(['low', 'medium', 'high', 'xhigh']);
export type Effort = z.infer<typeof Effort>;

export const Lineup = z.object({
  pm: OnOff,
  architect: OnOff,
  qa: Depth,
  security: Depth,
  reviewer: Depth,
});
export type Lineup = z.infer<typeof Lineup>;

export const RiskArea = z.enum([
  'auth',
  'authorization',
  'payments',
  'personal-data',
  'data-migration',
  'file-upload',
  'external-input',
  'concurrency',
  'public-api',
  'infrastructure',
  'secrets',
]);
export type RiskArea = z.infer<typeof RiskArea>;

/**
 * How any member talks to the rest of the team beyond their own deliverable. A role is expertise, not a limit on
 * what someone may notice: a tester can challenge the design, a developer can ask for a security review.
 * The orchestrator routes each signal to whoever needs it instead of broadcasting it.
 */
export const Signal = z.object({
  kind: z
    .enum(['question', 'assumption', 'concern', 'recruit', 'blocker'])
    .describe(
      'question: a decision only the human can make that materially changes the result · assumption: a decision you made yourself because the request left it open · concern: a problem outside your own deliverable (design, requirements, another area) · recruit: the mission needs a member who is not staffed · blocker: you cannot finish without help',
    ),
  to: z.enum(['lead', 'human', 'pm', 'architect', 'developer', 'qa', 'security', 'reviewer', 'team']).describe('Who needs this'),
  summary: z.string().describe('One sentence'),
  evidence: z.string().describe('What supports it: file:line, command output, spec reference. Empty only for questions.'),
  member: z.enum(['', 'pm', 'architect', 'qa', 'security', 'reviewer']).describe('recruit: the member to add; otherwise empty'),
  proposedDefault: z.string().describe('question: what the team will do if nobody answers; otherwise empty'),
});
export type Signal = z.infer<typeof Signal>;

const signals = z.array(Signal).describe('Questions, assumptions, concerns, recruit requests or blockers for the team. Usually empty.');

const perMember = <T extends z.ZodType>(t: T) =>
  z.object({ pm: t, architect: t, developer: t, qa: t, bugFixer: t, security: t, reviewer: t });

export const MissionPlan = z.object({
  missionName: z.string().describe('2-6 word mission title, e.g. "Course discount coupons"'),
  summary: z.string().describe('One or two sentences: what the human asked for'),
  taskType: z
    .enum(['feature', 'bugfix', 'refactor', 'ui', 'config', 'docs', 'test', 'chore', 'question', 'planning'])
    .describe('question: the human wants an answer, not a code change · planning: a design or plan, not a code change'),
  size: z.enum(['XS', 'S', 'M', 'L', 'XL']),
  risk: z.enum(['low', 'medium', 'high']),
  riskAreas: z.array(RiskArea),
  surfaces: z.array(z.enum(['frontend', 'backend', 'database', 'infra', 'docs', 'tests'])),
  lineup: Lineup,
  effort: perMember(Effort).describe('Reasoning effort per member for this mission'),
  briefs: perMember(z.string()).describe('Brief per staffed member (objective, focus, boundaries). Empty string for members not staffed; bugFixer brief is used if he gets called.'),
  keyFiles: z.array(z.string()).describe('Files most likely involved'),
  rationale: z.string().describe('Two to four sentences: why this size, risk and lineup'),
  estimatedCostUsd: z.number(),
  budgetNote: z.string().describe('Empty, or a note if the budget is tight or insufficient'),
  answer: z
    .string()
    .describe('question tasks: the complete answer with file:line references, when your triage already settles it; empty to hand the question to the Architect, and for every other task type'),
});
export type MissionPlan = z.infer<typeof MissionPlan>;

export const PmOutput = z.object({
  title: z.string().describe('Short feature title'),
  goal: z.string().describe('One paragraph: the problem this solves and for whom'),
  functionalRequirements: z.array(z.string()),
  nonFunctionalRequirements: z.array(z.string()),
  userFlow: z.array(z.string()).describe('Ordered steps of the main user flow, without numbering'),
  acceptanceCriteria: z.array(z.object({ id: z.string().describe('AC-1, AC-2, ...'), criterion: z.string() })).min(1),
  edgeCases: z.array(z.object({ id: z.string().describe('EC-1, EC-2, ...'), case: z.string(), expected: z.string() })),
  errorCases: z.array(z.string()),
  securityConsiderations: z.array(z.string()),
  outOfScope: z.array(z.string()),
  openQuestions: z.array(
    z.object({
      id: z.string().describe('Q-1, Q-2, ...'),
      question: z.string(),
      proposedDefault: z.string().describe('What the team will assume if nobody answers'),
    }),
  ),
});
export type PmOutput = z.infer<typeof PmOutput>;

export const DesignOutput = z.object({
  summary: z.string(),
  approach: z.string().describe('The design in a short paragraph'),
  decisions: z.array(
    z.object({
      id: z.string().describe('ADR-1, ADR-2, ...'),
      title: z.string(),
      context: z.string(),
      decision: z.string(),
      alternatives: z.array(z.string()),
      consequences: z.string(),
    }),
  ),
  dataModel: z.array(z.object({ entity: z.string(), change: z.string(), fields: z.array(z.string()) })),
  apiContracts: z.array(
    z.object({
      method: z.string(),
      path: z.string(),
      auth: z.string(),
      request: z.string(),
      response: z.string(),
      errors: z.array(z.string()),
    }),
  ),
  sequenceDiagram: z.string().describe('Mermaid sequenceDiagram source for the main flow, or empty'),
  erDiagram: z.string().describe('Mermaid erDiagram source if entities change, or empty'),
  filePlan: z.array(z.object({ path: z.string(), action: z.enum(['create', 'modify', 'delete']), purpose: z.string() })),
  testPlan: z.array(z.string()),
  risks: z.array(z.string()),
  milestones: z
    .array(z.object({ name: z.string(), deliverables: z.array(z.string()), acceptance: z.array(z.string()), dependsOn: z.array(z.string()) }))
    .describe('Planning missions: ordered milestones; empty when the design is built right away'),
});
export type DesignOutput = z.infer<typeof DesignOutput>;

const FileChange = z.object({ path: z.string(), change: z.string() });
const CommandRun = z.object({ command: z.string(), result: z.string() });

export const DevOutput = z.object({
  summary: z.string(),
  filesChanged: z.array(FileChange),
  criteriaCoverage: z.array(
    z.object({
      id: z.string().describe('Acceptance criterion id (or finding id in rework mode)'),
      status: z.enum(['DONE', 'PARTIAL', 'NOT_DONE']),
      tests: z.array(z.string()).describe('Test names or files that prove it'),
      notes: z.string(),
    }),
  ),
  testsAdded: z.array(z.string()),
  commandsRun: z.array(CommandRun),
  notes: z.array(z.string()).describe('Follow-ups and known limitations for the human'),
  rootCause: z.string().describe('Bug fixes: the root cause and the evidence that confirmed it; empty otherwise'),
  signals,
});
export type DevOutput = z.infer<typeof DevOutput>;

export const Bug = z.object({
  id: z.string().describe('BUG-001, BUG-002, ... — reuse the id if the same bug is still present'),
  severity: Severity,
  title: z.string(),
  location: z.string().describe('File, endpoint or component'),
  steps: z.array(z.string()),
  expected: z.string(),
  actual: z.string(),
});
export type Bug = z.infer<typeof Bug>;

export const QaOutput = z.object({
  status: z.enum(['PASS', 'FAIL']),
  summary: z.string(),
  criteria: z.array(
    z.object({
      id: z.string().describe('AC id'),
      result: z.enum(['PASS', 'FAIL', 'NOT_TESTABLE']),
      evidence: z.string(),
    }),
  ),
  scenarios: z.array(
    z.object({
      category: z.string().describe('Happy path, Validation, Boundary, Authentication, Authorization, Business rules, Concurrency, API errors, Data exposure, Regression, UI states, ...'),
      scenario: z.string(),
      result: z.enum(['PASS', 'FAIL', 'NOT_TESTABLE']),
      evidence: z.string().describe('How you verified it: test name, request/response, command output, code reference'),
    }),
  ),
  bugs: z.array(Bug),
  signals,
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
  filesChanged: z.array(FileChange),
  commandsRun: z.array(CommandRun),
  signals,
});
export type FixOutput = z.infer<typeof FixOutput>;

export const Finding = z.object({
  id: z.string().describe('SEC-001 / REV-001 ... — reuse the id if the same issue is still present'),
  severity: Severity,
  category: z.string().describe('Reviewer: Conventional Comments label + topic, e.g. "issue: concurrency". Security: vulnerability class.'),
  file: z.string().describe('path or path:line'),
  description: z.string(),
  suggestion: z.string(),
  standard: z.string().describe('OWASP / CWE reference for security findings (e.g. "A01:2025, CWE-639"), project rule id, or empty'),
});
export type Finding = z.infer<typeof Finding>;

export const ReviewOutput = z.object({
  status: z.enum(['APPROVED', 'REJECTED']),
  summary: z.string(),
  findings: z.array(Finding),
  praise: z.array(z.string()).describe('One to three things done well'),
  codeHealth: z.enum(['improves', 'neutral', 'degrades']),
  threats: z
    .array(
      z.object({
        category: z.enum(['Spoofing', 'Tampering', 'Repudiation', 'Information disclosure', 'Denial of service', 'Elevation of privilege']),
        threat: z.string(),
        mitigated: z.boolean(),
      }),
    )
    .describe('Security reviewer: STRIDE threats considered (full depth). Code reviewer: empty.'),
  missedEdgeCases: z.array(z.string()).describe('Edge cases nobody (PM, QA) considered'),
  lessons: z.array(z.string()).describe('Durable, project-specific lessons for future missions (may be empty)'),
  signals,
});
export type ReviewOutput = z.infer<typeof ReviewOutput>;

export const AnswerOutput = z.object({
  answer: z.string().describe('The answer in Markdown: direct first, then the supporting detail'),
  evidence: z.array(z.string()).describe('file:line references or command output that back the answer'),
  followUps: z.array(z.string()).describe('Open points or suggested next steps; may be empty'),
});
export type AnswerOutput = z.infer<typeof AnswerOutput>;

export const LeadDecision = z.object({
  summary: z.string().describe('One or two sentences on the situation and your call'),
  rulings: z.array(
    z.object({
      id: z.string(),
      ruling: z.enum(['fix', 'waive', 'escalate']),
      reason: z.string(),
      guidance: z.string().describe('For fix: what to do differently. For escalate: the one-line question for the human.'),
    }),
  ),
});
export type LeadDecision = z.infer<typeof LeadDecision>;

export const Debrief = z.object({
  headline: z.string().describe('One sentence: what happened'),
  summary: z.string().describe('Two to four sentences'),
  whatWasBuilt: z.array(z.string()),
  decisions: z.array(z.string()).describe('Choices and assumptions the human should know about'),
  evidence: z.array(z.string()),
  risks: z.array(z.string()).describe('Remaining risks and follow-ups'),
  howToTry: z.array(z.string()).describe('Concrete steps or commands to see the change working'),
  ruleUpdates: z.array(
    z.object({
      action: z.enum(['add', 'update', 'remove']),
      id: z.string().describe('Existing learned-rule id for update/remove (e.g. L-003); empty for add'),
      rule: z.string(),
      reason: z.string(),
    }),
  ),
});
export type Debrief = z.infer<typeof Debrief>;

export const PACK_IDS = ['express', 'mongodb', 'react', 'nextjs', 'sql', 'nestjs', 'python-web'] as const;

export const ProjectProfile = z.object({
  projectName: z.string(),
  summary: z.string().describe('What this project is, in two or three sentences'),
  stack: z.object({
    languages: z.array(z.string()),
    frameworks: z.array(z.string()),
    databases: z.array(z.string()),
    testing: z.array(z.string()),
    packageManager: z.string(),
    other: z.array(z.string()),
  }),
  architecture: z.object({
    overview: z.string(),
    modules: z.array(z.object({ path: z.string(), purpose: z.string() })),
    diagram: z.string().describe('Mermaid flowchart source'),
  }),
  conventions: z.array(z.object({ topic: z.string(), convention: z.string(), evidence: z.string().describe('path:line') })),
  commands: z.array(z.object({ name: z.string(), command: z.string(), purpose: z.string() })),
  howToRun: z.array(z.string()),
  howToTest: z.array(z.string()),
  sensitiveAreas: z.array(z.object({ path: z.string(), reason: z.string() })),
  rules: z.array(z.object({ rule: z.string(), why: z.string(), evidence: z.string() })),
  memberNotes: perMember(z.array(z.string())),
  stackPacks: z.array(z.enum(PACK_IDS)),
});
export type ProjectProfile = z.infer<typeof ProjectProfile>;

export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  return json;
}
