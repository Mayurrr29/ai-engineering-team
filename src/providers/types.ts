import path from 'node:path';
import { isInside, TEAM_DIR } from '../paths.js';
import type { Effort } from '../schemas.js';
import type { RoleId } from '../team.js';

export interface Access {
  /** Read, Glob and Grep. */
  read: boolean;
  /** Bash (tests, builds, curl...). */
  run: boolean;
  /** none: no file edits · repo: anywhere in the repo except protected dirs · lab: only inside labDir. */
  write: 'none' | 'repo' | 'lab';
  labDir?: string;
}

export interface AgentRequest {
  role: RoleId;
  /** Display name, e.g. "FRIDAY". */
  member: string;
  /** Role instructions + project context. Appended to the provider's base coding-agent prompt. */
  systemPrompt: string;
  /** The task for this step, including all upstream artifacts. */
  prompt: string;
  /** JSON Schema the final answer must satisfy. */
  outputSchema: Record<string, unknown>;
  access: Access;
  cwd: string;
  model?: string;
  effort?: Effort;
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
    readonly kind: 'failure' | 'budget' = 'failure',
  ) {
    super(message);
    this.name = 'AgentError';
  }
}

/** Decides whether a file write is inside the member's allowed area. Enforced by code, not by the prompt. */
export function checkWrite(filePath: string, access: Access, cwd: string): { allowed: true } | { allowed: false; reason: string } {
  const target = path.resolve(cwd, filePath);
  if (access.write === 'none') return { allowed: false, reason: 'Your role is read-only on this team: report findings instead of editing files.' };
  if (access.write === 'lab') {
    if (access.labDir && isInside(access.labDir, target)) return { allowed: true };
    return { allowed: false, reason: `You may only write inside your lab directory (${access.labDir ?? 'none'}). Report bugs instead of editing project files.` };
  }
  if (!isInside(cwd, target)) return { allowed: false, reason: 'Edits must stay inside the repository.' };
  if (isInside(path.join(cwd, TEAM_DIR), target)) return { allowed: false, reason: `${TEAM_DIR}/ belongs to the orchestrator; don't modify it.` };
  if (isInside(path.join(cwd, '.git'), target)) return { allowed: false, reason: 'Never modify .git/ directly.' };
  return { allowed: true };
}
