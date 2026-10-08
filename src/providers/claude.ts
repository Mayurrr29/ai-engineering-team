import path from 'node:path';
import { query, type HookCallback, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { AgentError, checkWrite, type AgentRequest, type AgentResult, type AIProvider } from './types.js';

const READ_TOOLS = ['Read', 'Glob', 'Grep'];
const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit'];

/**
 * Runs each agent as a Claude Code session through the Claude Agent SDK.
 * Uses your existing Claude Code login (or ANTHROPIC_API_KEY), loads the project's
 * CLAUDE.md and settings, restricts tools per role, and enforces each role's write area
 * with a PreToolUse hook (which applies regardless of user permission settings).
 */
export class ClaudeCodeProvider implements AIProvider {
  readonly name = 'claude-code';
  /** Set once a model rejects the effort parameter, so later calls don't send it. */
  private effortUnsupported = false;

  async run(req: AgentRequest): Promise<AgentResult> {
    try {
      return await this.runOnce(req, !this.effortUnsupported);
    } catch (err) {
      if (req.effort && !this.effortUnsupported && err instanceof AgentError && /effort/i.test(err.message) && err.kind !== 'budget') {
        this.effortUnsupported = true;
        return this.runOnce(req, false);
      }
      throw err;
    }
  }

  private async runOnce(req: AgentRequest, withEffort: boolean): Promise<AgentResult> {
    const tools: string[] = [];
    if (req.access.read) tools.push(...READ_TOOLS);
    if (req.access.run) tools.push('Bash');
    if (req.access.write !== 'none') tools.push(...WRITE_TOOLS, 'TodoWrite');

    const guardWrites: HookCallback = async (input) => {
      if (input.hook_event_name !== 'PreToolUse') return {};
      const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
      const target = toolInput.file_path ?? toolInput.notebook_path ?? toolInput.path;
      if (typeof target !== 'string') return {};
      const verdict = checkWrite(target, req.access, req.cwd);
      if (verdict.allowed) return {};
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: verdict.reason } };
    };

    const options: Options = {
      cwd: req.cwd,
      tools,
      allowedTools: tools,
      permissionMode: req.bypassPermissions ? 'bypassPermissions' : 'dontAsk',
      allowDangerouslySkipPermissions: req.bypassPermissions || undefined,
      hooks: { PreToolUse: [{ matcher: 'Edit|Write|NotebookEdit|MultiEdit', hooks: [guardWrites] }] },
      systemPrompt: { type: 'preset', preset: 'claude_code', append: req.systemPrompt },
      settingSources: ['user', 'project', 'local'],
      outputFormat: { type: 'json_schema', schema: req.outputSchema },
      maxTurns: req.maxTurns,
      maxBudgetUsd: req.maxBudgetUsd,
      model: req.model,
      effort: withEffort ? req.effort : undefined,
      persistSession: true,
    };

    let result: Extract<SDKMessage, { type: 'result' }> | undefined;
    try {
      for await (const message of query({ prompt: req.prompt, options })) {
        if (message.type === 'assistant') reportActivity(message, req.cwd, req.onActivity);
        if (message.type === 'result') result = message;
      }
    } catch (err) {
      throw new AgentError(`Claude Code session failed: ${(err as Error).message}`);
    }

    if (!result) throw new AgentError('Claude Code session ended without a result.');
    if (result.subtype !== 'success') {
      const detail = 'errors' in result && result.errors?.length ? `: ${result.errors.join('; ')}` : '';
      const kind = result.subtype === 'error_max_budget_usd' ? 'budget' : 'failure';
      throw new AgentError(`${req.member} stopped (${result.subtype})${detail}`, result.total_cost_usd, kind);
    }
    if (result.structured_output === undefined) {
      throw new AgentError(`${req.member} finished without structured output.`, result.total_cost_usd);
    }
    return { output: result.structured_output, costUsd: result.total_cost_usd, turns: result.num_turns, sessionId: result.session_id };
  }
}

function reportActivity(message: Extract<SDKMessage, { type: 'assistant' }>, cwd: string, onActivity?: (line: string) => void) {
  if (!onActivity || message.parent_tool_use_id) return;
  for (const block of message.message.content) {
    if (block.type !== 'tool_use') continue;
    const input = (block.input ?? {}) as Record<string, unknown>;
    const file = input.file_path ?? input.notebook_path ?? input.path;
    const target =
      typeof file === 'string' && path.isAbsolute(file) ? path.relative(cwd, file) || '.' : (file ?? input.pattern ?? input.command ?? input.description ?? '');
    const detail = String(target).replace(/\s+/g, ' ').slice(0, 100);
    onActivity(`${block.name}${detail ? ` ${detail}` : ''}`);
  }
}
