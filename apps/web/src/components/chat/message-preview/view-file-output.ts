import { z } from 'zod';

const outputSchema = z.object({
  ok: z.boolean(),
  isError: z.boolean().optional(),
  file_path: z.string(),
  mimeType: z.string().optional(),
  model: z.string().optional(),
  truncated: z.boolean().optional(),
  format: z.enum(['markdown', 'text']).optional(),
  startLine: z.number().optional(),
  endLine: z.number().optional(),
  totalLines: z.number().optional(),
  nextOffset: z.number().optional(),
  warnings: z.array(z.string()).optional(),
  content: z.array(
    z.discriminatedUnion('type', [
      z.object({ type: z.literal('text'), text: z.string() }),
      z.object({
        type: z.literal('image'),
        data: z.string(),
        mimeType: z.string(),
      }),
    ]),
  ),
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
    text: result.data.content
      .filter((part) => part.type === 'text')
      .map(({ text }) => text)
      .join('\n\n'),
  };
}
