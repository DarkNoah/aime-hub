import { AsyncLocalStorage } from 'node:async_hooks';
import {
  generateBackgroundTaskSystemPrompt,
  type BackgroundPromptTool,
} from '@mastra/core/background-tasks';
import type { Processor } from '@mastra/core/processors';
import { RequestContext } from '@mastra/core/request-context';
import type { ToolExecutionContext } from '@mastra/core/tools';
import { jsonSchema, type Schema } from 'ai';

const dispatchContext = new AsyncLocalStorage<RequestContext>();
const commandNames = new Set(['exec', 'exec_command']);
const dispositionSchema = {
  type: ['object', 'null'],
  properties: {
    disposition: { type: 'string', enum: ['foreground', 'deferred'] },
  },
  required: ['disposition'],
  additionalProperties: false,
} satisfies Awaited<Schema['jsonSchema']>;

/** Mastra injects its generic scheduling schema when it builds a step's tools. */
async function commandParameters(schema: Schema) {
  const original = await schema.jsonSchema;
  if (!original.properties?._background) return schema;
  return jsonSchema(
    {
      ...original,
      properties: { ...original.properties, _background: dispositionSchema },
    },
    { validate: schema.validate },
  );
}

export const commandDisposition = {
  id: 'command-disposition',
  async processOutputStream({ part }) {
    if (part.type !== 'tool-call' || !commandNames.has(part.payload.toolName))
      return part;
    const input = part.payload.args;
    if (!input || typeof input !== 'object' || !('_background' in input))
      return part;
    const { _background, ...args } = input;
    // The native dispatcher reads its overrides before invoking execute().
    // Preserve the legacy boolean only when no explicit disposition was sent.
    const mode =
      _background && typeof _background === 'object' ? _background : {};
    const deferred =
      'disposition' in mode
        ? mode.disposition === 'deferred'
        : 'enabled' in mode && mode.enabled === true;
    return {
      ...part,
      payload: {
        ...part.payload,
        args: deferred
          ? { ...args, _background: { disposition: 'deferred' } }
          : args,
      },
    };
  },
} satisfies Processor;

/** Each queued execution keeps the author and browser binding of its model step. */
export function deferredToolContext(runContext?: RequestContext) {
  return {
    id: 'deferred-tool-context',
    async processInputStep({ tools, requestContext, state }) {
      const source = runContext ?? requestContext;
      if (!source || (!tools?.exec && !tools?.exec_command)) return;
      const snapshot = new RequestContext(source.entries());
      const stepTools = { ...tools };
      const promptTools = tools as Record<string, BackgroundPromptTool>;
      state.nativePrompt = generateBackgroundTaskSystemPrompt(promptTools);
      const otherTools = Object.fromEntries(
        Object.entries(promptTools).filter(([name]) => !commandNames.has(name)),
      );
      state.otherToolsPrompt = generateBackgroundTaskSystemPrompt(otherTools);
      for (const name of commandNames) {
        const tool = tools[name];
        if (!tool || typeof tool !== 'object' || !('execute' in tool)) continue;
        const execute = tool.execute;
        if (typeof execute !== 'function') continue;
        const parameters =
          'parameters' in tool &&
          tool.parameters &&
          typeof tool.parameters === 'object' &&
          'jsonSchema' in tool.parameters
            ? await commandParameters(tool.parameters as Schema)
            : undefined;
        stepTools[name] = {
          ...tool,
          ...(parameters && {
            parameters,
            ...('inputSchema' in tool && { inputSchema: parameters }),
          }),
          execute: (...args: unknown[]) =>
            dispatchContext.run(snapshot, () =>
              Reflect.apply(execute, tool, args),
            ),
        };
      }
      return { tools: stepTools };
    },
    processLLMRequest({ prompt, state }) {
      // Mastra appends a shared scheduler guide to the first system message.
      // Keep it for tools that support the full set of native scheduling options.
      const [system, ...rest] = prompt;
      if (
        system?.role !== 'system' ||
        typeof state.nativePrompt !== 'string' ||
        !state.nativePrompt ||
        !system.content.endsWith(state.nativePrompt)
      )
        return;
      const content =
        system.content.slice(0, -state.nativePrompt.length) +
        (state.otherToolsPrompt ?? '');
      return { prompt: [{ ...system, content: content.trimEnd() }, ...rest] };
    },
  } satisfies Processor;
}

export function executionRequestContext(context: ToolExecutionContext) {
  if (!context.agent?.isBackgroundTask) return context.requestContext;
  // Keep framework-injected values and use the dispatching step's application context.
  const requestContext = new RequestContext(context.requestContext?.entries());
  for (const [key, value] of dispatchContext.getStore()?.entries() ?? [])
    requestContext.set(key, value);
  return requestContext;
}
