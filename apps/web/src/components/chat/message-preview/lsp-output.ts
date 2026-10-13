import { z } from 'zod';

const lspOutputSchema = z.strictObject({
  hover: z.object({ value: z.string(), kind: z.string() }).optional(),
  diagnostics: z
    .array(
      z.object({
        severity: z.string(),
        message: z.string(),
        source: z.string().nullable(),
      }),
    )
    .optional(),
  definition: z
    .array(
      z.object({
        location: z.string(),
        preview: z.string().nullable(),
      }),
    )
    .optional(),
  implementation: z.array(z.string()).optional(),
  error: z.string().optional(),
});

// Persisted tool outputs may be JSON strings. Preserve unfamiliar/truncated
// payloads through the generic ToolOutput instead of silently dropping fields.
export function parseLspOutput(output: unknown) {
  let value = output;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const result = lspOutputSchema.safeParse(value);
  return result.success ? result.data : null;
}
