import { INDICATORS } from './registry';
import type {
  IndicatorDefinition,
  IndicatorParameter,
  IndicatorParameters,
  IndicatorPreferences,
} from './types';

export const INDICATOR_STORAGE_KEY = 'vibe-quant:indicators:v1';

export function defaultParameters(
  definition: IndicatorDefinition,
): IndicatorParameters {
  return Object.fromEntries(
    definition.parameters.map((parameter) => [
      parameter.key,
      parameter.default,
    ]),
  );
}

function validParameter(
  parameter: IndicatorParameter,
  value: unknown,
): boolean {
  switch (parameter.type) {
    case 'number':
      return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        (!parameter.integer || Number.isSafeInteger(value)) &&
        (parameter.min === undefined || value >= parameter.min) &&
        (parameter.max === undefined || value <= parameter.max)
      );
    case 'select':
      return parameter.options.some((option) => option.value === value);
    case 'color':
      return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
    case 'boolean':
      return typeof value === 'boolean';
  }
}

export function validateParameters(
  definition: IndicatorDefinition,
  parameters: IndicatorParameters,
): string | undefined {
  for (const parameter of definition.parameters) {
    if (validParameter(parameter, parameters[parameter.key])) continue;
    if (parameter.type === 'number') {
      return `${parameter.label}请输入有效${parameter.integer ? '整数' : '数字'}${
        parameter.min !== undefined ? `，最小为 ${parameter.min}` : ''
      }${parameter.max !== undefined ? `，最大为 ${parameter.max}` : ''}`;
    }
    return `请检查${parameter.label}`;
  }
  return definition.validate?.(parameters);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Keep known keys only and repair malformed/obsolete storage without crashing charts. */
export function parsePreferences(raw: string | null): IndicatorPreferences {
  let stored: Record<string, unknown> = {};
  try {
    stored = record(raw ? JSON.parse(raw) : {});
  } catch {
    // Invalid JSON simply restores defaults.
  }
  return Object.fromEntries(
    INDICATORS.map((definition) => {
      const entry = record(stored[definition.id]);
      const savedParameters = record(entry.parameters);
      let parameters = defaultParameters(definition);
      for (const parameter of definition.parameters) {
        const value = savedParameters[parameter.key];
        if (validParameter(parameter, value)) {
          parameters[parameter.key] = value as string | number | boolean;
        }
      }
      if (definition.validate?.(parameters))
        parameters = defaultParameters(definition);
      return [
        definition.id,
        {
          visible:
            typeof entry.visible === 'boolean'
              ? entry.visible
              : definition.defaultVisible,
          parameters,
        },
      ];
    }),
  );
}

export function readPreferences(): IndicatorPreferences {
  try {
    return parsePreferences(window.localStorage.getItem(INDICATOR_STORAGE_KEY));
  } catch {
    return parsePreferences(null);
  }
}
