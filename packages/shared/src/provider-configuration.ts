import { z } from 'zod';

export type ProviderFieldText = string | { en: string; 'zh-CN': string };
type FieldBase = {
  key: string;
  label: ProviderFieldText;
  description?: ProviderFieldText;
  required?: boolean;
};

/** Serializable declarations shared by the admin form and server validation. */
export type ProviderConfigField = FieldBase &
  (
    | {
        type: 'text' | 'textarea';
        defaultValue?: string;
        placeholder?: ProviderFieldText;
        pattern?: string;
      }
    | {
        type: 'number';
        defaultValue?: number;
        placeholder?: ProviderFieldText;
        min?: number;
        max?: number;
        integer?: boolean;
      }
    | {
        type: 'select';
        defaultValue?: string;
        options: readonly { value: string; label: ProviderFieldText }[];
      }
    | { type: 'switch'; defaultValue?: boolean }
  );

export type ProviderConfiguration = {
  fields: readonly ProviderConfigField[];
  description?: ProviderFieldText;
  baseUrlHint?: ProviderFieldText;
  defaultBaseUrl?: string;
};
export type ProviderConfigurations = Record<string, ProviderConfiguration>;

export function providerFieldText(
  value: ProviderFieldText | undefined,
  language: string,
) {
  return typeof value === 'string' || !value
    ? value
    : value[language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'];
}

/** Blank/null clears optional fields. Defaults and validation are owned by the provider. */
export function parseProviderMetadata(
  fields: readonly ProviderConfigField[],
  metadata: Record<string, unknown>,
) {
  const shape: Record<string, z.ZodType> = {};
  for (const field of fields) {
    if (
      !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(field.key) ||
      ['__proto__', 'constructor', 'prototype'].includes(field.key) ||
      Object.hasOwn(shape, field.key)
    )
      throw new Error('Invalid or duplicate provider configuration key');
    let schema: z.ZodType;
    if (field.type === 'switch') schema = z.boolean();
    else if (field.type === 'number') {
      let number = z.number();
      if (field.integer) number = number.int();
      if (field.min !== undefined) number = number.min(field.min);
      if (field.max !== undefined) number = number.max(field.max);
      schema = number;
    } else if (field.type === 'select') {
      schema = z.enum(field.options.map(({ value }) => value));
    } else {
      let string = z.string().trim();
      if (field.required) string = string.min(1);
      if (field.pattern) string = string.regex(new RegExp(field.pattern));
      schema = string;
    }
    if (!field.required) schema = schema.optional();
    if (field.defaultValue !== undefined)
      schema = schema.default(field.defaultValue);
    shape[field.key] = z.preprocess(
      (value) =>
        value === null || (typeof value === 'string' && !value.trim())
          ? undefined
          : value,
      schema,
    );
  }
  const parsed = z.looseObject(shape).parse(metadata);
  return Object.fromEntries(
    Object.entries(parsed).filter(([, value]) => value !== undefined),
  );
}

export function providerConfigFieldName(key: string) {
  return `metadata.${key}`;
}

/** Keep explicit nulls in the PATCH so clearing a value survives a server-side merge. */
export function providerMetadataFromForm(
  form: FormData,
  fields: readonly ProviderConfigField[],
  metadata: Record<string, unknown> = {},
) {
  const next = { ...metadata };
  for (const field of fields) {
    const name = providerConfigFieldName(field.key);
    const value = form.get(name);
    next[field.key] =
      field.type === 'switch'
        ? form.has(name)
        : value === null || String(value).trim() === ''
          ? null
          : field.type === 'number'
            ? Number(value)
            : String(value);
  }
  parseProviderMetadata(fields, next);
  return next;
}
