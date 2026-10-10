import type { RoleId } from '../team.js';
import { AgentError, type AgentRequest, type AgentResult, type AIProvider } from './types.js';

type Responder = unknown | ((req: AgentRequest) => unknown);

/**
 * A scripted provider for tests and dry runs. Each role gets a queue of responses;
 * the last response for a role repeats once the queue is exhausted.
 */
export class MockProvider implements AIProvider {
  readonly name = 'mock';
  readonly calls: AgentRequest[] = [];
  private readonly queues: Partial<Record<RoleId, Responder[]>>;

  constructor(
    script: Partial<Record<RoleId, Responder[]>>,
    private readonly costPerCall = 0.01,
  ) {
    this.queues = Object.fromEntries(Object.entries(script).map(([k, v]) => [k, [...(v ?? [])]]));
  }

  async run(req: AgentRequest): Promise<AgentResult> {
    this.calls.push(req);
    const queue = this.queues[req.role];
    if (!queue || queue.length === 0) throw new AgentError(`MockProvider: no response scripted for role "${req.role}"`);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    const output = typeof next === 'function' ? await (next as (r: AgentRequest) => unknown)(req) : next;
    if (output instanceof Error) throw output;
    req.onActivity?.('Read src/app.js');
    return { output, costUsd: this.costPerCall, turns: 1, sessionId: req.resumeSessionId ?? `mock-${req.role}-${this.calls.length}` };
  }
}
