import { z } from 'zod';

export const pluginAccessSchema = z.strictObject({
  mode: z.enum(['all', 'selected']),
  userIds: z.array(z.string().trim().min(1)),
});
export type PluginAccess = z.infer<typeof pluginAccessSchema>;
export const pluginAccessConfigurationSchema = z.strictObject({
  access: pluginAccessSchema,
  revision: z.string().min(1),
});
export type PluginAccessConfiguration = z.infer<
  typeof pluginAccessConfigurationSchema
>;
