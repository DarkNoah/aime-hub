import { z } from 'zod';

export const environmentVariableInputSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  // Keep values verbatim, including empty strings and leading/trailing spaces.
  value: z
    .string()
    .max(16384)
    .refine((value) => !value.includes('\0')),
  description: z
    .string()
    .trim()
    .max(1000)
    .refine((value) => !value.includes('\0'))
    .default(''),
});

export const environmentVariableUpdateSchema = environmentVariableInputSchema
  .extend({
    description:
      environmentVariableInputSchema.shape.description.removeDefault(),
  })
  .partial()
  .refine((input) => Object.values(input).some((value) => value !== undefined));

export type EnvironmentVariableInput = z.input<
  typeof environmentVariableInputSchema
>;
export type EnvironmentVariableUpdate = z.input<
  typeof environmentVariableUpdateSchema
>;
export type EnvironmentVariable = z.output<
  typeof environmentVariableInputSchema
> & {
  id: string;
  createdAt: string;
  updatedAt: string;
};
