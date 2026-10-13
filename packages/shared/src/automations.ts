import { z } from 'zod';
import { chatSettingsSchema } from './threads.js';

export const automationScopeSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('personal') }).strict(),
  z
    .object({
      scope: z.literal('project'),
      projectId: z.string().regex(/^[a-zA-Z0-9_-]{16}$/),
    })
    .strict(),
  z.object({ scope: z.literal('system') }).strict(),
]);
export type AutomationScope = z.infer<typeof automationScopeSchema>;

export const automationStepLimits = [50, 100, 200, 300] as const;

export const automationInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    prompt: z.string().trim().min(1).max(20000),
    cron: z.string().trim().min(1).max(120),
    maxSteps: z.literal(automationStepLimits).nullable().default(null),
    separateThread: z.boolean().default(false),
    desktopNotification: z.boolean().default(false),
    settings: chatSettingsSchema,
    enabled: z.boolean(),
  })
  .strict();
export type AutomationInput = z.infer<typeof automationInputSchema>;
export type Automation = AutomationInput & {
  id: string;
  timezone: string;
  threadId: string;
  threadCreated: boolean;
  resourceId: string;
  scope: AutomationScope;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  nextFireAt: string | null;
  lastFireAt: string | null;
};
export type AutomationList = { items: Automation[]; canManage: boolean };
export type AutomationRun = {
  id: string;
  firedAt: string;
  status: 'running' | 'succeeded' | 'failed' | 'skipped';
  text: string;
  error: string | null;
};
