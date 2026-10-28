import { z } from 'zod';
import { isToolUIPart, type UIMessage } from 'ai';

export const INTELLIGENT_UI_TOOL = 'IntelligentUI';
export const INTELLIGENT_UI_CHANNEL = 'intelligent-ui';
export const INTELLIGENT_UI_MAX_RESPONSE = 60_000;

export function isIntelligentUiPart(part: UIMessage['parts'][number]) {
  return (
    isToolUIPart(part) &&
    (part.type === 'dynamic-tool' ? part.toolName : part.type.slice(5)) ===
      INTELLIGENT_UI_TOOL
  );
}

export function isCompletedIntelligentUiPart(part: UIMessage['parts'][number]) {
  return (
    isToolUIPart(part) &&
    isIntelligentUiPart(part) &&
    (part.state === 'output-available' ||
      part.state === 'output-error' ||
      part.state === 'output-denied')
  );
}

export const intelligentUiInputSchema = z.object({
  html: z
    .string()
    .describe('Self-contained HTML fragment with inline CSS and JavaScript.'),
  // Model providers may persist omitted optional arguments as explicit nulls.
  title: z.string().nullish().describe('Short title for the panel.'),
  tips: z
    .string()
    .nullish()
    .describe('Concise instructions shown above the panel.'),
  waitForResponse: z
    .boolean()
    .nullish()
    .describe(
      'Set true to wait for user data; omit or use false for display-only content.',
    ),
});

// Keep the native resume JSON Schema simple; RPC validation already requires JSON.
export const intelligentUiResumeSchema = z.record(z.string(), z.unknown());

export function parseIntelligentUiResponse(value: unknown) {
  const result = z.record(z.string(), z.json()).parse(value);
  if (JSON.stringify(result).length > INTELLIGENT_UI_MAX_RESPONSE)
    throw new Error(
      'Interaction data is too large. Submit only the selected values.',
    );
  return result;
}
