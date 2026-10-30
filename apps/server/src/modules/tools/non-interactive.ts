import type { ToolsInput } from '@mastra/core/agent';
import type { ToolExecutionContext } from '@mastra/core/tools';

/** Propagated through exec so deferred MCP/plugin tools use the same policy. */
export const NON_INTERACTIVE_TOOLS_CONTEXT = 'nonInteractiveTools';
const interactiveNames = new Set(['ask_user', 'submit_plan', 'intelligent_ui']);

type ToolCapabilities = {
  id?: string;
  suspendSchema?: unknown;
  resumeSchema?: unknown;
  requireApproval?: unknown;
  needsApprovalFn?: unknown;
  needsApproval?: unknown;
};

/** A conditional approval policy is still an interactive capability. */
export function isNonInteractiveTool(tool: object, name?: string): boolean {
  const capability = tool as ToolCapabilities;
  return !(
    interactiveNames.has(name ?? '') ||
    interactiveNames.has(capability.id ?? '') ||
    capability.suspendSchema != null ||
    capability.resumeSchema != null ||
    capability.requireApproval ||
    capability.needsApprovalFn ||
    capability.needsApproval
  );
}

/** Defense in depth for dynamically supplied tools without declared schemas. */
export function guardNonInteractiveTool<T extends object>(tool: T): T {
  const source = tool as T & {
    execute?: (
      input: unknown,
      context: ToolExecutionContext,
    ) => Promise<unknown>;
  };
  if (!source.execute) return tool;
  const execute = source.execute;
  const guardedExecute: typeof execute = async (input, context) => {
    context.requestContext?.set(NON_INTERACTIVE_TOOLS_CONTEXT, true);
    const suspend = async (): Promise<never> => {
      throw new Error(
        'This room does not support suspended tools. Send a room message and finish the current turn instead.',
      );
    };
    return execute.call(tool, input, {
      ...context,
      suspend,
      resumeData: undefined,
      ...(context.agent
        ? { agent: { ...context.agent, suspend, resumeData: undefined } }
        : {}),
      ...(context.workflow
        ? { workflow: { ...context.workflow, suspend, resumeData: undefined } }
        : {}),
      ...(context.mcp
        ? {
            mcp: {
              ...context.mcp,
              elicitation: { sendRequest: suspend },
              extra: { ...context.mcp.extra, sendRequest: suspend },
            },
          }
        : {}),
    });
  };
  // Some registered Tools are frozen. Replace the descriptor while creating
  // the clone instead of assigning to its copied read-only execute property.
  const descriptors = Object.getOwnPropertyDescriptors(tool);
  const original = descriptors.execute;
  return Object.create(Object.getPrototypeOf(tool), {
    ...descriptors,
    execute: {
      value: guardedExecute,
      enumerable: original?.enumerable ?? true,
      configurable: original?.configurable ?? true,
      writable: original && 'writable' in original ? original.writable : true,
    },
  }) as T;
}

export function nonInteractiveTools(tools: ToolsInput): ToolsInput {
  return Object.fromEntries(
    Object.entries(tools)
      .filter(([name, tool]) => isNonInteractiveTool(tool, name))
      .map(([name, tool]) => [name, guardNonInteractiveTool(tool)]),
  );
}
