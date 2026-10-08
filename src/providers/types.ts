import type { RoleName } from '../config.js';

export interface AgentRequest {
  role: RoleName;
  /** Role instructions + project rules + memory. Appended to the provider's base coding-agent prompt. */
  systemPrompt: string;
  /** The task for this step, including all upstream artifacts. */
  prompt: string;
  /** JSON Schema the final answer must satisfy. */
  outputSchema: Record<string, unknown>;
  /** Whether the agent may modify the repository. */
  canWrite: boolean;
  /** Whether the agent may run shell commands (tests, builds, curl...). */
  canRunCommands: boolean;
  cwd: string;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  bypassPermissions?: boolean;
  /** Progress callback for live activity (tool calls etc.). */
  onActivity?: (line: string) => void;
}

export interface AgentResult {
  /** Parsed structured output (validated again by the orchestrator). */
  output: unknown;
  costUsd: number;
  turns: number;
  sessionId?: string;
}

export interface AIProvider {
  readonly name: string;
  run(request: AgentRequest): Promise<AgentResult>;
}

export class AgentError extends Error {
  constructor(
    message: string,
    readonly costUsd = 0,
  ) {
    super(message);
    this.name = 'AgentError';
  }
}
