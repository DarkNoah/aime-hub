import { z } from 'zod';
import type { InstalledSkill } from './skills.js';

/** Explicit application tools. Workspace/browser tools are supplied by the runtime. */
export const agentToolIds = [
  'exec',
  'web_search',
  'web_fetch',
  'image_gen',
  'curr_time',
  'sleep',
  'ask_user',
  'task_write',
  'task_update',
  'task_complete',
  'task_check',
  'submit_plan',
] as const;
export type AgentToolId = (typeof agentToolIds)[number];

const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => !value.includes('\0'));
const skillPath = text(512)
  .min(1)
  .refine(
    (value) =>
      !value.includes('\\') &&
      value.split('/').every((part) => part && part !== '.' && part !== '..'),
  );
export const agentInputSchema = z.strictObject({
  name: text(100).trim().min(1),
  description: text(1000).trim().default(''),
  // Preserve prompt whitespace verbatim.
  instructions: text(24000).refine((value) => value.trim().length > 0),
  model: text(512)
    .min(1)
    .refine((value) => value.indexOf('/') > 0 && !value.endsWith('/'))
    .nullable(),
  tools: z
    .array(z.enum(agentToolIds))
    .max(agentToolIds.length)
    .refine((values) => new Set(values).size === values.length),
  skillPaths: z
    .array(skillPath)
    .max(100)
    .refine((values) => new Set(values).size === values.length),
});
export const agentUpdateSchema = agentInputSchema.extend({
  versionId: z.string().uuid(),
});
export const agentStatusSchema = z.strictObject({
  status: z.enum(['draft', 'published']),
  versionId: z.string().uuid(),
});
export type AgentStatusInput = z.infer<typeof agentStatusSchema>;
export type AgentInput = z.input<typeof agentInputSchema>;
export type AgentUpdate = z.input<typeof agentUpdateSchema>;
export const agentIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,99}$/);
export const agentDefaultsSchema = z.strictObject({
  defaultAgentId: agentIdSchema,
});
export type AgentDefaults = z.infer<typeof agentDefaultsSchema>;
export type AgentDefinition = z.output<typeof agentInputSchema> & {
  id: string;
};
export type CodeAgent = AgentDefinition & { source: 'code' };
export type ManagedAgent = z.output<typeof agentInputSchema> & {
  source: 'database';
  id: string;
  status: 'draft' | 'published' | 'archived';
  versionId: string;
  versionNumber: number;
  createdAt: string;
  updatedAt: string;
};
export type AdminAgent = ManagedAgent | CodeAgent;
export type AvailableAgent = Pick<
  AgentDefinition,
  'id' | 'name' | 'description' | 'model'
> & { source: AdminAgent['source'] };
export type AvailableAgents = AgentDefaults & { agents: AvailableAgent[] };
export type AgentCatalog = {
  tools: { id: AgentToolId; enabled: boolean }[];
  skills: InstalledSkill[];
};
