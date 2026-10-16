import { z } from 'zod';

const common = {
  key: z
    .string()
    .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/)
    .refine((key) => !['constructor', 'prototype', '__proto__'].includes(key)),
  label: z.string().trim().min(1).max(100),
  description: z.string().max(1000).optional(),
  required: z.boolean().default(false),
};

export const pluginConfigFieldSchema = z
  .discriminatedUnion('type', [
    z.strictObject({
      ...common,
      type: z.literal('text'),
      default: z.string().max(16384).optional(),
      placeholder: z.string().max(200).optional(),
      multiline: z.boolean().default(false),
    }),
    z.strictObject({
      ...common,
      type: z.literal('password'),
      placeholder: z.string().max(200).optional(),
    }),
    z.strictObject({
      ...common,
      type: z.literal('number'),
      default: z.number().optional(),
      min: z.number().optional(),
      max: z.number().optional(),
      integer: z.boolean().default(false),
    }),
    z.strictObject({
      ...common,
      type: z.literal('boolean'),
      default: z.boolean().default(false),
    }),
  ])
  .superRefine((field, ctx) => {
    if (
      field.type === 'number' &&
      ((field.min !== undefined &&
        field.max !== undefined &&
        field.min > field.max) ||
        (field.default !== undefined &&
          ((field.min !== undefined && field.default < field.min) ||
            (field.max !== undefined && field.default > field.max) ||
            (field.integer && !Number.isInteger(field.default)))))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Invalid numeric limits or default',
      });
    if (
      field.type === 'text' &&
      field.required &&
      field.default !== undefined &&
      !field.default.trim()
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Required field default cannot be empty',
      });
  });

export const pluginConfigFieldsSchema = z
  .array(pluginConfigFieldSchema)
  .max(50)
  .default([])
  .superRefine((fields, ctx) => {
    const keys = new Set<string>();
    for (const [index, field] of fields.entries()) {
      if (keys.has(field.key))
        ctx.addIssue({
          code: 'custom',
          path: [index, 'key'],
          message: 'Duplicate configuration key',
        });
      keys.add(field.key);
    }
  });

export type PluginConfigField = z.infer<typeof pluginConfigFieldSchema>;
export type PluginConfig = Readonly<Record<string, string | number | boolean>>;
export type PluginConfigIssue = { field: string; message: string };
export interface PluginConfiguration {
  config: PluginConfig;
  /** Optimistic concurrency token; changes on configuration or activation updates. */
  revision: string;
}

export function pluginConfigDefaults(
  fields: readonly PluginConfigField[],
): PluginConfig {
  return Object.fromEntries(
    fields.flatMap((field) =>
      'default' in field && field.default !== undefined
        ? [[field.key, field.default]]
        : [],
    ),
  );
}

export function parsePluginConfig(
  fields: readonly PluginConfigField[],
  input: unknown,
) {
  const shape: Record<string, z.ZodType> = {};
  for (const field of fields) {
    let schema: z.ZodType;
    if (field.type === 'number') {
      let number = z.number();
      if (field.integer) number = number.int();
      if (field.min !== undefined) number = number.min(field.min);
      if (field.max !== undefined) number = number.max(field.max);
      schema = number;
    } else if (field.type === 'boolean') {
      schema = z.boolean();
    } else {
      const text = z.string().max(16384);
      schema = field.required
        ? text.refine((value) => value.trim().length > 0)
        : text;
    }
    if (!field.required) schema = schema.optional();
    if ('default' in field && field.default !== undefined)
      schema = schema.default(field.default);
    shape[field.key] = schema;
  }
  const result = z.strictObject(shape).safeParse(input);
  if (!result.success)
    return {
      success: false as const,
      issues: result.error.issues.map((issue) => ({
        field: String(issue.path[0] ?? ''),
        message: issue.message,
      })),
    };
  return {
    success: true as const,
    data: Object.fromEntries(
      Object.entries(result.data).filter(([, value]) => value !== undefined),
    ) as PluginConfig,
  };
}
