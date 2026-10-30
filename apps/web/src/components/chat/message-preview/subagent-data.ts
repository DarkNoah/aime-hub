import type { DynamicToolUIPart } from 'ai';
import { commandRecord } from './command-data.js';

export function parseSubagentOutput(value: unknown) {
  const original = value;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      // Older responses contain only the subagent's reply.
    }
  }
  const data = commandRecord(value);
  if (typeof data?.text !== 'string')
    return typeof original === 'string'
      ? { text: original, data: null, tools: undefined }
      : null;
  return {
    text: data.text,
    data,
    // Preserve malformed entries for a raw fallback instead of dropping them.
    tools: Array.isArray(data.subAgentToolResults)
      ? data.subAgentToolResults
      : undefined,
  };
}

/** Adapt recorded child calls for the existing, read-only preview renderers. */
export function subagentToolPart(value: unknown): DynamicToolUIPart | null {
  const data = commandRecord(value);
  if (
    typeof data?.toolName !== 'string' ||
    !data.toolName.trim() ||
    typeof data.toolCallId !== 'string' ||
    !data.toolCallId.trim() ||
    !Object.hasOwn(data, 'result') ||
    (data.isError !== undefined && typeof data.isError !== 'boolean')
  )
    return null;
  const base = {
    type: 'dynamic-tool' as const,
    toolName: data.toolName,
    toolCallId: data.toolCallId,
    input: data.args,
  };
  if (data.isError === true) {
    const error = commandRecord(data.result);
    return {
      ...base,
      state: 'output-error',
      errorText:
        typeof data.result === 'string'
          ? data.result
          : typeof error?.message === 'string'
            ? error.message
            : (JSON.stringify(data.result, null, 2) ?? ''),
    };
  }
  return { ...base, state: 'output-available', output: data.result };
}
