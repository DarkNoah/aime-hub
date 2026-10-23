import { BuiltinTool } from '../../modules/tools/base.js';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { commandSandbox } from './command/sandbox.js';
import {
  commandOutputSchema,
  outputBudget,
  yieldTime,
} from './command/schema.js';

export const writeStdin = createTool({
  id: 'write_stdin',
  description: `Send input to a command session returned by exec_command and read new output. Pass chars="" (or omit it) to poll without sending input. Use a newline to submit an answer, e.g. {session_id:123, chars:"my-app\\n"}. PTY sessions accept terminal control characters such as Ctrl-C (\\u0003) to interrupt or Ctrl-D (\\u0004) for EOF. Returns session_id while running, exit_code when complete; completed sessions are released after their final output is read. Only sessions in the current conversation are accessible.`,
  inputSchema: z.object({
    session_id: z
      .number()
      .int()
      .positive()
      .describe('Session ID returned by exec_command'),
    chars: z
      .string()
      .default('')
      .describe('Input to write; empty string polls output without writing'),
    yield_time_ms: yieldTime,
    max_output_tokens: outputBudget,
  }),
  outputSchema: commandOutputSchema,
  execute: async (
    { session_id, chars, yield_time_ms, max_output_tokens },
    context,
  ) =>
    (await commandSandbox(context)).write(
      session_id,
      chars,
      yield_time_ms,
      max_output_tokens,
      context.abortSignal,
    ),
});

export class WriteStdinTool extends BuiltinTool {
  constructor() {
    super(writeStdin);
  }

  protected override create() {
    return this.tool;
  }
}
