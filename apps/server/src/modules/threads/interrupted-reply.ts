import type {
  Processor,
  ProcessInputStepArgs,
  ProcessOutputResultArgs,
} from '@mastra/core/processors';

/** Cancellation and deadline cleanup can save the current step under a fresh ID. */
export class InterruptedReplyProcessor implements Processor {
  readonly id = 'interrupted-reply';

  constructor(private readonly aliases: Map<string, string>) {}

  processInputStep({ state, messageId, messageList }: ProcessInputStepArgs) {
    state.messageId = messageId;
    state.previousTail = messageList.getPersisted.response.db().at(-1)?.id;
  }

  processOutputResult({
    result,
    messages,
    messageList,
    state,
  }: ProcessOutputResultArgs) {
    if (
      (result.finishReason === 'aborted' || result.finishReason === 'error') &&
      typeof state.messageId === 'string'
    ) {
      const partial = messages.at(-1);
      const parts = partial?.content.parts;
      if (
        partial?.role === 'assistant' &&
        partial.id !== state.messageId &&
        partial.id !== state.previousTail &&
        parts?.length === 1 &&
        parts[0].type === 'text' &&
        parts[0].text &&
        result.text.endsWith(parts[0].text)
      ) {
        this.aliases.set(partial.id, state.messageId);
      }
    }
    return messageList;
  }
}
