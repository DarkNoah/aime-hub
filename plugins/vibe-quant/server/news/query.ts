import { z } from 'zod';

const cursorSchema = z.object({
  time: z.number().positive().finite(),
  id: z.string().regex(/^[a-f0-9]{64}$/),
});

export function parseNewsCursor(cursor?: string) {
  if (!cursor) return undefined;
  return cursorSchema.parse(
    JSON.parse(Buffer.from(cursor, 'base64url').toString()),
  );
}
