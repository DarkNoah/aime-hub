import { randomUUID } from 'node:crypto';
import type { ToolsInput } from '@mastra/core/agent';
import {
  standardSchemaToJSONSchema,
  toStandardSchema,
} from '@mastra/core/schema';
import {
  createTool,
  isValidationError,
  validateToolInput,
  type Tool,
  type ToolExecutionContext,
  type NeedsApprovalFn,
} from '@mastra/core/tools';
import { createWorkspaceTools, createSkillTools } from '@mastra/core/workspace';
import { z } from 'zod';
import { ExecOutput, execOutputSchema } from './exec/output.js';
import { runExec } from './exec/runtime.js';

type Dependencies = {
  getTools: (context: ToolExecutionContext) => Promise<ToolsInput>;
};

/** The catalog is built at invocation time and respects global and Agent exclusions. */
export function createExecTool({ getTools }: Dependencies) {
  return createTool({
    id: 'exec',
    description: `Run JavaScript to orchestrate tools in a fresh isolated QuickJS/WASM runtime.
Pass a JavaScript function body in code (no Markdown fences); top-level await is supported.
ALL_TOOLS is an array of { name, description } for all currently available built-in, workspace and MCP tools. Globally disabled tools and this Agent's excluded tools are unavailable. MCP names start with mcp__.
Call await tools.read_file({ path: 'README.md' }) or await tools.mcp__server__tool({...}). Inspect tools[name].inputSchema for its JSON Schema. Names are normalized JavaScript identifiers; use the exact name from ALL_TOOLS.
text(value) explicitly emits text (non-strings are JSON serialized); image(value) explicitly emits an image from a base64 data URL, { image_url: dataURL }, an MCP image block, or a workspace media result. HTTP URLs are not accepted.
Only text() and image() output is returned. Return values, bare expressions, console output and nested tool results are not automatically emitted. Await all tool calls you need; unawaited work is cancelled when the script ends, but already-started external side effects cannot be rolled back.
No Node, process, require, imports, filesystem, network, console or timers are exposed. Access external capabilities through tools only. Runtime limits: 64 MiB memory, 1 second of synchronous CPU execution, at most 256 tool calls and 32 concurrent calls. yield_time_ms is a wall-clock timeout, not a background continuation. max_output_tokens is an approximate text budget (4 UTF-8 bytes/token); image output has a separate 10 MiB budget.
Disabled tools remain unavailable. Approval and suspension tools must be called directly by the Agent; exec cannot resume their interactions. exec itself is excluded from tools to prevent recursion.
Examples: text(ALL_TOOLS.filter(t => t.name.startsWith('mcp__'))); text(await tools.read_file({ path: 'README.md' })); image(await tools.read_file({ path: 'photo.png' }));`,
    inputSchema: z.object({
      code: z
        .string()
        .max(100_000)
        .describe(
          'JavaScript source body; use text() or image() to emit results',
        ),
      yield_time_ms: z
        .number()
        .int()
        .min(1)
        .max(60_000)
        .default(30_000)
        .describe(
          'Total execution timeout in milliseconds; no background continuation',
        ),
      max_output_tokens: z
        .number()
        .int()
        .min(1)
        .max(10_000)
        .default(10_000)
        .describe('Approximate text output budget; defaults to 10000 tokens'),
    }),
    outputSchema: execOutputSchema,
    execute: async ({ code, yield_time_ms, max_output_tokens }, context) => {
      const output = new ExecOutput(max_output_tokens);
      const controller = new AbortController();
      const signal = context.abortSignal
        ? AbortSignal.any([context.abortSignal, controller.signal])
        : controller.signal;
      const deadline = Date.now() + yield_time_ms;
      const timer = setTimeout(
        () => controller.abort(new Error('exec execution timed out')),
        yield_time_ms,
      );
      try {
        signal.throwIfAborted();
        const available = Promise.all([
          getTools({ ...context, abortSignal: signal }),
          context.workspace
            ? createWorkspaceTools(context.workspace, {
                workspace: context.workspace,
                requestContext: context.requestContext,
              })
            : {},
          context.browser?.getTools() ?? {},
        ]);
        const [application, workspace, browser] = await abortable(
          available,
          signal,
        );
        const skills = context.workspace?.skills
          ? createSkillTools(context.workspace.skills)
          : {};
        const catalog = new Map<string, Tool<unknown, unknown>>();
        for (const [id, candidate] of Object.entries({
          ...skills,
          ...browser,
          ...workspace,
          ...application,
        })) {
          if (!candidate || typeof candidate !== 'object') continue;
          if (id === 'exec' || !('execute' in candidate) || !candidate.execute)
            continue;
          const name = id
            .replace(/[^a-zA-Z0-9_$]/g, '_')
            .replace(/^(?=\d)/, '_');
          if (catalog.has(name))
            throw new Error(`Conflicting normalized tool name: ${name}`);
          catalog.set(name, candidate as Tool<unknown, unknown>);
        }
        await runExec({
          code,
          signal,
          deadline,
          catalog: [...catalog].map(([name, tool]) => ({
            name,
            description: tool.description ?? '',
            inputSchema: tool.inputSchema
              ? standardSchemaToJSONSchema(toStandardSchema(tool.inputSchema))
              : undefined,
          })),
          emit: (kind, value) =>
            kind === 'text' ? output.text(value) : output.image(value),
          dispatch: async (name, input) => {
            signal.throwIfAborted();
            const tool = catalog.get(name);
            if (!tool?.execute) throw new Error(`Unknown tool: ${name}`);
            const validated = validateToolInput(
              tool.inputSchema ? toStandardSchema(tool.inputSchema) : undefined,
              input,
              name,
            );
            if (validated.error) throw new Error(validated.error.message);
            const predicate =
              (tool as Tool & { needsApprovalFn?: NeedsApprovalFn })
                .needsApprovalFn ?? tool.requireApproval;
            const approval =
              typeof predicate === 'function'
                ? await predicate(validated.data, {
                    workspace: context.workspace,
                    requestContext: context.requestContext?.all,
                  })
                : predicate;
            if (approval || tool.suspendSchema)
              throw new Error(
                `${name} requires a direct Agent call for approval or suspension`,
              );
            const toolCallId = randomUUID();
            const suspend = async () => {
              throw new Error(
                `${name} cannot suspend inside exec; call it directly`,
              );
            };
            signal.throwIfAborted();
            const result = await tool.execute(input, {
              ...context,
              abortSignal: signal,
              suspend,
              resumeData: undefined,
              ...(context.agent
                ? {
                    agent: {
                      ...context.agent,
                      toolCallId,
                      suspend,
                      resumeData: undefined,
                    },
                  }
                : {}),
              ...(context.workflow
                ? {
                    workflow: {
                      ...context.workflow,
                      suspend,
                      resumeData: undefined,
                    },
                  }
                : {}),
            });
            if (isValidationError(result)) throw new Error(result.message);
            // Preserve lifecycle effects, including generated-asset registration.
            await tool.onOutput?.({
              output: result,
              toolName: name,
              toolCallId,
              abortSignal: signal,
            });
            return result;
          },
        });
      } catch (error) {
        output.error(error);
      } finally {
        clearTimeout(timer);
        controller.abort(new Error('exec execution finished'));
      }
      return output.result;
    },
    toModelOutput: (output: ExecOutput['result']) => ({
      type: 'content',
      value: output.content.map((part) =>
        part.type === 'image'
          ? { type: 'image-data', data: part.data, mediaType: part.mimeType }
          : part,
      ),
    }),
  });
}

async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([promise, cancelled]);
  } finally {
    signal.removeEventListener('abort', abort!);
  }
}

// The runtime builder supplies the current application and MCP catalogs.
export const exec = createExecTool({ getTools: async () => ({}) });
