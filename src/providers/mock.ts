import type { RoleName } from '../config.js';
import { AgentError, type AgentRequest, type AgentResult, type AIProvider } from './types.js';

type Responder = unknown | ((req: AgentRequest) => unknown);

/**
 * A scripted provider for tests and dry runs. Each role gets a queue of responses;
 * the last response for a role repeats once the queue is exhausted.
 */
export class MockProvider implements AIProvider {
  readonly name = 'mock';
  readonly calls: AgentRequest[] = [];
  private readonly queues: Partial<Record<RoleName, Responder[]>>;

  constructor(script: Partial<Record<RoleName, Responder[]>>) {
    this.queues = Object.fromEntries(Object.entries(script).map(([k, v]) => [k, [...(v ?? [])]]));
  }

  async run(req: AgentRequest): Promise<AgentResult> {
    this.calls.push(req);
    const queue = this.queues[req.role];
    if (!queue || queue.length === 0) throw new AgentError(`MockProvider: no response scripted for role "${req.role}"`);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    const output = typeof next === 'function' ? (next as (r: AgentRequest) => unknown)(req) : next;
    if (output instanceof Error) throw output;
    return { output, costUsd: 0.01, turns: 1 };
  }
}
