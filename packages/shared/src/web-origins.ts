import { z } from 'zod';

export const webOriginSchema = z
  .url({ protocol: /^https?$/ })
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        !url.username &&
        !url.password &&
        !url.hostname.includes('*') &&
        url.pathname === '/' &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  }, 'Expected an HTTP(S) origin without credentials, wildcards or a path')
  .transform((value) => new URL(value).origin);

export const webOriginsEnvSchema = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  )
  .pipe(z.array(webOriginSchema).min(1))
  .transform((origins) => [...new Set(origins)]);

// Keep callers that configure a single origin compatible.
export type WebOrigins = string | readonly string[];

export function normalizeWebOrigins(value: WebOrigins): string[] {
  const origins = typeof value === 'string' ? [value] : value;
  return [...new Set(origins.map((origin) => webOriginSchema.parse(origin)))];
}
