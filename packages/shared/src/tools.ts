import { z } from 'zod';

// Add a schema and runtime factory for each newly configurable tool.
export const toolIds = ['web_search', 'web_fetch'] as const;
export const toolIdSchema = z.enum(toolIds);
export const webSearchConfigSchema = z.strictObject({
  enabled: z.boolean().default(true),
  providerId: z.string().min(1).max(128).nullable().default(null),
  numResults: z.number().int().min(1).max(20).default(10),
  timeoutMs: z.number().int().min(1000).max(60000).default(15000),
});
export const webFetchConfigSchema = z.strictObject({
  enabled: z.boolean().default(true),
  providerId: z.string().min(1).max(128).nullable().default(null),
  timeoutMs: z.number().int().min(1000).max(60000).default(20000),
  maxChars: z.number().int().min(1000).max(200000).default(50000),
});
export const toolConfigSchemas = {
  web_search: webSearchConfigSchema,
  web_fetch: webFetchConfigSchema,
};
export type ToolId = z.infer<typeof toolIdSchema>;
export type WebSearchConfig = z.infer<typeof webSearchConfigSchema>;
export type WebFetchConfig = z.infer<typeof webFetchConfigSchema>;
export type ToolConfig =
  | { id: 'web_search'; config: WebSearchConfig }
  | { id: 'web_fetch'; config: WebFetchConfig };
export const defaultWebSearchConfig = webSearchConfigSchema.parse({});
export const defaultWebFetchConfig = webFetchConfigSchema.parse({});
