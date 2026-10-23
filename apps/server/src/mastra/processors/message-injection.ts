import type {
  Processor,
  ProcessLLMRequestArgs,
  ProcessLLMRequestResult,
} from '@mastra/core/processors';

type Prompt = ProcessLLMRequestArgs['prompt'];
export type InjectedMessage = Extract<
  Prompt[number],
  { role: 'system' | 'user' }
>;
type MessageSource = (
  args: ProcessLLMRequestArgs,
) => readonly InjectedMessage[] | Promise<readonly InjectedMessage[]>;

/** Keep system context first and user context before the conversation history. */
export function injectMessages(
  prompt: Prompt,
  messages: readonly InjectedMessage[],
): Prompt {
  if (!messages.length) return prompt;
  const firstConversation = prompt.findIndex(
    (message) => message.role !== 'system',
  );
  const boundary = firstConversation === -1 ? prompt.length : firstConversation;
  return [
    ...messages.filter((message) => message.role === 'system'),
    ...prompt.slice(0, boundary),
    ...messages.filter((message) => message.role === 'user'),
    ...prompt.slice(boundary),
  ];
}

/** Resolve fresh context per provider call without modifying persisted messages. */
export class MessageInjectionProcessor implements Processor {
  constructor(
    readonly id: string,
    private readonly source: MessageSource,
  ) {}

  async processLLMRequest(
    args: ProcessLLMRequestArgs,
  ): Promise<ProcessLLMRequestResult> {
    args.abortSignal?.throwIfAborted();
    const messages = await this.source(args);
    args.abortSignal?.throwIfAborted();
    if (!messages.length) return;
    return { prompt: injectMessages(args.prompt, messages) };
  }
}
