import type { MastraDBMessage } from '@mastra/core/agent';
import type { Processor, ProcessInputStepArgs } from '@mastra/core/processors';

const interruptedToolError =
  'Tool execution was interrupted or terminated before a result was recorded. ' +
  'The outcome is unknown. Check the current state before retrying.';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Preserve real outcomes and calls owned by approval, suspension, or background execution. */
function protectedCalls(messages: MastraDBMessage[]) {
  const pending = new Set<string>();
  for (const message of messages) {
    const metadata = message.content.metadata;
    for (const key of [
      'suspendedTools',
      'pendingToolApprovals',
      'backgroundTasks',
    ]) {
      for (const [id, value] of Object.entries(record(metadata?.[key]))) {
        pending.add(id);
        const entry = record(value);
        if (typeof entry.toolCallId === 'string') pending.add(entry.toolCallId);
      }
    }
    for (const part of message.content.parts) {
      if (
        part.type === 'tool-invocation' &&
        part.toolInvocation.state !== 'call' &&
        part.toolInvocation.state !== 'partial-call'
      )
        pending.add(part.toolInvocation.toolCallId);
      if (
        part.type === 'data-tool-call-suspended' ||
        part.type === 'data-tool-call-approval'
      ) {
        const data = record(part.data);
        if (typeof data.toolCallId === 'string') pending.add(data.toolCallId);
      }
    }
  }
  return pending;
}

/** Complete interrupted local calls before native prompt conversion drops them. */
export class IncompleteToolCallsProcessor implements Processor {
  readonly id = 'incomplete-tool-calls';

  processInputStep({ messageList, abortSignal }: ProcessInputStepArgs) {
    abortSignal?.throwIfAborted();
    const messages = messageList.get.all.db();
    const pending = protectedCalls(messages);
    for (const message of messages) {
      if (message.role !== 'assistant') continue;
      for (const part of message.content.parts) {
        if (part.type !== 'tool-invocation' || part.providerExecuted) continue;
        const invocation = part.toolInvocation;
        if (
          (invocation.state !== 'call' &&
            invocation.state !== 'partial-call') ||
          !invocation.toolCallId ||
          !invocation.toolName ||
          pending.has(invocation.toolCallId)
        )
          continue;
        // Native merging retains arguments/provider metadata and schedules the
        // repaired message for persistence, so history and UI agree with the prompt.
        messageList.updateToolInvocation({
          ...part,
          toolInvocation: {
            ...invocation,
            state: 'output-error',
            errorText: interruptedToolError,
          },
        });
      }
    }
    return messageList;
  }
}
