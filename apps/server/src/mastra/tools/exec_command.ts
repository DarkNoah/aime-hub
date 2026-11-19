import { BuiltinTool } from '../../modules/tools/base.js';
import { createTool } from '@mastra/core/tools';
import { executionRequestContext } from '../processors/deferred-tool-context.js';
import { commandSandbox } from './command/sandbox.js';
import {
  commandInputSchema,
  commandOutputSchema,
  commandLimits,
} from './command/schema.js';

export const execCommand = createTool({
  id: 'exec_command',
  description: `Run a shell command in the current conversation workspace. In the default foreground mode, return output and exit_code when finished, or session_id after yield_time_ms if still running. Continue a session with write_stdin; an empty chars value polls new output. Use foreground mode for commands that need input and tty=true for interactive CLIs. Sessions survive tool calls and turns until the workspace closes or the server restarts. For long commands that can finish unattended, call exec_command directly with _background: { disposition: "deferred" }. Mastra reports the final output and exit_code when the command exits, even if it outlasts yield_time_ms. Output in either mode is bounded; truncated=true indicates omitted output.`,
  background: {
    enabled: true,
    defaultDisposition: 'deferred',
    timeoutMs: 0,
    maxRetries: 0,
  },
  inputSchema: commandInputSchema,
  outputSchema: commandOutputSchema,
  execute: async (input, context) => {
    const startedAt = performance.now();
    const { abortSignal } = context;
    const backgroundTask = context.agent?.isBackgroundTask;
    try {
      abortSignal?.throwIfAborted();
      if (!input.cmd.trim()) throw new Error('cmd must not be empty.');
      if (input.shell !== undefined && !input.shell.trim())
        throw new Error('shell must not be empty.');
      if (input.workdir !== undefined && !input.workdir.trim())
        throw new Error('workdir must not be empty.');
      const userId = executionRequestContext(context)?.get('userId');
      const sandbox = await commandSandbox(context);
      return await sandbox.exec(
        {
          ...input,
          ...commandLimits(input.yield_time_ms, input.max_output_tokens),
        },
        {
          signal: abortSignal,
          userId: typeof userId === 'string' ? userId : undefined,
          backgroundTask,
        },
      );
    } catch (error) {
      if (!abortSignal?.aborted) throw error;
      if (backgroundTask) abortSignal.throwIfAborted();
      const output = '用户中止了操作';
      return {
        output,
        exit_code: 130,
        wall_time_seconds: (performance.now() - startedAt) / 1000,
        original_token_count: Math.ceil(Buffer.byteLength(output) / 4),
        truncated: false,
      };
    }
  },
});

export class ExecCommandTool extends BuiltinTool {
  constructor() {
    super(execCommand);
  }

  protected override create() {
    return this.tool;
  }
}
