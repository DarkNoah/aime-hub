import { createTool, type ToolExecutionContext } from '@mastra/core/tools';
import { z } from 'zod';
import { BuiltinTool } from '../../modules/tools/base.js';
import { withAbortSignal } from '../../lib/abort.js';
import {
  commandSandbox,
  UnknownCommandSessionError,
} from './command/sandbox.js';
import {
  commandOutputSchema,
  outputBudget,
  commandLimits,
  interruptedCommand,
} from './command/schema.js';

/** A queued or finished task can have a durable row without a live shell. */
async function taskStatus(
  id: string,
  chars: string,
  terminate: boolean,
  context: ToolExecutionContext,
) {
  const manager = context.mastra?.backgroundTaskManager;
  const agent = context.agent;
  if (!manager || !agent?.threadId || !agent.resourceId)
    throw new UnknownCommandSessionError(id);
  let task = await manager.getTask(id);
  if (
    !task ||
    task.toolName !== 'exec_command' ||
    task.threadId !== agent.threadId ||
    task.resourceId !== agent.resourceId
  )
    throw new UnknownCommandSessionError(id);
  if (terminate) {
    await manager.cancel(id);
    task = await manager.getTask(id);
    if (!task) throw new UnknownCommandSessionError(id);
  }
  if (chars)
    throw new Error(
      `Command task is ${task.status}; input was not sent. Send input when the command is running.`,
    );
  // The task manager delivers the final process transcript separately.
  const status = task.status;
  const active = status === 'pending' || status === 'running';
  return {
    status,
    ...(active ? { session_id: id } : {}),
    output: task.error?.message ?? '',
    exit_code:
      status === 'completed'
        ? commandOutputSchema.safeParse(task.result).data?.exit_code
        : undefined,
    wall_time_seconds: 0,
    original_token_count: Math.ceil(
      Buffer.byteLength(task.error?.message ?? '') / 4,
    ),
    truncated: false,
  };
}

export const writeStdin = createTool({
  id: 'write_stdin',
  description: `Interact with an exec_command in the current conversation. Pass its numeric session_id or native background taskId as session_id. Omit chars to read new output, or send text including a newline to answer a prompt. Set terminate=true to stop the process and its children, including non-PTY commands, or to cancel a queued task. Background completion is delivered automatically with its final output. PTY control characters retain their terminal meaning.`,
  inputSchema: z.object({
    session_id: z
      .union([z.number(), z.string()])
      .describe(
        'Numeric command session_id or string exec_command background taskId',
      ),
    chars: z
      .string()
      .default('')
      .describe('Input to send; empty reads new output'),
    terminate: z
      .boolean()
      .optional()
      .describe('Stop the command or cancel a queued task'),
    yield_time_ms: z
      .number()
      .optional()
      .describe(
        'Optional maximum wait for output in milliseconds. Background reads default to immediate, numeric sessions default to 10000.',
      ),
    max_output_tokens: outputBudget,
  }),
  outputSchema: commandOutputSchema,
  execute: async (
    { session_id, chars, terminate = false, yield_time_ms, max_output_tokens },
    context,
  ) => {
    const startedAt = performance.now();
    const signal = context.abortSignal;
    try {
      signal?.throwIfAborted();
      if (
        typeof session_id === 'number'
          ? !Number.isSafeInteger(session_id) || session_id <= 0
          : !session_id.trim()
      )
        throw new Error(
          'Pass the session_id or taskId returned by exec_command.',
        );
      if (terminate && chars)
        throw new Error('Send input and terminate in separate calls.');
      const limits = commandLimits(yield_time_ms, max_output_tokens);
      const nativeId = typeof session_id === 'string';
      if (nativeId && terminate && context.mastra?.backgroundTaskManager)
        return await withAbortSignal(signal, () =>
          taskStatus(session_id, chars, true, context),
        );
      try {
        return await (
          await commandSandbox(context)
        ).write(
          session_id,
          chars,
          yield_time_ms === 0
            ? 0
            : (limits.yield_time_ms ?? (nativeId ? 0 : 10000)),
          limits.max_output_tokens,
          signal,
          terminate,
        );
      } catch (error) {
        if (!(error instanceof UnknownCommandSessionError) || !nativeId)
          throw error;
        return await withAbortSignal(signal, () =>
          taskStatus(session_id, chars, terminate, context),
        );
      }
    } catch (error) {
      if (signal?.aborted) return interruptedCommand(startedAt);
      throw error;
    }
  },
});

export class WriteStdinTool extends BuiltinTool {
  constructor() {
    super(writeStdin);
  }

  protected override create() {
    return this.tool;
  }
}
