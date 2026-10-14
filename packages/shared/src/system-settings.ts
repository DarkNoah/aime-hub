import { z } from 'zod';

export const systemSettingsSchema = z
  .object({
    registrationEnabled: z.boolean(),
    requestLoggingEnabled: z.boolean(),
  })
  .strict();

export type SystemSettings = z.infer<typeof systemSettingsSchema>;

export const systemSettingsUpdateSchema = systemSettingsSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0);

export type SystemSettingsUpdate = z.infer<typeof systemSettingsUpdateSchema>;

export const defaultSystemSettings: SystemSettings = {
  registrationEnabled: true,
  requestLoggingEnabled: true,
};
