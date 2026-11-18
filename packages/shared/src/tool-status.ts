import type { ToolUIPart } from 'ai';

/** Derive the visible result state without changing the original tool part. */
export function getToolDisplayState(
  state: ToolUIPart['state'],
  output?: unknown,
): ToolUIPart['state'] {
  if (state !== 'output-available') return state;
  let result = output;
  if (typeof result === 'string') {
    // Keep summary updates cheap when legacy results contain large JSON/text.
    if (result.length > 16_384) return state;
    try {
      result = JSON.parse(result) as unknown;
    } catch {
      return state;
    }
  }
  if (!result || typeof result !== 'object' || Array.isArray(result))
    return state;
  const record = result as Record<string, unknown>;
  return record.isError === true || record.ok === false
    ? 'output-error'
    : state;
}
