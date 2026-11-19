import { AsyncLocalStorage } from 'node:async_hooks';
import type { Processor } from '@mastra/core/processors';
import { RequestContext } from '@mastra/core/request-context';
import type { ToolExecutionContext } from '@mastra/core/tools';

const dispatchContext = new AsyncLocalStorage<RequestContext>();

/** Each queued execution keeps the author and browser binding of its model step. */
export function deferredToolContext(runContext?: RequestContext) {
  return {
    id: 'deferred-tool-context',
    processInputStep({ tools, requestContext }) {
      const source = runContext ?? requestContext;
      if (!source || (!tools?.exec && !tools?.exec_command)) return;
      const snapshot = new RequestContext(source.entries());
      const stepTools = { ...tools };
      for (const name of ['exec', 'exec_command']) {
        const tool = tools[name];
        if (!tool || typeof tool !== 'object' || !('execute' in tool)) continue;
        const execute = tool.execute;
        if (typeof execute !== 'function') continue;
        stepTools[name] = {
          ...tool,
          execute: (...args: unknown[]) =>
            dispatchContext.run(snapshot, () =>
              Reflect.apply(execute, tool, args),
            ),
        };
      }
      return { tools: stepTools };
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
