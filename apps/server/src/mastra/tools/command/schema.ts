import { z } from 'zod';

export const outputBudget = z
  .number()
  .int()
  .min(1)
  .max(100_000)
  .default(10_000)
  .describe(
    'Maximum returned output tokens, approximated as 4 UTF-8 bytes per token; default 10000, capped at 100000',
  );
export const yieldTime = z
  .number()
  .int()
  .min(250)
  .max(30_000)
  .default(10_000)
  .describe(
    'Milliseconds to wait before returning (250–30000, default 10000). Does not terminate the process.',
  );

export const commandInputSchema = z.object({
  cmd: z.string().min(1).describe('Shell command to execute'),
  workdir: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Working directory; defaults to the current conversation workspace. Relative paths resolve from that directory.',
    ),
  shell: z
    .string()
    .min(1)
    .optional()
    .describe('Shell executable path; defaults to the user shell'),
  login: z
    .boolean()
    .default(true)
    .describe('Use login shell semantics; default true'),
  tty: z
    .boolean()
    .default(false)
    .describe('Allocate a real PTY for interactive CLIs; default false'),
  yield_time_ms: yieldTime,
  max_output_tokens: outputBudget,
});

export const commandOutputSchema = z.object({
  output: z.string(),
  session_id: z.number().int().optional(),
  exit_code: z.number().int().optional(),
  wall_time_seconds: z.number(),
  original_token_count: z.number().int(),
  truncated: z.boolean(),
});

export type CommandInput = z.infer<typeof commandInputSchema>;
