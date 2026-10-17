import { z } from 'zod';

const desktopApiUrlSchema = z
  .string()
  .trim()
  .refine((value) => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return (
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  }, 'Use an HTTP(S) API URL without credentials, query or fragment');

export const desktopTimeoutSchema = z.number().int().positive();

export const systemSettingsSchema = z
  .object({
    registrationEnabled: z.boolean(),
    requestLoggingEnabled: z.boolean(),
    e2bDesktopEnabled: z.boolean(),
    e2bDesktopApiUrl: desktopApiUrlSchema,
    e2bDesktopTemplate: z.string().trim(),
    e2bDesktopTimeoutSeconds: desktopTimeoutSchema,
    e2bDesktopHasApiKey: z.boolean(),
    e2bDesktopManaged: z.boolean(),
  })
  .strict();

export type SystemSettings = z.infer<typeof systemSettingsSchema>;

export const systemSettingsUpdateSchema = systemSettingsSchema
  .omit({ e2bDesktopHasApiKey: true, e2bDesktopManaged: true })
  .extend({ e2bDesktopApiKey: z.string().trim().nullable() })
  .partial()
  .refine((value) => Object.keys(value).length > 0);

export type SystemSettingsUpdate = z.infer<typeof systemSettingsUpdateSchema>;

export const defaultSystemSettings: SystemSettings = {
  registrationEnabled: true,
  requestLoggingEnabled: true,
  e2bDesktopEnabled: false,
  e2bDesktopApiUrl: '',
  e2bDesktopTemplate: 'desktop',
  e2bDesktopTimeoutSeconds: 300,
  e2bDesktopHasApiKey: false,
  e2bDesktopManaged: false,
};
