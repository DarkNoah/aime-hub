import { z } from 'zod';

const common = {
  key: z
    .string()
    .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/)
    .refine((key) => !['constructor', 'prototype', '__proto__'].includes(key)),
  label: z.string().trim().min(1).max(100),
  description: z.string().max(1000).optional(),
  group: z.string().trim().min(1).max(100).optional(),
  /** Presentation and conditional-required rule; hidden values are retained. */
  visibleWhen: z
    .strictObject({
      field: z.string().min(1).max(64),
      equals: z.union([z.string().max(200), z.boolean()]),
    })
    .optional(),
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
    z.strictObject({
      ...common,
      type: z.literal('select'),
      options: z
        .array(
          z.strictObject({
            value: z.string().min(1).max(200),
            label: z.string().trim().min(1).max(100),
          }),
        )
        .min(1)
        .max(100),
      default: z.string().max(200).optional(),
      placeholder: z.string().max(200).optional(),
    }),
  ])
  .superRefine((field, ctx) => {
    if (
      field.type === 'select' &&
      (new Set(field.options.map((option) => option.value)).size !==
        field.options.length ||
        (field.default !== undefined &&
          !field.options.some((option) => option.value === field.default)))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Invalid select options or default',
      });
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
      if (field.visibleWhen) {
        const controller = fields.find(
          (item) => item.key === field.visibleWhen!.field,
        );
        const equals = field.visibleWhen.equals;
        if (
          !controller ||
          controller === field ||
          controller.visibleWhen ||
          !['text', 'select', 'boolean'].includes(controller.type) ||
          (controller.type === 'boolean') !== (typeof equals === 'boolean') ||
          (controller.type === 'select' &&
            !controller.options.some((option) => option.value === equals))
        )
          ctx.addIssue({
            code: 'custom',
            path: [index, 'visibleWhen'],
            message: 'Invalid visibility condition',
          });
      }
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

export function isPluginConfigFieldVisible(
  field: PluginConfigField,
  values: Readonly<Record<string, unknown>>,
) {
  return (
    !field.visibleWhen ||
    values[field.visibleWhen.field] === field.visibleWhen.equals
  );
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
  const values = {
    ...pluginConfigDefaults(fields),
    ...(input && typeof input === 'object' ? input : {}),
  };
  for (const field of fields) {
    const required =
      field.required && isPluginConfigFieldVisible(field, values);
    let schema: z.ZodType;
    if (field.type === 'number') {
      let number = z.number();
      if (field.integer) number = number.int();
      if (field.min !== undefined) number = number.min(field.min);
      if (field.max !== undefined) number = number.max(field.max);
      schema = number;
    } else if (field.type === 'boolean') {
      schema = z.boolean();
    } else if (field.type === 'select') {
      const options = z.enum(field.options.map((option) => option.value));
      schema = required ? options : options.or(z.literal(''));
    } else {
      const text = z.string().max(16384);
      schema = required
        ? text.refine((value) => value.trim().length > 0)
        : text;
    }
    if (!required) schema = schema.optional();
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
