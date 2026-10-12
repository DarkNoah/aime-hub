import { z } from 'zod';

export const systemSettingsSchema = z
  .object({
    registrationEnabled: z.boolean(),
  })
  .strict();

export type SystemSettings = z.infer<typeof systemSettingsSchema>;

export const defaultSystemSettings: SystemSettings = {
  registrationEnabled: true,
};
