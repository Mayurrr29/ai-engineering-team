import path from 'node:path';
import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { AgentError, type AgentRequest, type AgentResult, type AIProvider } from './types.js';

const READ_TOOLS = ['Read', 'Glob', 'Grep'];
const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit'];

/**
 * Runs each agent as a Claude Code session through the Claude Agent SDK.
 * Uses your existing Claude Code login (or ANTHROPIC_API_KEY), loads the project's
 * CLAUDE.md and settings, and restricts tools per role.
 */
export class ClaudeCodeProvider implements AIProvider {
  readonly name = 'claude-code';

  async run(req: AgentRequest): Promise<AgentResult> {
    const tools = [...READ_TOOLS, 'TodoWrite'];
    if (req.canRunCommands) tools.push('Bash');
    if (req.canWrite) tools.push(...WRITE_TOOLS);

    const options: Options = {
      cwd: req.cwd,
      tools,
      allowedTools: tools,
      permissionMode: req.bypassPermissions ? 'bypassPermissions' : 'dontAsk',
      allowDangerouslySkipPermissions: req.bypassPermissions || undefined,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: req.systemPrompt },
      settingSources: ['user', 'project', 'local'],
      outputFormat: { type: 'json_schema', schema: req.outputSchema },
      maxTurns: req.maxTurns,
      maxBudgetUsd: req.maxBudgetUsd,
      model: req.model,
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
      throw new AgentError(`Agent stopped (${result.subtype})${detail}`, result.total_cost_usd);
    }
    if (result.structured_output === undefined) {
      throw new AgentError('Agent finished without structured output.', result.total_cost_usd);
    }
    return {
      output: result.structured_output,
      costUsd: result.total_cost_usd,
      turns: result.num_turns,
      sessionId: result.session_id,
    };
  }
}

function reportActivity(message: Extract<SDKMessage, { type: 'assistant' }>, cwd: string, onActivity?: (line: string) => void) {
  if (!onActivity || message.parent_tool_use_id) return;
  for (const block of message.message.content) {
    if (block.type !== 'tool_use') continue;
    const input = (block.input ?? {}) as Record<string, unknown>;
    const file = input.file_path ?? input.path;
    const target = typeof file === 'string' && path.isAbsolute(file) ? path.relative(cwd, file) || '.' : (file ?? input.pattern ?? input.command ?? '');
    const detail = String(target).replace(/\s+/g, ' ').slice(0, 90);
    onActivity(`${block.name}${detail ? ` ${detail}` : ''}`);
  }
}
