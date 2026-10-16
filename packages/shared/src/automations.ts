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
export const automationSchema = automationInputSchema.extend({
  id: z.string(),
  timezone: z.string(),
  threadId: z.string(),
  threadCreated: z.boolean(),
  resourceId: z.string(),
  scope: automationScopeSchema,
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  nextFireAt: z.string().nullable(),
  lastFireAt: z.string().nullable(),
});
export type Automation = z.infer<typeof automationSchema>;
export type AutomationList = { items: Automation[]; canManage: boolean };
export const automationRunSchema = z.object({
  id: z.string(),
  firedAt: z.string(),
  status: z.enum(['running', 'succeeded', 'failed', 'skipped']),
  text: z.string(),
  error: z.string().nullable(),
});
export type AutomationRun = z.infer<typeof automationRunSchema>;

// Remove defaults before making fields optional: patches must preserve omitted values.
export const automationSettingsPatchSchema = chatSettingsSchema
  .partial()
  .extend({
    model: chatSettingsSchema.shape.model.removeDefault().optional(),
    reasoningEffort: chatSettingsSchema.shape.reasoningEffort
      .removeDefault()
      .optional(),
  });
export const automationPatchSchema = automationInputSchema.partial().extend({
  maxSteps: automationInputSchema.shape.maxSteps.removeDefault().optional(),
  separateThread: automationInputSchema.shape.separateThread
    .removeDefault()
    .optional(),
  desktopNotification: automationInputSchema.shape.desktopNotification
    .removeDefault()
    .optional(),
  settings: automationSettingsPatchSchema.optional(),
});
export type AutomationPatch = z.infer<typeof automationPatchSchema>;

export const automationToolNames = [
  'automation_list',
  'automation_get',
  'automation_save',
  'automation_delete',
  'automation_run',
  'automation_history',
] as const;

export const automationToolResultSchema = z.union([
  z.object({
    items: z.array(automationSchema),
    canManage: z.boolean(),
    timezone: z.string(),
  }),
  z.object({
    automation: automationSchema,
    requested: z.literal(true).optional(),
    runs: z.array(automationRunSchema).optional(),
  }),
  z.object({ id: z.string(), deleted: z.literal(true) }),
]);
