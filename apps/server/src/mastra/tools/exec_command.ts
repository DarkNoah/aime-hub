import { BuiltinTool } from '../../modules/tools/base.js';
import { createTool } from '@mastra/core/tools';
import { commandSandbox } from './command/sandbox.js';
import {
  commandInputSchema,
  commandOutputSchema,
  commandLimits,
} from './command/schema.js';

export const execCommand = createTool({
  id: 'exec_command',
  description: `Run a shell command in the current conversation workspace. Use tty=true for interactive CLIs and terminal control characters. Returns output and exit_code when finished, or session_id when still running. Continue a running command with write_stdin; an empty chars value polls new output. yield_time_ms only controls the wait, not process lifetime. Output is incremental and bounded; truncated=true indicates omitted output. Sessions survive tool calls and turns until the workspace closes or the server restarts.`,
  inputSchema: commandInputSchema,
  outputSchema: commandOutputSchema,
  execute: async (input, context) => {
    context.abortSignal?.throwIfAborted();
    if (!input.cmd.trim()) throw new Error('cmd must not be empty.');
    if (input.shell !== undefined && !input.shell.trim())
      throw new Error('shell must not be empty.');
    if (input.workdir !== undefined && !input.workdir.trim())
      throw new Error('workdir must not be empty.');
    const userId = context.requestContext?.get('userId');
    return (await commandSandbox(context)).exec(
      {
        ...input,
        ...commandLimits(input.yield_time_ms, input.max_output_tokens),
      },
      context.abortSignal,
      typeof userId === 'string' ? userId : undefined,
    );
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
