import { z } from 'zod';
import { desktopTimeoutSchema } from './system-settings.js';

export const desktopSandboxIdSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/);
export const desktopSandboxSchema = z.object({
  id: desktopSandboxIdSchema,
  name: z.string(),
  template: z.string(),
  state: z.enum(['running', 'paused']),
  startedAt: z.string(),
  endAt: z.string(),
  cpuCount: z.number(),
  memoryMB: z.number(),
});
export type DesktopSandbox = z.infer<typeof desktopSandboxSchema>;

export const desktopSandboxCreateSchema = z
  .object({
    name: z.string().trim().default(''),
    template: z.string().trim().min(1).optional(),
    timeoutSeconds: desktopTimeoutSchema.optional(),
  })
  .strict();
export type DesktopSandboxCreate = z.infer<typeof desktopSandboxCreateSchema>;

export const desktopSandboxUpdateSchema = z
  .object({
    timeoutSeconds: desktopTimeoutSchema,
  })
  .strict();

export const desktopSandboxListSchema = z.object({
  items: z.array(desktopSandboxSchema),
  nextToken: z.string().nullable(),
});
