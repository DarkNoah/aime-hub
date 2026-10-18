import { z } from 'zod';
import { thinkingLevels } from './threads.js';
import { languageModelProviders as catalogProviders } from './provider-catalog.js';

export const languageModelProviders = {
  ...catalogProviders,
  newapi: 'New API',
  xinference: 'Xinference',
} as const;
export const otherProviders = {
  mineru: 'MinerU',
  paddleocr: 'PaddleOCR',
  serpapi: 'SerpAPI',
  'jina-ai': 'Jina AI',
} as const;
export const providerGroups = ['languageModel', 'other'] as const;
export function providerGroup(type: string) {
  return Object.hasOwn(otherProviders, type) ? 'other' : 'languageModel';
}
export function providerSupportsModels(type: string) {
  return isOcrProvider(type) || providerGroup(type) === 'languageModel';
}
export function isOcrProvider(type: string) {
  return type === 'mineru' || type === 'paddleocr';
}
export function providerSupportsWebTool(
  type: string,
  tool: 'web_search' | 'web_fetch',
) {
  return (
    type === 'deepseek' ||
    type === (tool === 'web_search' ? 'serpapi' : 'jina-ai')
  );
}
export const providerTypeSchema = z.enum([
  ...(Object.keys(languageModelProviders) as Array<
    keyof typeof languageModelProviders
  >),
  'mineru',
  'paddleocr',
  'serpapi',
  'jina-ai',
]);

const metadata = z.record(z.string(), z.unknown());
const modelId = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((id) =>
    [...id].every(
      (char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127,
    ),
  );
export const providerInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    type: providerTypeSchema.default('openai'),
    baseUrl: z
      .url()
      .max(2048)
      .refine((value) => {
        if (!URL.canParse(value)) return false;
        const url = new URL(value);
        return (
          ['https:', 'http:'].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      }),
    apiKey: z
      .string()
      .trim()
      .max(4096)
      .refine((value) => !/[\r\n]/.test(value))
      .optional(),
    enabled: z.boolean().default(true),
    metadata: metadata.default({}),
  })
  .strict();
export const providerUpdateSchema = providerInputSchema.partial().extend({
  type: providerInputSchema.shape.type.removeDefault().optional(),
  enabled: providerInputSchema.shape.enabled.removeDefault().optional(),
  metadata: providerInputSchema.shape.metadata.removeDefault().optional(),
});
export const modelTypes = [
  'language',
  'embedding',
  'rerank',
  'speech',
  'asr',
  'image',
  'ocr',
] as const;
export const modelTypeSchema = z.enum(modelTypes);
export type ModelType = z.infer<typeof modelTypeSchema>;
export function providerModelTypes(type: string): readonly ModelType[] {
  if (isOcrProvider(type)) return ['ocr'];
  return providerSupportsModels(type)
    ? modelTypes.filter((modelType) => modelType !== 'ocr')
    : [];
}
export const defaultModelTypes = {
  defaultModel: 'language',
  fastModel: 'language',
  imageModel: 'image',
  embeddingModel: 'embedding',
  rerankModel: 'rerank',
  speechModel: 'speech',
  asrModel: 'asr',
  ocrModel: 'ocr',
} as const;
export const defaultModelKeys = Object.keys(defaultModelTypes) as Array<
  keyof typeof defaultModelTypes
>;

export const defaultWebProviderTools = {
  webSearchProviderId: 'web_search',
  webFetchProviderId: 'web_fetch',
} as const;
export const defaultWebProviderKeys = Object.keys(
  defaultWebProviderTools,
) as Array<keyof typeof defaultWebProviderTools>;

export function modelSupportsType(
  model: { modelType?: ModelType; modalitiesOutput: readonly string[] },
  type: ModelType,
) {
  const modelType = model.modelType ?? 'language';
  if (type === 'image')
    return (
      (modelType === 'image' || modelType === 'language') &&
      model.modalitiesOutput.includes('image')
    );
  return (
    modelType === type &&
    (type !== 'language' || model.modalitiesOutput.includes('text'))
  );
}

export const modelInputSchema = z
  .object({
    id: modelId,
    modelType: modelTypeSchema.default('language'),
    name: z.string().trim().min(1).max(256),
    description: z.string().max(10000).nullable().default(null),
    displayName: z.string().trim().max(256).nullable().default(null),
    enabled: z.boolean().default(true),
    deprecated: z.boolean().nullable().default(null),
    passTest: z.boolean().nullable().default(null),
    modalitiesInput: z
      .array(z.enum(['text', 'image', 'audio', 'video', 'pdf']))
      .max(5)
      .default(['text']),
    modalitiesOutput: z
      .array(z.enum(['text', 'image', 'audio', 'video', 'pdf']))
      .max(5)
      .default(['text']),
    reasoning: z.boolean().default(false),
    toolCall: z.boolean().default(false),
    limitContext: z
      .number()
      .int()
      .positive()
      .max(2147483647)
      .nullable()
      .default(null),
    limitOutput: z
      .number()
      .int()
      .positive()
      .max(2147483647)
      .nullable()
      .default(null),
    metadata: metadata.default({}),
  })
  .strict();
export const modelUpdateSchema = modelInputSchema.partial().extend({
  modelType: modelInputSchema.shape.modelType.removeDefault().optional(),
  description: modelInputSchema.shape.description.removeDefault().optional(),
  displayName: modelInputSchema.shape.displayName.removeDefault().optional(),
  enabled: modelInputSchema.shape.enabled.removeDefault().optional(),
  deprecated: modelInputSchema.shape.deprecated.removeDefault().optional(),
  passTest: modelInputSchema.shape.passTest.removeDefault().optional(),
  modalitiesInput: modelInputSchema.shape.modalitiesInput
    .removeDefault()
    .optional(),
  modalitiesOutput: modelInputSchema.shape.modalitiesOutput
    .removeDefault()
    .optional(),
  reasoning: modelInputSchema.shape.reasoning.removeDefault().optional(),
  toolCall: modelInputSchema.shape.toolCall.removeDefault().optional(),
  limitContext: modelInputSchema.shape.limitContext.removeDefault().optional(),
  limitOutput: modelInputSchema.shape.limitOutput.removeDefault().optional(),
  metadata: modelInputSchema.shape.metadata.removeDefault().optional(),
});
export const modelDefaultsSchema = z
  .object({
    defaultModel: z.string().min(3).max(512).nullable(),
    fastModel: z.string().min(3).max(512).nullable(),
    imageModel: z.string().min(3).max(512).nullable(),
    embeddingModel: z.string().min(3).max(512).nullable().default(null),
    rerankModel: z.string().min(3).max(512).nullable().default(null),
    speechModel: z.string().min(3).max(512).nullable().default(null),
    asrModel: z.string().min(3).max(512).nullable().default(null),
    ocrModel: z.string().min(3).max(512).nullable().default(null),
    webSearchProviderId: z.string().min(1).max(128).nullable().default(null),
    webFetchProviderId: z.string().min(1).max(128).nullable().default(null),
    thinkingMode: z.enum(thinkingLevels),
  })
  .strict();
export type ProviderInput = z.infer<typeof providerInputSchema>;
export type ModelInput = z.infer<typeof modelInputSchema>;
export type ModelDefaults = z.infer<typeof modelDefaultsSchema>;
export type ProviderModel = ModelInput & {
  providerId: string;
  createdAt: string;
  updatedAt: string;
};
export type ProviderSummary = Omit<ProviderInput, 'apiKey'> & {
  id: string;
  hasApiKey: boolean;
  createdAt: string;
  updatedAt: string;
  modelCount: number;
};
export type ProviderDetail = ProviderSummary & { models: ProviderModel[] };
// User-facing catalog: connection details and internal metadata stay server-side.
export type AvailableModel = Pick<
  ProviderModel,
  | 'providerId'
  | 'id'
  | 'modelType'
  | 'name'
  | 'displayName'
  | 'description'
  | 'enabled'
  | 'modalitiesInput'
  | 'modalitiesOutput'
  | 'reasoning'
  | 'toolCall'
  | 'limitContext'
  | 'limitOutput'
>;
export type AvailableProvider = {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  models: AvailableModel[];
};
export type AvailableModels = {
  providers: AvailableProvider[];
  defaults?: Pick<ModelDefaults, 'defaultModel' | 'thinkingMode'>;
};
export type SyncResult = {
  added: number;
  deprecated: number;
  total: number;
  catalogAvailable: boolean;
};
export const emptyModelDefaults: ModelDefaults = {
  defaultModel: null,
  fastModel: null,
  imageModel: null,
  embeddingModel: null,
  rerankModel: null,
  speechModel: null,
  asrModel: null,
  ocrModel: null,
  webSearchProviderId: null,
  webFetchProviderId: null,
  thinkingMode: 'medium',
};
export function modelReference(providerId: string, id: string) {
  return `${providerId}/${id}`;
}

// Normalize persisted mode values from before system thinking levels were introduced.
export function normalizeModelDefaults(value: unknown): ModelDefaults {
  if (!value || typeof value !== 'object') return { ...emptyModelDefaults };
  const stored = value as Record<string, unknown>;
  const thinkingMode =
    stored.thinkingMode === 'off'
      ? 'none'
      : stored.thinkingMode === 'on' || stored.thinkingMode === 'auto'
        ? 'medium'
        : stored.thinkingMode;
  return modelDefaultsSchema.parse({ ...stored, thinkingMode });
}
