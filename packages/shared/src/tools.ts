import { z } from 'zod';

// Runtime registrations own the catalog; only tools with extra settings need a schema here.
export const toolIdSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,99}$/);
export const enabledToolConfigSchema = z.strictObject({
  enabled: z.boolean().default(true),
});
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
export const imageGenConfigSchema = z.strictObject({
  enabled: z.boolean().default(true),
  model: z
    .string()
    .trim()
    .min(3)
    .max(512)
    .refine((value) => value.indexOf('/') > 0 && !value.endsWith('/'))
    .nullable()
    .default(null),
  timeoutMs: z.number().int().min(1000).max(600000).default(180000),
});
export const speechConfigSchema = imageGenConfigSchema.extend({
  timeoutMs: z.number().int().min(1000).max(600000).default(300000),
});
export const transcribeConfigSchema = speechConfigSchema;
export const viewFileConfigSchema = imageGenConfigSchema.extend({
  timeoutMs: z.number().int().min(1000).max(600000).default(600000),
});
export const toolConfigSchemas = {
  web_search: webSearchConfigSchema,
  web_fetch: webFetchConfigSchema,
  image_gen: imageGenConfigSchema,
  speech: speechConfigSchema,
  transcribe: transcribeConfigSchema,
  view_file: viewFileConfigSchema,
};
export type ConfigurableToolId = keyof typeof toolConfigSchemas;
export const toolIds = Object.keys(toolConfigSchemas) as ConfigurableToolId[];
export type ToolId = z.infer<typeof toolIdSchema>;
export type WebSearchConfig = z.infer<typeof webSearchConfigSchema>;
export type WebFetchConfig = z.infer<typeof webFetchConfigSchema>;
export type ImageGenConfig = z.infer<typeof imageGenConfigSchema>;
export type SpeechConfig = z.infer<typeof speechConfigSchema>;
export type TranscribeConfig = z.infer<typeof transcribeConfigSchema>;
export type ViewFileConfig = z.infer<typeof viewFileConfigSchema>;
export type ToolConfig = { description: string } & (
  | { id: 'web_search'; kind: 'web_search'; config: WebSearchConfig }
  | { id: 'web_fetch'; kind: 'web_fetch'; config: WebFetchConfig }
  | { id: 'image_gen'; kind: 'image_gen'; config: ImageGenConfig }
  | { id: 'speech'; kind: 'speech'; config: SpeechConfig }
  | { id: 'transcribe'; kind: 'transcribe'; config: TranscribeConfig }
  | { id: 'view_file'; kind: 'view_file'; config: ViewFileConfig }
  | {
      id: string;
      kind: 'builtin';
      config: z.infer<typeof enabledToolConfigSchema>;
    }
);
export const defaultWebSearchConfig = webSearchConfigSchema.parse({});
export const defaultWebFetchConfig = webFetchConfigSchema.parse({});
export const defaultImageGenConfig = imageGenConfigSchema.parse({});
export const defaultSpeechConfig = speechConfigSchema.parse({});
export const defaultTranscribeConfig = transcribeConfigSchema.parse({});
export const defaultViewFileConfig = viewFileConfigSchema.parse({});
