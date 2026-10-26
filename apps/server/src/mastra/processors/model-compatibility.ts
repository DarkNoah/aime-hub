import { createHash } from 'node:crypto';
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
  deepseek: boolean,
): ProcessLLMRequestArgs['prompt'] {
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
          providerOptions:
            sameOrigin && !deepseek ? part.providerOptions : undefined,
        },
      ];
    });
    if (!content.length) return [];
    return [
      {
        ...message,
        content,
        providerOptions:
          deepseek && message.role === 'assistant'
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

/** Use Mastra's native model routing and message hooks; no SDK or fetch wrapper. */
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
    args.state.deepseek = deepseek;
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
      providerOptions.deepseek = {
        ...options,
        thinking: { type: disabled ? 'disabled' : 'enabled' },
        ...(!disabled
          ? {
              reasoningEffort:
                effort === 'minimal' || effort === 'low'
                  ? 'low'
                  : effort === 'max' || effort === 'ultra'
                    ? 'max'
                    : 'high',
            }
          : { reasoningEffort: undefined }),
      };
    } else if (config?.api === 'responses') {
      providerOptions.openai = { ...providerOptions.openai, store: false };
    }
    return {
      // The native compatible chat adapter round-trips reasoning_content. The
      // Responses adapter currently drops DeepSeek's reasoning_text events.
      model: deepseek
        ? { ...config!, providerId: 'deepseek', api: 'chat' }
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
      prompt: compatiblePrompt(prompt, state.scope, state.deepseek === true),
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
