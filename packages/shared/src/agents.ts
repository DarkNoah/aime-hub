import { z } from 'zod';
import type { InstalledSkill } from './skills.js';

import { toolIdSchema } from './tools.js';

export type AgentToolId = string;

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
  // Retained for existing stored versions; runtime tools are managed globally.
  tools: z
    .array(toolIdSchema)
    .max(128)
    .refine((values) => new Set(values).size === values.length)
    .default([]),
  // Global tools are inherited; an Agent only stores its exclusions.
  disabledTools: z
    .array(toolIdSchema)
    .max(128)
    .refine((values) => new Set(values).size === values.length)
    .default([]),
  skillsMode: z.enum(['auto', 'custom']).default('auto'),
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
