import { z } from 'zod';

const outputSchema = z.object({
  ok: z.boolean(),
  isError: z.boolean().optional(),
  file_path: z.string(),
  mimeType: z.string().optional(),
  model: z.string().optional(),
  truncated: z.boolean().optional(),
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
});

export function parseViewFileOutput(value: unknown) {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const result = outputSchema.safeParse(value);
  if (!result.success) return null;
  return {
    ...result.data,
    isError: !result.data.ok || result.data.isError === true,
    text: result.data.content.map(({ text }) => text).join('\n\n'),
  };
}
