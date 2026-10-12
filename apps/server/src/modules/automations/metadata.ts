import { z } from 'zod';
import {
  automationInputSchema,
  automationScopeSchema,
  type AutomationScope,
} from '@aime/shared/automations';

export const automationAgentId = 'scheduled-task';
export const legacyWorkflowId = 'automation-task';
export const metadataSchema = z.object({
  managedBy: z.literal('automations'),
  version: z.literal(2),
  ownerId: z.string().min(1),
  scope: automationScopeSchema,
  data: automationInputSchema,
  threadId: z.string().regex(/^schedule:[a-zA-Z0-9_-]{16}$/),
  // Earlier v2 schedules eagerly created their thread.
  threadCreated: z.boolean().default(true),
  resourceId: z.string().min(1),
});
export const legacyMetadataSchema = metadataSchema
  .omit({ threadId: true, threadCreated: true, resourceId: true })
  .extend({
    version: z.literal(1),
    data: automationInputSchema
      .extend({ timezone: z.string().optional() })
      .strip(),
  });
export type AutomationMetadata = z.infer<typeof metadataSchema>;
export const systemTimezone = () =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
export const automationResource = (scope: AutomationScope, ownerId: string) =>
  scope.scope === 'personal'
    ? `user:${ownerId}`
    : scope.scope === 'project'
      ? `project:${scope.projectId}`
      : 'system:automations';
