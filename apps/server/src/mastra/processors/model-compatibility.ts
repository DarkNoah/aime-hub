import { createHash } from 'node:crypto';
import { createDeepSeekResponsesModel } from '../providers/deepseek.js';
import type { OpenAICompatibleConfig } from '@mastra/core/llm';
import type {
  Processor,
  ProcessInputStepArgs,
  ProcessInputStepResult,
  ProcessLLMRequestArgs,
  ProcessLLMRequestResult,
  ProcessOutputStreamArgs,
} from '@mastra/core/processors';

type Selection = {
  reference: string;
  model: NonNullable<ProcessInputStepResult['model']>;
  providerOptions?: ProcessInputStepArgs['providerOptions'];
  modelSettings?: ProcessInputStepArgs['modelSettings'];
};
type CompatibleConfig = Extract<OpenAICompatibleConfig, { providerId: string }>;

function compatibleConfig(
  model: Selection['model'],
): CompatibleConfig | undefined {
  if (typeof model === 'object' && 'providerId' in model) return model;
}

/** Item IDs and encrypted reasoning belong to one account, endpoint and model. */
export function modelResponseScope({ reference, model }: Selection) {
  const config = compatibleConfig(model);
  return createHash('sha256')
    .update(
      JSON.stringify([
        reference.slice(0, reference.indexOf('/')),
        config?.url?.replace(/\/+$/, '') ?? '',
        config?.apiKey ?? '',
        config?.modelId ?? reference.slice(reference.indexOf('/') + 1),
      ]),
    )
    .digest('hex');
}

/** Only changes outbound history; stored parts retain their original provenance. */
export function compatiblePrompt(
  prompt: ProcessLLMRequestArgs['prompt'],
  scope: string,
  deepseekChat: boolean,
): ProcessLLMRequestArgs['prompt'] {
  const failedCalls = new Set(
    prompt.flatMap((message) =>
      message.role === 'tool'
        ? message.content.flatMap((part) =>
            part.type === 'tool-result' &&
            (part.output.type === 'error-text' ||
              part.output.type === 'error-json')
              ? [part.toolCallId]
              : [],
          )
        : [],
    ),
  );
  return prompt.flatMap((message): ProcessLLMRequestArgs['prompt'] => {
    if (message.role !== 'assistant' && message.role !== 'tool')
      return [message];
    const content = message.content.flatMap((part) => {
      const sameOrigin = part.providerOptions?.responseOrigin?.scope === scope;
      // Legacy unmarked reasoning cannot safely be attributed to this model.
      if (part.type === 'reasoning' && !sameOrigin) return [];
      return [
        {
          ...part,
          // Mastra discards unparseable arguments but retains the error result.
          // Keep that failed call valid on the wire so the model can correct it.
          // This only repairs outbound history; it never executes a placeholder.
          ...(part.type === 'tool-call' &&
          part.input === undefined &&
          failedCalls.has(part.toolCallId)
            ? { input: {} }
            : {}),
          providerOptions:
            sameOrigin && !deepseekChat ? part.providerOptions : undefined,
        },
      ];
    });
    if (!content.length) return [];
    return [
      {
        ...message,
        content,
        providerOptions:
          deepseekChat && message.role === 'assistant'
            ? {
                openaiCompatible: {
                  // Old or foreign turns have no DeepSeek reasoning. An explicit empty
                  // field keeps them valid without fabricating or replaying foreign thoughts.
                  reasoning_content: content
                    .flatMap((part) =>
                      part.type === 'reasoning' ? [part.text] : [],
                    )
                    .join(''),
                },
              }
            : undefined,
      } as ProcessLLMRequestArgs['prompt'][number],
    ];
  });
}

/** Scope replay metadata and select the provider's native wire format per step. */
export class ModelCompatibilityProcessor implements Processor {
  readonly id = 'model-compatibility';

  constructor(
    private readonly select: (
      args: ProcessInputStepArgs,
    ) => Selection | Promise<Selection>,
  ) {}

  async processInputStep(
    args: ProcessInputStepArgs,
  ): Promise<ProcessInputStepResult> {
    args.abortSignal?.throwIfAborted();
    const selection = await this.select(args);
    args.abortSignal?.throwIfAborted();
    const config = compatibleConfig(selection.model);
    const deepseek =
      !!config &&
      (config.providerId === 'deepseek' ||
        /(?:^|\/)deepseek(?:[-/:]|$)/i.test(config.modelId) ||
        /^https?:\/\/api\.deepseek\.com(?:\/|$)/i.test(config.url ?? ''));
    args.state.scope = modelResponseScope(selection);
    const deepseekResponses = deepseek && config.api === 'responses';
    args.state.deepseekChat = deepseek && !deepseekResponses;
    const providerOptions: NonNullable<Selection['providerOptions']> = {
      ...selection.providerOptions,
    };
    if (deepseek) {
      const options = providerOptions.deepseek;
      const effort =
        providerOptions.openai?.reasoningEffort ?? options?.reasoningEffort;
      const disabled =
        effort === 'none' ||
        (typeof options?.thinking === 'object' &&
          options.thinking !== null &&
          'type' in options.thinking &&
          options.thinking.type === 'disabled');
      const reasoningEffort = disabled
        ? 'none'
        : effort === 'minimal' || effort === 'low'
          ? 'low'
          : effort === 'max' || effort === 'ultra'
            ? 'max'
            : 'high';
      providerOptions.deepseek = deepseekResponses
        ? { reasoningEffort }
        : {
            ...options,
            thinking: { type: disabled ? 'disabled' : 'enabled' },
            reasoningEffort: disabled ? undefined : reasoningEffort,
          };
    } else if (config?.api === 'responses') {
      providerOptions.openai = { ...providerOptions.openai, store: false };
    }
    return {
      // Open Responses preserves reasoning_text and serializes tool images as
      // input_image. Honor the selected protocol instead of forcing Chat.
      model: deepseekResponses
        ? await createDeepSeekResponsesModel(config)
        : deepseek
          ? { ...config!, providerId: 'deepseek' }
          : selection.model,
      providerOptions,
      ...(selection.modelSettings
        ? { modelSettings: selection.modelSettings }
        : {}),
    };
  }

  processLLMRequest({
    prompt,
    state,
  }: ProcessLLMRequestArgs): ProcessLLMRequestResult {
    if (typeof state.scope !== 'string') return;
    return {
      prompt: compatiblePrompt(
        prompt,
        state.scope,
        state.deepseekChat === true,
      ),
    };
  }

  async processOutputStream({ part, state }: ProcessOutputStreamArgs) {
    if (typeof state.scope !== 'string') return part;
    switch (part.type) {
      case 'text-start':
      case 'text-delta':
      case 'text-end':
      case 'reasoning-start':
      case 'reasoning-delta':
      case 'reasoning-end':
      case 'tool-call':
      case 'tool-result':
        return {
          ...part,
          payload: {
            ...part.payload,
            providerMetadata: {
              ...part.payload.providerMetadata,
              responseOrigin: { scope: state.scope },
            },
          },
        } as typeof part;
      default:
        return part;
    }
  }
}
