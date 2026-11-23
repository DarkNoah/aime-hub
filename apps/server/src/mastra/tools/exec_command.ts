import { BuiltinTool } from '../../modules/tools/base.js';
import { createTool } from '@mastra/core/tools';
import { executionRequestContext } from '../processors/deferred-tool-context.js';
import { commandSandbox } from './command/sandbox.js';
import {
  commandInputSchema,
  commandOutputSchema,
  commandLimits,
  interruptedCommand,
} from './command/schema.js';

export const execCommand = createTool({
  id: 'exec_command',
  description: `Run a shell command in the current conversation workspace. By default wait until exit and return bounded output and exit_code. To wait briefly, pass yield_time_ms: a running command returns a numeric session_id for write_stdin. For background work call exec_command directly with _background: { disposition: "deferred" }; this takes precedence over yield_time_ms. The agent immediately receives a taskId, and Mastra delivers the final output on completion. Use that taskId with write_stdin only for input, on-demand output or termination. Submit unattended work once and await the notification. Use tty=true for terminal programs.`,
  background: {
    enabled: true,
    defaultDisposition: 'foreground',
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
          taskId: context.background?.taskId,
        },
      );
    } catch (error) {
      if (!abortSignal?.aborted) throw error;
      if (backgroundTask) abortSignal.throwIfAborted();
      return interruptedCommand(startedAt);
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
