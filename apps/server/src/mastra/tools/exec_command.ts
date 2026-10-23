import { BuiltinTool } from '../../modules/tools/base.js';
import { createTool } from '@mastra/core/tools';
import { commandSandbox } from './command/sandbox.js';
import { commandInputSchema, commandOutputSchema } from './command/schema.js';

export const execCommand = createTool({
  id: 'exec_command',
  description: `Run a shell command in the current conversation workspace. Use tty=true for interactive CLIs and terminal control characters. Returns output and exit_code when finished, or session_id when still running. Continue a running command with write_stdin; an empty chars value polls new output. yield_time_ms only controls the wait, not process lifetime. Output is incremental and bounded; truncated=true indicates omitted output. Sessions survive tool calls and turns until the workspace closes or the server restarts.`,
  inputSchema: commandInputSchema,
  outputSchema: commandOutputSchema,
  execute: async (input, context) =>
    (await commandSandbox(context)).exec(input, context.abortSignal),
});

export class ExecCommandTool extends BuiltinTool {
  constructor() {
    super(execCommand);
  }

  protected override create() {
    return this.tool;
  }
}
